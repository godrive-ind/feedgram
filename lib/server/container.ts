/**
 * Server composition container (task 8.2 support).
 *
 * Provides a single, lazily-initialized {@link PipelineWorker} for the API
 * route handlers (`POST /api/generate`, `GET /api/jobs/[jobId]`, ...). Keeping
 * the wiring in one place means the HTTP layer stays thin and the worker stays
 * mockable: tests call {@link setPipelineWorker} to inject an in-memory worker.
 *
 * Production wiring note:
 *   The design targets a Prisma-backed worker (Postgres job/credit stores —
 *   `PrismaJobStore` / `PrismaCreditRepository` in `lib/jobs/job-store.ts`).
 *   Because the Prisma client is not generated/connected in this environment,
 *   the DEFAULT worker here uses the established in-memory factory
 *   ({@link createInMemoryPipelineWorker}) so the route runs and is testable.
 *   Swapping to the Prisma-backed stores is a drop-in change inside
 *   {@link createDefaultWorker} that does not touch the route handlers.
 *
 * The worker is a module-level singleton so that — within a single serverless
 * instance — a job created by `POST /api/generate` and run via `waitUntil`
 * remains pollable by `GET /api/jobs/[jobId]`.
 */

import {
  createAIServiceConnectorFromEnv,
  type AIServiceConnector,
} from "@/lib/ai/connector";
import {
  createInMemoryPipelineWorker,
  type BatchArtifacts,
  type PipelineWorker,
} from "@/lib/pipeline/worker";
import { getBatchIntelligenceStore } from "@/lib/server/batch-intelligence-store";
import { getCreditRepository } from "@/lib/server/credit-provider";
import { getHistoryManager } from "@/lib/server/history-provider";
import { getVariationStore } from "@/lib/server/variation-store";
import type { DesignBriefInput, GenerationBatch } from "@/lib/types";

// ---------------------------------------------------------------------------
// Singleton management (globalThis to survive HMR / module re-evaluation)
// ---------------------------------------------------------------------------

// In Next.js dev mode, modules can be re-evaluated on hot reload. Using
// globalThis ensures the same worker instance persists so a job created by
// POST /api/generate is visible to GET /api/jobs/[jobId] across re-evaluations.
const GLOBAL_KEY_WORKER = "__fdg_pipeline_worker__" as const;
const GLOBAL_KEY_CONNECTOR = "__fdg_ai_connector__" as const;

const globalStore = globalThis as unknown as {
  [GLOBAL_KEY_WORKER]?: PipelineWorker;
  [GLOBAL_KEY_CONNECTOR]?: AIServiceConnector;
};

function getWorkerSingleton(): PipelineWorker | undefined {
  return globalStore[GLOBAL_KEY_WORKER];
}
function setWorkerSingleton(w: PipelineWorker | undefined) {
  globalStore[GLOBAL_KEY_WORKER] = w;
}
function getConnectorSingleton(): AIServiceConnector | undefined {
  return globalStore[GLOBAL_KEY_CONNECTOR];
}
function setConnectorSingleton(c: AIServiceConnector | undefined) {
  globalStore[GLOBAL_KEY_CONNECTOR] = c;
}

/**
 * Resolve the AI connector. Defaults to the env-backed connector
 * ({@link createAIServiceConnectorFromEnv}) whose vendor keys are read from
 * server-side env vars; tests inject a mock connector via {@link setConnector}.
 */
function resolveConnector(): AIServiceConnector {
  let connector = getConnectorSingleton();
  if (!connector) {
    connector = createAIServiceConnectorFromEnv();
    setConnectorSingleton(connector);
  }
  return connector;
}

/**
 * Read an optional non-negative integer of starting credits to seed for the
 * in-memory MVP worker (e.g. local dev). Production reads balances from the DB,
 * so this is only consulted by the in-memory default wiring.
 */
