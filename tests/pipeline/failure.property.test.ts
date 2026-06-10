import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  runPipeline,
  type RunPipelineOptions,
} from "@/lib/pipeline/failure";
import {
  start,
  getStepName,
  STEP_IDS,
  type StepTransform,
  type StepTransforms,
} from "@/lib/pipeline/engine";
import { createStepTransforms } from "@/lib/pipeline/steps";
import {
  MockAIServiceConnector,
  createControllableScheduler,
  type AIServiceConnector,
} from "@/lib/ai/connector";
import { createInMemoryCreditManager } from "@/lib/credit/credit-manager";
import {
  CONTENT_GOALS,
  VISUAL_STYLES,
  TONES,
  MANDATORY_ELEMENTS,
  OUTPUT_FORMATS,
  VARIATION_COUNTS,
  type DesignBriefInput,
  type PipelineState,
  type StepId,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Arbitraries — valid design briefs from the enum constants in lib/types
// (mirrors tests/pipeline/steps.property.test.ts).
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

/** Arbitrary failing step id (1..6). */
const failStepArb = fc.constantFrom<StepId>(1, 2, 3, 4, 5, 6);

/** Steps that make an AI service call and so can fail on an AI error. */
const AI_STEPS = [3, 6] as const satisfies readonly StepId[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock connector whose calls resolve immediately (fast scheduler). */
function makeConnector(): AIServiceConnector {
  return new MockAIServiceConnector({
    defaults: { scheduler: createControllableScheduler() },
  });
}

/**
 * A mock connector where the named AI step always fails. `step === 3` fails the
 * copy adapter; `step === 6` fails the image adapter. Uses the fast scheduler so
 * the 3 retry attempts + 30s timeout never block the test.
 */
function makeFailingAiConnector(step: 3 | 6): AIServiceConnector {
  const error = new Error(`AI call failed at step ${step}`);
  return new MockAIServiceConnector({
    copy: step === 3 ? { behavior: "fail", error } : undefined,
    image: step === 6 ? { behavior: "fail", error } : undefined,
    defaults: { scheduler: createControllableScheduler() },
  });
}

/** Wrap a transforms map so that `failStep` throws when run. */
function withFailingStep(
  base: StepTransforms,
  failStep: StepId,
  error: Error,
): StepTransforms {
  const throwing: StepTransform = () => {
    throw error;
  };
  return { ...base, [failStep]: throwing };
}

/** The per-step output field each step populates on the PipelineState. */
const STEP_OUTPUT_FIELD: Record<StepId, keyof PipelineState> = {
  1: "brandDna",
  2: "designSystem",
  3: "copy",
  4: "layout",
  5: "imagePrompt",
  6: "batch",
};

// ---------------------------------------------------------------------------
// Property 11: Kegagalan langkah menghentikan proses, refund, dan mempertahankan brief
// ---------------------------------------------------------------------------

describe("Pipeline_Engine — step failure stops, refunds, preserves brief", () => {
  // Feature: feed-design-generator, Property 11: Kegagalan langkah menghentikan proses, refund, dan mempertahankan brief
  // Validates: Requirements 2.10
  it("stops exactly at the failing step K, names step number+name, refunds unused credits, and keeps the brief unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        validBriefArb,
        variationCountArb,
        failStepArb,
        async (brief, count, failStep) => {
          const connector = makeConnector();
          const transforms = withFailingStep(
            createStepTransforms(connector),
            failStep,
            new Error(`boom at step ${failStep}`),
          );

          // Seed a credit balance, reserve the variation cost, and record the
          // pre-generation balance so we can assert the refund restores it.
          const { manager } = createInMemoryCreditManager({ user: 100 });
          const reservation = await manager.reserve("user", count);
          expect(reservation.success).toBe(true);
          const reservationId = reservation.reservationId as string;
          const balanceBeforeRun = await manager.getBalance("user");

          const initial = start(brief, count);
          // Snapshot the brief the engine starts with (count already applied).
          const briefSnapshot = JSON.parse(JSON.stringify(initial.brief));

          // Record which steps actually start running.
          const ranSteps: StepId[] = [];
          const options: RunPipelineOptions = {
            creditManager: manager,
            reservationId,
            onStep: (event) => {
              if (event.status === "running") ranSteps.push(event.step);
            },
          };

          const result = await runPipeline(initial, transforms, options);

          // 1. Pipeline failed at exactly step K.
          expect(result.succeeded).toBe(false);
          expect(result.failedStep).toBe(failStep);

          // 2. Stopped exactly at K: no step after K ever ran, and K did run.
          expect(ranSteps).toContain(failStep);
          for (const ran of ranSteps) {
            expect(ran).toBeLessThanOrEqual(failStep);
          }
          // Status map: <K done, K failed, >K still pending.
          for (const step of STEP_IDS) {
            if (step < failStep) {
              expect(result.state.statuses[step]).toBe("done");
            } else if (step === failStep) {
              expect(result.state.statuses[step]).toBe("failed");
            } else {
              expect(result.state.statuses[step]).toBe("pending");
            }
          }

          // 3. Error message names the step number AND the step name.
          expect(result.message).toBeDefined();
          expect(result.message).toContain(`Langkah ${failStep}`);
          expect(result.message).toContain(getStepName(failStep));

          // 4. Unused credits refunded: balance returns to its pre-run value.
          expect(result.refunded).toBe(true);
          const balanceAfter = await manager.getBalance("user");
          expect(balanceAfter).toBe(balanceBeforeRun + count);

          // 5. Brief unchanged.
          expect(result.state.brief).toEqual(briefSnapshot);

          // Retry is available after a failure.
          expect(result.retryAvailable).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12: Hasil langkah sebelumnya dipertahankan saat kegagalan pemanggilan AI
// ---------------------------------------------------------------------------

describe("Pipeline_Engine — prior step outputs preserved on AI-call failure", () => {
  // Feature: feed-design-generator, Property 12: Hasil langkah sebelumnya dipertahankan saat kegagalan pemanggilan AI
  // Validates: Requirements 3.5
  it("keeps outputs of steps 1..K-1 intact and offers retry when an AI call fails at step K", async () => {
    await fc.assert(
      fc.asyncProperty(
        validBriefArb,
        variationCountArb,
        fc.constantFrom(...AI_STEPS),
        async (brief, count, failStep) => {
          // Deterministic shared options so the success run and the failure run
          // produce identical step outputs for steps 1..K-1.
          const sharedOptions = { batchId: "batch-fixed", userId: "user" };

          // Reference run: fully successful, deterministic outputs for 1..K-1.
          const successState = start(brief, count);
          const successTransforms = createStepTransforms(
            makeConnector(),
            sharedOptions,
          );
          const successResult = await runPipeline(successState, successTransforms, {
            creditManager: createInMemoryCreditManager({ user: 100 }).manager,
            reservationId: "noop",
          });
          expect(successResult.succeeded).toBe(true);

          // Failure run: same brief/options, but the AI call at step K fails.
          const { manager } = createInMemoryCreditManager({ user: 100 });
          const reservation = await manager.reserve("user", count);
          const reservationId = reservation.reservationId as string;

          const initial = start(brief, count);
          const failTransforms = createStepTransforms(
            makeFailingAiConnector(failStep),
            sharedOptions,
          );
          const result = await runPipeline(initial, failTransforms, {
            creditManager: manager,
            reservationId,
          });

          // Failed precisely at the AI step.
          expect(result.succeeded).toBe(false);
          expect(result.failedStep).toBe(failStep);

          // Outputs of steps 1..K-1 are intact and identical to the success run.
          for (const step of STEP_IDS) {
            if (step >= failStep) break;
            const field = STEP_OUTPUT_FIELD[step];
            expect(result.state[field]).toBeDefined();
            expect(result.state[field]).toEqual(successResult.state[field]);
          }

          // The failing step produced no output.
          expect(result.state[STEP_OUTPUT_FIELD[failStep]]).toBeUndefined();

          // Retry option is available.
          expect(result.retryAvailable).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
