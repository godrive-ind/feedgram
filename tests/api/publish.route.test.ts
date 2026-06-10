import { afterEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/publish/[id]/route";
import { USER_ID_HEADER } from "@/lib/auth";
import { composeVariation } from "@/lib/canvas/renderer";
import {
  InMemoryPublishAdapter,
  MAX_PUBLISH_ATTEMPTS,
  publishVariation,
  resetPublishAdapter,
  setPublishAdapter,
} from "@/lib/publish/publish-adapter";
import {
  buildLayout,
  deriveBrandDna,
  deriveDesignSystem,
} from "@/lib/pipeline/steps";
import {
  InMemoryVariationStore,
  resetVariationStore,
  setVariationStore,
  type OwnedVariation,
} from "@/lib/server/variation-store";
import type {
  DesignBriefInput,
  DesignVariation,
  PublishChannel,
} from "@/lib/types";

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

/** Build an internally-consistent variation from a brief. */
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

/** Install a variation store seeded with the given owned variations. */
function installStore(seed: OwnedVariation[]): void {
  setVariationStore(new InMemoryVariationStore(seed));
}

/** Build a Request with the trusted user header and a JSON body. */
function makeRequest(userId: string | undefined, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (userId !== undefined) headers.set(USER_ID_HEADER, userId);
  return new Request("https://example.invalid/api/publish/v1", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  resetVariationStore();
  resetPublishAdapter();
});

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

describe("POST /api/publish/[id]", () => {
  it("returns 401 when the trusted user header is absent", async () => {
    setPublishAdapter(new InMemoryPublishAdapter());
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest(undefined, { channel: "instagram" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("returns 400 for an invalid/missing channel", async () => {
    setPublishAdapter(new InMemoryPublishAdapter());
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { channel: "tiktok" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_channel");
  });

  it("returns 400 for a malformed JSON body", async () => {
    setPublishAdapter(new InMemoryPublishAdapter());
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const headers = new Headers({ "content-type": "application/json" });
    headers.set(USER_ID_HEADER, "owner");
    const req = new Request("https://example.invalid/api/publish/v1", {
      method: "POST",
      headers,
      body: "{ not json",
    });
    const res = await POST(req, { params: { id: "v1" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  it("returns 404 for an unknown variation id", async () => {
    setPublishAdapter(new InMemoryPublishAdapter());
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { channel: "facebook" }), {
      params: { id: "missing" },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("returns 404 for a variation owned by another user (no existence leak)", async () => {
    setPublishAdapter(new InMemoryPublishAdapter());
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest("intruder", { channel: "linkedin" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(404);
  });

  it("publishes to the chosen channel for the owner (200) and preserves the variation", async () => {
    const adapter = new InMemoryPublishAdapter({ behavior: "succeed" });
    setPublishAdapter(adapter);
    const source = makeVariation("v1");
    installStore([{ variation: source, ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { channel: "instagram" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.result.success).toBe(true);
    expect(body.result.channel).toBe("instagram");
    expect(body.result.attempts).toBe(1);
    // Delivered to the correct channel.
    expect(adapter.published).toHaveLength(1);
    expect(adapter.published[0]).toMatchObject({
      variationId: "v1",
      channel: "instagram",
    });
    // Variation preserved unchanged and still re-publishable (Req 6.5).
    expect(body.variation.id).toBe(source.id);
    expect(body.variation.brandDna).toEqual(source.brandDna);
  });

  it("retries up to 3 times then succeeds (Req 6.7)", async () => {
    const adapter = new InMemoryPublishAdapter({
      behavior: "fail-then-succeed",
      failuresBeforeSuccess: 2,
    });
    setPublishAdapter(adapter);
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { channel: "facebook" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.result.success).toBe(true);
    expect(body.result.attempts).toBe(3);
    expect(adapter.calls).toBe(3);
  });

  it("preserves the variation and reports the cause on failure after retries (502)", async () => {
    const adapter = new InMemoryPublishAdapter({
      behavior: "fail",
      failureMessage: "kanal menolak: token kedaluwarsa",
    });
    setPublishAdapter(adapter);
    const source = makeVariation("v1");
    installStore([{ variation: source, ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { channel: "linkedin" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error).toBe("publish_failed");
    expect(body.channel).toBe("linkedin");
    // Never exceeds 3 attempts (Req 6.7).
    expect(body.attempts).toBe(MAX_PUBLISH_ATTEMPTS);
    expect(adapter.calls).toBe(MAX_PUBLISH_ATTEMPTS);
    expect(body.message).toContain("token kedaluwarsa");
    // Variation preserved unchanged (Req 6.6).
    expect(body.variation.id).toBe(source.id);
    expect(body.variation.brandDna).toEqual(source.brandDna);
    // Nothing recorded as published.
    expect(adapter.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator unit tests (publishVariation)
// ---------------------------------------------------------------------------

describe("publishVariation", () => {
  const channels: PublishChannel[] = ["instagram", "facebook", "linkedin"];

  it("never attempts more than the max on persistent failure (Req 6.7)", async () => {
    for (const channel of channels) {
      const adapter = new InMemoryPublishAdapter({ behavior: "fail" });
      const result = await publishVariation(makeVariation("v1"), channel, {
        adapter,
      });
      expect(result.success).toBe(false);
      expect(result.channel).toBe(channel);
      expect(result.attempts).toBe(MAX_PUBLISH_ATTEMPTS);
      expect(adapter.calls).toBe(MAX_PUBLISH_ATTEMPTS);
      expect(typeof result.message).toBe("string");
    }
  });

  it("treats a thrown adapter error as a failed attempt and still bounds retries", async () => {
    const adapter = new InMemoryPublishAdapter({
      behavior: "fail",
      throwOnFail: new Error("network error"),
    });
    const result = await publishVariation(makeVariation("v1"), "instagram", {
      adapter,
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(MAX_PUBLISH_ATTEMPTS);
    expect(adapter.calls).toBe(MAX_PUBLISH_ATTEMPTS);
    expect(result.message).toContain("network error");
  });

  it("succeeds on the first attempt without extra calls", async () => {
    const adapter = new InMemoryPublishAdapter({ behavior: "succeed" });
    const result = await publishVariation(makeVariation("v1"), "linkedin", {
      adapter,
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(adapter.calls).toBe(1);
  });
});
