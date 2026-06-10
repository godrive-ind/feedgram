/**
 * `POST /api/uploads` — accept multipart asset uploads, validate them
 * server-side, and store accepted files in object storage (task 8.4).
 *
 * Flow:
 *   1. Read the trusted authenticated user id from the middleware-injected
 *      `x-fdg-user-id` header (`lib/auth.ts`). Missing header → 401 (defensive;
 *      the middleware already gates `/api/*`).
 *   2. Parse `multipart/form-data` and collect uploaded files from the `files`
 *      (and `file`) form fields.
 *   3. Server-side validation via `Brief_Intake.validateUpload`
 *      (PNG/JPG/JPEG only, ≤10 MB/file, ≤10 files/session) — per-file
 *      accepted/rejected with reasons, never cancelling other valid files
 *      (Req 1.10, 1.11, 1.12).
 *   4. Upload accepted files to object storage via the storage adapter and
 *      return a `FileRef` for each, alongside the rejection reasons.
 *   5. If every file is rejected (and at least one was submitted), return
 *      `400` with the rejection reasons.
 *
 * Runtime: Node.js with a generous `maxDuration` since uploads + storage writes
 * can take time and must not run on the edge runtime.
 *
 * Requirements: 1.10, 1.11, 1.12, keamanan endpoint (Architecture → Keamanan).
 */

import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "@/lib/auth";
import { validateUpload } from "@/lib/intake/upload-validation";
import {
  getObjectStorage,
  type ObjectStorage,
} from "@/lib/storage/object-storage";
import type { FileRef, UploadedFile } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Injectable storage provider (mockable seam)
// ---------------------------------------------------------------------------

let storage: ObjectStorage | undefined;

/** Resolve the object storage, defaulting to the shared adapter. */
function getStorage(): ObjectStorage {
  return storage ?? getObjectStorage();
}

/** Override the storage adapter (used by production wiring and tests). */
export function setObjectStorage(adapter: ObjectStorage): void {
  storage = adapter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A parsed multipart file paired with its raw bytes for storage upload. */
interface ParsedFile {
  meta: UploadedFile;
  bytes: Uint8Array;
}

/**
 * Collect uploaded files from the multipart form. Reads both the `files`
 * (repeated) and `file` (single) fields and ignores non-file entries.
 */
async function collectFiles(form: FormData): Promise<ParsedFile[]> {
  const entries = [...form.getAll("files"), ...form.getAll("file")];
  const parsed: ParsedFile[] = [];

  for (const entry of entries) {
    if (typeof entry === "string") continue; // skip non-file fields
    const file = entry as File;
    const bytes = new Uint8Array(await file.arrayBuffer());
    parsed.push({
      bytes,
      meta: {
        name: file.name,
        // `file.type` may be empty for some clients; validateUpload also falls
        // back to the file-name extension, so both signals are considered.
        mimeType: file.type ?? "",
        sizeBytes: file.size === 0 ? bytes.byteLength : file.size,
      },
    });
  }

  return parsed;
}

/** Build a per-user storage key for an uploaded asset. */
function uploadKey(userId: string, name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `uploads/${userId}/${unique}-${safeName}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  const userId = getAuthenticatedUserId(request.headers);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "Permintaan tidak terautentikasi." },
      { status: 401 },
    );
  }

  // Parse multipart body.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: "Body harus berupa multipart/form-data berisi berkas.",
      },
      { status: 400 },
    );
  }

  const files = await collectFiles(form);
  if (files.length === 0) {
    return NextResponse.json(
      {
        error: "no_files",
        message: "Tidak ada berkas yang diunggah.",
      },
      { status: 400 },
    );
  }

  // Server-side validation (Req 1.10, 1.11, 1.12).
  const validation = validateUpload(files.map((f) => f.meta));

  // Map accepted metadata back to the parsed bytes by file name (in order).
  const bytesByName = new Map<string, Uint8Array[]>();
  for (const f of files) {
    const list = bytesByName.get(f.meta.name) ?? [];
    list.push(f.bytes);
    bytesByName.set(f.meta.name, list);
  }

  // Upload accepted files to object storage.
  const store = getStorage();
  const uploaded: (FileRef & {
    name: string;
    triggerBackgroundRemoval: boolean;
  })[] = [];

  for (const accepted of validation.accepted) {
    const queue = bytesByName.get(accepted.name);
    const data = queue?.shift() ?? new Uint8Array();
    const ref = await store.put({
      key: uploadKey(userId, accepted.name),
      data,
      contentType: accepted.mimeType || "application/octet-stream",
    });
    uploaded.push({
      ...ref,
      name: accepted.name,
      // Accepted files trigger automatic background removal (Req 1.10).
      triggerBackgroundRemoval: accepted.triggerBackgroundRemoval === true,
    });
  }

  // Req 1.11 / 1.12 — if every submitted file was rejected, return 400 with the
  // rejection reasons so the client can surface the format/size/count errors.
  if (validation.accepted.length === 0) {
    return NextResponse.json(
      { uploaded: [], rejected: validation.rejected },
      { status: 400 },
    );
  }

  return NextResponse.json(
    { uploaded, rejected: validation.rejected },
    { status: 200 },
  );
}
