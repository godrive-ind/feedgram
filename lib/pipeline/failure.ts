/**
 * Pipeline_Engine — step failure handling + credit refund (Layer 2).
 *
 * Orchestrates a full run of the strict sequential 6-step state machine
 * (`start` → `runStep` → `advance`) and implements the failure contract:
 *
 *   When step K fails (Req 2.10, 3.5):
 *     - STOP at K (no further steps run).
 *     - Build an error message naming BOTH the step number AND the step name.
 *     - Call `Credit_Manager.refund(reservationId)` to return the unused
 *       credits reserved for this batch.
 *     - Preserve the user's brief unchanged and keep the outputs of steps
 *       1..K-1 intact (Property 11, 12).
 *     - Expose that a retry is available.
 *
 *   On success the whole pipeline runs steps 1..6 and NO refund happens — the
 *   credit commit is the worker's responsibility (task 7.2).
 *
 * The `Credit_Manager` dependency is injected *structurally* (only `refund` is
 * required) so this module is testable with the in-memory credit manager and
 * stays decoupled from the storage layer.
 *
 * Pure/deterministic given deterministic step transforms (e.g. those built from
 * a mock `AI_Service_Connector`): the only side effect is the injected refund.
 *
 * See design "Pipeline_Engine failure handling", "Error Handling", and
 * Correctness Properties 11 & 12.
 *
 * Requirements: 2.10, 3.5
 */

import {
  LAST_STEP,
  advance,
  getStepName,
  runStep,
  type StepTransforms,
} from "@/lib/pipeline/engine";
import type { PipelineState, StepId } from "@/lib/types";

// ---------------------------------------------------------------------------
// Injected dependencies (structural — only `refund` is needed)
// ---------------------------------------------------------------------------

/**
 * The minimal slice of `Credit_Manager` this module depends on. Accepting only
 * `refund` keeps the dependency structural so any object exposing a compatible
 * `refund(reservationId)` (including the in-memory manager) can be injected.
 *
 * Requirements: 2.10
 */
export interface CreditRefunder {
  /** Return the unused credits held under `reservationId`. Req 2.10 */
  refund(reservationId: string): Promise<void>;
}

/**
 * A progress event emitted by {@link runPipeline} as it drives each step. It is
 * fired when a step starts ("running"), completes ("done"), or fails
 * ("failed"). Consumers (e.g. the pipeline worker, task 7.2) use it to update
 * the polled `JobStatus` so progress reflects the live pipeline state within
 * the 2s expectation (Req 2.9).
 */
export interface PipelineStepEvent {
  step: StepId;
  status: "running" | "done" | "failed";
  /** Pipeline state at the moment the event fires. */
  state: PipelineState;
}

/** Optional per-step progress hook. May be async; awaited before continuing. */
export type PipelineStepListener = (
  event: PipelineStepEvent,
) => void | Promise<void>;

