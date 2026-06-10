/**
 * `POST /api/export/[id]` — export a design variation or batch (tasks 12.1,
 * 12.4, 12.6).
 *
 * Backs the Export_Manager export responsibilities (design "Components and
 * Interfaces → Export_Manager"): produce a downloadable artifact for a
 * {@link DesignVariation} (PNG/JPG image, Req 6.1; CMYK print-ready PDF, Req
 * 6.2) or for a whole {@link GenerationBatch} (a single ZIP of every variation,
 * Req 6.3), upload it to object storage, and return the resulting
 * {@link FileRef}.
 *
 * Request body (JSON):
 *   { "format": "png" | "jpg" | "pdf" }   — the `[id]` is a VARIATION id
 *   { "format": "zip" }                   — the `[id]` is a BATCH id
 *
 * Authentication & authorization (design "Architecture → Keamanan"):
 *   - The authenticated user id is read from the trusted middleware-injected
 *     header (`x-fdg-user-id`, via `getAuthenticatedUserId`). Absent → 401.
 *   - Per-user ownership is enforced with `authorizeOwnership`. Consistent with
 *     the jobs/variations/publish routes, BOTH an unknown resource and one
 *     owned by another user return **404** so the API never leaks the existence
 *     of another user's variation/batch.
 *     - image/pdf: ownership comes from the variation's owning user
 *       (`variation-store`).
 *     - zip: ownership comes from the batch's `userId` (`history-manager`).
 *
 * Outcome:
 *   - On success → 200 with the {@link FileRef} (and an echo of `format`).
 *   - On export failure (e.g. a storage write error) → 502 with the cause
 *     message; the variation/batch is preserved unchanged (Req 6.8), since
 *     export is a pure read.
 *
 * Runtime: Node.js (the export encoders run server-side; not Edge). The image
 * export budget is ≤30s (Req 6.1); `maxDuration` accommodates a batch ZIP too.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5, 6.8
 */

import { NextResponse } from "next/server";

import { authorizeOwnership, getAuthenticatedUserId } from "@/lib/auth";
import {
  ExportError,
  getExportManager,
  type ImageExportFormat,
} from "@/lib/export/export-manager";
import { getHistoryManager } from "@/lib/server/history-provider";
import { getVariationStore } from "@/lib/server/variation-store";

export const runtime = "nodejs";
/** Image export budget is ≤30s (Req 6.1); allow headroom for a batch ZIP. */
export const maxDuration = 60;
// Exports are on-demand artifacts; never cache.
export const dynamic = "force-dynamic";

/** The export formats this route accepts. */
type ExportFormat = ImageExportFormat | "pdf" | "zip";

const VARIATION_FORMATS: ReadonlySet<string> = new Set(["png", "jpg", "pdf"]);

function isExportFormat(value: unknown): value is ExportFormat {
  return (
    typeof value === "string" &&
    (value === "png" || value === "jpg" || value === "pdf" || value === "zip")
  );
}

export async function POST(
  request: Request,
  context: { params: { id: string } },
): Promise<NextResponse> {
  const { id } = context.params;

  // 1. Authentication — trust only the middleware-injected header (fail closed).
  const userId = getAuthenticatedUserId(request.headers);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "Permintaan tidak terautentikasi." },
      { status: 401 },
    );
  }

  if (!id) {
    return NextResponse.json(
      { error: "not_found", message: "Sumber daya tidak ditemukan." },
      { status: 404 },
    );
  }

  // 2. Parse the JSON body defensively.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "invalid_json",
        message: "Body permintaan bukan JSON yang valid.",
      },
      { status: 400 },
    );
  }

  // 3. Validate the requested format.
  const format = (body ?? {}) as Record<string, unknown>;
  if (!isExportFormat(format.format)) {
    return NextResponse.json(
      {
        error: "invalid_format",
        message: 'Field "format" harus salah satu dari: png, jpg, pdf, zip.',
      },
      { status: 400 },
    );
  }
  const targetFormat = format.format;

  const exporter = getExportManager();

  // 4a. ZIP — the id refers to a BATCH; ownership comes from the batch userId.
  if (targetFormat === "zip") {
    const record = await getHistoryManager().loadBatch(id);
    if (!record || !authorizeOwnership(userId, record.batch.userId)) {
      return NextResponse.json(
        { error: "not_found", message: "Batch tidak ditemukan." },
        { status: 404 },
      );
    }

    try {
      const fileRef = await exporter.exportBatchZip(record.batch);
      return NextResponse.json({ format: targetFormat, fileRef }, { status: 200 });
    } catch (error) {
      return exportFailure(error, { batch: record.batch.id });
    }
  }

  // 4b. Image / PDF — the id refers to a VARIATION; ownership from its owner.
  if (VARIATION_FORMATS.has(targetFormat)) {
    const owned = await getVariationStore().getVariation(id);
    if (!owned || !authorizeOwnership(userId, owned.ownerUserId)) {
      return NextResponse.json(
        { error: "not_found", message: "Variasi tidak ditemukan." },
        { status: 404 },
      );
    }

    try {
      const fileRef =
        targetFormat === "pdf"
          ? await exporter.exportPdf(owned.variation)
          : await exporter.exportImage(
              owned.variation,
              targetFormat as ImageExportFormat,
            );
      // Export is a pure read; the variation is preserved unchanged (Req 6.5).
      return NextResponse.json(
        { format: targetFormat, fileRef, variation: owned.variation },
        { status: 200 },
      );
    } catch (error) {
      return exportFailure(error, { variation: owned.variation });
    }
  }

  // Unreachable given the format guard, but keep the handler total.
  return NextResponse.json(
    { error: "invalid_format", message: "Format ekspor tidak didukung." },
    { status: 400 },
  );
}

/**
 * Build a 502 failure response for a failed export. The variation/batch is
 * preserved unchanged and the cause message is surfaced (Req 6.8).
 */
function exportFailure(
  error: unknown,
  preserved: { variation?: unknown; batch?: unknown },
): NextResponse {
  const message =
    error instanceof ExportError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return NextResponse.json(
    {
      error: "export_failed",
      message,
      ...preserved,
    },
    { status: 502 },
  );
}
