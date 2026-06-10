import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/generate/route";
import { GET } from "@/app/api/jobs/[jobId]/route";
import { resetContainer, setPipelineWorker } from "@/lib/server/container";
import { getPipelineWorker as getProviderWorker } from "@/lib/server/worker-provider";
import { getPipelineWorker as getContainerWorker } from "@/lib/server/container";
import { createInMemoryPipelineWorker } from "@/lib/pipeline/worker";
import {
  MockAIServiceConnector,
  createControllableScheduler,
} from "@/lib/ai/connector";
import { USER_ID_HEADER, USER_PLAN_HEADER } from "@/lib/auth";
import type { DesignBriefInput } from "@/lib/types";

// ---------------------------------------------------------------------------
// This test proves the wiring fix for the duplicate-singleton bug: a job
// created via POST /api/generate (which resolves the worker from
// `lib/server/container`) MUST be pollable via GET /api/jobs/[jobId] (which
// resolves the worker from `lib/server/worker-provider`). After consolidating
// the provider to delegate to the container, both routes share ONE worker.
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

afterEach(() => {
  resetContainer();
});

describe("generate → jobs share one worker singleton", () => {
  it("the provider and the container resolve the SAME worker instance", () => {
    const { worker } = createInMemoryPipelineWorker({
      connector: new MockAIServiceConnector({
        defaults: { scheduler: createControllableScheduler() },
      }),
      initialCredits: { u1: 10 },
    });
    setPipelineWorker(worker);

    expect(getProviderWorker()).toBe(worker);
    expect(getContainerWorker()).toBe(worker);
    expect(getProviderWorker()).toBe(getContainerWorker());
  });

  it("a job created by POST /api/generate is pollable via GET /api/jobs/[jobId]", async () => {
    const { worker } = createInMemoryPipelineWorker({
      connector: new MockAIServiceConnector({
        defaults: { scheduler: createControllableScheduler() },
      }),
      initialCredits: { u1: 10 },
    });
    setPipelineWorker(worker);

    // Create the job via the generate route (resolves worker from container).
    const postRes = await POST(
      makePostRequest(makeBrief({ variationCount: 3 }), {
        userId: "u1",
        plan: "Pro",
      }),
    );
    expect(postRes.status).toBe(202);
    const { jobId } = await postRes.json();
    expect(typeof jobId).toBe("string");

    // Poll the job via the jobs route (resolves worker from worker-provider).
    // Before the fix this returned 404 because it hit a different singleton.
    const getRes = await GET(makeGetRequest("u1"), { params: { jobId } });
    // 200 (not 404) is the crux: the jobs route resolves the SAME worker the
    // generate route created the job in. A non-owned/unknown job yields 404.
    expect(getRes.status).toBe(200);
    const status = await getRes.json();
    expect(status.jobId).toBe(jobId);
    // The background pipeline may already be running/done by now (fast mock
    // connector), so accept any non-failed lifecycle state — the point is that
    // the job is VISIBLE across both routes.
    expect(["queued", "running", "done"]).toContain(status.state);
    expect(typeof status.currentStep).toBe("number");
  });
});
