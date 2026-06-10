/**
 * Pure, framework-agnostic helpers for the Center Panel (Canvas Output &
 * Preview, task 11.2).
 *
 * Kept separate from the React component so the core UI logic — grid-column
 * clamping, selection state transitions, edit-control derivation, and zoom
 * percent presets — can be unit tested in a plain Node environment without a
 * DOM. The heavy lifting (clamping ranges, edit controls, viewport math) lives
 * in `lib/canvas/controls.ts`; this module adapts it to the panel's needs and
 * adds the small amounts of panel-specific state logic.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */

import {
  clampGridColumns,
  clampZoom,
  selectVariation,
  zoomFromPercent,
  zoomToPercent,
  GRID_MAX_COLUMNS,
  GRID_MIN_COLUMNS,
  ZOOM_MAX,
  ZOOM_MIN,
  type GridColumns,
} from "@/lib/canvas/controls";
import type {
  DesignVariation,
  EditControls,
  GenerationBatch,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Grid columns (Req 4.3)
// ---------------------------------------------------------------------------

/** Default comparison-grid column count for a fresh panel. */
export const DEFAULT_GRID_COLUMNS: GridColumns = 2;

/** The selectable grid-column counts (2..4) for the toolbar control. (Req 4.3) */
export const GRID_COLUMN_OPTIONS: readonly GridColumns[] = [2, 3, 4];

/**
 * Normalise an arbitrary requested column count into the valid `[2, 4]` range
 * (forgiving clamp + round). Re-exported through this module so the panel has a
 * single import surface. (Req 4.3)
 */
export function normalizeGridColumns(cols: number): GridColumns {
  return clampGridColumns(cols);
}

/** Build the CSS `grid-template-columns` value for a column count. (Req 4.3) */
export function gridTemplateColumns(cols: number): string {
  return `repeat(${normalizeGridColumns(cols)}, minmax(0, 1fr))`;
}

// ---------------------------------------------------------------------------
// Zoom presets / stepping (Req 4.2)
// ---------------------------------------------------------------------------

/** Minimum / maximum zoom expressed as whole percent (25% .. 400%). */
export const ZOOM_MIN_PERCENT = Math.round(zoomToPercent(ZOOM_MIN));
export const ZOOM_MAX_PERCENT = Math.round(zoomToPercent(ZOOM_MAX));

/** Step size (in percent) for the zoom-in / zoom-out buttons. */
export const ZOOM_STEP_PERCENT = 25;

/**
 * Clamp a zoom percent into `[25, 400]`. Non-finite input falls back to 100%.
 * (Req 4.2)
 */
export function clampZoomPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.round(zoomToPercent(clampZoom(zoomFromPercent(percent))));
}

/**
 * Step the current zoom (a fraction) by `deltaPercent` and return the new,
 * clamped zoom fraction. Used by the +/- zoom buttons. (Req 4.2)
 */
export function stepZoom(currentZoom: number, deltaPercent: number): number {
  const nextPercent = zoomToPercent(clampZoom(currentZoom)) + deltaPercent;
  return clampZoom(zoomFromPercent(nextPercent));
}

/** Format a zoom fraction as a percent label, e.g. `1.0 -> "100%"`. */
export function formatZoomLabel(zoom: number): string {
  return `${Math.round(zoomToPercent(clampZoom(zoom)))}%`;
}

// ---------------------------------------------------------------------------
// Selection state (Req 4.4)
// ---------------------------------------------------------------------------

/**
 * Compute the next selected variation id when a variation is clicked. Clicking
 * the already-selected variation clears the selection (toggle); clicking any
 * other selects it. (Req 4.4)
 */
export function nextSelectedId(
  current: string | null,
  clicked: string,
): string | null {
  return current === clicked ? null : clicked;
}

/**
 * Derive the {@link EditControls} for the currently selected variation, or
 * `null` when nothing is selected. Selecting a variation surfaces edit,
 * regenerate, and duplicate entry points. (Req 4.4)
 */
export function editControlsFor(
  selectedId: string | null,
): EditControls | null {
  return selectedId === null ? null : selectVariation(selectedId);
}

/**
 * Whether a given variation id is the currently selected one. Convenience for
 * deriving the selected styling/aria state per grid cell.
 */
export function isSelected(
  selectedId: string | null,
  variationId: string,
): boolean {
  return selectedId === variationId;
}

// ---------------------------------------------------------------------------
// Batch / variation helpers (Req 4.1)
// ---------------------------------------------------------------------------

/**
 * The list of variations to display for a batch. Returns an empty list for a
 * missing/empty batch so the panel can render its empty state. A completed
 * batch surfaces ALL of its variations. (Req 4.1)
 */
export function variationsToDisplay(
  batch: GenerationBatch | null | undefined,
): DesignVariation[] {
  return batch?.variations ?? [];
}

/** Whether the panel has any variations to show. (Req 4.1) */
export function hasVariations(
  batch: GenerationBatch | null | undefined,
): boolean {
  return variationsToDisplay(batch).length > 0;
}

/**
 * Replace a variation in a batch by id (immutably), e.g. after a successful
 * regenerate/fine-tune returns a new variation. Returns the same batch
 * reference's shape with the matching variation swapped; unmatched ids leave
 * the batch unchanged.
 */
export function replaceVariation(
  batch: GenerationBatch,
  updated: DesignVariation,
): GenerationBatch {
  return {
    ...batch,
    variations: batch.variations.map((v) =>
      v.id === updated.id ? updated : v,
    ),
  };
}

/**
 * Insert a duplicated variation (a local copy with a new id) immediately after
 * its source in the batch. Pure: returns a new batch; the duplicate carries the
 * same brand/design-system/copy/layout so it stays brand-consistent until the
 * user regenerates it. Used by the local "duplicate" entry point. (Req 4.4)
 */
export function duplicateVariation(
  batch: GenerationBatch,
  sourceId: string,
  newId: string,
): GenerationBatch {
  const index = batch.variations.findIndex((v) => v.id === sourceId);
  if (index === -1) return batch;
  const source = batch.variations[index];
  const copy: DesignVariation = { ...source, id: newId, rating: undefined };
  const variations = [
    ...batch.variations.slice(0, index + 1),
    copy,
    ...batch.variations.slice(index + 1),
  ];
  return { ...batch, variations };
}

// ---------------------------------------------------------------------------
// Re-exports for a single panel import surface
// ---------------------------------------------------------------------------

export {
  GRID_MIN_COLUMNS,
  GRID_MAX_COLUMNS,
  ZOOM_MIN,
  ZOOM_MAX,
  type GridColumns,
};
