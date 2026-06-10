import { describe, expect, it } from "vitest";

import {
  MockAIServiceConnector,
  type RegenerableResult,
} from "@/lib/ai/connector";
import type {
  CopyContent,
  CopyRequest,
  ImageAsset,
  ImageRequest,
  UploadedFile,
  BrandDNA,
  DesignBriefInput,
  ImagePrompt,
  OutputFormat,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Integration tests for AI_Service_Connector with mocked adapters.
//
// Verifies:
//  - generateCopy / generateImage / removeBackground call their adapters with
//    the correct arguments and surface the adapter response (Req 3.1, 3.2, 3.4).
//  - compose/render handing-off is exercised via the rendered ImageAsset
//    flowing back through the connector (Req 3.3 — connector responsibility).
//  - fail-then-succeed recovers within the attempt budget (Req 3.5/3.6 budget).
//  - *WithRegenerate methods return a RegenerableResult whose regenerate()
//    re-invokes the underlying call (manual regeneration after success, Req 3.7).
// ---------------------------------------------------------------------------

const brief: DesignBriefInput = {
  brandName: "Acme",
  contentGoal: "Promosi",
  visualStyle: "VibrantCleanModern",
  tone: "Energik",
  outputFormat: { name: "InstagramFeed", width: 1080, height: 1350 },
  variationCount: 6,
  accentPalette: ["#ff0066", "#00d4ff"],
  mandatoryElements: ["CTAButton"],
  uploadedAssets: [],
};
const brandDna: BrandDNA = {
  brandName: "Acme",
  accentPalette: ["#ff0066", "#00d4ff"],
  tone: "Energik",
  visualStyle: "VibrantCleanModern",
};
const copyReq: CopyRequest = {
  brief,
  brandDna,
  contentGoal: "Promosi",
  tone: "Energik",
};
const imagePrompt: ImagePrompt = { prompt: "vibrant promo banner" };
const outputFormat: OutputFormat = {
  name: "InstagramFeed",
  width: 1080,
  height: 1350,
};
const imageReq: ImageRequest = { imagePrompt, format: outputFormat };
const upload: UploadedFile = {
  name: "logo.png",
  mimeType: "image/png",
  sizeBytes: 4096,
  triggerBackgroundRemoval: true,
};

const copyResult: CopyContent = {
  headline: "Big Sale",
  subHeadline: "Up to 50% off",
  cta: "Shop Now",
  alignedGoal: "Promosi",
  alignedTone: "Energik",
};
const imageResult: ImageAsset = {
  id: "img-1",
  url: "https://example.invalid/generated.png",
  width: 1080,
  height: 1350,
};
const bgResult: ImageAsset = {
  id: "img-nobg",
  url: "https://example.invalid/nobg.png",
  width: 512,
  height: 512,
};

describe("AIServiceConnector integration (mocked adapters)", () => {
  describe("adapter invocation with correct arguments & responses", () => {
    it("generateCopy calls the LLM adapter with the request and returns its response (Req 3.1)", async () => {
      const connector = new MockAIServiceConnector({
        copy: { behavior: "succeed", result: copyResult },
      });

      const out = await connector.generateCopy(copyReq);

      expect(connector.copyAdapter.calls).toBe(1);
      expect(connector.copyAdapter.lastArgs).toEqual([copyReq]);
      expect(out).toEqual(copyResult);
    });

    it("generateImage calls the image-gen adapter with the request and returns its response (Req 3.2, 3.3)", async () => {
      const connector = new MockAIServiceConnector({
        image: { behavior: "succeed", result: imageResult },
      });

      const out = await connector.generateImage(imageReq);

      expect(connector.imageAdapter.calls).toBe(1);
      expect(connector.imageAdapter.lastArgs).toEqual([imageReq]);
      expect(out).toEqual(imageResult);
    });

    it("removeBackground calls the background-removal adapter with the asset and returns its response (Req 3.4)", async () => {
      const connector = new MockAIServiceConnector({
        background: { behavior: "succeed", result: bgResult },
      });

      const out = await connector.removeBackground(upload);

      expect(connector.backgroundAdapter.calls).toBe(1);
      expect(connector.backgroundAdapter.lastArgs).toEqual([upload]);
      expect(out).toEqual(bgResult);
    });

    it("uses a result factory so the adapter can echo its request arguments", async () => {
      const connector = new MockAIServiceConnector({
        copy: {
          behavior: "succeed",
          resultFactory: (req) => ({
            ...copyResult,
            headline: (req as CopyRequest).brief.brandName,
          }),
        },
      });

      const out = await connector.generateCopy(copyReq);
      expect(out.headline).toBe("Acme");
    });
  });

  describe("fail-then-succeed recovery within the attempt budget (Req 3.5, 3.6)", () => {
    it("recovers after 2 leading failures within the default 3-attempt budget", async () => {
      const connector = new MockAIServiceConnector({
        copy: {
          behavior: "fail-then-succeed",
          failuresBeforeSuccess: 2,
          result: copyResult,
        },
        // backoff defaults to 0, so no real waiting occurs.
      });

      const out = await connector.generateCopy(copyReq);

      // 2 failures + 1 success == 3 attempts, exactly the default budget.
      expect(connector.copyAdapter.calls).toBe(3);
      expect(out).toEqual(copyResult);
    });

    it("recovers for image generation after a single transient failure", async () => {
      const connector = new MockAIServiceConnector({
        image: {
          behavior: "fail-then-succeed",
          failuresBeforeSuccess: 1,
          result: imageResult,
        },
      });

      const out = await connector.generateImage(imageReq);
      expect(connector.imageAdapter.calls).toBe(2);
      expect(out).toEqual(imageResult);
    });
  });

  describe("manual regeneration after success (Req 3.7)", () => {
    it("generateCopyWithRegenerate returns a result whose regenerate() re-invokes the call", async () => {
      const connector = new MockAIServiceConnector({
        copy: { behavior: "succeed", result: copyResult },
      });

      const first: RegenerableResult<CopyContent> =
        await connector.generateCopyWithRegenerate(copyReq);

      expect(first.output).toEqual(copyResult);
      expect(connector.copyAdapter.calls).toBe(1);
      expect(typeof first.regenerate).toBe("function");

      const second = await first.regenerate();
      // Regenerating re-invokes the underlying adapter call.
      expect(connector.copyAdapter.calls).toBe(2);
      expect(second.output).toEqual(copyResult);
      // ...and yields another regenerable result.
      expect(typeof second.regenerate).toBe("function");

      await second.regenerate();
      expect(connector.copyAdapter.calls).toBe(3);
    });

    it("generateImageWithRegenerate re-invokes the image adapter on regenerate()", async () => {
      const connector = new MockAIServiceConnector({
        image: { behavior: "succeed", result: imageResult },
      });

      const first = await connector.generateImageWithRegenerate(imageReq);
      expect(first.output).toEqual(imageResult);
      expect(connector.imageAdapter.calls).toBe(1);

      await first.regenerate();
      expect(connector.imageAdapter.calls).toBe(2);
    });

    it("removeBackgroundWithRegenerate re-invokes the background adapter on regenerate()", async () => {
      const connector = new MockAIServiceConnector({
        background: { behavior: "succeed", result: bgResult },
      });

      const first = await connector.removeBackgroundWithRegenerate(upload);
      expect(first.output).toEqual(bgResult);
      expect(connector.backgroundAdapter.calls).toBe(1);

      await first.regenerate();
      expect(connector.backgroundAdapter.calls).toBe(2);
    });
  });
});
