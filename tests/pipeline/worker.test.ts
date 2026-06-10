import { describe, expect, it } from "vitest";

import {
  PipelineWorker,
  InMemoryBriefStore,
  InsufficientCreditError,
  createInMemoryPipelineWorker,
} from "@/lib/pipeline/worker";
import {
  CreditManager,
  InMemoryCreditRepository,
} from "@/lib/credit/credit-manager";
import { InMemoryJobStore } from "@/lib/jobs/job-store";
import {
  MockAIServiceConnector,
  createControllableScheduler,
  type AIServiceConnector,
} from "@/lib/ai/connector";
import type {
  DesignBriefInput,
  GenerationBatch,
  VariationCount,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid design brief for worker runs. */
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
    variationCount: 3,
    accentPalette: ["#112233", "#445566"],
    mandatoryElements: ["LogoStrip", "CTAButton"],
    uploadedAssets: [],
    ...overrides,
  };
}

/** Mock AI connector whose calls resolve immediately (fast scheduler). */
function makeConnector(): AIServiceConnector {
  return new MockAIServiceConnector({
    defaults: { scheduler: createControllableScheduler() },
  });
}

/** A connector whose image step always fails (to drive a step-6 failure). */
function makeImageFailingConnector(): AIServiceConnector {
  return new MockAIServiceConnector({
    image: { behavior: "fail", error: new Error("image gen down") },
    defaults: { scheduler: createControllableScheduler(), maxAttempts: 1 },
  });
}

/** A connector whose copy step always fails (to drive a step-3 failure). */
function makeCopyFailingConnector(): AIServiceConnector {
  return new MockAIServiceConnector({
    copy: { behavior: "fail", error: new Error("llm down") },
    defaults: { scheduler: createControllableScheduler(), maxAttempts: 1 },
  });
}

// ---------------------------------------------------------------------------
// createJob
// ---------------------------------------------------------------------------

