import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  HISTORY_PAGE_SIZE,
  HistoryManager,
  createInMemoryHistoryManager,
  type HistoryRepository,
  type StoredBatchRecord,
} from "@/lib/history/history-manager";
import {
  CONTENT_GOALS,
  MANDATORY_ELEMENTS,
  OUTPUT_FORMATS,
  TONES,
  VARIATION_COUNTS,
  VISUAL_STYLES,
  type DesignBriefInput,
  type DesignVariation,
  type GenerationBatch,
  type OutputFormat,
} from "@/lib/types";

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Smart generators — constrain to the real input space (valid briefs/batches).
// ---------------------------------------------------------------------------

/** Hex colour arbitrary (e.g. "#1a2b3c"). */
const hexColorArb = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, "0")}`);

/** Arbitrary output format drawn from the canonical option list. */
const outputFormatArb: fc.Arbitrary<OutputFormat> = fc.constantFrom(
  ...(OUTPUT_FORMATS.map((f) => ({ ...f })) as unknown as OutputFormat[]),
);

/** Arbitrary valid {@link DesignBriefInput}. */
const briefArb: fc.Arbitrary<DesignBriefInput> = fc.record({
  brandName: fc.string({ minLength: 1, maxLength: 50 }),
  tagline: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
  mainMessage: fc.option(fc.string({ maxLength: 500 }), { nil: undefined }),
  contentGoal: fc.constantFrom(...CONTENT_GOALS),
  visualStyle: fc.constantFrom(...VISUAL_STYLES),
  tone: fc.constantFrom(...TONES),
  outputFormat: outputFormatArb,
  variationCount: fc.constantFrom(...VARIATION_COUNTS),
  accentPalette: fc.array(hexColorArb, { minLength: 1, maxLength: 4 }),
  mandatoryElements: fc.uniqueArray(fc.constantFrom(...MANDATORY_ELEMENTS), {
    maxLength: MANDATORY_ELEMENTS.length,
  }),
  uploadedAssets: fc.constant([]),
});

/** Build a single variation for a batch, derived from a brief + index. */
function makeVariation(
  batchId: string,
  index: number,
  brief: DesignBriefInput,
): DesignVariation {
  return {
    id: `${batchId}-v${index}`,
    batchId,
    brandDna: {
      brandName: brief.brandName,
      tagline: brief.tagline,
      accentPalette: [...brief.accentPalette],
      tone: brief.tone,
      visualStyle: brief.visualStyle,
    },
    designSystem: {
      headlineFont: "Inter",
      bodyFont: "Inter",
      typographyScale: [12, 16, 24],
      radius: 8,
      layoutDensity: "regular",
      brandElementPosition: { logo: "top-left" },
      ctaStyle: "solid",
    },
    copy: {
      headline: "Headline",
      cta: "CTA",
      alignedGoal: brief.contentGoal,
      alignedTone: brief.tone,
    },
    layout: {
      id: `${batchId}-layout`,
      format: { ...brief.outputFormat },
      slots: [],
      includedElements: [...brief.mandatoryElements],
    },
    imageAsset: {
      id: `${batchId}-img${index}`,
      url: `https://x.invalid/${batchId}-${index}.png`,
      width: brief.outputFormat.width,
      height: brief.outputFormat.height,
    },
    renderedCanvas: {
      url: `https://x.invalid/${batchId}-${index}-canvas.png`,
      width: brief.outputFormat.width,
      height: brief.outputFormat.height,
    },
  };
}

/**
 * Arbitrary {@link GenerationBatch} (+ its brief) for a given user. `createdAt`
 * is drawn from an epoch millisecond range and rendered as an ISO string so
 * ordering by timestamp is meaningful.
 */
function batchRecordArb(userId: string): fc.Arbitrary<StoredBatchRecord> {
  return fc
    .record({
      id: fc.string({ minLength: 1, maxLength: 16 }),
      brief: briefArb,
      createdAtMs: fc.integer({
        min: Date.parse("2020-01-01T00:00:00.000Z"),
        max: Date.parse("2030-01-01T00:00:00.000Z"),
      }),
      variationCount: fc.integer({ min: 1, max: 4 }),
    })
    .map(({ id, brief, createdAtMs, variationCount }) => {
      const batch: GenerationBatch = {
        id,
        userId,
        briefId: `${id}-brief`,
        variations: Array.from({ length: variationCount }, (_, i) =>
          makeVariation(id, i, brief),
        ),
        status: "done",
        createdAt: new Date(createdAtMs).toISOString(),
      };
      return { batch, brief };
    });
}

/**
 * Repository whose `saveBatch` always rejects (storage unavailable), counting
 * attempts. Used for Property 26.
 */
class UnavailableSaveRepository implements HistoryRepository {
  saveCalls = 0;
  async saveBatch(): Promise<void> {
    this.saveCalls++;
    throw new Error("storage down");
  }
  async listBatches(): Promise<StoredBatchRecord[]> {
    return [];
  }
  async loadBatch(): Promise<StoredBatchRecord | undefined> {
    return undefined;
  }
  async getRating(): Promise<number | undefined> {
    return undefined;
  }
  async saveRating(): Promise<void> {
    throw new Error("storage down");
  }
}

