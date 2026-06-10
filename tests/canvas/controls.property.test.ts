import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  setZoom,
  clampZoom,
  pan,
  clampPan,
  createViewportState,
  ZOOM_MIN,
  ZOOM_MAX,
  type PanBounds,
} from "@/lib/canvas/controls";

/**
 * Feature: feed-design-generator, Property 14: Kontrol zoom dan pan terbatas —
 * Untuk setiap nilai zoom yang diminta, level zoom efektif selalu di-clamp ke
 * rentang [25%, 400%]; dan untuk setiap operasi pan, offset hasil tidak pernah
 * melewati batas area konten preview.
 *
 * Validates: Requirements 4.2
 */

// Arbitrary numbers spanning in-range, out-of-range, negatives, and the
// non-finite values (NaN / +Infinity / -Infinity) the clamp must tolerate.
const anyNumber = fc.oneof(
  fc.double({ noNaN: false }), // includes NaN, +/-Infinity, and finite doubles
  fc.integer({ min: -10_000, max: 10_000 }),
  fc.double({ min: -1000, max: 1000, noNaN: true }),
  fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    ZOOM_MIN,
    ZOOM_MAX,
    0,
  ),
);

// Positive, finite dimensions for the viewport / content area.
const positiveDim = fc.double({ min: 1, max: 10_000, noNaN: true });

const boundsArb: fc.Arbitrary<PanBounds> = fc.record({
  viewportWidth: positiveDim,
  viewportHeight: positiveDim,
  contentWidth: positiveDim,
  contentHeight: positiveDim,
});

describe("Feature: feed-design-generator, Property 14: Kontrol zoom dan pan terbatas", () => {
  it("effective zoom is always clamped to [0.25, 4.0] and pan never exceeds content bounds", () => {
    fc.assert(
      fc.property(
        anyNumber, // requested zoom
        anyNumber, // dx
        anyNumber, // dy
        boundsArb,
        (requestedZoom, dx, dy, bounds) => {
          // --- Zoom clamping ---
          const effectiveZoom = setZoom(requestedZoom);
          expect(Number.isFinite(effectiveZoom)).toBe(true);
          expect(effectiveZoom).toBeGreaterThanOrEqual(ZOOM_MIN);
          expect(effectiveZoom).toBeLessThanOrEqual(ZOOM_MAX);
          // setZoom is the clampZoom alias.
          expect(effectiveZoom).toBe(clampZoom(requestedZoom));

          // --- Pan clamping ---
          const state = createViewportState(requestedZoom);
          const next = pan(state, dx, dy, bounds);

          // Resulting offset must lie within the allowed pan range for the
          // (clamped) zoom — i.e. content edges never pulled past the
          // viewport edge.
          const z = next.zoom;
          const overflowX = bounds.contentWidth * z - bounds.viewportWidth;
          const overflowY = bounds.contentHeight * z - bounds.viewportHeight;
          const xLo = Math.min(0, -overflowX);
          const xHi = Math.max(0, -overflowX);
          const yLo = Math.min(0, -overflowY);
          const yHi = Math.max(0, -overflowY);

          expect(Number.isFinite(next.panX)).toBe(true);
          expect(Number.isFinite(next.panY)).toBe(true);
          expect(next.panX).toBeGreaterThanOrEqual(xLo);
          expect(next.panX).toBeLessThanOrEqual(xHi);
          expect(next.panY).toBeGreaterThanOrEqual(yLo);
          expect(next.panY).toBeLessThanOrEqual(yHi);

          // The viewport zoom carried on the panned state is itself clamped.
          expect(next.zoom).toBeGreaterThanOrEqual(ZOOM_MIN);
          expect(next.zoom).toBeLessThanOrEqual(ZOOM_MAX);

          // clampPan is idempotent: re-clamping an already-clamped offset is a
          // no-op, confirming the result is strictly within bounds.
          const reclamped = clampPan(next.panX, next.panY, next.zoom, bounds);
          expect(reclamped.panX).toBe(next.panX);
          expect(reclamped.panY).toBe(next.panY);
        },
      ),
      { numRuns: 300 },
    );
  });
});
