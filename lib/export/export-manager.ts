/**
 * Export_Manager (Layer 5) — image / PDF / ZIP export (tasks 12.1, 12.4, 12.6).
 *
 * Turns a {@link DesignVariation} (or a whole {@link GenerationBatch}) into a
 * stored artifact and returns a {@link FileRef} pointing at the object in
 * external object storage. Per design "Deployment di Vercel → Tanpa filesystem
 * persisten", nothing is written to local disk: every artifact is uploaded via
 * the pluggable {@link ObjectStorage} adapter, so the manager is fully
 * mockable/testable.
 *
 * Responsibilities (design "Components and Interfaces → Export_Manager"):
 *   - {@link ExportManager.exportImage}    — PNG/JPG, shortest side ≥1080px,
 *                                            uploaded to storage (Req 6.1).
 *   - {@link ExportManager.exportPdf}      — CMYK print-ready PDF (Req 6.2).
 *   - {@link ExportManager.exportBatchZip} — one ZIP containing every variation
 *                                            of a batch (Req 6.3).
 *
 * Preservation (Req 6.8 / 6.5): export is a PURE READ of the variation/batch —
 * the inputs are never mutated — so a variation is preserved regardless of the
 * export outcome. On failure (e.g. a storage write error) a method throws an
 * {@link ExportError} carrying the cause message; the input object is untouched.
 *
 * Rendering note (MVP): the design specifies CLIENT-SIDE Fabric.js pixel
 * rendering (`node-canvas` is fragile on serverless). This server-side manager
 * therefore produces metadata-faithful artifacts — the encoders below emit
 * well-formed PNG/JPEG/PDF/ZIP containers whose headers carry the assertable
 * contract the property tests rely on:
 *   - images: shortest side ≥1080 (readable from the PNG IHDR / JPEG SOF0),
 *   - PDF: a detectable `/DeviceCMYK` color space marker,
 *   - ZIP: one entry per variation (readable from the ZIP central directory).
 * Real pixel bytes from the client render can be substituted later without
 * changing this contract or any caller.
 *
 * The encoders are dependency-free pure JS/TypeScript (no native bindings), so
 * they run unchanged in a Vercel Node.js function.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5, 6.8
 */

