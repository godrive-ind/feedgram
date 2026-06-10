/**
 * Canvas_Renderer (Layer 4) — interactive preview controls.
 *
 * Pure, framework-agnostic logic for the canvas preview interactions:
 * zoom, pan, comparison grid columns, variation selection (edit controls), and
 * applying a Design_System change to the live preview. None of these functions
 * touch React or the DOM at import time, so they are fully unit/property
 * testable in Node (Vitest + fast-check). The UI layer (`app/page.tsx`,
 * Fabric.js viewport) wires these results into actual rendering.
 *
 * Exposes:
 * - `setZoom(level)`            — clamp to [25%, 400%] (Req 4.2)
 * - `pan(state, dx, dy, bounds)` — offset clamped to content area (Req 4.2)
 * - `setGridColumns(cols)`     — accept only 2..4 (Req 4.3)
 * - `selectVariation(id)`      — return EditControls (Req 4.4)
 * - `applyDesignSystemChange(current, patch)` — merged DesignSystem (Req 4.5)
 *
 * Zoom convention: levels are stored internally as a FRACTION where `1.0`
 * means 100%. The valid range is therefore `[ZOOM_MIN, ZOOM_MAX] = [0.25, 4.0]`
 * (25%–400%). Percent <-> fraction helpers are provided for the UI.
 *
 * See design "Components and Interfaces → Canvas_Renderer" and
 * "Property 14: Kontrol zoom dan pan terbatas".
 *
 * Requirements: 4.2, 4.3, 4.4, 4.5
 */

