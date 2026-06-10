import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DefaultExportManager,
  readImageDimensions,
  MIN_EXPORT_SHORTEST_SIDE,
  type ImageExportFormat,
} from "@/lib/export/export-manager";
import { InMemoryObjectStorage } from "@/lib/storage/object-storage";
import type {
  BrandDNA,
  CanvasRef,
  CopyContent,
  DesignSystem,
  DesignVariation,
  ImageAsset,
  LayoutTemplate,
  OutputFormat,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Arbitraries
//
// Property 19 must hold for *every* DesignVariation regardless of its source
// format dimensions, so we generate variations whose layout format spans a wide
// range of widths/heights — including portrait, landscape, square, very small
// (well below 1080), and already-large formats. The export contract upscales
// uniformly so the SHORTEST side reaches >= 1080 (Req 6.1); generating small
// and lopsided dimensions exercises that upscaling logic hardest.
// ---------------------------------------------------------------------------

const brandDna: BrandDNA = {
  brandName: "Acme",
  accentPalette: ["#112233"],
  tone: "Profesional",
  visualStyle: "CorporateBlue",
};

const designSystem: DesignSystem = {
  headlineFont: "Inter",
  bodyFont: "Roboto",
  typographyScale: [12, 16, 20, 28, 40],
  radius: 8,
  layoutDensity: "regular",
  brandElementPosition: { logo: "top-left" },
  ctaStyle: "solid",
};

const copy: CopyContent = {
  headline: "Headline",
  cta: "Daftar",
  alignedGoal: "Branding",
  alignedTone: "Profesional",
};

const imageAsset: ImageAsset = {
  id: "img",
  url: "https://example.invalid/img.png",
  width: 1080,
  height: 1080,
};

const canvasRef: CanvasRef = {
  url: "https://example.invalid/canvas.png",
  width: 1080,
  height: 1080,
};

/** Arbitrary output format with a broad range of (possibly lopsided) sizes. */
const formatArb: fc.Arbitrary<OutputFormat> = fc
  .record({
    width: fc.integer({ min: 1, max: 5000 }),
    height: fc.integer({ min: 1, max: 5000 }),
  })
  // The OutputFormat type is a fixed discriminated union, but the export logic
  // only reads `.width`/`.height`; cast so we can probe arbitrary dimensions.
  .map(({ width, height }) => ({ name: "Square", width, height }) as unknown as OutputFormat);

function makeLayout(format: OutputFormat): LayoutTemplate {
  return {
    id: "layout-1",
    format,
    slots: [],
    includedElements: ["LogoStrip", "CTAButton"],
  };
}

const variationArb: fc.Arbitrary<DesignVariation> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0),
    formatArb,
  )
  .map(
    ([id, format]): DesignVariation => ({
      id: `v-${id}`,
      batchId: "batch-1",
      brandDna,
      designSystem,
      copy,
      layout: makeLayout(format),
      imageAsset,
      renderedCanvas: canvasRef,
    }),
  );

const imageFormatArb = fc.constantFrom<ImageExportFormat>("png", "jpg");

// ---------------------------------------------------------------------------
// Property 19: Resolusi ekspor gambar
// ---------------------------------------------------------------------------

describe("Export_Manager.exportImage — image export resolution", () => {
  // Feature: feed-design-generator, Property 19: Untuk setiap DesignVariation, berkas hasil ekspor PNG atau JPG memiliki sisi terpendek >= 1080 piksel.
  // Validates: Requirements 6.1
  it("produces an exported PNG/JPG whose shortest side is >= 1080px for every variation", async () => {
    await fc.assert(
      fc.asyncProperty(
        variationArb,
        imageFormatArb,
        async (variation, fmt) => {
          const storage = new InMemoryObjectStorage();
          const manager = new DefaultExportManager(storage);

          const ref = await manager.exportImage(variation, fmt);
          expect(ref.format).toBe(fmt === "png" ? "image/png" : "image/jpeg");

          // Read the dimensions back from the actual stored bytes (the real
          // exported artifact, not the computed dimensions) to assert Req 6.1.
          // Derive the storage key from the returned FileRef url so we read the
          // real object regardless of any key sanitization the manager applies.
          const key = ref.url.replace("memory://storage/", "");
          const stored = await storage.get(key);
          expect(stored).toBeDefined();

          const dims = readImageDimensions(stored!);
          expect(dims).toBeDefined();
          expect(dims!.format).toBe(fmt);
          expect(Math.min(dims!.width, dims!.height)).toBeGreaterThanOrEqual(
            MIN_EXPORT_SHORTEST_SIDE,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
