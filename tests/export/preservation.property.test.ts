import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DefaultExportManager,
  ExportError,
  type ImageExportFormat,
} from "@/lib/export/export-manager";
import {
  InMemoryPublishAdapter,
  publishVariation,
  type PublishBehavior,
} from "@/lib/publish/publish-adapter";
import {
  InMemoryObjectStorage,
  type ObjectStorage,
  type PutObjectInput,
} from "@/lib/storage/object-storage";
import {
  PUBLISH_CHANNELS,
  type BrandDNA,
  type CanvasRef,
  type CopyContent,
  type DesignSystem,
  type DesignVariation,
  type FileRef,
  type ImageAsset,
  type LayoutTemplate,
  type OutputFormat,
  type PublishChannel,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Arbitraries
//
// Property 21: for every DesignVariation, after an export OR publish operation
// with ANY outcome (success or failure), the variation remains unchanged and
// can still be re-exported / re-published. We therefore generate:
//   - arbitrary variations,
//   - an operation kind (export-png/jpg/pdf or publish),
//   - an outcome (success or failure) — failures are induced by a failing
//     storage adapter (export) or a failing publish adapter (publish).
// We then assert the variation is byte-for-byte equal before and after, and
// that a second identical operation can be performed (re-export / re-publish).
// ---------------------------------------------------------------------------

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

const brandDnaArb: fc.Arbitrary<BrandDNA> = fc.record({
  brandName: fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => s.trim().length > 0),
  accentPalette: fc.array(
    fc
      .integer({ min: 0, max: 0xffffff })
      .map((n) => `#${n.toString(16).padStart(6, "0")}`),
    { minLength: 1, maxLength: 4 },
  ),
  tone: fc.constant("Profesional"),
  visualStyle: fc.constant("CorporateBlue"),
}) as fc.Arbitrary<BrandDNA>;

const variationArb: fc.Arbitrary<DesignVariation> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0),
    brandDnaArb,
  )
  .map(
    ([id, brandDna]): DesignVariation => ({
      id: `v-${id}`,
      batchId: "batch-1",
      brandDna,
      designSystem,
      copy,
      layout: makeLayout(SQUARE),
      imageAsset,
      renderedCanvas: canvasRef,
    }),
  );

/** An object storage that always rejects writes (induces export failure). */
class FailingObjectStorage implements ObjectStorage {
  async put(_input: PutObjectInput): Promise<FileRef> {
    throw new Error("storage unavailable");
  }
  async get(): Promise<Uint8Array | undefined> {
    return undefined;
  }
}

type Operation =
  | { kind: "export"; fmt: ImageExportFormat | "pdf"; succeed: boolean }
  | { kind: "publish"; channel: PublishChannel; behavior: PublishBehavior };

const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({
    kind: fc.constant("export" as const),
    fmt: fc.constantFrom<ImageExportFormat | "pdf">("png", "jpg", "pdf"),
    succeed: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("publish" as const),
    channel: fc.constantFrom<PublishChannel>(...PUBLISH_CHANNELS),
    behavior: fc.constantFrom<PublishBehavior>(
      "succeed",
      "fail",
      "fail-then-succeed",
    ),
  }),
);

/** Run one export/publish operation; swallow induced failures. */
async function runOperation(
  variation: DesignVariation,
  op: Operation,
): Promise<void> {
  if (op.kind === "export") {
    const storage = op.succeed
      ? new InMemoryObjectStorage()
      : new FailingObjectStorage();
    const manager = new DefaultExportManager(storage);
    try {
      if (op.fmt === "pdf") await manager.exportPdf(variation);
      else await manager.exportImage(variation, op.fmt);
    } catch (err) {
      // Failure is an allowed outcome; only ExportError is expected.
      expect(err).toBeInstanceOf(ExportError);
    }
  } else {
    const adapter = new InMemoryPublishAdapter({ behavior: op.behavior });
    // publishVariation never throws; it returns success/failure either way.
    await publishVariation(variation, op.channel, { adapter });
  }
}

// ---------------------------------------------------------------------------
// Property 21: Variasi dipertahankan terlepas dari hasil ekspor/publikasi
// ---------------------------------------------------------------------------

describe("Export_Manager — variation preserved regardless of export/publish outcome", () => {
  // Feature: feed-design-generator, Property 21: Untuk setiap DesignVariation, setelah operasi ekspor atau publikasi dengan hasil apa pun (sukses atau gagal), variasi tersebut tetap tidak berubah dan masih dapat diekspor atau dipublikasikan ulang.
  // Validates: Requirements 6.5, 6.6, 6.8
  it("leaves the variation unchanged and re-exportable/re-publishable after any outcome", async () => {
    await fc.assert(
      fc.asyncProperty(
        variationArb,
        operationArb,
        async (variation, op) => {
          const before = JSON.stringify(variation);

          // First operation (success or induced failure).
          await runOperation(variation, op);

          // Variation is byte-for-byte unchanged (Req 6.5 / 6.6 / 6.8).
          expect(JSON.stringify(variation)).toBe(before);

          // It can still be re-exported AND re-published (success outcome) to
          // prove it remains a usable, re-operable variation.
          const okStorage = new InMemoryObjectStorage();
          const okManager = new DefaultExportManager(okStorage);
          const reExport = await okManager.exportImage(variation, "png");
          expect(reExport.format).toBe("image/png");

          const okAdapter = new InMemoryPublishAdapter({ behavior: "succeed" });
          const rePublish = await publishVariation(
            variation,
            PUBLISH_CHANNELS[0],
            { adapter: okAdapter },
          );
          expect(rePublish.success).toBe(true);

          // Still unchanged after the re-operations.
          expect(JSON.stringify(variation)).toBe(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});
