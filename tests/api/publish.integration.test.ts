import { afterEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/publish/[id]/route";
import { USER_ID_HEADER } from "@/lib/auth";
import { composeVariation } from "@/lib/canvas/renderer";
import {
  MAX_PUBLISH_ATTEMPTS,
  resetPublishAdapter,
  setPublishAdapter,
  type PublishAdapter,
  type PublishDelivery,
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
import {
  PUBLISH_CHANNELS,
  type DesignBriefInput,
  type DesignVariation,
  type PublishChannel,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Task 12.9 — Integration test: publish to channel with a MOCKED adapter.
//
// Exercises the full `POST /api/publish/[id]` route wired to a mock
// PublishAdapter (the external channel boundary). Verifies:
//   - the variation is dispatched to the CORRECT channel (Req 6.4), and
//   - failure handling: persistent failure surfaces the cause and bounds
//     retries; a transient failure recovers within the retry budget.
// The mock adapter records every (variationId, channel, attempt) so we can
// assert exactly what the route asked the external channel to do.
// ---------------------------------------------------------------------------

interface DeliverCall {
  variationId: string;
  channel: PublishChannel;
}

/**
 * A recording mock {@link PublishAdapter} (the external-channel boundary).
 * Configurable to succeed, always fail (with a cause), or fail a number of
 * times before succeeding — enough to drive channel-dispatch + failure-handling
 * assertions through the real route.
 */
class MockChannelAdapter implements PublishAdapter {
  readonly calls: DeliverCall[] = [];

  constructor(
    private readonly opts: {
      mode: "succeed" | "fail" | "fail-then-succeed";
      failuresBeforeSuccess?: number;
      cause?: string;
    },
  ) {}

  async deliver(
    variation: DesignVariation,
    channel: PublishChannel,
  ): Promise<PublishDelivery> {
    this.calls.push({ variationId: variation.id, channel });
    const cause = this.opts.cause ?? "kanal menolak permintaan";

    switch (this.opts.mode) {
      case "succeed":
        return { ok: true, reference: `${channel}:${variation.id}` };
      case "fail":
        return { ok: false, message: cause };
      case "fail-then-succeed": {
        const threshold = this.opts.failuresBeforeSuccess ?? 1;
        return this.calls.length <= threshold
          ? { ok: false, message: cause }
          : { ok: true, reference: `${channel}:${variation.id}` };
      }
    }
  }
}

function makeBrief(): DesignBriefInput {
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
  };
}

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

function installStore(seed: OwnedVariation[]): void {
  setVariationStore(new InMemoryVariationStore(seed));
}

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

describe("Integration: POST /api/publish/[id] with a mocked channel adapter", () => {
  // --- Correct channel dispatch (Req 6.4) ----------------------------------

  it.each(PUBLISH_CHANNELS)(
    "dispatches the variation to the chosen channel %s",
    async (channel) => {
      const adapter = new MockChannelAdapter({ mode: "succeed" });
      setPublishAdapter(adapter);
      installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

      const res = await POST(makeRequest("owner", { channel }), {
        params: { id: "v1" },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.result.success).toBe(true);
      expect(body.result.channel).toBe(channel);
      expect(body.result.attempts).toBe(1);

      // The adapter was asked to deliver to EXACTLY that channel, once.
      expect(adapter.calls).toEqual([{ variationId: "v1", channel }]);
    },
  );

  it("does not dispatch to any other channel than the one requested", async () => {
    const adapter = new MockChannelAdapter({ mode: "succeed" });
    setPublishAdapter(adapter);
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    await POST(makeRequest("owner", { channel: "facebook" }), {
      params: { id: "v1" },
    });

    expect(adapter.calls.every((c) => c.channel === "facebook")).toBe(true);
    expect(adapter.calls.some((c) => c.channel === "instagram")).toBe(false);
    expect(adapter.calls.some((c) => c.channel === "linkedin")).toBe(false);
  });

  // --- Failure handling (Req 6.6 / 6.7) ------------------------------------

  it("surfaces the cause and bounds retries to the max on persistent failure", async () => {
    const adapter = new MockChannelAdapter({
      mode: "fail",
      cause: "token kanal kedaluwarsa",
    });
    setPublishAdapter(adapter);
    const source = makeVariation("v1");
    installStore([{ variation: source, ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { channel: "instagram" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error).toBe("publish_failed");
    expect(body.channel).toBe("instagram");
    expect(body.attempts).toBe(MAX_PUBLISH_ATTEMPTS);
    expect(body.message).toContain("token kanal kedaluwarsa");

    // Exactly MAX_PUBLISH_ATTEMPTS deliveries, all to the requested channel.
    expect(adapter.calls).toHaveLength(MAX_PUBLISH_ATTEMPTS);
    expect(adapter.calls.every((c) => c.channel === "instagram")).toBe(true);

    // Variation preserved unchanged and still re-publishable (Req 6.6).
    expect(body.variation.id).toBe(source.id);
    expect(body.variation.brandDna).toEqual(source.brandDna);
  });

  it("recovers within the retry budget after transient channel failures", async () => {
    const adapter = new MockChannelAdapter({
      mode: "fail-then-succeed",
      failuresBeforeSuccess: 2,
    });
    setPublishAdapter(adapter);
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { channel: "linkedin" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.result.success).toBe(true);
    expect(body.result.attempts).toBe(3);
    expect(adapter.calls).toHaveLength(3);
    expect(adapter.calls.every((c) => c.channel === "linkedin")).toBe(true);
  });

  it("treats a thrown adapter error as a failed attempt and still bounds retries", async () => {
    // An adapter that throws (a hard transport error) on every attempt.
    const throwing: PublishAdapter & { calls: DeliverCall[] } = {
      calls: [],
      async deliver(variation, channel) {
        this.calls.push({ variationId: variation.id, channel });
        throw new Error("ECONNRESET");
      },
    };
    setPublishAdapter(throwing);
    installStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { channel: "facebook" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error).toBe("publish_failed");
    expect(body.attempts).toBe(MAX_PUBLISH_ATTEMPTS);
    expect(body.message).toContain("ECONNRESET");
    expect(throwing.calls).toHaveLength(MAX_PUBLISH_ATTEMPTS);
  });
});
