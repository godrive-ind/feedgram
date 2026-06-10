import { describe, expect, it } from "vitest";

import {
  DEFAULT_GRID_COLUMNS,
  GRID_COLUMN_OPTIONS,
  ZOOM_MAX_PERCENT,
  ZOOM_MIN_PERCENT,
  ZOOM_STEP_PERCENT,
  clampZoomPercent,
  duplicateVariation,
  editControlsFor,
  formatZoomLabel,
  gridTemplateColumns,
  hasVariations,
  isSelected,
  nextSelectedId,
  normalizeGridColumns,
  replaceVariation,
  stepZoom,
  variationsToDisplay,
} from "@/app/components/canvas-panel-helpers";
import { ZOOM_DEFAULT } from "@/lib/canvas/controls";
import type {
  BrandDNA,
  CopyContent,
  DesignSystem,
  DesignVariation,
  GenerationBatch,
  ImageAsset,
  LayoutTemplate,
  OutputFormat,
} from "@/lib/types";

// Unit tests for the Center Panel (Canvas Output & Preview) pure helpers
// (task 11.2). Requirements: 4.1, 4.2, 4.3, 4.4

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FORMAT: OutputFormat = { name: "Square", width: 1080, height: 1080 };

const brandDna: BrandDNA = {
  brandName: "Acme",
  accentPalette: ["#2563eb", "#111827"],
  tone: "Profesional",
  visualStyle: "Minimalis",
};

const designSystem: DesignSystem = {
  headlineFont: "Inter",
  bodyFont: "Inter",
  typographyScale: [32, 18],
  radius: 8,
  layoutDensity: "regular",
  brandElementPosition: { logo: "top-left" },
  ctaStyle: "solid",
};

const layout: LayoutTemplate = {
  id: "layout-1",
  format: FORMAT,
  slots: [],
  includedElements: ["CTAButton"],
};

const imageAsset: ImageAsset = {
  id: "img-1",
  url: "https://example.com/a.png",
  width: 1080,
  height: 1080,
};

function makeVariation(id: string): DesignVariation {
  const copy: CopyContent = {
    headline: `Headline ${id}`,
    cta: "Daftar",
    alignedGoal: "Rekrutmen",
    alignedTone: "Profesional",
  };
  return {
    id,
    batchId: "batch-1",
    brandDna,
    designSystem,
    copy,
    layout,
    imageAsset,
    renderedCanvas: { url: "", width: 1080, height: 1080, format: "png" },
  };
}