// ---------------------------------------------------------------------------
// Property 22: Round-trip simpan dan muat riwayat (Req 7.1, 7.3)
// ---------------------------------------------------------------------------

/**
 * Feature: feed-design-generator, Property 22: Untuk setiap `GenerationBatch`
 * beserta brief terkait, menyimpannya ke riwayat lalu memuatnya kembali
 * menghasilkan batch dan brief yang setara dengan aslinya.
 *
 * Validates: Requirements 7.1, 7.3
 */
describe("Property 22: Round-trip simpan dan muat riwayat", () => {
  it("saving a batch + brief then loading it yields an equivalent batch + brief (Req 7.1, 7.3)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 12 }),
        // Build a record bound to the generated user id.
        fc
          .string({ minLength: 1, maxLength: 12 })
          .chain((userId) => batchRecordArb(userId)),
        async (_unused, record) => {
          const { manager } = createInMemoryHistoryManager();

          const save = await manager.saveBatch(record.batch, record.brief);
          expect(save.saved).toBe(true);

          const loaded = await manager.loadBatch(record.batch.id);
          expect(loaded).toBeDefined();
          // Round-trip equivalence: loaded batch + brief equal the originals.
          expect(loaded!.batch).toEqual(record.batch);
          expect(loaded!.brief).toEqual(record.brief);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 23: Pengurutan dan paginasi riwayat (Req 7.2)
// ---------------------------------------------------------------------------

/**
 * Feature: feed-design-generator, Property 23: Untuk setiap himpunan
 * `GenerationBatch`, hasil `listBatches` terurut dari `createdAt` terbaru ke
 * terlama dan tidak pernah memuat lebih dari 20 entri per halaman.
 *
 * Validates: Requirements 7.2
 */
describe("Property 23: Pengurutan dan paginasi riwayat", () => {
  it("returns batches newest-first and never more than 20 per page (Req 7.2)", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A user id plus a set of batches (unique ids) owned by that user.
        fc.string({ minLength: 1, maxLength: 12 }).chain((userId) =>
          fc
            .uniqueArray(batchRecordArb(userId), {
              minLength: 0,
              maxLength: 55,
              selector: (r) => r.batch.id,
            })
            .map((records) => ({ userId, records })),
        ),
        async ({ userId, records }) => {
          const { manager } = createInMemoryHistoryManager(records);

          const totalPages = Math.max(
            1,
            Math.ceil(records.length / HISTORY_PAGE_SIZE),
          );

          const seen: GenerationBatch[] = [];
          for (let page = 1; page <= totalPages; page++) {
            const pageBatches = await manager.listBatches(userId, page);
            // Never more than 20 entries per page (Req 7.2).
            expect(pageBatches.length).toBeLessThanOrEqual(HISTORY_PAGE_SIZE);
            seen.push(...pageBatches);
          }

          // Every owned batch appears exactly once across the pages.
          expect(seen).toHaveLength(records.length);

          // Global ordering across all pages is newest → oldest by createdAt.
          for (let i = 1; i < seen.length; i++) {
            const prev = Date.parse(seen[i - 1].createdAt);
            const curr = Date.parse(seen[i].createdAt);
            expect(prev).toBeGreaterThanOrEqual(curr);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 26: Data batch dipertahankan saat penyimpanan riwayat gagal (Req 7.7)
// ---------------------------------------------------------------------------

/**
 * Feature: feed-design-generator, Property 26: Untuk setiap kegagalan
 * penyimpanan `GenerationBatch` ke riwayat, data batch pada sesi aktif tetap
 * utuh tanpa perubahan.
 *
 * Validates: Requirements 7.7
 */
describe("Property 26: Data batch dipertahankan saat penyimpanan riwayat gagal", () => {
  it("keeps the in-session batch data intact when persistence fails (Req 7.7)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 12 })
          .chain((userId) => batchRecordArb(userId)),
        async (record) => {
          // Snapshot the original batch + brief before attempting to save.
          const originalBatch = structuredClone(record.batch);
          const originalBrief = structuredClone(record.brief);

          const repo = new UnavailableSaveRepository();
          const manager = new HistoryManager(repo, { saveAttempts: 3 });

          const result = await manager.saveBatch(record.batch, record.brief);

          // Persistence failed and the batch was retained for the session.
          expect(result.saved).toBe(false);
          expect(result.retained).toBe(true);
          expect(typeof result.message).toBe("string");

          // The caller's batch/brief objects are unchanged (no mutation).
          expect(record.batch).toEqual(originalBatch);
          expect(record.brief).toEqual(originalBrief);

          // The retained, in-session batch is intact and equals the original,
          // and remains loadable from the active session.
          const retained = manager
            .getRetainedBatches()
            .find((r) => r.batch.id === originalBatch.id);
          expect(retained).toBeDefined();
          expect(retained!.batch).toEqual(originalBatch);
          expect(retained!.brief).toEqual(originalBrief);

          const loaded = await manager.loadBatch(originalBatch.id);
          expect(loaded).toBeDefined();
          expect(loaded!.batch).toEqual(originalBatch);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
