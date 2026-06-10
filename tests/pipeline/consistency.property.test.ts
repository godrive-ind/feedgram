import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { verifyConsistency } from "@/lib/pipeline/consistency";
import {
  MANDATORY_ELEMENTS,
  OUTPUT_FORMATS,
  TONES,
  VISUAL_STYLES,
  type BrandDNA,
  type CanvasRef,
  type CopyContent,
  type DesignSystem,
  type DesignVariation,
  type GenerationBatch,
  type ImageAsset,
  type LayoutTemplate,
  type MandatoryElement,
  type OutputFormat,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Arbitraries — build a brand "shared" across every variation in a batch, then
// clone that brand identity into N variations. A consistent batch reuses the
// same BrandDNA / DesignSystem / accent palette / fonts / mandatory elements in
// every variation; Property 18 then mutates a single variation to deviate.
// ---------------------------------------------------------------------------

/** Arbitrary hex color string for the accent palette. */
const hexColorArb = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, "0")}`);

/** Arbitrary shared BrandDNA for a batch (identical across variations). */
const brandDnaArb: fc.Arbitrary<BrandDNA> = fc.record({
  brandName: fc
    .string({ minLength: 1, maxLength: 50 })
    .filter((s) => s.trim().length > 0),
  tagline: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
  accentPalette: fc.array(hexColorArb, { minLength: 1, maxLength: 5 }),
  tone: fc.constantFrom(...TONES),
  visualStyle: fc.constantFrom(...VISUAL_STYLES),
}) as fc.Arbitrary<BrandDNA>;

/** Arbitrary shared DesignSystem for a batch (fonts identical across variations). */
const designSystemArb: fc.Arbitrary<DesignSystem> = fc.record({
  headlineFont: fc.constantFrom("Inter", "Poppins", "Montserrat", "Lora"),
  bodyFont: fc.constantFrom("Inter", "Roboto", "OpenSans", "Merriweather"),
  typographyScale: fc.constant([12, 16, 20, 28, 40]),
  radius: fc.integer({ min: 0, max: 32 }),
  layoutDensity: fc.constantFrom("compact", "regular", "spacious"),
  brandElementPosition: fc.constant({ logo: "top-left" }),
  ctaStyle: fc.constantFrom("solid", "outline", "ghost"),
}) as fc.Arbitrary<DesignSystem>;

const imageAsset: ImageAsset = {
  id: "img",
  url: "https://example.invalid/img.png",
  width: 1080,
  height: 1350,
};

const canvasRef: CanvasRef = {
  url: "https://example.invalid/canvas.png",
  width: 1080,
  height: 1350,
};

const copy: CopyContent = {
  headline: "Headline",
  cta: "Daftar",
  alignedGoal: "Branding",
  alignedTone: "Profesional",
};

/** Build a LayoutTemplate that includes (a superset of) the given elements. */
function makeLayout(
  format: OutputFormat,
  includedElements: MandatoryElement[],
): LayoutTemplate {
  return {
    id: "layout-1",
    format,
    slots: [],
    includedElements: [...includedElements],
  };
}

/**
 * Build a single DesignVariation cloning the shared brand identity. Optional
 * overrides let Property 18 introduce a deviation on exactly one variation.
 */
function makeVariation(params: {
  id: string;
  brandDna: BrandDNA;
  designSystem: DesignSystem;
  layout: LayoutTemplate;
}): DesignVariation {
  return {
    id: params.id,
    batchId: "batch-1",
    brandDna: params.brandDna,
    designSystem: params.designSystem,
    copy,
    layout: params.layout,
    imageAsset,
    renderedCanvas: canvasRef,
  };
}

/** Build a fully consistent batch from a shared brand + design system. */
function makeConsistentBatch(params: {
  brandDna: BrandDNA;
  designSystem: DesignSystem;
  format: OutputFormat;
  mandatoryElements: MandatoryElement[];
  count: number;
}): GenerationBatch {
  const layout = makeLayout(params.format, params.mandatoryElements);
  const variations: DesignVariation[] = Array.from(
    { length: params.count },
    (_, i) =>
      makeVariation({
        id: `var-${i}`,
        // Each variation gets its OWN copy of the identity objects (cloned),
        // mirroring how the pipeline emits independent-but-equal values.
        brandDna: { ...params.brandDna, accentPalette: [...params.brandDna.accentPalette] },
        designSystem: { ...params.designSystem },
        layout: makeLayout(params.format, params.mandatoryElements),
      }),
  );
  return {
    id: "batch-1",
    userId: "user-1",
    briefId: "brief-1",
    variations,
    status: "running",
    createdAt: new Date(0).toISOString(),
  };
}

const formatArb = fc.constantFrom(...OUTPUT_FORMATS) as fc.Arbitrary<OutputFormat>;
const mandatoryArb = fc.uniqueArray(fc.constantFrom(...MANDATORY_ELEMENTS), {
  maxLength: MANDATORY_ELEMENTS.length,
});
const countArb = fc.integer({ min: 1, max: 9 });

// ---------------------------------------------------------------------------
// Property 17: Konsistensi brand lintas variasi dalam satu batch
// ---------------------------------------------------------------------------

describe("verifyConsistency — brand consistency across batch variations", () => {
  // Feature: feed-design-generator, Property 17: Konsistensi brand lintas variasi dalam satu batch
  // Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.6
  it("reports consistent (no violations) when every variation shares BrandDNA, accentPalette, fonts, and all mandatory elements", () => {
    fc.assert(
      fc.property(
        brandDnaArb,
        designSystemArb,
        formatArb,
        mandatoryArb,
        countArb,
        (brandDna, designSystem, format, mandatoryElements, count) => {
          const batch = makeConsistentBatch({
            brandDna,
            designSystem,
            format,
            mandatoryElements,
            count,
          });

          const report = verifyConsistency(batch, { mandatoryElements });

          expect(report.consistent).toBe(true);
          expect(report.violations).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 18: Deteksi dan pelaporan ketidakkonsistenan
// ---------------------------------------------------------------------------

/** The attribute a single deviating variation will violate. */
type DeviationKind =
  | "brandDna"
  | "accentPalette"
  | "headlineFont"
  | "bodyFont"
  | "mandatoryElement";

describe("verifyConsistency — detection & reporting of inconsistency", () => {
  // Feature: feed-design-generator, Property 18: Deteksi dan pelaporan ketidakkonsistenan
  // Validates: Requirements 5.5
  it("returns consistent=false, reports the deviating variation + attribute, and preserves all variations", () => {
    fc.assert(
      fc.property(
        brandDnaArb,
        designSystemArb,
        formatArb,
        // At least one mandatory element so a 'mandatoryElement' deviation is possible.
        fc.uniqueArray(fc.constantFrom(...MANDATORY_ELEMENTS), {
          minLength: 1,
          maxLength: MANDATORY_ELEMENTS.length,
        }),
        // >=2 variations so a non-reference variation can deviate (the first
        // variation is the reference brand and never deviates from itself).
        fc.integer({ min: 2, max: 9 }),
        fc.constantFrom<DeviationKind>(
          "brandDna",
          "accentPalette",
          "headlineFont",
          "bodyFont",
          "mandatoryElement",
        ),
        (brandDna, designSystem, format, mandatoryElements, count, kind) => {
          const batch = makeConsistentBatch({
            brandDna,
            designSystem,
            format,
            mandatoryElements,
            count,
          });

          // Deviate exactly the LAST variation (a non-reference one).
          const target = batch.variations[batch.variations.length - 1];
          const deviantId = target.id;
          let deviant = target;

          switch (kind) {
            case "brandDna":
              deviant = {
                ...target,
                brandDna: {
                  ...target.brandDna,
                  brandName: target.brandDna.brandName + "_X",
                },
              };
              break;
            case "accentPalette":
              deviant = {
                ...target,
                brandDna: {
                  ...target.brandDna,
                  accentPalette: [...target.brandDna.accentPalette, "#000000_DEV"],
                },
              };
              break;
            case "headlineFont":
              deviant = {
                ...target,
                designSystem: {
                  ...target.designSystem,
                  headlineFont: target.designSystem.headlineFont + "_X",
                },
              };
              break;
            case "bodyFont":
              deviant = {
                ...target,
                designSystem: {
                  ...target.designSystem,
                  bodyFont: target.designSystem.bodyFont + "_X",
                },
              };
              break;
            case "mandatoryElement": {
              // Drop one required element from this variation's layout.
              const dropped = mandatoryElements.slice(1);
              deviant = {
                ...target,
                layout: makeLayout(format, dropped),
              };
              break;
            }
          }

          const variations = [
            ...batch.variations.slice(0, -1),
            deviant,
          ];
          const deviantBatch: GenerationBatch = { ...batch, variations };

          const report = verifyConsistency(deviantBatch, { mandatoryElements });

          // Inconsistency detected (Req 5.5).
          expect(report.consistent).toBe(false);
          expect(report.violations.length).toBeGreaterThan(0);

          // The deviating variation + attribute are reported specifically.
          const matching = report.violations.filter(
            (v) => v.variationId === deviantId && v.attribute === kind,
          );
          expect(matching.length).toBeGreaterThan(0);

          // Successfully produced variations are preserved unchanged (Req 5.5):
          // verifyConsistency is pure and does not drop or mutate variations.
          expect(deviantBatch.variations).toHaveLength(count);
        },
      ),
      { numRuns: 100 },
    );
  });
});
