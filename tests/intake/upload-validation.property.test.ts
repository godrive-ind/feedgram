import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  validateUpload,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_SESSION,
  ALLOWED_EXTENSIONS,
} from "@/lib/intake/upload-validation";
import type { UploadedFile } from "@/lib/types";

// ---------------------------------------------------------------------------
// Oracle: independent re-implementation of the spec rules used to check the
// implementation. Mirrors validateUpload's documented behaviour:
//   1. format check first  -> reason "format"
//   2. size check          -> reason "size"
//   3. count budget (10)   -> reason "count"
// ---------------------------------------------------------------------------

const ALLOWED_MIME = ["image/png", "image/jpeg", "image/jpg"];

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function formatOk(file: UploadedFile): boolean {
  const mime = (file.mimeType ?? "").trim().toLowerCase();
  const ext = extOf(file.name ?? "");
  return (
    ALLOWED_MIME.includes(mime) ||
    (ALLOWED_EXTENSIONS as readonly string[]).includes(ext)
  );
}

type Expected = { accepted: number; format: number; size: number; count: number };

function oracle(files: UploadedFile[]): Expected {
  let accepted = 0;
  let format = 0;
  let size = 0;
  let count = 0;
  for (const f of files) {
    if (!formatOk(f)) {
      format++;
      continue;
    }
    if (f.sizeBytes > MAX_FILE_SIZE_BYTES) {
      size++;
      continue;
    }
    if (accepted >= MAX_FILES_PER_SESSION) {
      count++;
      continue;
    }
    accepted++;
  }
  return { accepted, format, size, count };
}

// ---------------------------------------------------------------------------
// Generators (include edge cases: exactly 10MB, >10MB, unsupported ext,
// many files to overflow the 10-per-session count budget)
// ---------------------------------------------------------------------------

const goodExtArb = fc.constantFrom("png", "jpg", "jpeg", "PNG", "JPG", "JPEG");
const badExtArb = fc.constantFrom("gif", "bmp", "webp", "svg", "pdf", "txt", "");
const baseNameArb = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((s) => !s.includes("."));

const nameArb = fc.oneof(
  fc.tuple(baseNameArb, goodExtArb).map(([n, e]) => `${n}.${e}`),
  fc.tuple(baseNameArb, badExtArb).map(([n, e]) => (e ? `${n}.${e}` : n))
);

const mimeArb = fc.constantFrom(
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "application/pdf",
  "text/plain",
  ""
);

// Sizes biased toward the 10MB boundary plus a broad range.
const sizeArb = fc.oneof(
  fc.constantFrom(
    0,
    1,
    MAX_FILE_SIZE_BYTES - 1,
    MAX_FILE_SIZE_BYTES,
    MAX_FILE_SIZE_BYTES + 1,
    MAX_FILE_SIZE_BYTES * 2
  ),
  fc.integer({ min: 0, max: MAX_FILE_SIZE_BYTES * 2 })
);

const fileArb: fc.Arbitrary<UploadedFile> = fc.record({
  name: nameArb,
  mimeType: mimeArb,
  sizeBytes: sizeArb,
});

// Up to 25 files so the 10-per-session count budget can overflow.
const filesArb = fc.array(fileArb, { minLength: 0, maxLength: 25 });

describe("Brief_Intake validateUpload — properties", () => {
  // Feature: feed-design-generator, Property 3: Validasi berkas unggahan
  it("Property 3: only PNG/JPG/JPEG <=10MB accepted up to 10/session; rejects with reason format/size/count", () => {
    fc.assert(
      fc.property(filesArb, (files) => {
        const result = validateUpload(files);
        const exp = oracle(files);

        // Accepted count matches the oracle and never exceeds the session cap.
        expect(result.accepted.length).toBe(exp.accepted);
        expect(result.accepted.length).toBeLessThanOrEqual(
          MAX_FILES_PER_SESSION
        );

        // Every accepted file genuinely satisfies format + size rules and is
        // marked for background removal (Req 1.10).
        for (const a of result.accepted) {
          expect(formatOk(a)).toBe(true);
          expect(a.sizeBytes).toBeLessThanOrEqual(MAX_FILE_SIZE_BYTES);
          expect(a.triggerBackgroundRemoval).toBe(true);
        }

        // Rejection reasons partition correctly.
        const byReason = { format: 0, size: 0, count: 0 };
        for (const r of result.rejected) byReason[r.reason]++;
        expect(byReason.format).toBe(exp.format);
        expect(byReason.size).toBe(exp.size);
        expect(byReason.count).toBe(exp.count);

        // Nothing is lost: accepted + rejected accounts for every input file.
        expect(result.accepted.length + result.rejected.length).toBe(
          files.length
        );
      }),
      { numRuns: 200 }
    );
  });
});
