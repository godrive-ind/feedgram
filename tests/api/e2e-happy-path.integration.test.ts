import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { POST as GENERATE } from "@/app/api/generate/route";
import { GET as JOB_STATUS } from "@/app/api/jobs/[jobId]/route";
import { GET as HISTORY } from "@/app/api/history/route";
import { POST as EXPORT } from "@/app/api/export/[id]/route";

import {
  resetContainer,
  setPipelineWorker,
} from "@/lib/server/container";
import {
  createInMemoryPipelineWorker,
  type PipelineWorker,
} from "@/lib/pipeline/worker";
import {
  MockAIServiceConnector,
  createControllableScheduler,
} from "@/lib/ai/connector";
import {
  DefaultExportManager,
  readImageDimensions,
  resetExportManager,
  setExportManager,
} from "@/lib/export/export-manager";
import {
  createInMemoryHistoryManager,
  type HistoryManager,
} from "@/lib/history/history-manager";
import {
  getHistoryManager,
  resetHistoryManager,
  setHistoryManager,
} from "@/lib/server/history-provider";
import {
  InMemoryVariationStore,
  getVariationStore,
  resetVariationStore,
  setVariationStore,
} from "@/lib/server/variation-store";
import { InMemoryObjectStorage } from "@/lib/storage/object-storage";
import { USER_ID_HEADER, USER_PLAN_HEADER } from "@/lib/auth";
import type {
  DesignBriefInput,
  GenerationBatch,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Task 14.2 — End-to-end happy-path integration test.
//
// Exercises the FULL "brief → job → batch → export" journey as ONE cohesive
// happy path, against the real route handlers, with the external boundaries
// (AI connector + object storage) MOCKED and the in-memory worker/stores
// injected through the established container/provider seams:
//
//   1. POST /api/generate with a valid brief → 202 { jobId }; 1 credit per
//      variation is reserved up front (Req 2.1).
//   2. The background job runs to completion (worker.runJob) → state "done"
//      with a resultBatchId; the batch holds exactly `variationCount`
//      variations (Req 2.8). GET /api/jobs/{jobId} reports the done state.
//   3. The completed batch is saved to history (Req 7.1) — verified through
//      GET /api/history.
//   4. One of the batch's variations is exported via POST /api/export/[id] →
//      a FileRef is returned; the stored PNG bytes have a shortest side
//      ≥1080px (Req 6.1).
//
// The worker's `onBatch` sink mirrors the production container wiring
// (`persistCompletedBatch`): on a "done" batch it saves to the History_Manager
// (Req 7.1) and registers each variation in the variation store so the export
// route can resolve + authorize them — all through the SAME provider seams the
// routes read from.
// ---------------------------------------------------------------------------

const USER = "u-e2e";
const VARIATION_COUNT = 3;
const INITIAL_CREDITS = 10;

function makeBrief(
  overrides: Partial<DesignBriefInput> = {},
): DesignBriefInput {
  return {
    brandName: "Acme",
    tagline: "We build",
    mainMessage: "Join our team",
    contentGoal: "Rekrutmen",
    visualStyle: "CorporateBlue",
    tone: "Profesional",
    outputFormat: { name: "Square", width: 1080, height: 1080 },
    variationCount: VARIATION_COUNT,
    accentPalette: ["#112233", "#445566"],
    mandatoryElements: ["LogoStrip", "CTAButton"],
    uploadedAssets: [],
    ...overrides,
  };
}

function makeGenerateRequest(
  body: unknown,
  opts: { userId: string; plan: string },
): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(USER_ID_HEADER, opts.userId);
  headers.set(USER_PLAN_HEADER, opts.plan);
  return new NextRequest("https://app.test/api/generate", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeGetRequest(url: string, userId: string): Request {
  const headers = new Headers();
  headers.set(USER_ID_HEADER, userId);
  return new Request(url, { headers });
}

function makeExportRequest(userId: string, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(USER_ID_HEADER, userId);
  return new Request("https://app.test/api/export/x", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * Wire the full server stack with mocked external boundaries:
 *   - a fast mock AI connector (controllable scheduler so the 30s timeout never
 *     blocks),
 *   - an in-memory object storage behind the real DefaultExportManager,
 *   - in-memory History_Manager + variation store behind the provider seams,
 *   - a pipeline worker whose `onBatch` sink persists the done batch to those
 *     same seams (mirroring the production container wiring).
 */
function wireStack(): {
  worker: PipelineWorker;
  storage: InMemoryObjectStorage;
  historyManager: HistoryManager;
  creditManager: ReturnType<typeof createInMemoryPipelineWorker>["creditManager"];
} {
  // External: object storage (mock) behind the real export manager.
  const storage = new InMemoryObjectStorage();
  setExportManager(new DefaultExportManager(storage));

  // Provider seams: in-memory history + variation store, shared by the worker
  // sink AND the history/export routes.
  const { manager: historyManager } = createInMemoryHistoryManager();
  setHistoryManager(historyManager);
  setVariationStore(new InMemoryVariationStore());

  // Worker: mock AI connector + seeded credits; on a done batch, persist to the
  // same seams the routes read from (Req 7.1 + export ownership).
  const { worker, creditManager } = createInMemoryPipelineWorker({
    connector: new MockAIServiceConnector({
      defaults: { scheduler: createControllableScheduler() },
    }),
    initialCredits: { [USER]: INITIAL_CREDITS },
    onBatch: async (batch: GenerationBatch, brief: DesignBriefInput) => {
      await getHistoryManager().saveBatch(batch, brief);
      const store = getVariationStore();
      for (const variation of batch.variations) {
        await store.saveVariation(variation, batch.userId);
      }
    },
  });
  setPipelineWorker(worker);

  return { worker, storage, historyManager, creditManager };
}

afterEach(() => {
  resetContainer();
  resetExportManager();
  resetHistoryManager();
  resetVariationStore();
});

describe("E2E happy path: brief → job → batch → export (AI & storage mocked)", () => {
  it("runs the full journey end-to-end through the real route handlers", async () => {
    const { worker, storage, creditManager } = wireStack();

    // --- 1. POST /api/generate → 202 { jobId }; credits reserved (Req 2.1) ---
    const generateRes = await GENERATE(
      makeGenerateRequest(makeBrief(), { userId: USER, plan: "Pro" }),
    );
    expect(generateRes.status).toBe(202);
    const { jobId } = await generateRes.json();
    expect(typeof jobId).toBe("string");
    expect(jobId.length).toBeGreaterThan(0);

    // 1 credit per variation reserved up front (Req 2.1): 10 - 3 = 7 available.
    expect(await creditManager.getBalance(USER)).toBe(
      INITIAL_CREDITS - VARIATION_COUNT,
    );

    // --- 2. Drive the background job to completion (Req 2.8) ------------------
    // POST already kicked the pipeline off via waitUntil; awaiting an explicit
    // run gives a deterministic terminal state (runJob is idempotent).
    await worker.runJob(jobId);

    const jobRes = await JOB_STATUS(makeGetRequest("https://app.test/api/jobs/x", USER), {
      params: { jobId },
    });
    expect(jobRes.status).toBe(200);
    const jobStatus = await jobRes.json();
    expect(jobStatus.state).toBe("done");
    expect(typeof jobStatus.resultBatchId).toBe("string");
    const batchId: string = jobStatus.resultBatchId;
    expect(batchId.length).toBeGreaterThan(0);

    // --- 3. Completed batch saved to history (Req 7.1) -----------------------
    const historyRes = await HISTORY(
      makeGetRequest("https://app.test/api/history", USER),
    );
    expect(historyRes.status).toBe(200);
    const { batches } = await historyRes.json();
    expect(Array.isArray(batches)).toBe(true);

    const savedBatch = batches.find(
      (b: GenerationBatch) => b.id === batchId,
    ) as GenerationBatch | undefined;
    expect(savedBatch).toBeDefined();
    // The batch holds exactly `variationCount` variations (Req 2.8).
    expect(savedBatch!.variations).toHaveLength(VARIATION_COUNT);

    // --- 4. Export one variation via POST /api/export/[id] (Req 6.1) ---------
    const variationId = savedBatch!.variations[0].id;
    const exportRes = await EXPORT(
      makeExportRequest(USER, { format: "png" }),
      { params: { id: variationId } },
    );
    expect(exportRes.status).toBe(200);
    const exportBody = await exportRes.json();
    expect(exportBody.format).toBe("png");
    expect(exportBody.fileRef.format).toBe("image/png");
    expect(typeof exportBody.fileRef.url).toBe("string");

    // Read the stored PNG bytes back and assert the shortest side ≥1080 (Req 6.1).
    const storedKey = `exports/${batchId}/${variationId}.png`;
    const stored = await storage.get(storedKey);
    expect(stored).toBeDefined();
    const dims = readImageDimensions(stored!);
    expect(dims).toBeDefined();
    expect(Math.min(dims!.width, dims!.height)).toBeGreaterThanOrEqual(1080);
  });
});
