/**
 * Pure, framework-agnostic helpers for the Right Panel (Properties / Prompt
 * Chain / History / Credit).
 *
 * Kept separate from the React component (mirroring `brief-form-helpers.ts`)
 * so the data-shaping logic — turning a polled {@link JobStatus} into display
 * rows for the 6-step progress indicator, deciding when to stop polling,
 * ordering/limiting the history list, and validating ratings — can be unit
 * tested in a plain Node environment without a DOM.
 *
 * Requirements: 2.9 (progress indicator), 7.2 (history ordering + page cap),
 * 7.4/7.8 (rating range), 8.1 (credit balance display).
 */

import type {
  DesignVariation,
  GenerationBatch,
  JobState,
  JobStatus,
  StepId,
  StepStatus,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Step naming (Req 2.9 — "nama langkah aktif")
// ---------------------------------------------------------------------------

/** All six pipeline step ids in strict order. */
export const STEP_IDS: readonly StepId[] = [1, 2, 3, 4, 5, 6] as const;

/**
 * Human-readable names of the 6 pipeline steps. Kept in sync with the same map
 * in `app/api/jobs/[jobId]/route.ts` (the polling response also includes
 * `currentStepName`, but we re-derive names here so each row is labelled even
 * when shaping a bare {@link JobStatus}). Req 2.9.
 */
export const STEP_NAMES: Record<StepId, string> = {
  1: "Brand DNA Extraction",
  2: "Design System Selection",
  3: "Copy Generation",
  4: "Layout Composition",
  5: "Image Prompt Build",
  6: "Render & Compose",
};

/** Indonesian status labels for the per-step indicator (Req 2.9). */
export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  pending: "Belum dijalankan",
  running: "Sedang berjalan",
  done: "Selesai",
  failed: "Gagal",
};

// ---------------------------------------------------------------------------
// Progress rows (Req 2.9)
// ---------------------------------------------------------------------------

/** A single row in the 6-step progress indicator. */
export interface ProgressRow {
  step: StepId;
  name: string;
  status: StepStatus;
  statusLabel: string;
  /** True for the currently-active step (`JobStatus.currentStep`). */
  isActive: boolean;
}

/** The polling response shape returned by `GET /api/jobs/{jobId}`. */
export interface JobStatusResponse extends JobStatus {
  /** Name of the currently-active step, supplied by the route. */
  currentStepName: string;
}

/**
 * Map a {@link JobStatus} to the ordered list of display rows for the 6-step
 * progress indicator (Req 2.9). Each row carries the step number, name, status,
 * a localized status label, and whether it is the active step.
 *
 * `isActive` is only meaningful while the job is in flight: once the job is in
 * a terminal state (`done`/`failed`) no row is marked active, so the indicator
 * does not keep highlighting a step after the pipeline stops.
 */
export function toProgressRows(status: JobStatus): ProgressRow[] {
  const active = isTerminalState(status.state) ? null : status.currentStep;
  return STEP_IDS.map((step) => {
    const stepStatus = status.statuses[step] ?? "pending";
    return {
      step,
      name: STEP_NAMES[step],
      status: stepStatus,
      statusLabel: STEP_STATUS_LABELS[stepStatus],
      isActive: step === active,
    };
  });
}

/** A terminal job state: polling should stop once reached (Req 2.9). */
export function isTerminalState(state: JobState): boolean {
  return state === "done" || state === "failed";
}

/** Whether polling should continue for the given status. */
export function shouldContinuePolling(status: JobStatus | null): boolean {
  if (!status) return true;
  return !isTerminalState(status.state);
}

/**
 * Short human-readable summary of the active step for the panel header
 * (e.g. "Langkah 3/6: Copy Generation"). For terminal states it reports the
 * outcome instead.
 */
export function describeProgress(status: JobStatus): string {
  if (status.state === "done") return "Selesai — semua langkah berhasil.";
  if (status.state === "failed") {
    const failed = status.failedStep ?? status.currentStep;
    return `Gagal pada langkah ${failed}/6: ${STEP_NAMES[failed]}.`;
  }
  return `Langkah ${status.currentStep}/6: ${STEP_NAMES[status.currentStep]}`;
}

// ---------------------------------------------------------------------------
// History shaping (Req 7.2)
// ---------------------------------------------------------------------------

/** Max history entries shown per page (Req 7.2). */
export const HISTORY_PAGE_SIZE = 20;

/** A compact, display-ready history row derived from a {@link GenerationBatch}. */
export interface HistoryRow {
  batchId: string;
  createdAt: string;
  status: GenerationBatch["status"];
  variationCount: number;
}

/**
 * Order batches newest-first and cap to at most {@link HISTORY_PAGE_SIZE}
 * entries per page (Req 7.2). Pure: returns a new array and does not mutate the
 * input. `createdAt` is compared as an ISO timestamp; ties keep input order.
 */
export function shapeHistory(
  batches: readonly GenerationBatch[],
): HistoryRow[] {
  return [...batches]
    .sort((a, b) => compareCreatedAtDesc(a.createdAt, b.createdAt))
    .slice(0, HISTORY_PAGE_SIZE)
    .map((batch) => ({
      batchId: batch.id,
      createdAt: batch.createdAt,
      status: batch.status,
      variationCount: batch.variations.length,
    }));
}

/** Compare two ISO timestamps for newest-first ordering. */
function compareCreatedAtDesc(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  // Fall back to string compare if either timestamp is unparseable.
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    return a < b ? 1 : a > b ? -1 : 0;
  }
  return tb - ta;
}

// ---------------------------------------------------------------------------
// Rating validation (Req 7.4, 7.8)
// ---------------------------------------------------------------------------

/** Inclusive rating bounds (Req 7.4). */
export const MIN_RATING = 1;
export const MAX_RATING = 5;

/** Selectable rating values (1..5) for the rating control. */
export const RATING_VALUES: readonly number[] = [1, 2, 3, 4, 5] as const;

/**
 * Whether a rating is a valid integer in the inclusive range 1..5 (Req 7.4).
 * Out-of-range or non-integer values must be rejected (Req 7.8).
 */
export function isValidRating(rating: number): boolean {
  return Number.isInteger(rating) && rating >= MIN_RATING && rating <= MAX_RATING;
}

/**
 * Resolve the rating to display for a variation after a (possibly invalid)
 * rating attempt. Mirrors `History_Manager.rateVariation` semantics (Req 7.8):
 * a valid new rating is stored; an invalid one is rejected and the previous
 * rating (if any) is preserved unchanged.
 */
export function resolveDisplayedRating(
  previous: number | undefined,
  attempted: number,
): number | undefined {
  return isValidRating(attempted) ? attempted : previous;
}

/** Build the display rows for the rating control from batch variations. */
export interface RatingRow {
  variationId: string;
  rating?: number;
}

/** Map a batch's variations to rating rows (id + current rating). Req 7.2/7.4 */
export function toRatingRows(
  variations: readonly DesignVariation[],
): RatingRow[] {
  return variations.map((v) => ({ variationId: v.id, rating: v.rating }));
}

// ---------------------------------------------------------------------------
// Credit balance display (Req 8.1)
// ---------------------------------------------------------------------------

/**
 * Normalize a raw credit balance for display: a non-negative integer (Req 8.1,
 * 8.6). Defensive against bad/missing values from the API.
 */
export function normalizeBalance(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}