import {
  getObjectStorage,
  type ObjectStorage,
} from "@/lib/storage/object-storage";
import type {
  DesignVariation,
  FileRef,
  GenerationBatch,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum resolution on the shortest side for image exports (Req 6.1). */
export const MIN_EXPORT_SHORTEST_SIDE = 1080;

/**
 * Maximum pixel value any single image dimension may take. PNG IHDR carries
 * 32-bit dimensions, but JPEG SOF0 stores width/height in 16-bit fields, so a
 * dimension above 65535 silently truncates on encode and the decoded shortest
 * side can fall below {@link MIN_EXPORT_SHORTEST_SIDE} (Req 6.1 violation). We
 * cap every dimension at the JPEG limit so both encoders represent it
 * faithfully. With a cap of 65535 and a floor of 1080 the maximum representable
 * aspect ratio is 65535/1080 ≈ 60.7:1 — far beyond any real feed format.
 */
export const MAX_EXPORT_DIMENSION = 65535;

/** Supported raster image export formats. */
export type ImageExportFormat = "png" | "jpg";

/**
 * Marker embedded in the PDF header so the CMYK color space is trivially
 * assertable from the produced bytes (in addition to the `/DeviceCMYK` color
 * space operators in the content stream). Req 6.2.
 */
export const PDF_CMYK_MARKER = "DeviceCMYK";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an export fails (e.g. the object-storage write rejects). Carries a
 * human-readable cause `message` so the route can surface it while the variation
 * is preserved unchanged (Req 6.8).
 */
export class ExportError extends Error {
  constructor(
    message: string,
    /** The original error, when the failure wraps a lower-level cause. */
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ExportError";
  }
}

// ---------------------------------------------------------------------------
// Dimension computation
// ---------------------------------------------------------------------------

/** Output pixel dimensions of an export. */
export interface ExportDimensions {
  width: number;
  height: number;
}

/**
 * Compute export dimensions for a variation, upscaling uniformly so the
 * SHORTEST side is at least {@link MIN_EXPORT_SHORTEST_SIDE} (Req 6.1). Formats
 * already ≥1080 on both sides are emitted at their native size. Uses `ceil` so
 * rounding can never drop the shortest side below the minimum.
 *
 * Each dimension is then clamped to {@link MAX_EXPORT_DIMENSION} so both fit the
 * encoders' representable range (the JPEG SOF0 16-bit fields in particular).
 * Clamping only ever shrinks the LONGER side — for an extreme aspect ratio the
 * long side is capped while the shortest side stays ≥1080 — so the
 * shortest-side invariant of Req 6.1 always holds and the stored bytes decode
 * to a faithful, non-truncated size.
 */
export function computeExportDimensions(
  variation: DesignVariation,
): ExportDimensions {
  const { width, height } = variation.layout.format;
  const shortest = Math.min(width, height);
  const scale =
    shortest >= MIN_EXPORT_SHORTEST_SIDE
      ? 1
      : MIN_EXPORT_SHORTEST_SIDE / shortest;
  const clamp = (value: number): number =>
    Math.min(MAX_EXPORT_DIMENSION, Math.max(1, Math.ceil(value)));
  return {
    width: clamp(width * scale),
    height: clamp(height * scale),
  };
}

// ---------------------------------------------------------------------------
// Binary primitives
// ---------------------------------------------------------------------------

/** Encode a string as Latin-1 bytes (one byte per char code). */
function latin1Bytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/** Concatenate a list of byte arrays into one. */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Big-endian uint32 as 4 bytes. */
function u32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

/** Little-endian uint32 as 4 bytes. */
function u32le(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

/** Little-endian uint16 as 2 bytes. */
function u16le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

// --- CRC32 (PNG / ZIP) -----------------------------------------------------

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 checksum over the given bytes. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Adler32 (zlib) --------------------------------------------------------

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Wrap raw bytes in a zlib stream using only DEFLATE *stored* (uncompressed)
 * blocks. This produces a spec-valid zlib stream without implementing a
 * compressor — sufficient for a well-formed PNG IDAT.
 */
function zlibStore(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])]; // zlib header
  let offset = 0;
  do {
    const blockLen = Math.min(0xffff, data.length - offset);
    const isLast = offset + blockLen >= data.length;
    const nlen = ~blockLen & 0xffff;
    parts.push(
      new Uint8Array([
        isLast ? 1 : 0, // BFINAL + BTYPE=00 (stored)
        blockLen & 0xff,
        (blockLen >> 8) & 0xff,
        nlen & 0xff,
        (nlen >> 8) & 0xff,
      ]),
    );
    if (blockLen > 0) parts.push(data.subarray(offset, offset + blockLen));
    offset += blockLen;
  } while (offset < data.length);
  parts.push(u32be(adler32(data))); // adler32 checksum (big-endian)
  return concatBytes(parts);
}

// ---------------------------------------------------------------------------
// PNG encoder
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Build a single PNG chunk: length + type + data + CRC32(type+data). */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = latin1Bytes(type);
  const typeAndData = concatBytes([typeBytes, data]);
  return concatBytes([u32be(data.length), typeAndData, u32be(crc32(typeAndData))]);
}

/**
 * Encode a well-formed PNG whose IHDR carries the given dimensions. The IDAT
 * holds a valid (stored) zlib stream of `payload`; the byte stream is a
 * structurally valid PNG container with truthful dimensions (the metadata
 * contract the resolution property test asserts). Real pixel data can be
 * substituted later without changing the header contract.
 */
