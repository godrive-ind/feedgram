import { afterEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/variations/[id]/route";
import { USER_ID_HEADER } from "@/lib/auth";
import { composeVariation } from "@/lib/canvas/renderer";
import {
  buildLayout,
  deriveBrandDna,
  deriveDesignSystem,
} from "@/lib/pipeline/steps";
import {
  createInMemoryPipelineWorker,
  type PipelineWorker,
} from "@/lib/pipeline/worker";
import { setPipelineWorker } from "@/lib/server/container";
import {
  InMemoryVariationStore,
  resetVariationStore,
  setVariationStore,
  type OwnedVariation,
} from "@/lib/server/variation-store";
import {
  MockAIServiceConnector,
  createControllableScheduler,
  type AIServiceConnector,
} from "@/lib/ai/connector";
import type { DesignBriefInput, DesignVariation } from "@/lib/types";

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

/** Build an internally-consistent source variation from a brief. */
function makeVariation(id: string, batchId = "batch-1"): DesignVariation {
  const brief = makeBrief();
  const brandDna = deriveBrandDna(brief);
  const designSystem = deriveDesignSystem(brandDna);
  const layout = buildLayout(
    brief.outputFormat,
    brief.mandatoryElements,
    designSystem,
  );
  return composeVariation(
    {
      batchId,
      brandDna,
      designSystem,
      copy: {
        headline: brief.brandName,
        cta: "Pelajari",
        alignedGoal: brief.contentGoal,
        alignedTone: brief.tone,
      },
      layout,
      imageAsset: {
        id: "src-img",
        url: "https://example.invalid/src.png",
        width: 1080,
        height: 1080,
      },
    },
    { id },
  );
}

/** Connector whose image generation succeeds immediately. */
function makeSuccessConnector(): AIServiceConnector {
  return new MockAIServiceConnector({
    defaults: { scheduler: createControllableScheduler() },
  });
}

/** Connector whose image generation always fails (instant, no real timers). */
function makeFailureConnector(): AIServiceConnector {
  return new MockAIServiceConnector({
    image: { behavior: "fail", error: new Error("vendor down") },
    defaults: { scheduler: createControllableScheduler(), maxAttempts: 1 },
  });
}

/** Install a worker (providing the AI connector) into the shared container. */
function installWorker(connector: AIServiceConnector): PipelineWorker {
  const { worker } = createInMemoryPipelineWorker({ connector });
  setPipelineWorker(worker);
  return worker;
}

/** Install a variation store seeded with the given owned variations. */
function installStore(seed: OwnedVariation[]): void {
  setVariationStore(new InMemoryVariationStore(seed));
}

/** Build a Request with the trusted user header and a JSON body. */
function makeRequest(userId: string | undefined, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (userId !== undefined) headers.set(USER_ID_HEADER, userId);
  return new Request("https://example.invalid/api/variations/v1", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  resetVariationStore();
  // Rebuild the container default worker next time it's accessed.
  setPipelineWorker(
    createInMemoryPipelineWorker({ connector: makeSuccessConnector() }).worker,
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/variations/[id]", () => {
  it("returns 401 when the trusted user header is absent", async () => {
    installWorker(makeSuccessConnector());
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest(undefined, { action: "regenerate" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("returns 400 for an invalid action", async () => {
    installWorker(makeSuccessConnector());
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { action: "bogus" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_action");
  });

  it("returns 400 for fine-tune without feedback", async () => {
    installWorker(makeSuccessConnector());
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { action: "fine-tune" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_feedback");
  });

  it("returns 404 for an unknown variation id", async () => {
    installWorker(makeSuccessConnector());
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { action: "regenerate" }), {
      params: { id: "does-not-exist" },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("returns 404 for a variation owned by another user (no existence leak)", async () => {
    installWorker(makeSuccessConnector());
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest("intruder", { action: "regenerate" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(404);
  });

  it("regenerates the variation for the owner (200, brand preserved)", async () => {
    installWorker(makeSuccessConnector());
    const source = makeVariation("v1");
    installStore([{ variation: source, ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { action: "regenerate" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.variation).toBeDefined();
    // New variation but brand/design carried over identically (Req 4.6).
    expect(body.variation.id).not.toBe(source.id);
    expect(body.variation.batchId).toBe(source.batchId);
    expect(body.variation.brandDna).toEqual(source.brandDna);
    expect(body.variation.designSystem).toEqual(source.designSystem);
  });

  it("fine-tunes the variation for the owner (200, brand preserved)", async () => {
    installWorker(makeSuccessConnector());
    const source = makeVariation("v1");
    installStore([{ variation: source, ownerUserId: "owner" }]);

    const res = await POST(
      makeRequest("owner", { action: "fine-tune", feedback: "more contrast" }),
      { params: { id: "v1" } },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.variation.brandDna).toEqual(source.brandDna);
    expect(body.variation.designSystem).toEqual(source.designSystem);
  });

  it("preserves the source variation on derive failure (502)", async () => {
    installWorker(makeFailureConnector());
    const source = makeVariation("v1");
    installStore([{ variation: source, ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { action: "regenerate" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error).toBe("derive_failed");
    expect(body.source).toBe("regenerate");
    // The original variation is returned unchanged (Req 4.7/7.9).
    expect(body.variation.id).toBe(source.id);
    expect(body.variation.brandDna).toEqual(source.brandDna);
    expect(typeof body.message).toBe("string");
  });
});