/** Options for {@link runPipeline}. */
export interface RunPipelineOptions {
  /** Credit manager used to refund unused credits on failure. Req 2.10 */
  creditManager: CreditRefunder;
  /** The reservation holding this batch's credits (reserve → commit/refund). */
  reservationId: string;
  /**
   * Optional progress hook invoked as each step starts/finishes/fails. Lets the
   * worker mirror `currentStep` + per-step statuses into the persisted
   * `JobStatus` for polling (Req 2.9). Omitting it preserves the original
   * behaviour (no progress side effects).
   */
  onStep?: PipelineStepListener;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Outcome of running the pipeline through {@link runPipeline}.
 *
 * - `succeeded`     — true when all six steps completed.
 * - `state`         — the final pipeline state. On failure it preserves the
 *                     brief unchanged and keeps the outputs of steps 1..K-1
 *                     intact (Property 11, 12); the failing step is "failed".
 * - `failedStep`    — the step number K that failed (only when `succeeded` is
 *                     false).
 * - `message`       — failure message naming the step number + name (Req 2.10).
 * - `refunded`      — true when unused credits were refunded (failure path).
 * - `retryAvailable`— true when the user may retry (always true on failure).
 */
export interface PipelineRunResult {
  succeeded: boolean;
  state: PipelineState;
  failedStep?: StepId;
  message?: string;
  refunded: boolean;
  retryAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Failure message
// ---------------------------------------------------------------------------

/**
 * Build the failure message for a failed step. Always names BOTH the step
 * number and the human-readable step name (Req 2.10). The underlying error
 * detail (e.g. the AI connector's timeout/error message) is appended when
 * available.
 */
export function buildFailureMessage(step: StepId, error?: string): string {
  const base = `Langkah ${step} (${getStepName(step)}) gagal`;
  return error && error.trim().length > 0 ? `${base}: ${error}` : base;
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

/**
 * Handle a failed step: refund the unused credits and assemble the failure
 * result. The passed `failedState` already carries the failing step marked
 * "failed" and the preserved brief + prior step outputs (produced by
 * `runStep`), so this function does not mutate it.
 *
 * Refund is performed exactly once for the reservation (Req 2.10). Retry is
 * always offered after a failure (Req 3.5).
 *
 * Requirements: 2.10, 3.5
 */
export async function handleStepFailure(
  failedState: PipelineState,
  failedStep: StepId,
  error: string | undefined,
  options: RunPipelineOptions,
): Promise<PipelineRunResult> {
  // Return unused credits for this batch (Req 2.10).
  await options.creditManager.refund(options.reservationId);

  return {
    succeeded: false,
    state: failedState, // brief unchanged + steps 1..K-1 intact (Property 11, 12)
    failedStep,
    message: buildFailureMessage(failedStep, error),
    refunded: true,
    retryAvailable: true,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the pipeline from its current step through the final step, driving the
 * strict sequential state machine with `runStep` + `advance`.
 *
 * Behaviour:
 * - Runs the active step via {@link runStep}. On a successful step it advances
 *   to the next step (N → N+1) and continues; after the final step it stops.
 * - On the FIRST failed step K it stops immediately (no later steps run),
 *   refunds the reserved credits via {@link handleStepFailure}, and returns a
 *   failure result that preserves the brief and the outputs of steps 1..K-1
 *   (Property 11, 12) while exposing that a retry is available.
 * - On full success it returns `{ succeeded: true, refunded: false, ... }` —
 *   credits are NOT refunded (the commit is handled by the worker, task 7.2).
 *
 * Pure/deterministic aside from the injected refund: given deterministic
 * transforms it always produces the same result.
 *
 * Requirements: 2.10, 3.5
 */
export async function runPipeline(
  initialState: PipelineState,
  transforms: StepTransforms,
  options: RunPipelineOptions,
): Promise<PipelineRunResult> {
  let state = initialState;

  // Iterate the strict sequential machine until the final step completes or a
  // step fails.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = state.current;

    // Notify that this step has started (status "running"). Req 2.9
    if (options.onStep) {
      await options.onStep({ step, status: "running", state });
    }

    const result = await runStep(state, step, transforms);

    if (result.status === "failed") {
      // Notify failure before refunding so the worker can persist the failed
      // step status (Req 2.9, 2.10).
      if (options.onStep) {
        await options.onStep({ step, status: "failed", state: result.state });
      }
      // Stop at the failing step K, refund, preserve brief + prior outputs.
      return handleStepFailure(result.state, step, result.error, options);
    }

    // Step succeeded: carry the merged output forward.
    state = result.state;

    // Notify that this step finished successfully. Req 2.9
    if (options.onStep) {
      await options.onStep({ step, status: "done", state });
    }

    // Stop after the final step; otherwise advance strictly to N+1 (Req 2.2).
    if (step >= LAST_STEP) {
      break;
    }
    state = advance(state);
  }

  return {
    succeeded: true,
    state,
    refunded: false, // success never refunds (commit handled by worker)
    retryAvailable: false,
  };
}

// ---------------------------------------------------------------------------
// Convenience aggregate
// ---------------------------------------------------------------------------

/** Convenience object grouping the failure-handling functions. */
export const PipelineFailure = {
  runPipeline,
  handleStepFailure,
  buildFailureMessage,
} as const;