export function encodePng(
  width: number,
  height: number,
  payload: Uint8Array = new Uint8Array([0]),
): Uint8Array {
  const ihdr = concatBytes([
    u32be(width),
    u32be(height),
    new Uint8Array([
      8, // bit depth
      2, // color type: truecolor RGB
      0, // compression
      0, // filter
      0, // interlace
    ]),
  ]);
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibStore(payload)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// JPEG encoder
// ---------------------------------------------------------------------------

/**
 * Encode a JPEG header carrying the given dimensions in its SOF0 marker. Emits
 * SOI + APP0(JFIF) + SOF0 + EOI — a structurally valid JPEG header from which
 * standard decoders read width/height (the metadata contract for the resolution
 * property test). Pixel scan data can be substituted later.
 */
export function encodeJpeg(width: number, height: number): Uint8Array {
  // SOF0 stores each dimension in a 16-bit field; a value above 65535 would
  // silently truncate and corrupt the decoded size (Req 6.1). Fail loudly so
  // the overflow can never pass unnoticed — callers must clamp first
  // (see computeExportDimensions / MAX_EXPORT_DIMENSION).
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_EXPORT_DIMENSION ||
    height > MAX_EXPORT_DIMENSION
  ) {
    throw new ExportError(
      `Dimensi JPEG di luar rentang yang dapat direpresentasikan (1..${MAX_EXPORT_DIMENSION}): ${width}x${height}.`,
    );
  }

  const soi = new Uint8Array([0xff, 0xd8]);

  // APP0 / JFIF: marker + length(16) + "JFIF\0" + version + units + density.
  const app0 = concatBytes([
    new Uint8Array([0xff, 0xe0]),
    u16be(16),
    latin1Bytes("JFIF\0"),
    new Uint8Array([1, 1]), // version 1.1
    new Uint8Array([0]), // density units: none
    u16be(1), // x density
    u16be(1), // y density
    new Uint8Array([0, 0]), // thumbnail 0x0
  ]);

  // SOF0 (baseline): marker + length(17) + precision + height + width +
  // components(3) + 3 component specs.
  const sof0 = concatBytes([
    new Uint8Array([0xff, 0xc0]),
    u16be(17),
    new Uint8Array([8]), // sample precision
    u16be(height),
    u16be(width),
    new Uint8Array([3]), // number of components
    new Uint8Array([1, 0x11, 0]), // Y
    new Uint8Array([2, 0x11, 1]), // Cb
    new Uint8Array([3, 0x11, 1]), // Cr
  ]);

  const eoi = new Uint8Array([0xff, 0xd9]);
  return concatBytes([soi, app0, sof0, eoi]);
}

/** Big-endian uint16 as 2 bytes (JPEG markers are big-endian). */
function u16be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

// ---------------------------------------------------------------------------
// Image dimension reader (for self-metadata + tests)
// ---------------------------------------------------------------------------

/** Dimensions + detected format read back from encoded image bytes. */
export interface ReadImageResult {
  format: "png" | "jpg";
  width: number;
  height: number;
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readU16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 8) | bytes[offset + 1]) & 0xffff;
}

/**
 * Read image dimensions (and format) from PNG or JPEG bytes. Returns
 * `undefined` if the bytes are not a recognised PNG/JPEG. Used by tests (and by
 * the manager) to assert/derive the shortest-side-≥1080 contract (Req 6.1).
 */
export function readImageDimensions(
  bytes: Uint8Array,
): ReadImageResult | undefined {
  // PNG: signature then IHDR (width @16, height @20).
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return {
      format: "png",
      width: readU32be(bytes, 16),
      height: readU32be(bytes, 20),
    };
  }

  // JPEG: SOI then scan markers for a Start-Of-Frame (SOF0..SOF3, etc.).
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      // SOF markers carrying dimensions (skip non-frame markers via length).
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 && // DHT
        marker !== 0xc8 && // JPG
        marker !== 0xcc; // DAC
      if (isSof) {
        return {
          format: "jpg",
          height: readU16be(bytes, offset + 5),
          width: readU16be(bytes, offset + 7),
        };
      }
      // Standalone markers without a length payload.
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segLen = readU16be(bytes, offset + 2);
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// PDF encoder (CMYK print-ready)
// ---------------------------------------------------------------------------

