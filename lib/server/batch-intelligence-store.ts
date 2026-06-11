/**
 * Batch intelligence store seam (task 17.2 support).
 *
 * `GET /api/batches/[id]/intelligence` needs to (1) resolve the
 * Design_Intelligence artefacts produced for a batch — `Design_Brief_Analysis`,
 * `Visual_Strategy`, and the per-variation `Quality_Report`s (Req 4.4, 4.5) —
 * and (2) know which user owns the batch so per-user ownership can be enforced
 * before the artefacts are served (Req 11.6).
 *
 * Neither the worker/job store (`lib/server/container.ts`) nor the
 * History_Manager expose a read path for the batch-level reasoning artefacts:
 * `GenerationBatch` carries no `briefAnalysis`/`visualStrategy` fields, and the
 * design persists those two artefacts "bersama Generation_Batch" (alongside the
 * batch) rather than on it. There is also no production artefact persistence yet
 * (the Prisma columns added in task 18.1 are not connected in this
 * environment). So, consistent with the injectable-seam pattern used by sibling
 * routes (the variations route's `setVariationStore`, the history route's
 * `setHistoryManager`, the memory provider's `setIntelligenceMemory`), this
 * module provides:
 *
 *   - a small {@link BatchIntelligenceStore} interface (lookup + save),
 *   - a default in-memory implementation ({@link InMemoryBatchIntelligenceStore}),
 *   - an injectable provider ({@link getBatchIntelligenceStore} /
 *     {@link setBatchIntelligenceStore} / {@link resetBatchIntelligenceStore})
 *     so the route is testable and a Prisma-backed store can be dropped in later
 *     WITHOUT touching the handler.
 *
 * Ownership model: a batch has a `userId`. The store records that owning user id
 * alongside the artefacts and returns it from
 * {@link BatchIntelligenceStore.getBatchIntelligence} so the route can collapse
 * "unknown" and "not owned" into a single 404 — never leaking the existence of
 * another user's batch (Req 11.6), consistent with the jobs/variations routes.
 *
 * Requirements: 4.4, 4.5, 11.6 (route support).
 */

import type {
  DesignBriefAnalysis,
  QualityReport,
  VisualStrategy,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The Design_Intelligence artefacts persisted for a single batch, together with
 * the id of the user that owns the batch.
 *
 * For batches generated WITHOUT Professional_Mode there are no reasoning
 * artefacts: `professionalMode` is `false` and the artefact fields are absent.
 * Recording the owner even for those batches lets the route authorise ownership
 * and return an explicit "no artefacts" payload rather than leaking existence.
 */
export interface StoredBatchIntelligence {
  /** The batch these artefacts belong to. */
  batchId: string;
  /** The owning user (the `userId` of the `GenerationBatch`). */
  ownerUserId: string;
  /** Whether the batch was generated with Professional_Mode active (Req 4.5). */
  professionalMode: boolean;
  /** Brief analysis artefact (present only for Professional_Mode batches). */
  briefAnalysis?: DesignBriefAnalysis;
  /** Visual strategy artefact (present only for Professional_Mode batches). */
  visualStrategy?: VisualStrategy;
  /** Per-variation quality reports (present only for Professional_Mode batches). */
  qualityReports?: QualityReport[];
}

/**
 * Persistence boundary for batch-level Design_Intelligence artefacts used by the
 * intelligence-viewing route.
 *
 * Kept intentionally small: the route only needs to look the artefacts up (to
 * authorise + serve them), and the worker's `onBatch` sink needs to persist them
 * when a batch completes.
 */
export interface BatchIntelligenceStore {
  /**
   * Resolve a batch's artefacts and owning user by id, or `undefined` when no
   * such batch has been recorded. The route collapses "unknown" and "not owned"
   * into a single 404 so it never leaks the existence of another user's batch.
   */
  getBatchIntelligence(
    batchId: string,
  ): Promise<StoredBatchIntelligence | undefined>;
  /** Persist (or replace) the artefacts recorded for a batch. */
  saveBatchIntelligence(record: StoredBatchIntelligence): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cloning helpers (defensive copies so stored/returned data is immutable)
// ---------------------------------------------------------------------------

function cloneQualityReport(report: QualityReport): QualityReport {
  return {
    ...report,
    scores: report.scores.map((s) => ({ ...s })),
    detectedNegativePatterns: [...report.detectedNegativePatterns],
  };
}

/** Deep-ish clone so callers cannot mutate the stored record in place. */
function cloneRecord(record: StoredBatchIntelligence): StoredBatchIntelligence {
  return {
    batchId: record.batchId,
    ownerUserId: record.ownerUserId,
    professionalMode: record.professionalMode,
    ...(record.briefAnalysis
      ? { briefAnalysis: { ...record.briefAnalysis } }
      : {}),
    ...(record.visualStrategy
      ? {
          visualStrategy: {
            ...record.visualStrategy,
            typography: { ...record.visualStrategy.typography },
          },
        }
      : {}),
    ...(record.qualityReports
      ? { qualityReports: record.qualityReports.map(cloneQualityReport) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + local wiring)
// ---------------------------------------------------------------------------

/** In-memory {@link BatchIntelligenceStore} backed by a `Map`. */
export class InMemoryBatchIntelligenceStore implements BatchIntelligenceStore {
  private readonly byId = new Map<string, StoredBatchIntelligence>();

  constructor(seed: readonly StoredBatchIntelligence[] = []) {
    for (const record of seed) {
      this.byId.set(record.batchId, cloneRecord(record));
    }
  }

  async getBatchIntelligence(
    batchId: string,
  ): Promise<StoredBatchIntelligence | undefined> {
    const record = this.byId.get(batchId);
    return record ? cloneRecord(record) : undefined;
  }

  async saveBatchIntelligence(record: StoredBatchIntelligence): Promise<void> {
    this.byId.set(record.batchId, cloneRecord(record));
  }
}

// ---------------------------------------------------------------------------
// Injectable provider (mockable seam — globalThis for HMR survival)
// ---------------------------------------------------------------------------

const GLOBAL_KEY = "__fdg_batch_intelligence_store__" as const;
const globalStore = globalThis as unknown as { [GLOBAL_KEY]?: BatchIntelligenceStore };

/**
 * Resolve the process-wide {@link BatchIntelligenceStore}, lazily building an
 * empty in-memory store on first use. Production wiring (Prisma-backed)
 * substitutes a real store via {@link setBatchIntelligenceStore} without
 * changing the route handler.
 */
export function getBatchIntelligenceStore(): BatchIntelligenceStore {
  if (!globalStore[GLOBAL_KEY]) {
    globalStore[GLOBAL_KEY] = new InMemoryBatchIntelligenceStore();
  }
  return globalStore[GLOBAL_KEY];
}

/** Inject a specific batch intelligence store (tests and alternative wirings). */
export function setBatchIntelligenceStore(store: BatchIntelligenceStore): void {
  globalStore[GLOBAL_KEY] = store;
}

/** Reset the store seam (test helper) so the next access rebuilds the default. */
export function resetBatchIntelligenceStore(): void {
  globalStore[GLOBAL_KEY] = undefined;
}