import type {
  DesignSystem,
  DesignSystemPatch,
  EditControls,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Zoom — constants & helpers (Req 4.2)
// ---------------------------------------------------------------------------

/** Minimum effective zoom, as a fraction. 0.25 === 25%. (Req 4.2) */
export const ZOOM_MIN = 0.25;

/** Maximum effective zoom, as a fraction. 4.0 === 400%. (Req 4.2) */
export const ZOOM_MAX = 4.0;

/** Default zoom, as a fraction. 1.0 === 100%. */
export const ZOOM_DEFAULT = 1.0;

/** Convert a zoom fraction (1.0) to a percent number (100). */
export function zoomToPercent(level: number): number {
  return level * 100;
}

/** Convert a zoom percent (100) to a zoom fraction (1.0). */
export function zoomFromPercent(percent: number): number {
  return percent / 100;
}

/**
 * Clamp a requested zoom fraction into `[ZOOM_MIN, ZOOM_MAX]`.
 *
 * Non-finite input (NaN/Infinity) falls back to {@link ZOOM_DEFAULT} so the
 * preview never enters an invalid zoom state. (Req 4.2)
 */
export function clampZoom(level: number): number {
  if (!Number.isFinite(level)) return ZOOM_DEFAULT;
  if (level < ZOOM_MIN) return ZOOM_MIN;
  if (level > ZOOM_MAX) return ZOOM_MAX;
  return level;
}

/**
 * Compute the effective zoom for a requested level. Alias of {@link clampZoom}
 * matching the `setZoom(level)` interface in the design. Returns the clamped
 * fraction the caller should apply to the viewport. (Req 4.2)
 */
export function setZoom(level: number): number {
  return clampZoom(level);
}

// ---------------------------------------------------------------------------
// Viewport / pan model (Req 4.2)
// ---------------------------------------------------------------------------

/**
 * Immutable viewport state for the preview canvas.
 * `panX`/`panY` are the translation (in viewport pixels) of the content's
 * top-left corner relative to the viewport's top-left corner.
 */
export interface ViewportState {
  /** Zoom as a fraction within [ZOOM_MIN, ZOOM_MAX]. */
  zoom: number;
  /** Horizontal pan offset in viewport pixels. */
  panX: number;
  /** Vertical pan offset in viewport pixels. */
  panY: number;
}

/**
 * Dimensions describing the preview content area and the visible viewport.
 * `contentWidth`/`contentHeight` are the UNSCALED content dimensions; the
 * effective on-screen size is multiplied by the current zoom.
 */
export interface PanBounds {
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
}

/** Create a fresh viewport state at default zoom and no pan. */
export function createViewportState(
  zoom: number = ZOOM_DEFAULT,
): ViewportState {
  return { zoom: clampZoom(zoom), panX: 0, panY: 0 };
}

/**
 * Inclusive `[min, max]` pan range along one axis.
 * Internal helper shared by both axes.
 */
function panRange(viewport: number, content: number, zoom: number): {
  min: number;
  max: number;
} {
  const scaled = content * zoom;
  // Positive when content overflows the viewport (panning is meaningful),
  // negative when content is smaller than the viewport (slack space).
  const overflow = scaled - viewport;
  // Unifies both cases: content edges can never be pulled inside the content
  // area past the viewport edge.
  const lo = Math.min(0, -overflow);
  const hi = Math.max(0, -overflow);
  return { min: lo, max: hi };
}

/** Clamp a scalar into an inclusive range. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Clamp a pan offset so the content never moves past the preview content area
 * bounds, accounting for the current zoom. Returns a corrected
 * `{ panX, panY }`. Non-finite offsets collapse to the nearest valid bound.
 * (Req 4.2)
 */
export function clampPan(
  panX: number,
  panY: number,
  zoom: number,
  bounds: PanBounds,
): { panX: number; panY: number } {
  const z = clampZoom(zoom);
  const x = panRange(bounds.viewportWidth, bounds.contentWidth, z);
  const y = panRange(bounds.viewportHeight, bounds.contentHeight, z);
  const safeX = Number.isFinite(panX) ? panX : 0;
  const safeY = Number.isFinite(panY) ? panY : 0;
  return {
    panX: clamp(safeX, x.min, x.max),
    panY: clamp(safeY, y.min, y.max),
  };
}

/**
 * Apply a pan delta `(dx, dy)` to the viewport and clamp the result to the
 * content area bounds. Non-mutating: returns a NEW {@link ViewportState}.
 *
 * The returned offset is guaranteed to lie within the allowed pan range for
 * the state's (clamped) zoom, so the content can never be dragged past the
 * preview content area. (Req 4.2)
 */
export function pan(
  state: ViewportState,
  dx: number,
  dy: number,
  bounds: PanBounds,
): ViewportState {
  const zoom = clampZoom(state.zoom);
  const dX = Number.isFinite(dx) ? dx : 0;
  const dY = Number.isFinite(dy) ? dy : 0;
  const { panX, panY } = clampPan(
    state.panX + dX,
    state.panY + dY,
    zoom,
    bounds,
  );
  return { zoom, panX, panY };
}

/**
 * Set the viewport zoom (clamped) and re-clamp the existing pan offset against
 * the new zoom so a zoom-out never leaves content outside the content area.
 * Non-mutating. (Req 4.2)
 */
export function zoomViewport(
  state: ViewportState,
  level: number,
  bounds: PanBounds,
): ViewportState {
  const zoom = clampZoom(level);
  const { panX, panY } = clampPan(state.panX, state.panY, zoom, bounds);
  return { zoom, panX, panY };
}

// ---------------------------------------------------------------------------
// Comparison grid columns (Req 4.3)
// ---------------------------------------------------------------------------

/** Minimum number of side-by-side comparison columns. (Req 4.3) */
export const GRID_MIN_COLUMNS = 2;

/** Maximum number of side-by-side comparison columns. (Req 4.3) */
export const GRID_MAX_COLUMNS = 4;

/** Allowed comparison grid column counts. (Req 4.3) */
export type GridColumns = 2 | 3 | 4;

/** Type guard: is `cols` an accepted grid column count (2..4)? (Req 4.3) */
export function isValidGridColumns(cols: number): cols is GridColumns {
  return (
    Number.isInteger(cols) &&
    cols >= GRID_MIN_COLUMNS &&
    cols <= GRID_MAX_COLUMNS
  );
}

/**
 * Accept only 2..4 comparison columns. Returns the validated
 * {@link GridColumns}; throws `RangeError` for out-of-range / non-integer
 * input so callers cannot silently render an unsupported grid. (Req 4.3)
 *
 * Use {@link clampGridColumns} instead when a forgiving clamp is preferred.
 */
export function setGridColumns(cols: number): GridColumns {
  if (!isValidGridColumns(cols)) {
    throw new RangeError(
      `Jumlah kolom grid harus antara ${GRID_MIN_COLUMNS} dan ${GRID_MAX_COLUMNS}; diterima ${cols}.`,
    );
  }
  return cols;
}

/**
 * Clamp an arbitrary number into the valid grid column range `[2, 4]`,
 * rounding to the nearest integer. Non-finite input falls back to
 * {@link GRID_MIN_COLUMNS}. (Req 4.3)
 */
export function clampGridColumns(cols: number): GridColumns {
  if (!Number.isFinite(cols)) return GRID_MIN_COLUMNS;
  const rounded = Math.round(cols);
  const clamped = clamp(rounded, GRID_MIN_COLUMNS, GRID_MAX_COLUMNS);
  return clamped as GridColumns;
}

// ---------------------------------------------------------------------------
// Variation selection -> edit controls (Req 4.4)
// ---------------------------------------------------------------------------

/**
 * Return the {@link EditControls} surfaced when a user selects a variation.
 * Selecting a variation enables edit, regenerate, and duplicate actions for
 * that variation. (Req 4.4)
 */
export function selectVariation(id: string): EditControls {
  return {
    variationId: id,
    canEdit: true,
    canRegenerate: true,
    canDuplicate: true,
  };
}

// ---------------------------------------------------------------------------
// Apply Design_System change to the preview (Req 4.5)
// ---------------------------------------------------------------------------

/**
 * Apply a {@link DesignSystemPatch} to the current {@link DesignSystem},
 * returning a NEW design system reflecting the change so the preview can
 * re-render. Pure merge — undefined patch fields leave the current value
 * untouched; the `logoPosition`/`watermark` patch fields map onto the nested
 * `brandElementPosition`. (Req 4.5)
 */
export function applyDesignSystemChange(
  current: DesignSystem,
  patch: DesignSystemPatch,
): DesignSystem {
  const next: DesignSystem = {
    ...current,
    brandElementPosition: { ...current.brandElementPosition },
  };

  if (patch.headlineFont !== undefined) next.headlineFont = patch.headlineFont;
  if (patch.bodyFont !== undefined) next.bodyFont = patch.bodyFont;
  if (patch.radius !== undefined) next.radius = patch.radius;
  if (patch.layoutDensity !== undefined) {
    next.layoutDensity = patch.layoutDensity;
  }
  if (patch.typographyScale !== undefined) {
    // Copy the array so the result never aliases the patch input.
    next.typographyScale = [...patch.typographyScale];
  }
  if (patch.ctaStyle !== undefined) next.ctaStyle = patch.ctaStyle;
  if (patch.logoPosition !== undefined) {
    next.brandElementPosition.logo = patch.logoPosition;
  }
  if (patch.watermark !== undefined) {
    next.brandElementPosition.watermark = patch.watermark;
  }

  return next;
}

// ---------------------------------------------------------------------------
// CanvasControls aggregate (convenience object for API/UI imports)
// ---------------------------------------------------------------------------

/** Convenience object grouping the Canvas_Renderer preview controls. */
export const CanvasControls = {
  // zoom
  setZoom,
  clampZoom,
  zoomToPercent,
  zoomFromPercent,
  zoomViewport,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_DEFAULT,
  // pan / viewport
  createViewportState,
  pan,
  clampPan,
  // grid
  setGridColumns,
  clampGridColumns,
  isValidGridColumns,
  GRID_MIN_COLUMNS,
  GRID_MAX_COLUMNS,
  // selection + edit
  selectVariation,
  applyDesignSystemChange,
} as const;
