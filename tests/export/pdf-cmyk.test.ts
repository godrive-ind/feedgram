import { describe, expect, it } from "vitest";

import {
  DefaultExportManager,
  encodeCmykPdf,
  PDF_CMYK_MARKER,
  pdfColorSpace,
} from "@/lib/export/export-manager";
import { composeVariation } from "@/lib/canvas/renderer";
import {
  buildLayout,
  deriveBrandDna,
  deriveDesignSystem,
} from "@/lib/pipeline/steps";
import { InMemoryObjectStorage } from "@/lib/storage/object-storage";
import type {
  DesignBriefInput,
  DesignVariation,
  OutputFormat,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Task 12.5 — Unit test: PDF CMYK color space (Req 6.2)
//
// Verifies that the exported PDF's metadata indicates a CMYK color space. The
// CMYK contract is asserted from the produced bytes two ways:
//   1. the `%FDG-COLORSPACE:DeviceCMYK` header marker, and
//   2. the `/DeviceCMYK` ColorSpace resource in the page object.
// Both are surfaced by `pdfColorSpace`, which returns the marker only when the
// document declares DeviceCMYK.
// ---------------------------------------------------------------------------

const SQUARE: OutputFormat = { name: "Square", width: 1080, height: 1080 };
const PORTRAIT: OutputFormat = { name: "InstagramFeed", width: 1080, height: 1350 };

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

function makeVariation(id: string, format: OutputFormat): DesignVariation {
  const brief = makeBrief(format);
  const brandDna = deriveBrandDna(brief);
  const designSystem = deriveDesignSystem(brandDna);
  const layout = buildLayout(format, brief.mandatoryElements, designSystem);
  return composeVariation(
    {
      batchId: "batch-1",
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

describe("encodeCmykPdf — CMYK color space metadata (Req 6.2)", () => {
  it("emits a well-formed PDF that declares the DeviceCMYK color space", () => {
    const pdf = encodeCmykPdf(1080, 1080);
    const text = new TextDecoder("latin1").decode(pdf);

    // Structurally a PDF.
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    // Color space metadata indicates CMYK (Req 6.2).
    expect(pdfColorSpace(pdf)).toBe(PDF_CMYK_MARKER);
    // The page resource dictionary declares the DeviceCMYK color space.
    expect(text).toContain("/DeviceCMYK");
    // And the header marker advertises it too.
    expect(text).toContain(`%FDG-COLORSPACE:${PDF_CMYK_MARKER}`);
  });

  it("does NOT report CMYK for a document without the DeviceCMYK marker", () => {
    const notCmyk = new TextEncoder().encode(
      "%PDF-1.7\n/DeviceRGB\n%%EOF\n",
    );
    expect(pdfColorSpace(notCmyk)).toBeUndefined();
  });

  it("declares CMYK regardless of page dimensions", () => {
    for (const [w, h] of [
      [1080, 1080],
      [1080, 1350],
      [1200, 628],
    ] as const) {
      expect(pdfColorSpace(encodeCmykPdf(w, h))).toBe(PDF_CMYK_MARKER);
    }
  });
});

describe("DefaultExportManager.exportPdf — exported PDF is CMYK (Req 6.2)", () => {
  it("uploads a PDF whose stored bytes declare the DeviceCMYK color space", async () => {
    const storage = new InMemoryObjectStorage();
    const manager = new DefaultExportManager(storage);
    const variation = makeVariation("v1", SQUARE);

    const ref = await manager.exportPdf(variation);
    expect(ref.format).toBe("application/pdf");
    expect(ref.bytes).toBeGreaterThan(0);

    const stored = await storage.get(
      `exports/${variation.batchId}/${variation.id}.pdf`,
    );
    expect(stored).toBeDefined();
    expect(pdfColorSpace(stored!)).toBe(PDF_CMYK_MARKER);
  });

  it("declares CMYK for a portrait variation too", async () => {
    const storage = new InMemoryObjectStorage();
    const manager = new DefaultExportManager(storage);
    const variation = makeVariation("v2", PORTRAIT);

    await manager.exportPdf(variation);
    const stored = await storage.get(
      `exports/${variation.batchId}/${variation.id}.pdf`,
    );
    expect(pdfColorSpace(stored!)).toBe(PDF_CMYK_MARKER);
  });
});