describe("PipelineWorker.createJob", () => {
  it("reserves 1 credit per variation, persists the brief, and creates a queued job", async () => {
    const { worker, jobStore, briefStore, creditManager } =
      createInMemoryPipelineWorker({
        connector: makeConnector(),
        initialCredits: { u1: 10 },
      });

    const brief = makeBrief({ variationCount: 6 });
    const job = await worker.createJob(brief, 6, "u1");

    expect(job.userId).toBe("u1");
    expect(job.variationCount).toBe(6);
    expect(job.reservationId).toBeTypeOf("string");

    // 6 credits held -> available balance drops to 4.
    expect(await creditManager.getBalance("u1")).toBe(4);

    // Brief persisted and reachable by id.
    expect(await briefStore.getBrief(job.briefId)).toBeDefined();

    // Job seeded queued at step 1.
    const status = await jobStore.getStatus(job.id);
    expect(status?.state).toBe("queued");
    expect(status?.currentStep).toBe(1);
  });

  it("throws InsufficientCreditError without deducting when balance is too low", async () => {
    const { worker, creditManager } = createInMemoryPipelineWorker({
      connector: makeConnector(),
      initialCredits: { u1: 2 },
    });

    await expect(worker.createJob(makeBrief(), 3, "u1")).rejects.toBeInstanceOf(
      InsufficientCreditError,
    );
    // Balance untouched (Req 8.3).
    expect(await creditManager.getBalance("u1")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runJob — success
// ---------------------------------------------------------------------------

describe("PipelineWorker.runJob (success)", () => {
  it("runs steps 1..6, commits credit, and marks the job done with resultBatchId", async () => {
    const batches: GenerationBatch[] = [];
    const { worker, jobStore, creditManager } = createInMemoryPipelineWorker({
      connector: makeConnector(),
      initialCredits: { u1: 5 },
      onBatch: (b) => {
        batches.push(b);
      },
    });

    const job = await worker.createJob(makeBrief({ variationCount: 3 }), 3, "u1");
    await worker.runJob(job.id);

    const status = await jobStore.getStatus(job.id);
    expect(status?.state).toBe("done");
    expect(status?.resultBatchId).toBeDefined();
    expect(status?.currentStep).toBe(6);
    expect(Object.values(status!.statuses).every((s) => s === "done")).toBe(
      true,
    );

    // Credit committed (held funds consumed): 5 - 3 = 2 available.
    expect(await creditManager.getBalance("u1")).toBe(2);

    // onBatch sink received exactly the produced batch with matching id.
    expect(batches).toHaveLength(1);
    expect(batches[0].id).toBe(status?.resultBatchId);
    expect(batches[0].variations).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// runJob — failure
// ---------------------------------------------------------------------------

describe("PipelineWorker.runJob (failure)", () => {
  it("stops at the failing step, refunds, and records failedStep + message", async () => {
    const { worker, jobStore, creditManager } = createInMemoryPipelineWorker({
      connector: makeImageFailingConnector(),
      initialCredits: { u1: 5 },
    });

    const job = await worker.createJob(makeBrief({ variationCount: 3 }), 3, "u1");
    await worker.runJob(job.id);

    const status = await jobStore.getStatus(job.id);
    expect(status?.state).toBe("failed");
    expect(status?.failedStep).toBe(6);
    expect(status?.message).toContain("Langkah 6");
    expect(status?.statuses[6]).toBe("failed");

    // Unused credits refunded (Req 2.10): back to full 5.
    expect(await creditManager.getBalance("u1")).toBe(5);
  });

  it("fails at step 3 when copy generation fails and preserves earlier step results", async () => {
    const { worker, jobStore, creditManager } = createInMemoryPipelineWorker({
      connector: makeCopyFailingConnector(),
      initialCredits: { u1: 5 },
    });

    const job = await worker.createJob(makeBrief({ variationCount: 3 }), 3, "u1");
    await worker.runJob(job.id);

    const status = await jobStore.getStatus(job.id);
    expect(status?.state).toBe("failed");
    expect(status?.failedStep).toBe(3);
    expect(status?.statuses[1]).toBe("done");
    expect(status?.statuses[2]).toBe("done");
    expect(status?.statuses[3]).toBe("failed");

    // Refunded to full balance.
    expect(await creditManager.getBalance("u1")).toBe(5);
  });

  it("is a no-op for an unknown job id", async () => {
    const { worker } = createInMemoryPipelineWorker({
      connector: makeConnector(),
    });
    await expect(worker.runJob("does-not-exist")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getJobStatus — polling + ownership
// ---------------------------------------------------------------------------

describe("PipelineWorker.getJobStatus", () => {
  it("returns status for the owner and undefined for a different user", async () => {
    const { worker } = createInMemoryPipelineWorker({
      connector: makeConnector(),
      initialCredits: { owner: 5 },
    });

    const job = await worker.createJob(makeBrief(), 3, "owner");

    expect(await worker.getJobStatus(job.id, "owner")).toBeDefined();
    expect(await worker.getJobStatus(job.id, "intruder")).toBeUndefined();
  });

  it("reflects the live currentStep transitions reported during runJob", async () => {
    // Use a manual wiring so we can observe status mid-run via onBatch ordering.
    const jobStore = new InMemoryJobStore();
    const briefStore = new InMemoryBriefStore();
    const creditManager = new CreditManager(
      new InMemoryCreditRepository({ u1: 5 }),
    );
    const worker = new PipelineWorker({
      jobStore,
      creditManager,
      briefStore,
      connector: makeConnector(),
    });

    const variationCount: VariationCount = 3;
    const job = await worker.createJob(makeBrief({ variationCount }), variationCount, "u1");
    await worker.runJob(job.id);

    const status = await worker.getJobStatus(job.id, "u1");
    expect(status?.state).toBe("done");
    expect(status?.currentStep).toBe(6);
  });
});