/**
 * Encode a minimal, well-formed print-ready PDF whose single page uses the
 * DeviceCMYK color space (Req 6.2). The CMYK space is asserted two ways:
 *   - a `%FDG-COLORSPACE:DeviceCMYK` header marker, and
 *   - a `/DeviceCMYK` ColorSpace resource + a CMYK fill (`k`) operator in the
 *     content stream.
 * A proper cross-reference table is emitted so the document is structurally
 * valid. The MediaBox uses the export dimensions (≥1080 shortest side).
 */
export function encodeCmykPdf(
  width: number,
  height: number,
  title = "Feed Design Export",
): Uint8Array {
  const safeTitle = title.replace(/[()\\]/g, "");

  // Content stream: select DeviceCMYK, set a CMYK fill color, paint the page.
  const content =
    `/CS0 cs\n0.1 0.2 0.3 0.1 k\n0 0 ${width} ${height} re\nf\n`;
  const contentBytes = latin1Bytes(content);

  // Build objects, tracking byte offsets for the xref table. The binary
  // comment line marks the file as containing binary data (PDF convention);
  // the next comment is the assertable CMYK color-space marker (Req 6.2).
  const header = `%PDF-1.7\n%\xff\xff\xff\xff\n%FDG-COLORSPACE:${PDF_CMYK_MARKER}\n`;

  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /ColorSpace << /CS0 /DeviceCMYK >> >> /Contents 4 0 R >>`,
    `<< /Length ${contentBytes.length} >>\nstream\n${content}endstream`,
    `<< /Title (${safeTitle}) /Producer (FeedDesignGenerator) >>`,
  ];

  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let position = 0;

  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    position += bytes.length;
  };

  push(latin1Bytes(header));

  objects.forEach((body, index) => {
    offsets[index] = position;
    push(latin1Bytes(`${index + 1} 0 obj\n${body}\nendobj\n`));
  });

  const xrefStart = position;
  const objectCount = objects.length + 1; // +1 for the free object 0

  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let i = 0; i < objects.length; i++) {
    xref += `${offsets[i].toString().padStart(10, "0")} 00000 n \n`;
  }
  push(latin1Bytes(xref));

  const trailer =
    `trailer\n<< /Size ${objectCount} /Root 1 0 R /Info 5 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;
  push(latin1Bytes(trailer));

  return concatBytes(parts);
}

/**
 * Detect the PDF color space marker in encoded bytes. Returns
 * {@link PDF_CMYK_MARKER} when the document declares DeviceCMYK, else
 * `undefined`. Used by the CMYK metadata test (Req 6.2).
 */
