import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  HistoryManager,
  MAX_RATING,
  MIN_RATING,
  createInMemoryHistoryManager,
  isValidRating,
  type HistoryRepository,
  type StoredBatchRecord,
} from "@/lib/history/history-manager";

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Repository whose `saveRating` always rejects (storage unavailable), while
 * counting attempts. Mirrors the `UnavailableHistoryRepository` pattern in
 * `tests/history/history-manager.test.ts` but scoped to rating persistence.
 */
class UnavailableRatingRepository implements HistoryRepository {
  saveRatingCalls = 0;
  async saveBatch(): Promise<void> {
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
    this.saveRatingCalls++;
    throw new Error("storage down");
  }
}

/** Arbitrary for a valid integer rating in [1, 5] (Req 7.4). */
const validRatingArb = fc.integer({ min: MIN_RATING, max: MAX_RATING });

/**
 * Arbitrary for an invalid rating: either an out-of-range integer or a
 * non-integer value (Req 7.8). Excludes the valid [1, 5] integers.
 */
const invalidRatingArb = fc.oneof(
  // Out-of-range integers (below 1 or above 5).
  fc.integer({ min: -1000, max: 0 }),
  fc.integer({ min: 6, max: 1000 }),
  // Non-integer finite values that are not whole numbers.
  fc
    .double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
    .filter((n) => !Number.isInteger(n)),
  // Explicit non-finite edge cases.
  fc.constantFrom(NaN, Infinity, -Infinity),
);

// ---------------------------------------------------------------------------
// Property 24: Validasi rentang rating (Req 7.4, 7.8)
// ---------------------------------------------------------------------------

/**
 * Feature: feed-design-generator, Property 24: Untuk setiap nilai rating: bila
 * berupa bilangan bulat 1..5 maka diterima dan disimpan bersama variasi; bila di
 * luar rentang itu (non-integer atau di luar 1..5) maka ditolak dan rating
 * sebelumnya (jika ada) dipertahankan.
 *
 * Validates: Requirements 7.4, 7.8
 */
describe("Property 24: Validasi rentang rating", () => {
  it("accepts and stores every integer rating in 1..5 (Req 7.4)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 12 }),
        validRatingArb,
        async (variationId, rating) => {
          const { manager, repo } = createInMemoryHistoryManager();

          const result = await manager.rateVariation(variationId, rating);

          expect(result.accepted).toBe(true);
          expect(result.storedRating).toBe(rating);
          // Persisted alongside the variation.
          expect(await repo.getRating(variationId)).toBe(rating);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects out-of-range / non-integer ratings and preserves the previous rating (Req 7.8)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 12 }),
        validRatingArb,
        invalidRatingArb,
        async (variationId, previous, invalid) => {
          // Sanity: the generated invalid value is genuinely invalid.
          expect(isValidRating(invalid)).toBe(false);

          const { manager, repo } = createInMemoryHistoryManager();

          // Establish a valid previous rating.
          const first = await manager.rateVariation(variationId, previous);
          expect(first.accepted).toBe(true);

          // Now apply an invalid rating.
          const result = await manager.rateVariation(variationId, invalid);

          expect(result.accepted).toBe(false);
          expect(result.storedRating).toBe(previous); // previous preserved
          expect(typeof result.message).toBe("string");
          // The persisted rating is unchanged.
          expect(await repo.getRating(variationId)).toBe(previous);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects an invalid rating with no previous rating (storedRating undefined) (Req 7.8)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 12 }),
        invalidRatingArb,
        async (variationId, invalid) => {
          const { manager } = createInMemoryHistoryManager();

          const result = await manager.rateVariation(variationId, invalid);

          expect(result.accepted).toBe(false);
          expect(result.storedRating).toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 25: Ketahanan rating saat penyimpanan tidak tersedia (Req 7.5)
// ---------------------------------------------------------------------------

/**
 * Feature: feed-design-generator, Property 25: Untuk setiap rating valid yang
 * diberikan ketika penyimpanan tidak tersedia, rating tetap diterima dan
 * ditampilkan pada antarmuka, sistem mencoba menyimpan ulang maksimal 3 kali,
 * dan tidak ada pesan kesalahan yang ditampilkan kepada pengguna.
 *
 * Validates: Requirements 7.5
 */
describe("Property 25: Ketahanan rating saat penyimpanan tidak tersedia", () => {
  it("accepts the rating, surfaces no error, and retries persistence <= 3x (Req 7.5)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 12 }),
        validRatingArb,
        // Configured silent retry limit (kept at the spec maximum of 3).
        fc.integer({ min: 1, max: 3 }),
        async (variationId, rating, ratingAttempts) => {
          const repo = new UnavailableRatingRepository();
          const manager = new HistoryManager(repo, { ratingAttempts });

          const result = await manager.rateVariation(variationId, rating);

          // Accepted + displayed at the UI level despite storage being down.
          expect(result.accepted).toBe(true);
          expect(result.storedRating).toBe(rating);
          // No error message is surfaced to the user.
          expect(result.message).toBeUndefined();
          // Persistence was retried silently, never exceeding the limit (<= 3).
          expect(repo.saveRatingCalls).toBe(ratingAttempts);
          expect(repo.saveRatingCalls).toBeLessThanOrEqual(3);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("keeps the accepted rating visible for a subsequent rejection while storage stays down (Req 7.5, 7.8)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 12 }),
        validRatingArb,
        invalidRatingArb,
        async (variationId, valid, invalid) => {
          const repo = new UnavailableRatingRepository();
          const manager = new HistoryManager(repo, { ratingAttempts: 3 });

          const accepted = await manager.rateVariation(variationId, valid);
          expect(accepted.accepted).toBe(true);

          // A following invalid rating must preserve the in-session value even
          // though it never persisted (storage unavailable).
          const rejected = await manager.rateVariation(variationId, invalid);
          expect(rejected.accepted).toBe(false);
          expect(rejected.storedRating).toBe(valid);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
