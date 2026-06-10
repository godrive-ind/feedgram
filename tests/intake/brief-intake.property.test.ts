import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { validateBrief, BRIEF_FIELD_LIMITS } from "@/lib/intake/brief-intake";
import {
  CONTENT_GOALS,
  VISUAL_STYLES,
  TONES,
  OUTPUT_FORMATS,
  VARIATION_COUNTS,
  MANDATORY_ELEMENTS,
  type DesignBriefInput,
  type OutputFormat,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const contentGoalArb = fc.constantFrom(...CONTENT_GOALS);
const visualStyleArb = fc.constantFrom(...VISUAL_STYLES);
const toneArb = fc.constantFrom(...TONES);
const outputFormatArb = fc.constantFrom(
  ...(OUTPUT_FORMATS as readonly OutputFormat[])
);
const variationCountArb = fc.constantFrom(...VARIATION_COUNTS);
const mandatoryElementsArb = fc.uniqueArray(
  fc.constantFrom(...MANDATORY_ELEMENTS)
);
const accentPaletteArb = fc.array(
  fc.hexaString({ minLength: 6, maxLength: 6 }).map((h) => `#${h}`),
  { maxLength: 5 }
);

/**
 * Build a base brief with all non-text fields valid, so individual properties
 * can override only the text fields under test.
 */
function briefArb(
  brandName: fc.Arbitrary<string>,
  tagline: fc.Arbitrary<string | undefined>,
  mainMessage: fc.Arbitrary<string | undefined>
): fc.Arbitrary<DesignBriefInput> {
  return fc.record({
    brandName,
    tagline,
    mainMessage,
    contentGoal: contentGoalArb,
    visualStyle: visualStyleArb,
    tone: toneArb,
    outputFormat: outputFormatArb,
    variationCount: variationCountArb,
    accentPalette: accentPaletteArb,
    mandatoryElements: mandatoryElementsArb,
    uploadedAssets: fc.constant([]),
  }) as fc.Arbitrary<DesignBriefInput>;
}

/** Whitespace-only / empty strings: edge case for the required-field rule. */
const whitespaceOnlyArb = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v", "\u00a0"), {
    minLength: 0,
    maxLength: 12,
  })
  .map((parts) => parts.join(""));

describe("Brief_Intake validateBrief — properties", () => {
  // Feature: feed-design-generator, Property 1: Validasi nama brand wajib
  it("Property 1: rejects empty/whitespace-only brandName and preserves all field values unchanged", () => {
    fc.assert(
      fc.property(
        briefArb(
          whitespaceOnlyArb,
          fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
          fc.option(fc.string({ maxLength: 500 }), { nil: undefined })
        ),
        (brief) => {
          const result = validateBrief(brief);

          // Validation must reject the request.
          expect(result.valid).toBe(false);
          // A brandName error must be reported.
          expect(result.errors.some((e) => e.field === "brandName")).toBe(true);
          // preservedValues must equal the input exactly (reference identity +
          // deep equality of every field).
          expect(result.preservedValues).toBe(brief);
          expect(result.preservedValues).toEqual(brief);
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Batas karakter field teks (Req 1.13)
// ---------------------------------------------------------------------------

/**
 * A non-whitespace string of an exact length, including boundary lengths.
 * Built from a single visible character so `.length` is deterministic and the
 * brandName required-field rule never trips for non-empty values.
 */
function fixedLengthString(len: number): string {
  return "a".repeat(len);
}

/**
 * Arbitrary that biases toward boundary lengths around `limit`
 * (limit-1, limit, limit+1) while also exploring a wider range.
 */
function lengthAroundArb(limit: number): fc.Arbitrary<number> {
  return fc.oneof(
    fc.constantFrom(0, 1, limit - 1, limit, limit + 1, limit + 50),
    fc.integer({ min: 1, max: limit * 2 })
  );
}

describe("Brief_Intake validateBrief — character limits (Property 2)", () => {
  // Feature: feed-design-generator, Property 2: Batas karakter field teks
  it("Property 2: brandName>50, tagline>100, mainMessage>500 rejected; within-limit accepted", () => {
    fc.assert(
      fc.property(
        lengthAroundArb(BRIEF_FIELD_LIMITS.brandName),
        lengthAroundArb(BRIEF_FIELD_LIMITS.tagline),
        lengthAroundArb(BRIEF_FIELD_LIMITS.mainMessage),
        contentGoalArb,
        visualStyleArb,
        toneArb,
        outputFormatArb,
        variationCountArb,
        (
          brandLen,
          taglineLen,
          mainLen,
          contentGoal,
          visualStyle,
          tone,
          outputFormat,
          variationCount
        ) => {
          // brandName must be non-empty to isolate the length rule from the
          // required-field rule; use at least length 1.
          const effectiveBrandLen = Math.max(1, brandLen);
          const brief: DesignBriefInput = {
            brandName: fixedLengthString(effectiveBrandLen),
            tagline: fixedLengthString(taglineLen),
            mainMessage: fixedLengthString(mainLen),
            contentGoal,
            visualStyle,
            tone,
            outputFormat,
            variationCount,
            accentPalette: [],
            mandatoryElements: [],
            uploadedAssets: [],
          };

          const result = validateBrief(brief);

          const brandErr = result.errors.some((e) => e.field === "brandName");
          const taglineErr = result.errors.some((e) => e.field === "tagline");
          const mainErr = result.errors.some((e) => e.field === "mainMessage");

          // brandName rejected iff > 50.
          expect(brandErr).toBe(
            effectiveBrandLen > BRIEF_FIELD_LIMITS.brandName
          );
          // tagline rejected iff > 100.
          expect(taglineErr).toBe(taglineLen > BRIEF_FIELD_LIMITS.tagline);
          // mainMessage rejected iff > 500.
          expect(mainErr).toBe(mainLen > BRIEF_FIELD_LIMITS.mainMessage);

          // Overall validity reflects the union of the three rules.
          const anyOver =
            effectiveBrandLen > BRIEF_FIELD_LIMITS.brandName ||
            taglineLen > BRIEF_FIELD_LIMITS.tagline ||
            mainLen > BRIEF_FIELD_LIMITS.mainMessage;
          expect(result.valid).toBe(!anyOver);
        }
      ),
      { numRuns: 200 }
    );
  });
});
