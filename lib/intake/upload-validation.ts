/**
 * Brief_Intake (Layer 1) — pure validation logic for uploaded assets.
 *
 * Implements `validateUpload`, which validates a list of uploaded files against
 * three independent per-file rules and partitions them into `accepted` and
 * `rejected`. A single failing file never cancels other valid files.
 *
 * Rules (Req 1.10, 1.11, 1.12):
 * - Format: only PNG/JPG/JPEG are accepted; otherwise rejected with reason
 *   `"format"`.
 * - Size: files larger than 10 MB are rejected with reason `"size"`.
 * - Count: at most 10 files may be accepted per session; format+size-valid
 *   files beyond that budget are rejected with reason `"count"`.
 *
 * Accepted files are marked with `triggerBackgroundRemoval = true` so the
 * session can fire automatic background removal for them (Req 1.10).
 *
 * Pure logic only — no I/O. See design "Components and Interfaces → Brief_Intake".
 *
 * Requirements: 1.10, 1.11, 1.12
 */

import type {
  UploadedFile,
  UploadRejectionReason,
  UploadValidationResult,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Upload limits & allowed formats (Req 1.10, 1.11, 1.12)
// ---------------------------------------------------------------------------

/** Maximum size per uploaded file: 10 MB. Req 1.10, 1.12 */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Maximum number of accepted files per session: 10. Req 1.10, 1.12 */
export const MAX_FILES_PER_SESSION = 10;

/** Allowed MIME types for uploaded assets. Req 1.10, 1.11 */
export const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
] as const;

/** Allowed file extensions (lowercase, without leading dot). Req 1.10, 1.11 */
export const ALLOWED_EXTENSIONS = ["png", "jpg", "jpeg"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the lowercase extension (without dot) from a file name. */
function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * A file is an accepted image format when EITHER its MIME type OR its file-name
 * extension matches one of the allowed PNG/JPG/JPEG values. This tolerates
 * uploads where one of the two signals is missing or generic.
 */
function isAllowedFormat(file: UploadedFile): boolean {
  const mime = (file.mimeType ?? "").trim().toLowerCase();
  const ext = getExtension(file.name ?? "");
  const mimeOk = (ALLOWED_MIME_TYPES as readonly string[]).includes(mime);
  const extOk = (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
  return mimeOk || extOk;
}

// ---------------------------------------------------------------------------
// validateUpload — Req 1.10, 1.11, 1.12
// ---------------------------------------------------------------------------

/**
 * Validate a list of uploaded files.
 *
 * Files are evaluated in input order. Each file is checked independently so
 * that one rejected file never cancels other valid files:
 * 1. Format check first — non PNG/JPG/JPEG rejected with reason `"format"`.
 * 2. Size check — files > 10 MB rejected with reason `"size"`.
 * 3. Count budget — only format+size-valid files consume the 10-per-session
 *    budget; valid files beyond that cap are rejected with reason `"count"`.
 *
 * Accepted files are returned with `triggerBackgroundRemoval = true` (Req 1.10).
 */
export function validateUpload(files: UploadedFile[]): UploadValidationResult {
  const accepted: UploadedFile[] = [];
  const rejected: {
    file: string;
    reason: UploadRejectionReason;
    message: string;
  }[] = [];

  for (const file of files) {
    // Req 1.11 — unsupported format.
    if (!isAllowedFormat(file)) {
      rejected.push({
        file: file.name,
        reason: "format",
        message: "Hanya format PNG, JPG, dan JPEG yang didukung",
      });
      continue;
    }

    // Req 1.12 — per-file size limit (10 MB).
    if (file.sizeBytes > MAX_FILE_SIZE_BYTES) {
      rejected.push({
        file: file.name,
        reason: "size",
        message: "Ukuran berkas maksimum 10 MB per berkas",
      });
      continue;
    }

    // Req 1.10, 1.12 — session count limit (10 accepted files).
    // Only format+size-valid files consume the count budget.
    if (accepted.length >= MAX_FILES_PER_SESSION) {
      rejected.push({
        file: file.name,
        reason: "count",
        message: "Maksimum 10 berkas per sesi",
      });
      continue;
    }

    // Req 1.10 — accepted file marked to trigger automatic background removal.
    accepted.push({ ...file, triggerBackgroundRemoval: true });
  }

  return { accepted, rejected };
}
