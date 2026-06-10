import { afterEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/jobs/[jobId]/route";
import { USER_ID_HEADER } from "@/lib/auth";
import {
  createInMemoryPipelineWorker,
  type PipelineWorker,
} from "@/lib/pipeline/worker";
import { setPipelineWorkerForTesting } from "@/lib/server/worker-provider";
import {
  MockAIServiceConnector,
  createControllableScheduler,
} from "@/lib/ai/connector";
import type { DesignBriefInput } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Mock AI connector whose calls resolve immediately. */
function makeConnector() {
  return new MockAIServiceConnector({
    defaults: { scheduler: createControllableScheduler() },
  });
}

/** Build a Request carrying the trusted middleware-injected user header. */
function makeRequest(userId?: string): Request {
  const headers = new Headers();
  if (userId !== undefined) headers.set(USER_ID_HEADER, userId);
  return new Request("https://example.invalid/api/jobs/x", { headers });
}

/** Install a worker into the provider and return it. */
function installWorker(initialCredits: Record<string, number>): {
  worker: PipelineWorker;
} {
  const { worker } = createInMemoryPipelineWorker({
    connector: makeConnector(),
    initialCredits,
  });
  setPipelineWorkerForTesting(worker);
  return { worker };
}

afterEach(() => {
  setPipelineWorkerForTesting(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/jobs/[jobId]", () => {
  it("returns 401 when the trusted user header is absent", async () => {
    installWorker({ owner: 5 });
    const res = await GET(makeRequest(undefined), { params: { jobId: "anything" } });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("returns 404 for an unknown job id", async () => {
    installWorker({ owner: 5 });
    const res = await GET(makeRequest("owner"), {
      params: { jobId: "does-not-exist" },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("returns 404 for a job owned by a different user (no existence leak)", async () => {
    const { worker } = installWorker({ owner: 5 });
    const job = await worker.createJob(makeBrief(), 3, "owner");

    const res = await GET(makeRequest("intruder"), {
      params: { jobId: job.id },
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 with the JobStatus for the owner (queued, before run)", async () => {
    const { worker } = installWorker({ owner: 5 });
    const job = await worker.createJob(makeBrief({ variationCount: 3 }), 3, "owner");

    const res = await GET(makeRequest("owner"), { params: { jobId: job.id } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.jobId).toBe(job.id);
    expect(body.state).toBe("queued");
    expect(body.currentStep).toBe(1);
    expect(body.currentStepName).toBe("Brand DNA Extraction");
    // Per-step statuses exposed for the progress indicator (Req 2.9).
    expect(body.statuses).toMatchObject({
      1: "pending",
      2: "pending",
      3: "pending",
      4: "pending",
      5: "pending",
      6: "pending",
    });
  });

  it("reflects a completed run: state done, all steps done, resultBatchId set", async () => {
    const { worker } = installWorker({ owner: 5 });
    const job = await worker.createJob(makeBrief({ variationCount: 3 }), 3, "owner");
    await worker.runJob(job.id);

    const res = await GET(makeRequest("owner"), { params: { jobId: job.id } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.state).toBe("done");
    expect(body.currentStep).toBe(6);
    expect(body.currentStepName).toBe("Render & Compose");
    expect(body.resultBatchId).toBeDefined();
    expect(Object.values(body.statuses).every((s) => s === "done")).toBe(true);
  });

  it("is idempotent: repeated polls return the same status without side effects", async () => {
    const { worker } = installWorker({ owner: 5 });
    const job = await worker.createJob(makeBrief(), 3, "owner");

    const first = await (
      await GET(makeRequest("owner"), { params: { jobId: job.id } })
    ).json();
    const second = await (
      await GET(makeRequest("owner"), { params: { jobId: job.id } })
    ).json();

    // No execution triggered by polling — still queued at step 1 both times.
    expect(first.state).toBe("queued");
    expect(second.state).toBe("queued");
    expect(second.currentStep).toBe(1);
  });
});
