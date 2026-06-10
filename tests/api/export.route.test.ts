import { afterEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/export/[id]/route";
import { USER_ID_HEADER } from "@/lib/auth";
import { composeVariation } from "@/lib/canvas/renderer";
import {
  DefaultExportManager,
  ExportError,
  PDF_CMYK_MARKER,
  pdfColorSpace,
  readImageDimensions,
  readZipEntryNames,
  resetExportManager,
  setExportManager,
  type ExportManager,
} from "@/lib/export/export-manager";
import {
  buildLayout,
  deriveBrandDna,
  deriveDesignSystem,
} from "@/lib/pipeline/steps";
import { createInMemoryHistoryManager } from "@/lib/history/history-manager";
import {
  resetHistoryManager,
  setHistoryManager,
} from "@/lib/server/history-provider";
import {
  InMemoryVariationStore,
  resetVariationStore,
  setVariationStore,
  type OwnedVariation,
} from "@/lib/server/variation-store";
import { InMemoryObjectStorage } from "@/lib/storage/object-storage";
import type {
  DesignBriefInput,
  DesignVariation,
  GenerationBatch,
  OutputFormat,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SQUARE: OutputFormat = { name: "Square", width: 1080, height: 1080 };

function makeBrief(): DesignBriefInput {
  return {
    brandName: "Acme",
    tagline: "We build",
    mainMessage: "Join our team",
    contentGoal: "Rekrutmen",
    visualStyle: "CorporateBlue",
    tone: "Profesional",
    outputFormat: SQUARE,
    variationCount: 3,
    accentPalette: ["#112233", "#445566"],
    mandatoryElements: ["LogoStrip", "CTAButton"],
    uploadedAssets: [],
  };
}

function makeVariation(id: string, batchId = "batch-1"): DesignVariation {
  const brief = makeBrief();
  const brandDna = deriveBrandDna(brief);
  const designSystem = deriveDesignSystem(brandDna);
  const layout = buildLayout(brief.outputFormat, brief.mandatoryElements, designSystem);
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
        width: 1080,
        height: 1080,
      },
    },
    { id },
  );
}

function makeBatch(id: string, count: number, userId = "owner"): GenerationBatch {
  return {
    id,
    userId,
    briefId: "brief-1",
    status: "done",
    createdAt: new Date().toISOString(),
    variations: Array.from({ length: count }, (_, i) =>
      makeVariation(`${id}-v${i}`, id),
    ),
  };
}

function installVariationStore(seed: OwnedVariation[]): void {
  setVariationStore(new InMemoryVariationStore(seed));
}

function installRealExporter(): InMemoryObjectStorage {
  const storage = new InMemoryObjectStorage();
  setExportManager(new DefaultExportManager(storage));
  return storage;
}

function makeRequest(userId: string | undefined, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (userId !== undefined) headers.set(USER_ID_HEADER, userId);
  return new Request("https://example.invalid/api/export/x", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  resetVariationStore();
  resetHistoryManager();
  resetExportManager();
});

// ---------------------------------------------------------------------------
// Auth / validation
// ---------------------------------------------------------------------------

describe("POST /api/export/[id]", () => {
  it("returns 401 when the trusted user header is absent", async () => {
    installRealExporter();
    installVariationStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);
    const res = await POST(makeRequest(undefined, { format: "png" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid format", async () => {
    installRealExporter();
    installVariationStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);
    const res = await POST(makeRequest("owner", { format: "gif" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_format");
  });

  it("returns 400 for malformed JSON", async () => {
    installRealExporter();
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(USER_ID_HEADER, "owner");
    const req = new Request("https://example.invalid/api/export/v1", {
      method: "POST",
      headers,
      body: "{ not json",
    });
    const res = await POST(req, { params: { id: "v1" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  // --- Image / PDF (variation) ---------------------------------------------

  it("exports a PNG for the owner (200) and preserves the variation (Req 6.1, 6.5)", async () => {
    const storage = installRealExporter();
    const source = makeVariation("v1");
    installVariationStore([{ variation: source, ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { format: "png" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.format).toBe("png");
    expect(body.fileRef.format).toBe("image/png");
    expect(body.variation.id).toBe(source.id);

    const stored = await storage.get(`exports/${source.batchId}/${source.id}.png`);
    const dims = readImageDimensions(stored!);
    expect(Math.min(dims!.width, dims!.height)).toBeGreaterThanOrEqual(1080);
  });

  it("exports a CMYK PDF for the owner (Req 6.2)", async () => {
    const storage = installRealExporter();
    const source = makeVariation("v1");
    installVariationStore([{ variation: source, ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { format: "pdf" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fileRef.format).toBe("application/pdf");
    const stored = await storage.get(`exports/${source.batchId}/${source.id}.pdf`);
    expect(pdfColorSpace(stored!)).toBe(PDF_CMYK_MARKER);
  });

  it("returns 404 for an unknown variation", async () => {
    installRealExporter();
    installVariationStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);
    const res = await POST(makeRequest("owner", { format: "png" }), {
      params: { id: "missing" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a variation owned by another user (no existence leak)", async () => {
    installRealExporter();
    installVariationStore([{ variation: makeVariation("v1"), ownerUserId: "owner" }]);
    const res = await POST(makeRequest("intruder", { format: "png" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(404);
  });

  // --- ZIP (batch) ---------------------------------------------------------

  it("exports a batch ZIP with one entry per variation (Req 6.3)", async () => {
    const storage = installRealExporter();
    const batch = makeBatch("batch-9", 6);
    const { manager, repo } = createInMemoryHistoryManager();
    await repo.saveBatch(batch, makeBrief());
    setHistoryManager(manager);

    const res = await POST(makeRequest("owner", { format: "zip" }), {
      params: { id: "batch-9" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fileRef.format).toBe("application/zip");

    const stored = await storage.get(`exports/${batch.id}/batch-${batch.id}.zip`);
    expect(readZipEntryNames(stored!)).toHaveLength(6);
  });

  it("returns 404 for a batch owned by another user", async () => {
    installRealExporter();
    const batch = makeBatch("batch-9", 3, "owner");
    const { manager, repo } = createInMemoryHistoryManager();
    await repo.saveBatch(batch, makeBrief());
    setHistoryManager(manager);

    const res = await POST(makeRequest("intruder", { format: "zip" }), {
      params: { id: "batch-9" },
    });
    expect(res.status).toBe(404);
  });

  // --- Failure preservation ------------------------------------------------

  it("returns 502 with the cause and preserves the variation on export failure (Req 6.8)", async () => {
    const failing: ExportManager = {
      async exportImage() {
        throw new ExportError("storage down: timeout");
      },
      async exportPdf() {
        throw new ExportError("storage down: timeout");
      },
      async exportBatchZip() {
        throw new ExportError("storage down: timeout");
      },
    };
    setExportManager(failing);
    const source = makeVariation("v1");
    installVariationStore([{ variation: source, ownerUserId: "owner" }]);

    const res = await POST(makeRequest("owner", { format: "png" }), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("export_failed");
    expect(body.message).toContain("storage down");
    expect(body.variation.id).toBe(source.id);
  });
});
