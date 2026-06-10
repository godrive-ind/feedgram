/**
 * Pipeline_Engine (Layer 2) — strict sequential 6-step state machine.
 *
 * Implements the pure, testable core of the pipeline:
 * - `start` initialises a `PipelineState` at step 1 with every step "pending".
 * - `advance` moves the machine strictly from step N to step N+1 (never skips,
 *   repeats, or goes backward) and rejects advancing past the final step.
 * - `runStep` is the framework that runs a single step by delegating to an
 *   injectable per-step transform and updating that step's status.
 *
 * The concrete per-step transforms live in `lib/pipeline/steps.ts` (task 4.3)
 * and are plugged in via the `StepTransforms` map, which keeps this module
 * pure, deterministic, and easy to mock in tests.
 *
 * See design "Components and Interfaces → Pipeline_Engine" and the
 * "Mesin status pipeline (ketat sekuensial)" state diagram.
 *
 * Requirements: 2.1, 2.2
 */

import type {
  DesignBriefInput,
  PipelineState,
  StepId,
  StepResult,
  StepStatus,
  VariationCount,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Step metadata
// ---------------------------------------------------------------------------

/** The first step id in the pipeline. */
export const FIRST_STEP: StepId = 1;

/** The final step id in the pipeline. */
export const LAST_STEP: StepId = 6;

/** Ordered list of all step ids (1..6). Req 2.1 */
export const STEP_IDS: readonly StepId[] = [1, 2, 3, 4, 5, 6] as const;

/**
 * Human-readable name for each step, used for progress/error messaging
 * (e.g. Req 2.9 progress indicator, Req 2.10 failure message). Req 2.1
 */
export const STEP_NAMES: Record<StepId, string> = {
  1: "Brand DNA Extraction",
  2: "Design System Selection",
  3: "Copy Generation",
  4: "Layout Composition",
  5: "Image Prompt Build",
  6: "Render & Compose",
};

/** Return the human-readable name for a step id. */
export function getStepName(step: StepId): string {
  return STEP_NAMES[step];
}

// ---------------------------------------------------------------------------
// Injectable per-step transforms
// ---------------------------------------------------------------------------

/**
 * A per-step transform receives the current pipeline state (with the active
 * step already marked "running") and returns a partial state patch carrying
 * that step's output (e.g. `{ brandDna }`). The patch is merged into the
 * state by `runStep`. Transforms may be async (they typically call the
 * `AI_Service_Connector`).
 *
 * The actual transforms are implemented in `lib/pipeline/steps.ts` (task 4.3).
 */
export type StepTransform = (
  state: PipelineState,
) => Partial<PipelineState> | Promise<Partial<PipelineState>>;

/**
 * Map of step id -> transform. Any step without a provided transform is run as
 * a no-op passthrough (the later task fills these in), so the state-machine
 * framework is usable and testable on its own.
 */
export type StepTransforms = Partial<Record<StepId, StepTransform>>;

// ---------------------------------------------------------------------------
// State construction helpers
// ---------------------------------------------------------------------------

/** Build a fresh statuses map with every step set to "pending". Req 2.9 */
export function initialStatuses(): Record<StepId, StepStatus> {
  return {
    1: "pending",
    2: "pending",
    3: "pending",
    4: "pending",
    5: "pending",
    6: "pending",
  };
}

// ---------------------------------------------------------------------------
// start — Req 2.1
// ---------------------------------------------------------------------------

/**
 * Initialise a pipeline run.
 *
 * Returns a `PipelineState` positioned at the first step (`current === 1`) with
 * every step status set to "pending". The provided `variationCount` is applied
 * to the brief so the engine and the brief agree on the requested batch size
 * (Req 2.8 is enforced downstream by the step-6 transform).
 *
 * Requirements: 2.1
 */
export function start(
  brief: DesignBriefInput,
  variationCount: VariationCount,
): PipelineState {
  return {
    current: FIRST_STEP,
    statuses: initialStatuses(),
    brief: { ...brief, variationCount },
  };
}

// ---------------------------------------------------------------------------
// advance — Req 2.2
// ---------------------------------------------------------------------------

/**
 * Advance the state machine strictly from step N to step N+1.
 *
 * Strict sequencing rules (Req 2.2):
 * - The current step is always incremented by exactly one — the machine never
 *   skips ahead, repeats, or moves backward.
 * - Advancing past the final step (6) is not allowed and throws a `RangeError`.
 *
 * The step being left behind is marked "done" (advancing represents a
 * successful completion gate); the new current step remains "pending" until
 * `runStep` marks it "running".
 *
 * @throws {RangeError} when called while already on the final step.
 */
export function advance(state: PipelineState): PipelineState {
  if (state.current >= LAST_STEP) {
    throw new RangeError(
      `Cannot advance past final step ${LAST_STEP} (${STEP_NAMES[LAST_STEP]})`,
    );
  }

  const completed = state.current;
  const next = (completed + 1) as StepId;

  return {
    ...state,
    current: next,
    statuses: {
      ...state.statuses,
      [completed]: "done",
    },
  };
}

// ---------------------------------------------------------------------------
// runStep — framework delegating to a per-step transform
// ---------------------------------------------------------------------------

/**
 * Run a single pipeline step.
 *
 * Framework behavior:
 * 1. Marks the step "running".
 * 2. Delegates to the injected transform for that step (no-op passthrough when
 *    no transform is provided — the concrete transforms arrive in task 4.3).
 * 3. Merges the transform's partial-state patch and marks the step "done".
 * 4. On a thrown transform error, marks the step "failed" and surfaces the
 *    message (failure handling/refund is task 4.9).
 *
 * Strict sequencing (Req 2.2): a step may only be run when it is the active
 * step (`step === state.current`); running any other step throws a
 * `RangeError` so steps cannot be skipped, repeated, or revisited.
 *
 * The function is pure with respect to its inputs: it returns new state objects
 * and never mutates the argument.
 *
 * @throws {RangeError} when `step` is not the current active step.
 */
export async function runStep(
  state: PipelineState,
  step: StepId,
  transforms: StepTransforms = {},
): Promise<StepResult> {
  if (step !== state.current) {
    throw new RangeError(
      `Cannot run step ${step} (${STEP_NAMES[step]}) while step ${state.current} (${STEP_NAMES[state.current]}) is active`,
    );
  }

  // 1. Mark the active step "running".
  const running: PipelineState = {
    ...state,
    statuses: { ...state.statuses, [step]: "running" },
  };

  const transform = transforms[step];

  try {
    // 2. Delegate to the per-step transform (no-op passthrough if absent).
    const patch = transform ? await transform(running) : {};

    // 3. Merge the patch and mark the step "done".
    const nextState: PipelineState = {
      ...running,
      ...patch,
      statuses: { ...running.statuses, [step]: "done" },
    };

    return { step, status: "done", state: nextState };
  } catch (error) {
    // 4. Mark the step "failed" and surface the error message.
    const failedState: PipelineState = {
      ...running,
      statuses: { ...running.statuses, [step]: "failed" },
    };

    return {
      step,
      status: "failed",
      state: failedState,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// PipelineEngine aggregate (convenience object for API/worker imports)
// ---------------------------------------------------------------------------

/** Convenience object grouping the pipeline state-machine functions. */
export const PipelineEngine = {
  start,
  advance,
  runStep,
  getStepName,
  initialStatuses,
  STEP_NAMES,
  STEP_IDS,
  FIRST_STEP,
  LAST_STEP,
} as const;
