import { describe, expect, it } from "vitest";

import {
  computeExportDimensions,
  createZip,
  DefaultExportManager,
  encodeCmykPdf,
  encodeJpeg,
  encodePng,
  ExportError,
  MIN_EXPORT_SHORTEST_SIDE,
  PDF_CMYK_MARKER,
  pdfColorSpace,
  readImageDimensions,
  readZipEntryNames,
} from "@/lib/export/export-manager";
import { composeVariation } from "@/lib/canvas/renderer";
import {
  buildLayout,
  deriveBrandDna,
  deriveDesignSystem,
} from "@/lib/pipeline/steps";
import { InMemoryObjectStorage, type ObjectStorage } from "@/lib/storage/object-storage";
import type {
  DesignBriefInput,
  DesignVariation,
  GenerationBatch,
  OutputFormat,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBrief(format: OutputFormat): DesignBriefInput {
  return {
    brandName: "Acme",
    tagline: "We build",
    mainMessage: "Join our team",
    contentGoal: "Rekrutmen",
    visualStyle: "CorporateBlue",
    tone: "Profesional",
    outputFormat: format,
    variationCount: 3,
    accentPalette: ["#112233", "#445566"],
    mandatoryElements: ["LogoStrip", "CTAButton"],
    uploadedAssets: [],
  };
}

function makeVariation(
  id: string,
  format: OutputFormat,
  batchId = "batch-1",
): DesignVariation {
  const brief = makeBrief(format);
  const brandDna = deriveBrandDna(brief);
  const designSystem = deriveDesignSystem(brandDna);
  const layout = buildLayout(format, brief.mandatoryElements, designSystem);
  return composeVariation(
    {
      batchId,
      brandDna,
      designSystem,
      copy: {
        headline: brief.brandName,
        cta: "Pelajari",
        alignedGoal: brief.contentGoal,
        alignedTone: brief.tone,
      },
      layout,
      imageAsset: {
        id: "src-img",
        url: "https://example.invalid/src.png",
        width: format.width,
        height: format.height,
      },
    },
    { id },
  );
}

function makeBatch(id: string, count: number): GenerationBatch {
  const format: OutputFormat = { name: "Square", width: 1080, height: 1080 };
  return {
    id,
    userId: "owner",
    briefId: "brief-1",
    status: "done",
    createdAt: new Date().toISOString(),
    variations: Array.from({ length: count }, (_, i) =>
      makeVariation(`${id}-v${i}`, format, id),
    ),
  };
}

const LANDSCAPE: OutputFormat = { name: "Landscape", width: 1200, height: 628 };
const SQUARE: OutputFormat = { name: "Square", width: 1080, height: 1080 };

// ---------------------------------------------------------------------------
// Dimension contract (Req 6.1)
// ---------------------------------------------------------------------------

describe("computeExportDimensions", () => {
  it("upscales so the shortest side is >= 1080 (Landscape 1200x628)", () => {
    const v = makeVariation("v1", LANDSCAPE);
    const dims = computeExportDimensions(v);
    expect(Math.min(dims.width, dims.height)).toBeGreaterThanOrEqual(
      MIN_EXPORT_SHORTEST_SIDE,
    );
    // Aspect ratio preserved (within rounding).
    expect(dims.width / dims.height).toBeCloseTo(1200 / 628, 1);
  });

  it("keeps native size when already >= 1080 on the shortest side", () => {
    const v = makeVariation("v1", SQUARE);
    expect(computeExportDimensions(v)).toEqual({ width: 1080, height: 1080 });
  });
});

// ---------------------------------------------------------------------------
// Image encoders (Req 6.1)
// ---------------------------------------------------------------------------

describe("image encoders", () => {
  it("encodes a PNG whose IHDR reports the requested dimensions", () => {
    const png = encodePng(1080, 1350);
    const dims = readImageDimensions(png);
    expect(dims).toEqual({ format: "png", width: 1080, height: 1350 });
  });

  it("encodes a JPEG whose SOF0 reports the requested dimensions", () => {
    const jpg = encodeJpeg(1080, 1920);
    const dims = readImageDimensions(jpg);
    expect(dims).toEqual({ format: "jpg", width: 1080, height: 1920 });
  });
});

// ---------------------------------------------------------------------------
// PDF CMYK (Req 6.2)
// ---------------------------------------------------------------------------

describe("encodeCmykPdf", () => {
  it("produces a PDF that declares the DeviceCMYK color space", () => {
    const pdf = encodeCmykPdf(1080, 1080);
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toContain(`/${PDF_CMYK_MARKER}`);
    expect(pdfColorSpace(pdf)).toBe(PDF_CMYK_MARKER);
  });
});

// ---------------------------------------------------------------------------
// ZIP (Req 6.3)
// ---------------------------------------------------------------------------

describe("createZip / readZipEntryNames", () => {
  it("round-trips entry names with the correct count", () => {
    const entries = [
      { name: "a.png", data: new Uint8Array([1, 2, 3]) },
      { name: "b.png", data: new Uint8Array([4, 5]) },
      { name: "c.png", data: new Uint8Array([6]) },
    ];
    const zip = createZip(entries);
    const names = readZipEntryNames(zip);
    expect(names).toEqual(["a.png", "b.png", "c.png"]);
  });
});

// ---------------------------------------------------------------------------
// DefaultExportManager (storage contract + preservation)
// ---------------------------------------------------------------------------

describe("DefaultExportManager", () => {
  it("exportImage uploads a PNG with shortest side >= 1080 and returns a FileRef", async () => {
    const storage = new InMemoryObjectStorage();
    const manager = new DefaultExportManager(storage);
    const v = makeVariation("v1", LANDSCAPE);

    const ref = await manager.exportImage(v, "png");
    expect(ref.format).toBe("image/png");
    expect(ref.bytes).toBeGreaterThan(0);

    const stored = await storage.get(`exports/${v.batchId}/${v.id}.png`);
    expect(stored).toBeDefined();
    const dims = readImageDimensions(stored!);
    expect(dims?.format).toBe("png");
    expect(Math.min(dims!.width, dims!.height)).toBeGreaterThanOrEqual(1080);
  });

  it("exportImage as jpg uploads a JPEG file", async () => {
    const storage = new InMemoryObjectStorage();
    const manager = new DefaultExportManager(storage);
    const v = makeVariation("v1", SQUARE);

    const ref = await manager.exportImage(v, "jpg");
    expect(ref.format).toBe("image/jpeg");
    const stored = await storage.get(`exports/${v.batchId}/${v.id}.jpg`);
    expect(readImageDimensions(stored!)?.format).toBe("jpg");
  });

  it("exportPdf uploads a CMYK PDF", async () => {
    const storage = new InMemoryObjectStorage();
    const manager = new DefaultExportManager(storage);
    const v = makeVariation("v1", SQUARE);

    const ref = await manager.exportPdf(v);
    expect(ref.format).toBe("application/pdf");
    const stored = await storage.get(`exports/${v.batchId}/${v.id}.pdf`);
    expect(pdfColorSpace(stored!)).toBe(PDF_CMYK_MARKER);
  });

  it("exportBatchZip produces one ZIP entry per variation (Req 6.3)", async () => {
    const storage = new InMemoryObjectStorage();
    const manager = new DefaultExportManager(storage);
    const batch = makeBatch("batch-9", 6);

    const ref = await manager.exportBatchZip(batch);
    expect(ref.format).toBe("application/zip");
    const stored = await storage.get(
      `exports/${batch.id}/batch-${batch.id}.zip`,
    );
    const names = readZipEntryNames(stored!);
    expect(names).toHaveLength(batch.variations.length);
  });

  it("preserves the variation and surfaces a cause on storage failure (Req 6.8)", async () => {
    const failing: ObjectStorage = {
      async put() {
        throw new Error("R2 unavailable");
      },
      async get() {
        return undefined;
      },
    };
    const manager = new DefaultExportManager(failing);
    const v = makeVariation("v1", SQUARE);
    const before = JSON.stringify(v);

    await expect(manager.exportImage(v, "png")).rejects.toBeInstanceOf(
      ExportError,
    );
    try {
      await manager.exportImage(v, "png");
    } catch (err) {
      expect((err as ExportError).message).toContain("R2 unavailable");
    }
    // Variation untouched (pure read).
    expect(JSON.stringify(v)).toBe(before);
  });
});
