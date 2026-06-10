import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  start,
  advance,
  runStep,
  STEP_IDS,
  LAST_STEP,
} from "@/lib/pipeline/engine";
import {
  createStepTransforms,
  deriveBrandDna,
  deriveDesignSystem,
  buildLayout,
  buildImagePrompt,
  VISUAL_STYLE_PRESETS,
  type StepTransformsOptions,
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
  type BrandDNA,
  type DesignBriefInput,
  type DesignSystem,
  type LayoutTemplate,
  type PipelineState,
  type VariationCount,
  type VisualStyle,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Arbitraries — valid design briefs generated from the enum constants in
// lib/types (mirrors tests/pipeline/engine.property.test.ts).
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

/** Arbitrary variation count (3 | 6 | 9). */
const variationCountArb = fc.constantFrom(...VARIATION_COUNTS);

// ---------------------------------------------------------------------------
// Helpers — run the pipeline (or specific steps) via the step transforms using
// a deterministic MockAIServiceConnector with an injected fast scheduler so no
// real 30s timers ever block the tests.
// ---------------------------------------------------------------------------

/** Build a mock connector whose calls resolve immediately (fast scheduler). */
function makeConnector(): AIServiceConnector {
  return new MockAIServiceConnector({
    defaults: { scheduler: createControllableScheduler() },
  });
}

/**
 * Run all six steps strictly in order through the engine + step transforms and
 * return the final populated `PipelineState`.
 */
async function runPipeline(
  brief: DesignBriefInput,
  count: VariationCount,
  connector: AIServiceConnector,
  options: StepTransformsOptions = {},
): Promise<PipelineState> {
  const transforms = createStepTransforms(connector, options);
  let state = start(brief, count);
  for (const step of STEP_IDS) {
    const result = await runStep(state, step, transforms);
    expect(result.status).toBe("done");
    state = result.state;
    if (step < LAST_STEP) {
      state = advance(state);
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Property 5: Brand DNA diturunkan dari brief
// ---------------------------------------------------------------------------

describe("Pipeline step transforms — Step 1 Brand DNA derivation", () => {
  // Feature: feed-design-generator, Property 5: Brand DNA diturunkan dari brief
  // Validates: Requirements 2.3
  it("derives a BrandDNA whose brandName, accentPalette, tone, and visualStyle equal the brief", () => {
    fc.assert(
      fc.property(validBriefArb, (brief) => {
        const brandDna = deriveBrandDna(brief);

        expect(brandDna.brandName).toBe(brief.brandName);
        expect(brandDna.tone).toBe(brief.tone);
        expect(brandDna.visualStyle).toBe(brief.visualStyle);
        // Same values, in order (cloned, not aliased).
        expect(brandDna.accentPalette).toEqual(brief.accentPalette);
        expect(brandDna.accentPalette).not.toBe(brief.accentPalette);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Copy selaras dengan tujuan dan tone
// ---------------------------------------------------------------------------

describe("Pipeline step transforms — Step 3 Copy alignment", () => {
  // Feature: feed-design-generator, Property 6: Copy selaras dengan tujuan dan tone
  // Validates: Requirements 2.5
  it("produces CopyContent whose alignedGoal/alignedTone equal the brief's contentGoal/tone", async () => {
    await fc.assert(
      fc.asyncProperty(validBriefArb, async (brief) => {
        const connector = makeConnector();
        const transforms = createStepTransforms(connector);

        // Reach step 3: run step 1 (Brand DNA) then advance to step 3.
        let state = start(brief, brief.variationCount);
        const s1 = await runStep(state, 1, transforms);
        expect(s1.status).toBe("done");
        state = advance(s1.state); // -> step 2
        state = advance(state); // -> step 3 (step 2 output not needed for copy)

        const s3 = await runStep(state, 3, transforms);
        expect(s3.status).toBe("done");

        const copy = s3.state.copy;
        expect(copy).toBeDefined();
        expect(copy?.alignedGoal).toBe(brief.contentGoal);
        expect(copy?.alignedTone).toBe(brief.tone);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Layout selaras dengan format dan elemen wajib
// ---------------------------------------------------------------------------

describe("Pipeline step transforms — Step 4 Layout composition", () => {
  // Feature: feed-design-generator, Property 7: Layout selaras dengan format dan elemen wajib
  // Validates: Requirements 2.6
  it("produces a LayoutTemplate whose format equals the brief and includedElements is a superset of mandatoryElements", async () => {
    await fc.assert(
      fc.asyncProperty(validBriefArb, async (brief) => {
        const connector = makeConnector();
        const transforms = createStepTransforms(connector);

        // Reach step 4: run steps 1 & 2 (Brand DNA, Design System), advance to 4.
        let state = start(brief, brief.variationCount);
        const s1 = await runStep(state, 1, transforms);
        state = advance(s1.state); // -> step 2
        const s2 = await runStep(state, 2, transforms);
        state = advance(s2.state); // -> step 3
        state = advance(state); // -> step 4

        const s4 = await runStep(state, 4, transforms);
        expect(s4.status).toBe("done");

        const layout = s4.state.layout;
        expect(layout).toBeDefined();
        // format equals the brief's output format.
        expect(layout?.format).toEqual(brief.outputFormat);
        // includedElements is a superset of the brief's mandatory elements.
        const included = new Set(layout?.includedElements);
        for (const el of brief.mandatoryElements) {
          expect(included.has(el)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: Image prompt menggabungkan tiga sumber
// ---------------------------------------------------------------------------

/** Arbitrary BrandDNA. */
const brandDnaArb: fc.Arbitrary<BrandDNA> = fc.record({
  brandName: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
  tagline: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
  accentPalette: fc.array(hexColorArb, { minLength: 1, maxLength: 5 }),
  tone: fc.constantFrom(...TONES),
  visualStyle: fc.constantFrom(...VISUAL_STYLES),
}) as fc.Arbitrary<BrandDNA>;

describe("Pipeline step transforms — Step 5 Image prompt combination", () => {
  // Feature: feed-design-generator, Property 8: Image prompt menggabungkan tiga sumber
  // Validates: Requirements 2.7
  it("builds a prompt containing identifiable tokens from BrandDNA, DesignSystem, and LayoutTemplate", () => {
    fc.assert(
      fc.property(
        brandDnaArb,
        fc.constantFrom(...VISUAL_STYLES),
        fc.constantFrom(...OUTPUT_FORMATS),
        fc.uniqueArray(fc.constantFrom(...MANDATORY_ELEMENTS), {
          maxLength: MANDATORY_ELEMENTS.length,
        }),
        (brandDna, designStyle, outputFormat, mandatoryElements) => {
          // DesignSystem derived from a (possibly different) visual style so
          // its font tokens are well-defined and independent of the brand.
          const designSystem: DesignSystem = deriveDesignSystem({
            ...brandDna,
            visualStyle: designStyle,
          });
          const layout: LayoutTemplate = buildLayout(
            outputFormat,
            mandatoryElements,
            designSystem,
          );

          const { prompt } = buildImagePrompt(brandDna, designSystem, layout);

          // Brand DNA markers (identity).
          expect(prompt).toContain(brandDna.brandName);
          expect(prompt).toContain(brandDna.visualStyle);
          expect(prompt).toContain(brandDna.tone);

          // Design System markers (fonts).
          expect(prompt).toContain(designSystem.headlineFont);
          expect(prompt).toContain(designSystem.bodyFont);

          // Layout Template markers (structure).
          expect(prompt).toContain(layout.id);
          expect(prompt).toContain(layout.format.name);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Jumlah variasi batch sesuai pilihan
// ---------------------------------------------------------------------------

describe("Pipeline step transforms — Step 6 Render & Compose batch size", () => {
  // Feature: feed-design-generator, Property 9: Jumlah variasi batch sesuai pilihan
  // Validates: Requirements 2.8
  it("produces a GenerationBatch with exactly variationCount variations", async () => {
    await fc.assert(
      fc.asyncProperty(validBriefArb, variationCountArb, async (brief, count) => {
        const connector = makeConnector();
        const finalState = await runPipeline(brief, count, connector);

        const batch = finalState.batch;
        expect(batch).toBeDefined();
        // Exactly `count` variations (Property 9). start() applies `count` to
        // the brief, so the step-6 transform reads the requested batch size.
        expect(batch?.variations).toHaveLength(count);
      }),
      { numRuns: 100 },
    );
  });
});

// Guard: every visual style has a design-system preset so step 2 is total.
describe("VISUAL_STYLE_PRESETS coverage", () => {
  it("has a preset for every visual style", () => {
    for (const style of VISUAL_STYLES as readonly VisualStyle[]) {
      expect(VISUAL_STYLE_PRESETS[style]).toBeDefined();
    }
  });
});
