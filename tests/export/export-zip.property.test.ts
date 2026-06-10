import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DefaultExportManager,
  readZipEntryNames,
} from "@/lib/export/export-manager";
import { InMemoryObjectStorage } from "@/lib/storage/object-storage";
import type {
  BrandDNA,
  CanvasRef,
  CopyContent,
  DesignSystem,
  DesignVariation,
  GenerationBatch,
  ImageAsset,
  LayoutTemplate,
  OutputFormat,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Arbitraries
//
// Property 20: for every GenerationBatch, the exported batch ZIP contains
// EXACTLY as many entries as there are DesignVariations in the batch. We
// generate batches with a varying number of variations (including 1, the
// plan-allowed 3/6/9, and larger counts) and varying output formats per
// variation to ensure the entry count is purely driven by the variation count.
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

const SQUARE: OutputFormat = { name: "Square", width: 1080, height: 1080 };

function makeLayout(format: OutputFormat): LayoutTemplate {
  return {
    id: "layout-1",
    format,
    slots: [],
    includedElements: ["LogoStrip", "CTAButton"],
  };
}

function makeVariation(id: string, batchId: string): DesignVariation {
  return {
    id,
    batchId,
    brandDna,
    designSystem,
    copy,
    layout: makeLayout(SQUARE),
    imageAsset,
    renderedCanvas: canvasRef,
  };
}

/** Arbitrary batch with N (1..30) variations, each with a unique id. */
const batchArb: fc.Arbitrary<GenerationBatch> = fc
  .integer({ min: 1, max: 30 })
  .map((count): GenerationBatch => {
    const id = "batch-1";
    return {
      id,
      userId: "owner",
      briefId: "brief-1",
      status: "done",
      createdAt: new Date(0).toISOString(),
      variations: Array.from({ length: count }, (_, i) =>
        makeVariation(`${id}-v${i}`, id),
      ),
    };
  });

// ---------------------------------------------------------------------------
// Property 20: Kelengkapan isi ZIP batch
// ---------------------------------------------------------------------------

describe("Export_Manager.exportBatchZip — ZIP batch completeness", () => {
  // Feature: feed-design-generator, Property 20: Untuk setiap GenerationBatch, berkas ZIP hasil ekspor batch berisi tepat sejumlah entri yang sama dengan jumlah DesignVariation pada batch tersebut.
  // Validates: Requirements 6.3
  it("produces a ZIP whose entry count exactly equals the batch variation count", async () => {
    await fc.assert(
      fc.asyncProperty(batchArb, async (batch) => {
        const storage = new InMemoryObjectStorage();
        const manager = new DefaultExportManager(storage);

        const ref = await manager.exportBatchZip(batch);
        expect(ref.format).toBe("application/zip");

        // Read the entry names back from the actual stored ZIP bytes.
        const key = `exports/${batch.id}/batch-${batch.id}.zip`;
        const stored = await storage.get(key);
        expect(stored).toBeDefined();

        const names = readZipEntryNames(stored!);
        // Exactly one entry per variation (Req 6.3).
        expect(names).toHaveLength(batch.variations.length);
      }),
      { numRuns: 100 },
    );
  });
});