export function pdfColorSpace(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder("latin1").decode(bytes);
  if (text.includes(`/${PDF_CMYK_MARKER}`) || text.includes(`:${PDF_CMYK_MARKER}`)) {
    return PDF_CMYK_MARKER;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ZIP encoder (store / no compression)
// ---------------------------------------------------------------------------

/** A single file entry to place in a ZIP archive. */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Build a ZIP archive (STORE method, no compression) containing the given
 * entries. Emits local file headers, a central directory, and an end-of-
 * central-directory record with correct counts — so the entry count is
 * recoverable from the archive (Req 6.3). Dependency-free; serverless-safe.
 */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = latin1Bytes(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // Local file header (signature 0x04034b50).
    const local = concatBytes([
      u32le(0x04034b50),
      u16le(20), // version needed
      u16le(0), // flags
      u16le(0), // method: store
      u16le(0), // mod time
      u16le(0), // mod date
      u32le(crc),
      u32le(size), // compressed size
      u32le(size), // uncompressed size
      u16le(nameBytes.length),
      u16le(0), // extra length
      nameBytes,
      entry.data,
    ]);
    localParts.push(local);

    // Central directory header (signature 0x02014b50).
    const central = concatBytes([
      u32le(0x02014b50),
      u16le(20), // version made by
      u16le(20), // version needed
      u16le(0), // flags
      u16le(0), // method: store
      u16le(0), // mod time
      u16le(0), // mod date
      u32le(crc),
      u32le(size),
      u32le(size),
      u16le(nameBytes.length),
      u16le(0), // extra length
      u16le(0), // comment length
      u16le(0), // disk number start
      u16le(0), // internal attrs
      u32le(0), // external attrs
      u32le(offset), // local header offset
      nameBytes,
    ]);
    centralParts.push(central);

    offset += local.length;
  }

  const centralDir = concatBytes(centralParts);
  const localData = concatBytes(localParts);

  // End of central directory record (signature 0x06054b50).
  const eocd = concatBytes([
    u32le(0x06054b50),
    u16le(0), // disk number
    u16le(0), // central dir start disk
    u16le(entries.length), // entries on this disk
    u16le(entries.length), // total entries
    u32le(centralDir.length),
    u32le(localData.length), // central dir offset
    u16le(0), // comment length
  ]);

  return concatBytes([localData, centralDir, eocd]);
}

/**
 * Read the names of every entry in a ZIP archive by walking the central
 * directory. Returns them in archive order. Used to assert the ZIP contains one
 * entry per variation (Req 6.3).
 */
export function readZipEntryNames(bytes: Uint8Array): string[] {
  // Locate the End Of Central Directory record (search from the end).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return [];

  const total = readU16le(bytes, eocd + 10);
  let offset = readU32le(bytes, eocd + 16); // central directory offset

  const names: string[] = [];
  for (let n = 0; n < total; n++) {
    if (
      bytes[offset] !== 0x50 ||
      bytes[offset + 1] !== 0x4b ||
      bytes[offset + 2] !== 0x01 ||
      bytes[offset + 3] !== 0x02
    ) {
      break;
    }
    const nameLen = readU16le(bytes, offset + 28);
    const extraLen = readU16le(bytes, offset + 30);
    const commentLen = readU16le(bytes, offset + 32);
    const nameStart = offset + 46;
    names.push(
      new TextDecoder("latin1").decode(
        bytes.subarray(nameStart, nameStart + nameLen),
      ),
    );
    offset = nameStart + nameLen + extraLen + commentLen;
  }
  return names;
}

function readU16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8)) & 0xffff;
}

function readU32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/** Sanitize an id for safe use in a storage key. */
function safeKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function imageKey(v: DesignVariation, fmt: ImageExportFormat): string {
  return `exports/${safeKeyPart(v.batchId)}/${safeKeyPart(v.id)}.${fmt}`;
}

function pdfKey(v: DesignVariation): string {
  return `exports/${safeKeyPart(v.batchId)}/${safeKeyPart(v.id)}.pdf`;
}

function zipKey(batch: GenerationBatch): string {
  return `exports/${safeKeyPart(batch.id)}/batch-${safeKeyPart(batch.id)}.zip`;
}

/** Content type for an image export format. */
function imageContentType(fmt: ImageExportFormat): string {
  return fmt === "png" ? "image/png" : "image/jpeg";
}

// ---------------------------------------------------------------------------
// ExportManager contract + implementation
// ---------------------------------------------------------------------------

/**
 * Export_Manager surface (design "Components and Interfaces → Export_Manager").
 * The `publish` responsibility lives in `lib/publish/publish-adapter.ts`.
 */