function devInitialCredits(): number {
  const raw = process.env.DEV_INITIAL_CREDITS;
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Build the default (in-memory MVP) worker. See production-wiring note above. */
function createDefaultWorker(): PipelineWorker {
  const grant = devInitialCredits();
  // Share the SAME credit repository as the credits route (credit-provider) so
  // a granted/seeded balance is visible to both the UI (`GET /api/credits`) and
  // the generate flow (reserve/commit/refund). This makes the credit-provider
  // the single source of truth for balances (no separate worker-owned manager).
  const creditRepo = getCreditRepository();
  // Seed an optional dev balance via DEV_INITIAL_CREDITS into the shared repo.
  if (grant > 0) {
    void creditRepo.addCredits("__dev__", grant);
  }
  const { worker } = createInMemoryPipelineWorker({
    connector: resolveConnector(),
    // Reuse the shared repository so balances are unified across the app.
    creditRepo,
    // On batch completion (state "done"), persist it to history (Req 7.1) and
    // populate the variation store so export/publish/regenerate routes operate
    // on the real variations (task 14.1). Failures here never fail the job
    // (the worker swallows onBatch errors).
    onBatch: persistCompletedBatch,
  });
  return worker;
}

/**
 * Sink invoked by the worker when a batch completes successfully. Persists the
 * batch + brief into the History_Manager (Req 7.1) and registers every
 * variation (with its owning user) in the variation store so the
 * export/publish/variations routes can resolve and authorize them, and records
 * the batch-level Design_Intelligence artefacts
 * (Brief_Analysis/Visual_Strategy/Quality_Reports) so
 * `GET /api/batches/[id]/intelligence` can serve them to the owner (Req 4.4, 4.5).
 *
 * Resolved through the same injectable provider seams the routes use
 * (`getHistoryManager` / `getVariationStore` / `getBatchIntelligenceStore`), so
 * tests that inject their own managers see the worker's persisted batches and
 * vice versa.
 */
async function persistCompletedBatch(
  batch: GenerationBatch,
  brief: DesignBriefInput,
  artifacts?: BatchArtifacts,
): Promise<void> {
  // Persist to history (retries + session-retention handled inside saveBatch).
  await getHistoryManager().saveBatch(batch, brief);

  // Register each variation under the batch's owning user for the per-variation
  // routes (export/publish/regenerate ownership checks).
  const store = getVariationStore();
  for (const variation of batch.variations) {
    await store.saveVariation(variation, batch.userId);
  }

  // Record the batch-level Design_Intelligence artefacts so
  // `GET /api/batches/[id]/intelligence` can serve them to the owner (Req 4.4,
  // 4.5, 11.6). `artifacts` is present only for Professional_Mode batches; for
  // the legacy/base path we still record the owner + professionalMode:false so
  // the route can authorise ownership and return an explicit "no artefacts"
  // payload rather than leaking batch existence.
  await getBatchIntelligenceStore().saveBatchIntelligence({
    batchId: batch.id,
    ownerUserId: batch.userId,
    professionalMode: artifacts !== undefined,
    ...(artifacts?.briefAnalysis
      ? { briefAnalysis: artifacts.briefAnalysis }
      : {}),
    ...(artifacts?.visualStrategy
      ? { visualStrategy: artifacts.visualStrategy }
      : {}),
    ...(artifacts?.qualityReports
      ? { qualityReports: artifacts.qualityReports }
      : {}),
  });
}

/**
 * Return the process-wide {@link PipelineWorker}, creating the default in-memory
 * worker on first use. Route handlers call this instead of constructing wiring.
 */
export function getPipelineWorker(): PipelineWorker {
  let worker = getWorkerSingleton();
  if (!worker) {
    worker = createDefaultWorker();
    setWorkerSingleton(worker);
  }
  return worker;
}

/** Inject a specific worker (used by tests and alternative wirings). */
export function setPipelineWorker(worker: PipelineWorker): void {
  setWorkerSingleton(worker);
}

/** Override the AI connector before the worker is first built (tests/wiring). */
export function setConnector(connector: AIServiceConnector): void {
  setConnectorSingleton(connector);
}

/** Reset the container (test helper) so the next access rebuilds defaults. */
export function resetContainer(): void {
  setWorkerSingleton(undefined);
  setConnectorSingleton(undefined);
}