function makeBatch(ids: string[]): GenerationBatch {
  return {
    id: "batch-1",
    userId: "user-1",
    briefId: "brief-1",
    variations: ids.map(makeVariation),
    status: "done",
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Grid columns (Req 4.3)
// ---------------------------------------------------------------------------

describe("grid columns (Req 4.3)", () => {
  it("offers exactly the 2..4 options with a valid default", () => {
    expect(GRID_COLUMN_OPTIONS).toEqual([2, 3, 4]);
    expect(GRID_COLUMN_OPTIONS).toContain(DEFAULT_GRID_COLUMNS);
  });

  it("clamps out-of-range column requests into 2..4", () => {
    expect(normalizeGridColumns(1)).toBe(2);
    expect(normalizeGridColumns(0)).toBe(2);
    expect(normalizeGridColumns(5)).toBe(4);
    expect(normalizeGridColumns(100)).toBe(4);
    expect(normalizeGridColumns(3)).toBe(3);
  });

  it("rounds fractional requests before clamping", () => {
    expect(normalizeGridColumns(2.4)).toBe(2);
    expect(normalizeGridColumns(3.6)).toBe(4);
  });

  it("builds a grid-template-columns string for the clamped count", () => {
    expect(gridTemplateColumns(3)).toBe("repeat(3, minmax(0, 1fr))");
    expect(gridTemplateColumns(99)).toBe("repeat(4, minmax(0, 1fr))");
  });
});

// ---------------------------------------------------------------------------
// Zoom (Req 4.2)
// ---------------------------------------------------------------------------

describe("zoom helpers (Req 4.2)", () => {
  it("exposes 25%..400% percent bounds", () => {
    expect(ZOOM_MIN_PERCENT).toBe(25);
    expect(ZOOM_MAX_PERCENT).toBe(400);
  });

  it("clamps zoom percent into [25, 400]", () => {
    expect(clampZoomPercent(10)).toBe(25);
    expect(clampZoomPercent(25)).toBe(25);
    expect(clampZoomPercent(100)).toBe(100);
    expect(clampZoomPercent(400)).toBe(400);
    expect(clampZoomPercent(1000)).toBe(400);
  });

  it("falls back to 100% for non-finite percent", () => {
    expect(clampZoomPercent(Number.NaN)).toBe(100);
    expect(clampZoomPercent(Number.POSITIVE_INFINITY)).toBe(100);
  });

  it("steps zoom and stays within the clamped fraction range", () => {
    // From 100% (1.0), stepping down by 25% lands on 0.75.
    expect(stepZoom(ZOOM_DEFAULT, -ZOOM_STEP_PERCENT)).toBeCloseTo(0.75, 5);
    // Stepping far down clamps at 0.25 (25%).
    expect(stepZoom(0.3, -1000)).toBeCloseTo(0.25, 5);
    // Stepping far up clamps at 4.0 (400%).
    expect(stepZoom(3.9, 1000)).toBeCloseTo(4.0, 5);
  });

  it("formats a zoom fraction as a percent label", () => {
    expect(formatZoomLabel(1)).toBe("100%");
    expect(formatZoomLabel(0.25)).toBe("25%");
    expect(formatZoomLabel(4)).toBe("400%");
    // out-of-range gets clamped before formatting
    expect(formatZoomLabel(10)).toBe("400%");
  });
});

// ---------------------------------------------------------------------------
// Selection state (Req 4.4)
// ---------------------------------------------------------------------------

describe("selection state (Req 4.4)", () => {
  it("selects a clicked variation when none/other is selected", () => {
    expect(nextSelectedId(null, "v1")).toBe("v1");
    expect(nextSelectedId("v1", "v2")).toBe("v2");
  });

  it("toggles off when clicking the already-selected variation", () => {
    expect(nextSelectedId("v1", "v1")).toBeNull();
  });

  it("returns null edit controls when nothing is selected", () => {
    expect(editControlsFor(null)).toBeNull();
  });

  it("surfaces edit/regenerate/duplicate controls when selected (Req 4.4)", () => {
    const controls = editControlsFor("v1");
    expect(controls).toEqual({
      variationId: "v1",
      canEdit: true,
      canRegenerate: true,
      canDuplicate: true,
    });
  });

  it("reports whether a given id is selected", () => {
    expect(isSelected("v1", "v1")).toBe(true);
    expect(isSelected("v1", "v2")).toBe(false);
    expect(isSelected(null, "v1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Batch / variation helpers (Req 4.1)
// ---------------------------------------------------------------------------

describe("batch helpers (Req 4.1)", () => {
  it("returns an empty list for a missing/empty batch", () => {
    expect(variationsToDisplay(null)).toEqual([]);
    expect(variationsToDisplay(undefined)).toEqual([]);
    expect(hasVariations(null)).toBe(false);
  });

  it("surfaces all variations when a batch completes", () => {
    const batch = makeBatch(["a", "b", "c"]);
    expect(variationsToDisplay(batch).map((v) => v.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(hasVariations(batch)).toBe(true);
  });

  it("replaces a variation by id immutably", () => {
    const batch = makeBatch(["a", "b"]);
    const updated = { ...makeVariation("b"), rating: 5 };
    const next = replaceVariation(batch, updated);
    expect(next).not.toBe(batch);
    expect(next.variations.find((v) => v.id === "b")?.rating).toBe(5);
    // unrelated variation untouched
    expect(next.variations.find((v) => v.id === "a")).toEqual(
      batch.variations.find((v) => v.id === "a"),
    );
  });

  it("leaves the batch unchanged when replacing an unknown id", () => {
    const batch = makeBatch(["a"]);
    const next = replaceVariation(batch, makeVariation("zzz"));
    expect(next.variations.map((v) => v.id)).toEqual(["a"]);
  });

  it("duplicates a variation right after its source with a new id", () => {
    const batch = makeBatch(["a", "b"]);
    const next = duplicateVariation(batch, "a", "a-copy");
    expect(next.variations.map((v) => v.id)).toEqual(["a", "a-copy", "b"]);
    const copy = next.variations[1];
    expect(copy.batchId).toBe("batch-1");
    expect(copy.brandDna).toEqual(brandDna);
    expect(copy.rating).toBeUndefined();
  });

  it("does not duplicate when the source id is unknown", () => {
    const batch = makeBatch(["a"]);
    const next = duplicateVariation(batch, "missing", "x");
    expect(next.variations.map((v) => v.id)).toEqual(["a"]);
  });
});