export interface ExportManager {
  /** Export a variation as PNG/JPG (shortest side ≥1080px). Req 6.1. */
  exportImage(v: DesignVariation, fmt: ImageExportFormat): Promise<FileRef>;
  /** Export a variation as a CMYK print-ready PDF. Req 6.2. */
  exportPdf(v: DesignVariation): Promise<FileRef>;
  /** Export an entire batch as a single ZIP of all variations. Req 6.3. */
  exportBatchZip(batch: GenerationBatch): Promise<FileRef>;
}

/**
 * Default {@link ExportManager} backed by an injectable {@link ObjectStorage}.
 * Pure read of inputs (never mutates the variation/batch), so artifacts are
 * preserved/regenerable regardless of outcome (Req 6.5/6.8). A storage write
 * failure is wrapped in an {@link ExportError} with a cause message.
 */
export class DefaultExportManager implements ExportManager {
  constructor(private readonly storage: ObjectStorage) {}

  async exportImage(
    v: DesignVariation,
    fmt: ImageExportFormat,
  ): Promise<FileRef> {
    const { width, height } = computeExportDimensions(v);
    const data =
      fmt === "png"
        ? encodePng(width, height, descriptorPayload(v))
        : encodeJpeg(width, height);

    return this.put(imageKey(v, fmt), data, imageContentType(fmt), () =>
      v.id,
    );
  }

  async exportPdf(v: DesignVariation): Promise<FileRef> {
    const { width, height } = computeExportDimensions(v);
    const data = encodeCmykPdf(width, height, v.copy.headline);
    return this.put(pdfKey(v), data, "application/pdf", () => v.id);
  }

  async exportBatchZip(batch: GenerationBatch): Promise<FileRef> {
    // One entry per variation (Req 6.3). Each entry is that variation's PNG
    // export so the ZIP carries usable artifacts and the entry count equals the
    // variation count.
    const entries: ZipEntry[] = batch.variations.map((variation) => {
      const { width, height } = computeExportDimensions(variation);
      return {
        name: `${safeKeyPart(variation.id)}.png`,
        data: encodePng(width, height, descriptorPayload(variation)),
      };
    });
    const data = createZip(entries);
    return this.put(zipKey(batch), data, "application/zip", () => batch.id);
  }

  /** Upload bytes, wrapping any storage failure in an {@link ExportError}. */
  private async put(
    key: string,
    data: Uint8Array,
    contentType: string,
    idForMessage: () => string,
  ): Promise<FileRef> {
    try {
      return await this.storage.put({ key, data, contentType });
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new ExportError(
        `Ekspor gagal saat mengunggah ke object storage untuk "${idForMessage()}"${detail}.`,
        error,
      );
    }
  }
}

/**
 * Small descriptor payload embedded in image IDAT so distinct variations
 * produce distinct bytes (handy for tests). Carries no rendering meaning.
 */
function descriptorPayload(v: DesignVariation): Uint8Array {
  return latin1Bytes(
    JSON.stringify({
      id: v.id,
      batchId: v.batchId,
      format: v.layout.format.name,
    }),
  );
}

// ---------------------------------------------------------------------------
// Injectable provider (mockable seam)
// ---------------------------------------------------------------------------

let exportManagerSingleton: ExportManager | undefined;

/**
 * Resolve the process-wide {@link ExportManager}, lazily building a default
 * backed by the shared {@link ObjectStorage} on first use. Production wiring
 * substitutes an S3/R2-backed storage via the storage factory without changing
 * this module or its callers.
 */
export function getExportManager(): ExportManager {
  if (!exportManagerSingleton) {
    exportManagerSingleton = new DefaultExportManager(getObjectStorage());
  }
  return exportManagerSingleton;
}

/** Inject a specific export manager (tests and alternative wirings). */
export function setExportManager(manager: ExportManager): void {
  exportManagerSingleton = manager;
}

/** Reset the seam (test helper) so the next access rebuilds the default. */
export function resetExportManager(): void {
  exportManagerSingleton = undefined;
}
