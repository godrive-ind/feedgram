import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/generate/route";
import { GET } from "@/app/api/jobs/[jobId]/route";
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
  type MockConnectorConfig,
} from "@/lib/ai/connector";
import { USER_ID_HEADER, USER_PLAN_HEADER } from "@/lib/auth";
import type { DesignBriefInput } from "@/lib/types";

// ---------------------------------------------------------------------------
// Task 8.5 — Integration test: async job flow + auth smoke test.
//
// This file exercises the COMPLETE async job lifecycle THROUGH the HTTP route
// handlers (not the worker directly), with AI & storage mocked:
//
//   1. Happy path: POST /api/generate -> 202 { jobId }; the worker runs the
//      6-step pipeline to completion; GET /api/jobs/{jobId} reports state
//      "done" with all six steps "done" and a resultBatchId (Req 2.9).
//   2. Failure path: a forced step failure makes the worker report state
//      "failed" with the failed step number, and the reserved credit is
//      refunded so the balance is restored (Req 2.10).
//   3. Auth smoke test (keamanan endpoint): the protected endpoints reject
//      unauthenticated requests (401) and never expose another user's job
//      (cross-user access -> 404, existence not leaked).
//
// Sibling tests (`generate.test.ts`, `jobs-status.route.test.ts`,
// `generate-jobs.integration.test.ts`) already cover the individual route
// contracts and the shared-singleton wiring; this file adds the end-to-end
// done-state polling assertion and the failed/refund variant.
// ---------------------------------------------------------------------------

