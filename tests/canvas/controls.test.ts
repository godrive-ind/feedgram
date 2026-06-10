import { describe, expect, it } from "vitest";

import {
  setGridColumns,
  clampGridColumns,
  isValidGridColumns,
  selectVariation,
  applyDesignSystemChange,
  GRID_MIN_COLUMNS,
  GRID_MAX_COLUMNS,
} from "@/lib/canvas/controls";
import type { DesignSystem, DesignSystemPatch } from "@/lib/types";

/**
 * Unit tests for Canvas_Renderer interactive controls.
 *
 * - Grid columns accept only 2..4 (Req 4.3)
 * - Variation selection surfaces edit/regenerate/duplicate controls (Req 4.4)
 * - applyDesignSystemChange returns an updated DesignSystem reflecting the
 *   patch (including logoPosition/watermark -> brandElementPosition) without
 *   mutating the input (Req 4.5)
 */

function makeDesignSystem(overrides: Partial<DesignSystem> = {}): DesignSystem {
  return {
    headlineFont: "Inter",
    bodyFont: "Roboto",
    typographyScale: [12, 16, 24, 32],
    radius: 8,
    layoutDensity: "regular",
    brandElementPosition: { logo: "top-left", watermark: "bottom-right" },
    ctaStyle: "solid",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Grid columns — accept only 2..4 (Req 4.3)
// ---------------------------------------------------------------------------

describe("setGridColumns (Req 4.3)", () => {
  it("accepts 2, 3, and 4 and returns the value unchanged", () => {
    expect(setGridColumns(2)).toBe(2);
    expect(setGridColumns(3)).toBe(3);
    expect(setGridColumns(4)).toBe(4);
  });

  it("throws RangeError for values below the minimum", () => {
    expect(() => setGridColumns(1)).toThrow(RangeError);
    expect(() => setGridColumns(0)).toThrow(RangeError);
    expect(() => setGridColumns(-3)).toThrow(RangeError);
  });

  it("throws RangeError for values above the maximum", () => {
    expect(() => setGridColumns(5)).toThrow(RangeError);
    expect(() => setGridColumns(100)).toThrow(RangeError);
  });

  it("throws RangeError for non-integer and non-finite input", () => {
    expect(() => setGridColumns(2.5)).toThrow(RangeError);
    expect(() => setGridColumns(Number.NaN)).toThrow(RangeError);
    expect(() => setGridColumns(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("clampGridColumns (Req 4.3)", () => {
  it("returns valid columns unchanged", () => {
    expect(clampGridColumns(2)).toBe(2);
    expect(clampGridColumns(3)).toBe(3);
    expect(clampGridColumns(4)).toBe(4);
  });

  it("clamps out-of-range values into [2, 4]", () => {
    expect(clampGridColumns(1)).toBe(GRID_MIN_COLUMNS);
    expect(clampGridColumns(0)).toBe(GRID_MIN_COLUMNS);
    expect(clampGridColumns(-10)).toBe(GRID_MIN_COLUMNS);
    expect(clampGridColumns(5)).toBe(GRID_MAX_COLUMNS);
    expect(clampGridColumns(99)).toBe(GRID_MAX_COLUMNS);
  });

  it("rounds fractional values to the nearest integer column", () => {
    expect(clampGridColumns(2.4)).toBe(2);
    expect(clampGridColumns(2.6)).toBe(3);
    expect(clampGridColumns(3.5)).toBe(4);
  });

  it("falls back to the minimum for non-finite input", () => {
    expect(clampGridColumns(Number.NaN)).toBe(GRID_MIN_COLUMNS);
    expect(clampGridColumns(Number.POSITIVE_INFINITY)).toBe(GRID_MIN_COLUMNS);
    expect(clampGridColumns(Number.NEGATIVE_INFINITY)).toBe(GRID_MIN_COLUMNS);
  });
});

describe("isValidGridColumns (Req 4.3)", () => {
  it("is true only for 2, 3, 4", () => {
    expect(isValidGridColumns(2)).toBe(true);
    expect(isValidGridColumns(3)).toBe(true);
    expect(isValidGridColumns(4)).toBe(true);
  });

  it("is false for out-of-range, fractional, and non-finite values", () => {
    expect(isValidGridColumns(1)).toBe(false);
    expect(isValidGridColumns(5)).toBe(false);
    expect(isValidGridColumns(2.5)).toBe(false);
    expect(isValidGridColumns(Number.NaN)).toBe(false);
    expect(isValidGridColumns(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Variation selection -> edit controls (Req 4.4)
// ---------------------------------------------------------------------------

describe("selectVariation (Req 4.4)", () => {
  it("returns EditControls enabling edit, regenerate, and duplicate for the variation", () => {
    const controls = selectVariation("variation-123");
    expect(controls).toEqual({
      variationId: "variation-123",
      canEdit: true,
      canRegenerate: true,
      canDuplicate: true,
    });
  });

  it("carries the selected variation id", () => {
    expect(selectVariation("abc").variationId).toBe("abc");
    expect(selectVariation("").variationId).toBe("");
  });
});

// ---------------------------------------------------------------------------
// applyDesignSystemChange (Req 4.5)
// ---------------------------------------------------------------------------

describe("applyDesignSystemChange (Req 4.5)", () => {
  it("applies scalar patch fields onto a new design system", () => {
    const current = makeDesignSystem();
    const patch: DesignSystemPatch = {
      headlineFont: "Poppins",
      bodyFont: "Lato",
      radius: 16,
      layoutDensity: "spacious",
      ctaStyle: "outline",
    };

    const next = applyDesignSystemChange(current, patch);

    expect(next.headlineFont).toBe("Poppins");
    expect(next.bodyFont).toBe("Lato");
    expect(next.radius).toBe(16);
    expect(next.layoutDensity).toBe("spacious");
    expect(next.ctaStyle).toBe("outline");
  });

  it("maps logoPosition and watermark onto brandElementPosition", () => {
    const current = makeDesignSystem();
    const patch: DesignSystemPatch = {
      logoPosition: "center",
      watermark: "top-left",
    };

    const next = applyDesignSystemChange(current, patch);

    expect(next.brandElementPosition.logo).toBe("center");
    expect(next.brandElementPosition.watermark).toBe("top-left");
  });

  it("leaves undefined patch fields untouched", () => {
    const current = makeDesignSystem();
    const next = applyDesignSystemChange(current, { radius: 24 });

    expect(next.radius).toBe(24);
    expect(next.headlineFont).toBe(current.headlineFont);
    expect(next.bodyFont).toBe(current.bodyFont);
    expect(next.layoutDensity).toBe(current.layoutDensity);
    expect(next.brandElementPosition.logo).toBe(
      current.brandElementPosition.logo,
    );
    expect(next.brandElementPosition.watermark).toBe(
      current.brandElementPosition.watermark,
    );
  });

  it("copies typographyScale without aliasing the patch array", () => {
    const current = makeDesignSystem();
    const patchScale = [10, 20, 40];
    const next = applyDesignSystemChange(current, {
      typographyScale: patchScale,
    });

    expect(next.typographyScale).toEqual(patchScale);
    expect(next.typographyScale).not.toBe(patchScale);

    // Mutating the source array must not affect the result.
    patchScale.push(80);
    expect(next.typographyScale).toEqual([10, 20, 40]);
  });

  it("does not mutate the input design system", () => {
    const current = makeDesignSystem();
    const snapshot = JSON.parse(JSON.stringify(current));

    applyDesignSystemChange(current, {
      headlineFont: "Changed",
      radius: 999,
      logoPosition: "moved",
      watermark: "moved-too",
      typographyScale: [1, 2, 3],
    });

    expect(current).toEqual(snapshot);
    // brandElementPosition is a fresh object on the result, not the input's.
    const next = applyDesignSystemChange(current, { logoPosition: "x" });
    expect(next.brandElementPosition).not.toBe(current.brandElementPosition);
  });
});
