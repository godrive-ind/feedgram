import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/generate/route";
import {
  resetContainer,
  setPipelineWorker,
} from "@/lib/server/container";
import { createInMemoryPipelineWorker } from "@/lib/pipeline/worker";
import {
  MockAIServiceConnector,
  createControllableScheduler,
} from "@/lib/ai/connector";
import { USER_ID_HEADER, USER_PLAN_HEADER } from "@/lib/auth";
import type { DesignBriefInput } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
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

/** Build a worker with a fast mock connector and seed credits for a user. */
function wireWorker(initialCredits: Record<string, number>) {
  const { worker, jobStore, creditManager } = createInMemoryPipelineWorker({
    connector: new MockAIServiceConnector({
      defaults: { scheduler: createControllableScheduler() },
    }),
    initialCredits,
  });
  setPipelineWorker(worker);
  return { worker, jobStore, creditManager };
}

/** Construct a request with optional auth headers and a JSON body. */
function makeRequest(
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

afterEach(() => {
  resetContainer();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/generate", () => {
  it("rejects with 401 when no authenticated user header is present", async () => {
    wireWorker({ u1: 10 });
    const res = await POST(makeRequest(makeBrief()));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("unauthorized");
  });

  it("returns 400 with errors + preservedValues for an invalid brief (Req 1.3)", async () => {
    wireWorker({ u1: 10 });
    const brief = makeBrief({ brandName: "   " }); // whitespace-only → invalid
    const res = await POST(makeRequest(brief, { userId: "u1", plan: "Pro" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_brief");
    expect(json.errors.some((e: { field: string }) => e.field === "brandName")).toBe(
      true,
    );
    // Preserved values echo the input unchanged (Req 1.3).
    expect(json.preservedValues.brandName).toBe("   ");
    expect(json.preservedValues.tagline).toBe(brief.tagline);
  });

  it("returns 202 with a jobId and reserves 1 credit per variation (Req 8.2)", async () => {
    const { creditManager, jobStore } = wireWorker({ u1: 10 });
    const res = await POST(
      makeRequest(makeBrief({ variationCount: 3 }), { userId: "u1", plan: "Pro" }),
    );
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(typeof json.jobId).toBe("string");

    // The job exists and belongs to the user.
    const job = await jobStore.getJob(json.jobId);
    expect(job?.userId).toBe("u1");

    // 3 credits were held out of 10 (available balance reduced).
    expect(await creditManager.getBalance("u1")).toBe(7);
  });

  it("returns 402 with upgrade prompt and no deduction when credit is insufficient (Req 8.3)", async () => {
    const { creditManager } = wireWorker({ u1: 2 });
    const res = await POST(
      makeRequest(makeBrief({ variationCount: 3 }), { userId: "u1", plan: "Pro" }),
    );
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error).toBe("insufficient_credit");
    expect(json.upgradePrompt).toBe(true);
    // Balance unchanged (Req 8.3).
    expect(await creditManager.getBalance("u1")).toBe(2);
  });

  it("returns 403 with upgrade prompt for 9 variations on a Free plan (Req 8.4)", async () => {
    const { creditManager } = wireWorker({ u1: 100 });
    const res = await POST(
      makeRequest(makeBrief({ variationCount: 9 }), { userId: "u1", plan: "Free" }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("plan_restriction");
    expect(json.upgradePrompt).toBe(true);
    // No credit reserved on a plan rejection.
    expect(await creditManager.getBalance("u1")).toBe(100);
  });

  it("returns 400 for a malformed variation count", async () => {
    wireWorker({ u1: 100 });
    const res = await POST(
      makeRequest(makeBrief({ variationCount: 5 as never }), {
        userId: "u1",
        plan: "Pro",
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_variation_count");
  });
});