function makeBrief(overrides: Partial<DesignBriefInput> = {}): DesignBriefInput {
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

/**
 * Build a worker wired with a fast mock connector (controllable scheduler so
 * the 30s timeout never blocks) and seed credits. `connectorConfig` lets a test
 * force a step failure (e.g. the copy step) to exercise the failed/refund path.
 */
function wireWorker(
  initialCredits: Record<string, number>,
  connectorConfig: MockConnectorConfig = {},
): { worker: PipelineWorker; creditManager: ReturnType<typeof createInMemoryPipelineWorker>["creditManager"] } {
  const { worker, creditManager } = createInMemoryPipelineWorker({
    connector: new MockAIServiceConnector({
      defaults: { scheduler: createControllableScheduler() },
      ...connectorConfig,
    }),
    initialCredits,
  });
  setPipelineWorker(worker);
  return { worker, creditManager };
}

function makePostRequest(
  body: unknown,
  opts: { userId?: string; plan?: string } = {},
): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.userId) headers.set(USER_ID_HEADER, opts.userId);
  if (opts.plan) headers.set(USER_PLAN_HEADER, opts.plan);
  return new NextRequest("https://app.test/api/generate", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeGetRequest(userId?: string): Request {
  const headers = new Headers();
  if (userId !== undefined) headers.set(USER_ID_HEADER, userId);
  return new Request("https://app.test/api/jobs/x", { headers });
}

/** Create a job via the generate route and return its jobId (asserting 202). */
async function createJobViaRoute(
  brief: DesignBriefInput,
  opts: { userId: string; plan: string },
): Promise<string> {
  const res = await POST(makePostRequest(brief, opts));
  expect(res.status).toBe(202);
  const { jobId } = await res.json();
  expect(typeof jobId).toBe("string");
  return jobId;
}

afterEach(() => {
  resetContainer();
});

// ---------------------------------------------------------------------------
// 1. Async job flow — happy path (Req 2.9)
// ---------------------------------------------------------------------------

describe("async job flow: POST /api/generate → worker → GET /api/jobs (done)", () => {
  it("runs the pipeline to completion: GET reports done, all steps done, resultBatchId set", async () => {
    const { worker, creditManager } = wireWorker({ u1: 10 });

    const jobId = await createJobViaRoute(makeBrief({ variationCount: 3 }), {
      userId: "u1",
      plan: "Pro",
    });

    // POST already kicked the pipeline off in the background; await an explicit
    // run for a deterministic terminal state (runJob is safe to re-enter — the
    // commit is idempotent), then poll the status THROUGH the jobs route.
    await worker.runJob(jobId);

    const res = await GET(makeGetRequest("u1"), { params: { jobId } });
    expect(res.status).toBe(200);

    const status = await res.json();
    expect(status.jobId).toBe(jobId);
    expect(status.state).toBe("done");
    // Active step is the final one and named for the progress UI (Req 2.9).
    expect(status.currentStep).toBe(6);
    expect(status.currentStepName).toBe("Render & Compose");
    // Every step reported done.
    expect(Object.values(status.statuses).every((s) => s === "done")).toBe(true);
    // The produced batch id is surfaced on success.
    expect(typeof status.resultBatchId).toBe("string");
    expect(status.resultBatchId.length).toBeGreaterThan(0);
    // No failure fields on the success path.
    expect(status.failedStep).toBeUndefined();

    // Reserved credits were committed (3 of 10 consumed), not refunded.
    expect(await creditManager.getBalance("u1")).toBe(7);
  });

  it("progresses from queued → done (polling is read-only and idempotent)", async () => {
    const { worker } = wireWorker({ u1: 10 });
    const jobId = await createJobViaRoute(makeBrief({ variationCount: 3 }), {
      userId: "u1",
      plan: "Pro",
    });

    // Before the run completes the status is a non-failed lifecycle state.
    const early = await (
      await GET(makeGetRequest("u1"), { params: { jobId } })
    ).json();
    expect(["queued", "running", "done"]).toContain(early.state);

    await worker.runJob(jobId);

    // Two consecutive polls after completion return the same terminal status —
    // polling never mutates the job (Req 2.9).
    const first = await (
      await GET(makeGetRequest("u1"), { params: { jobId } })
    ).json();
    const second = await (
      await GET(makeGetRequest("u1"), { params: { jobId } })
    ).json();
    expect(first.state).toBe("done");
    expect(second.state).toBe("done");
    expect(second.resultBatchId).toBe(first.resultBatchId);
  });
});

// ---------------------------------------------------------------------------
// 2. Async job flow — forced failure + credit refund (Req 2.10)
// ---------------------------------------------------------------------------

describe("async job flow: forced step failure reports failed + refunds credit", () => {
  it("fails at the copy step (3), preserves earlier step outputs, and refunds the reserved credit", async () => {
    // Force the LLM (copy generation, step 3) to fail on every attempt.
    const { worker, creditManager } = wireWorker(
      { u1: 10 },
      { copy: { behavior: "fail" } },
    );

    const jobId = await createJobViaRoute(makeBrief({ variationCount: 3 }), {
      userId: "u1",
      plan: "Pro",
    });

    // Reserving 3 credits up front reduces the available balance (Req 8.2).
    expect(await creditManager.getBalance("u1")).toBe(7);

    await worker.runJob(jobId);

    const res = await GET(makeGetRequest("u1"), { params: { jobId } });
    expect(res.status).toBe(200);
    const status = await res.json();

    // The job is reported failed at step 3 with a message naming the step.
    expect(status.state).toBe("failed");
    expect(status.failedStep).toBe(3);
    expect(status.currentStep).toBe(3);
    expect(status.message).toContain("Langkah 3");
    expect(status.message).toContain("Copy Generation");

    // Earlier steps stay done; the failing step is marked failed; later steps
    // never ran (Req 2.10 — stop at the failed step).
    expect(status.statuses[1]).toBe("done");
    expect(status.statuses[2]).toBe("done");
    expect(status.statuses[3]).toBe("failed");
    expect(status.statuses[4]).toBe("pending");
    expect(status.statuses[5]).toBe("pending");
    expect(status.statuses[6]).toBe("pending");

    // No batch id on failure.
    expect(status.resultBatchId).toBeUndefined();

    // The reserved credits were refunded — balance restored to the original 10.
    expect(await creditManager.getBalance("u1")).toBe(10);
  });

  it("fails at the render step (6) and refunds when image generation fails", async () => {
    // Force the image generator (render & compose, step 6) to fail.
    const { worker, creditManager } = wireWorker(
      { u1: 6 },
      { image: { behavior: "fail" } },
    );

    const jobId = await createJobViaRoute(makeBrief({ variationCount: 6 }), {
      userId: "u1",
      plan: "Pro",
    });
    expect(await creditManager.getBalance("u1")).toBe(0);

    await worker.runJob(jobId);

    const status = await (
      await GET(makeGetRequest("u1"), { params: { jobId } })
    ).json();
    expect(status.state).toBe("failed");
    expect(status.failedStep).toBe(6);
    expect(status.message).toContain("Render & Compose");
    // All reserved credits refunded (Req 2.10).
    expect(await creditManager.getBalance("u1")).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 3. Auth smoke test (keamanan endpoint)
// ---------------------------------------------------------------------------

describe("auth smoke test: protected endpoints reject unauthenticated & cross-user access", () => {
  it("POST /api/generate rejects with 401 when no authenticated user is present", async () => {
    wireWorker({ u1: 10 });
    const res = await POST(makePostRequest(makeBrief()));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("unauthorized");
  });

  it("GET /api/jobs/[jobId] rejects with 401 when no authenticated user is present", async () => {
    const { worker } = wireWorker({ u1: 10 });
    const job = await worker.createJob(makeBrief(), 3, "u1");
    const res = await GET(makeGetRequest(undefined), { params: { jobId: job.id } });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("unauthorized");
  });

  it("GET /api/jobs/[jobId] denies cross-user access without leaking existence (404)", async () => {
    wireWorker({ owner: 10 });
    // Owner creates a job via the generate route...
    const ownerJobId = await createJobViaRoute(makeBrief(), {
      userId: "owner",
      plan: "Pro",
    });

    // ...and a different authenticated user cannot read it.
    const res = await GET(makeGetRequest("intruder"), {
      params: { jobId: ownerJobId },
    });
    // 404 (not 403) — the existence of another user's job is never revealed.
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("not_found");

    // The legitimate owner still sees their own job.
    const ownerRes = await GET(makeGetRequest("owner"), {
      params: { jobId: ownerJobId },
    });
    expect(ownerRes.status).toBe(200);
  });
});
