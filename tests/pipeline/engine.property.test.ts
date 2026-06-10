import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  start,
  advance,
  runStep,
  STEP_IDS,
  FIRST_STEP,
  LAST_STEP,
} from "@/lib/pipeline/engine";
import {
  CONTENT_GOALS,
  VISUAL_STYLES,
  TONES,
  MANDATORY_ELEMENTS,
  OUTPUT_FORMATS,
  VARIATION_COUNTS,
  type DesignBriefInput,
  type StepId,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Arbitraries — generate valid design briefs from the enum constants in
// lib/types, plus arbitrary variation counts (3 | 6 | 9).
// ---------------------------------------------------------------------------

/** Arbitrary hex color string for the accent palette. */
const hexColorArb = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, "0")}`);

/** Arbitrary valid `DesignBriefInput` constrained to the real input space. */
const validBriefArb: fc.Arbitrary<DesignBriefInput> = fc.record({
  brandName: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
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
// Property 4: Eksekusi pipeline berurutan ketat
// ---------------------------------------------------------------------------

describe("Pipeline_Engine — strict sequential execution", () => {
  // Feature: feed-design-generator, Property 4: Eksekusi pipeline berurutan ketat
  // Validates: Requirements 2.1, 2.2
  it("executes steps strictly in order [1,2,3,4,5,6] and advance only yields current+1", async () => {
    await fc.assert(
      fc.asyncProperty(validBriefArb, variationCountArb, async (brief, count) => {
        // start() => positioned at step 1 with all statuses pending.
        const initial = start(brief, count);
        expect(initial.current).toBe(FIRST_STEP);
        expect(initial.current).toBe(1);
        for (const step of STEP_IDS) {
          expect(initial.statuses[step]).toBe("pending");
        }

        // Iterating advance from step 1 produces exactly [2,3,4,5,6].
        const visited: StepId[] = [];
        let state = initial;
        while (state.current < LAST_STEP) {
          const before = state.current;
          state = advance(state);
          // advance only yields current+1 (never skip, repeat, or go backward).
          expect(state.current).toBe((before + 1) as StepId);
          // the left-behind step is marked done.
          expect(state.statuses[before]).toBe("done");
          visited.push(state.current);
        }
        expect(visited).toEqual([2, 3, 4, 5, 6]);

        // The full executed order is exactly [1,2,3,4,5,6].
        expect([initial.current, ...visited]).toEqual([1, 2, 3, 4, 5, 6]);

        // Advancing past the final step (6) throws.
        expect(() => advance(state)).toThrow();

        // runStep with a wrong (non-current) step id throws. At the initial
        // state (current === 1), every step other than 1 must be rejected.
        for (const wrong of STEP_IDS) {
          if (wrong === initial.current) continue;
          await expect(runStep(initial, wrong)).rejects.toThrow();
        }
      }),
      { numRuns: 100 },
    );
  });
});
