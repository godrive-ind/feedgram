import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  regenerateVariation,
  fineTuneVariation,
  type DeriveResult,
} from "@/lib/pipeline/derive";
import { composeVariation } from "@/lib/canvas/renderer";
import {
  deriveBrandDna,
  deriveDesignSystem,
  buildLayout,
} from "@/lib/pipeline/steps";
import {
  MockAIServiceConnector,
  createControllableScheduler,
  type AIServiceConnector,
} from "@/lib/ai/connector";
import {
  CONTENT_GOALS,
  VISUAL_STYLES,
  TONES,
  MANDATORY_ELEMENTS,
  OUTPUT_FORMATS,
  VARIATION_COUNTS,
  type DesignBriefInput,
  type DesignVariation,
  type ImageAsset,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary hex color string for the accent palette. */
const hexColorArb = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, "0")}`);

/** Arbitrary valid `DesignBriefInput` constrained to the real input space. */
const validBriefArb: fc.Arbitrary<DesignBriefInput> = fc.record({
  brandName: fc
    .string({ minLength: 1, maxLength: 50 })
    .filter((s) => s.trim().length > 0),
  tagline: fc.string({ maxLength: 100 }),
  mainMessage: fc.string({ maxLength: 500 }),
  contentGoal: fc.constantFrom(...CONTENT_GOALS),
  visualStyle: fc.constantFrom(...VISUAL_STYLES),
  tone: fc.constantFrom(...TONES),
  outputFormat: fc.constantFrom(...OUTPUT_FORMATS),
  variationCount: fc.constantFrom(...VARIATION_COUNTS),
  accentPalette: fc.array(hexColorArb, { minLength: 1, maxLength: 5 }),
  mandatoryElements: fc.uniqueArray(fc.constantFrom(...MANDATORY_ELEMENTS), {
    maxLength: MANDATORY_ELEMENTS.length,
  }),
  uploadedAssets: fc.constant([]),
}) as fc.Arbitrary<DesignBriefInput>;

/** Arbitrary image asset used to seed the source variation. */
const imageAssetArb: fc.Arbitrary<ImageAsset> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  url: fc.webUrl(),
  width: fc.integer({ min: 256, max: 2048 }),
  height: fc.integer({ min: 256, max: 2048 }),
}) as fc.Arbitrary<ImageAsset>;

/**
 * Arbitrary SOURCE `DesignVariation`, built from a valid brief through the same
 * step transforms the pipeline uses so brand/design/copy/layout are internally
 * consistent (Brand DNA + Design System derived from the brief; layout from the
 * brief's format + mandatory elements). An optional rating is included.
 */
const sourceVariationArb: fc.Arbitrary<DesignVariation> = fc
  .record({
    brief: validBriefArb,
    imageAsset: imageAssetArb,
    batchId: fc.string({ minLength: 1, maxLength: 12 }),
    rating: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
  })
  .map(({ brief, imageAsset, batchId, rating }) => {
    const brandDna = deriveBrandDna(brief);
    const designSystem = deriveDesignSystem(brandDna);
    const layout = buildLayout(
      brief.outputFormat,
      brief.mandatoryElements,
      designSystem,
    );
    const copy = {
      headline: brief.brandName,
      cta: "Pelajari",
      alignedGoal: brief.contentGoal,
      alignedTone: brief.tone,
    };
    const variation = composeVariation({
      batchId,
      brandDna,
      designSystem,
      copy,
      layout,
      imageAsset,
    });
    return rating === undefined ? variation : { ...variation, rating };
  });

/** Arbitrary user feedback string for fine-tune. */
const feedbackArb = fc.string({ maxLength: 120 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mock connector whose image generation succeeds immediately. */
function makeSuccessConnector(): AIServiceConnector {
  return new MockAIServiceConnector({
    defaults: { scheduler: createControllableScheduler() },
  });
}

/** Mock connector whose image generation always fails (no real timers). */
function makeFailingConnector(): AIServiceConnector {
  return new MockAIServiceConnector({
    image: { behavior: "fail", error: new Error("boom") },
    // 1 attempt keeps the failing path fast and deterministic.
    defaults: { scheduler: createControllableScheduler(), maxAttempts: 1 },
  });
}

// ---------------------------------------------------------------------------
// Property 15: Operasi turunan variasi mempertahankan brand
// ---------------------------------------------------------------------------

describe("Derived variation operations — brand preservation", () => {
  // Feature: feed-design-generator, Property 15: Operasi turunan variasi mempertahankan brand
  // Validates: Requirements 4.6, 7.6
  it("regenerateVariation produces a variation whose BrandDNA and DesignSystem equal the source", async () => {
    await fc.assert(
      fc.asyncProperty(sourceVariationArb, async (source) => {
        const connector = makeSuccessConnector();
        const result: DeriveResult = await regenerateVariation(source, {
          connector,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.variation.brandDna).toEqual(source.brandDna);
          expect(result.variation.designSystem).toEqual(source.designSystem);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: feed-design-generator, Property 15: Operasi turunan variasi mempertahankan brand
  // Validates: Requirements 4.6, 7.6
  it("fineTuneVariation produces a variation whose BrandDNA and DesignSystem equal the source", async () => {
    await fc.assert(
      fc.asyncProperty(
        sourceVariationArb,
        feedbackArb,
        async (source, feedback) => {
          const connector = makeSuccessConnector();
          const result: DeriveResult = await fineTuneVariation(
            source,
            feedback,
            { connector },
          );

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.variation.brandDna).toEqual(source.brandDna);
            expect(result.variation.designSystem).toEqual(source.designSystem);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 16: Kegagalan operasi turunan mempertahankan variasi asal
// ---------------------------------------------------------------------------

describe("Derived variation operations — source preserved on failure", () => {
  // Feature: feed-design-generator, Property 16: Kegagalan operasi turunan mempertahankan variasi asal
  // Validates: Requirements 4.7, 7.9
  it("regenerateVariation failure returns the source unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(sourceVariationArb, async (source) => {
        const snapshot = structuredClone(source);
        const connector = makeFailingConnector();

        const result: DeriveResult = await regenerateVariation(source, {
          connector,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          // The unchanged source is carried back and is identical to before.
          expect(result.source).toEqual(snapshot);
          expect(result.message).toBeTruthy();
        }
        // The caller's object was never mutated (pure operation).
        expect(source).toEqual(snapshot);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: feed-design-generator, Property 16: Kegagalan operasi turunan mempertahankan variasi asal
  // Validates: Requirements 4.7, 7.9
  it("fineTuneVariation failure returns the source unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        sourceVariationArb,
        feedbackArb,
        async (source, feedback) => {
          const snapshot = structuredClone(source);
          const connector = makeFailingConnector();

          const result: DeriveResult = await fineTuneVariation(
            source,
            feedback,
            { connector },
          );

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.source).toEqual(snapshot);
            expect(result.message).toBeTruthy();
          }
          expect(source).toEqual(snapshot);
        },
      ),
      { numRuns: 100 },
    );
  });
});
