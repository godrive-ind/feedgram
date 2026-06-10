/**
 * History_Manager (Layer 6) — generation history persistence + rating feedback
 * loop (tasks 13.1, 13.5).
 *
 * Storage access is abstracted behind {@link HistoryRepository} so the manager
 * can be unit/property tested with an in-memory repository and later wired to a
 * Prisma-backed repository (the `GenerationBatch` / `DesignBrief` /
 * `DesignVariation` models already exist in `prisma/schema.prisma`) WITHOUT
 * changing this logic — mirroring the seam pattern used by `Credit_Manager`
 * (`lib/credit/credit-manager.ts`) and the Job Store (`lib/jobs/job-store.ts`).
 *
 * Responsibilities:
 *   - `saveBatch`     — persist a batch + its brief, retrying on failure; if all
 *                       attempts fail, RETAIN the batch in the active session and
 *                       surface an error indication (Req 7.1, 7.7).
 *   - `listBatches`   — list a user's batches newest → oldest, ≤20 per page
 *                       (Req 7.2). Ordering + pagination are enforced here so the
 *                       invariant holds regardless of repository order.
 *   - `loadBatch`     — reload a batch together with its brief (Req 7.3).
 *   - `rateVariation` — accept an integer rating 1..5 and store it (Req 7.4);
 *                       reject out-of-range / non-integer values while preserving
 *                       the previous rating + an error indication (Req 7.8); when
 *                       storage is unavailable, accept the rating at the UI level
 *                       and SILENTLY retry persistence up to 3 times without
 *                       surfacing an error (Req 7.5).
 *
 * Signature notes (intentional, documented deviations from the design's TS
 * sketch — chosen for testability + to satisfy the error-indication clauses):
 *   - `saveBatch` returns a {@link SaveBatchResult} (instead of `Promise<void>`)
 *     so callers can react to a persistence failure (Req 7.7). The worker's
 *     `onBatch` sink (task 14.1) may simply ignore the result.
 *   - `listBatches` takes the owning `userId` (per-user history) in addition to
 *     the page number.
 *   - `rateVariation` is async (`Promise<RatingResult>`) because the silent
 *     persistence retry (Req 7.5) is inherently asynchronous.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.7, 7.8
 */

import type {
  DesignBriefInput,
  GenerationBatch,
  RatingResult,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum history entries returned per page (Req 7.2). */
export const HISTORY_PAGE_SIZE = 20;

/** Default number of persistence attempts before giving up. */
export const DEFAULT_SAVE_ATTEMPTS = 3;

/** Maximum silent persistence attempts for a rating (Req 7.5). */
export const MAX_RATING_PERSIST_ATTEMPTS = 3;

/** Lowest valid rating (Req 7.4). */
export const MIN_RATING = 1;

/** Highest valid rating (Req 7.4). */
export const MAX_RATING = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A persisted batch together with the brief it was generated from. */
export interface StoredBatchRecord {
  batch: GenerationBatch;
  brief: DesignBriefInput;
}

/**
 * Result of {@link HistoryManager.saveBatch}.
 *
 * - `saved`    — the batch was persisted to the repository.
 * - `retained` — persistence failed after all attempts, so the batch was kept
 *   in the active session instead (Req 7.7).
 * - `attempts` — number of persistence attempts made.
 * - `message`  — error indication, present only when `saved === false`.
 */
export interface SaveBatchResult {
  saved: boolean;
  retained: boolean;
  attempts: number;
  message?: string;
}

/**
 * Storage abstraction for the History_Manager.
 *
 * Implementations persist batches/briefs and per-variation ratings. The
 * in-memory implementation below is the default; a Prisma-backed implementation
 * (drop-in) can push ordering/pagination to the DB — but the manager re-applies
 * the newest-first + ≤20/page invariants defensively regardless (Req 7.2).
 *
 * Methods MAY reject (throw) when the underlying storage is unavailable; the
 * manager treats a rejection as a transient failure and applies the retry /
 * session-retention behaviour required by Req 7.5 and 7.7.
 */
export interface HistoryRepository {
  /** Persist a batch + its brief. Rejects when storage is unavailable. */
  saveBatch(batch: GenerationBatch, brief: DesignBriefInput): Promise<void>;
  /** Return ALL stored records for a user (ordering not assumed). */
  listBatches(userId: string): Promise<StoredBatchRecord[]>;
  /** Load a single batch + brief by id, or `undefined` when unknown. */
  loadBatch(batchId: string): Promise<StoredBatchRecord | undefined>;
  /** Read the stored rating for a variation, or `undefined`. */
  getRating(variationId: string): Promise<number | undefined>;
  /** Persist a variation rating. Rejects when storage is unavailable. */
  saveRating(variationId: string, rating: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether `rating` is a valid integer rating in `[1, 5]` (Req 7.4, 7.8). */
export function isValidRating(rating: number): boolean {
  return Number.isInteger(rating) && rating >= MIN_RATING && rating <= MAX_RATING;
}

/** Deep-ish clone of a brief so stored/returned copies cannot be mutated. */
function cloneBrief(brief: DesignBriefInput): DesignBriefInput {
  return {
    ...brief,
    accentPalette: [...brief.accentPalette],
    mandatoryElements: [...brief.mandatoryElements],
    uploadedAssets: brief.uploadedAssets.map((a) => ({ ...a })),
    outputFormat: { ...brief.outputFormat },
  };
}

/** Deep-ish clone of a batch so stored/returned copies cannot be mutated. */
function cloneBatch(batch: GenerationBatch): GenerationBatch {
  return {
    ...batch,
    variations: batch.variations.map((v) => ({
      ...v,
      brandDna: { ...v.brandDna, accentPalette: [...v.brandDna.accentPalette] },
      designSystem: {
        ...v.designSystem,
        typographyScale: [...v.designSystem.typographyScale],
        brandElementPosition: { ...v.designSystem.brandElementPosition },
      },
      copy: { ...v.copy },
      layout: {
        ...v.layout,
        format: { ...v.layout.format },
        slots: v.layout.slots.map((s) => ({ ...s })),
        includedElements: [...v.layout.includedElements],
      },
      imageAsset: { ...v.imageAsset },
      renderedCanvas: { ...v.renderedCanvas },
    })),
  };
}

/**
 * Compare two records for newest-first ordering. Sorts by `createdAt`
 * descending; ties are broken by `id` descending so the order is deterministic
 * even when timestamps are identical (Req 7.2).
 */
function newestFirst(a: StoredBatchRecord, b: StoredBatchRecord): number {
  const ta = Date.parse(a.batch.createdAt);
  const tb = Date.parse(b.batch.createdAt);
  const aValid = Number.isFinite(ta);
  const bValid = Number.isFinite(tb);
  if (aValid && bValid && ta !== tb) return tb - ta;
  // Fall back to a stable string compare (handles invalid/equal timestamps).
  if (a.batch.createdAt !== b.batch.createdAt) {
    return a.batch.createdAt < b.batch.createdAt ? 1 : -1;
  }
  if (a.batch.id === b.batch.id) return 0;
  return a.batch.id < b.batch.id ? 1 : -1;
}

// ---------------------------------------------------------------------------
// In-memory repository (tests + local wiring; not for production)
// ---------------------------------------------------------------------------

/**
 * In-memory {@link HistoryRepository} keeping records + ratings in maps. Used by
 * tests and local wiring; the production Prisma-backed repository is a drop-in.
 */
export class InMemoryHistoryRepository implements HistoryRepository {
  private readonly batches = new Map<string, StoredBatchRecord>();
  private readonly ratings = new Map<string, number>();

  constructor(seed: readonly StoredBatchRecord[] = []) {
    for (const record of seed) {
      this.batches.set(record.batch.id, {
        batch: cloneBatch(record.batch),
        brief: cloneBrief(record.brief),
      });
    }
  }

  async saveBatch(
    batch: GenerationBatch,
    brief: DesignBriefInput,
  ): Promise<void> {
    this.batches.set(batch.id, {
      batch: cloneBatch(batch),
      brief: cloneBrief(brief),
    });
  }

  async listBatches(userId: string): Promise<StoredBatchRecord[]> {
    const result: StoredBatchRecord[] = [];
    for (const record of this.batches.values()) {
      if (record.batch.userId === userId) {
        result.push({
          batch: cloneBatch(record.batch),
          brief: cloneBrief(record.brief),
        });
      }
    }
    return result;
  }

  async loadBatch(batchId: string): Promise<StoredBatchRecord | undefined> {
    const record = this.batches.get(batchId);
    if (!record) return undefined;
    return {
      batch: cloneBatch(record.batch),
      brief: cloneBrief(record.brief),
    };
  }

  async getRating(variationId: string): Promise<number | undefined> {
    return this.ratings.get(variationId);
  }

  async saveRating(variationId: string, rating: number): Promise<void> {
    this.ratings.set(variationId, rating);
  }
}

// ---------------------------------------------------------------------------
// HistoryManager
// ---------------------------------------------------------------------------

/** Options for {@link HistoryManager}. */
export interface HistoryManagerOptions {
  /** Persistence attempts for {@link HistoryManager.saveBatch} (default 3). */
  saveAttempts?: number;
  /** Silent persistence attempts for a rating (default 3, Req 7.5). */
  ratingAttempts?: number;
}

/**
 * Manages generation history and the rating feedback loop.
 *
 * Depends only on a {@link HistoryRepository}, so it is storage-agnostic and
 * fully mockable. Maintains a small amount of in-session state so it can honour
 * the resilience requirements when storage is unavailable:
 *   - `retained`       — batches whose persistence failed, kept for the session
 *                        (Req 7.7).
 *   - `sessionRatings` — last accepted rating per variation, used both to keep
 *                        showing a rating when storage is down (Req 7.5) and to
 *                        preserve the previous rating when a new value is
 *                        rejected (Req 7.8).
 */
export class HistoryManager {
  private readonly saveAttempts: number;
  private readonly ratingAttempts: number;

  /** Batches retained in the active session after a failed save (Req 7.7). */
  private readonly retained = new Map<string, StoredBatchRecord>();

  /** Last accepted rating per variation (UI-visible; Req 7.5, 7.8). */
  private readonly sessionRatings = new Map<string, number>();

  constructor(
    private readonly repo: HistoryRepository,
    options: HistoryManagerOptions = {},
  ) {
    this.saveAttempts = Math.max(1, options.saveAttempts ?? DEFAULT_SAVE_ATTEMPTS);
    this.ratingAttempts = Math.max(
      1,
      options.ratingAttempts ?? MAX_RATING_PERSIST_ATTEMPTS,
    );
  }

  /**
   * Persist a batch + its brief to history (Req 7.1).
   *
   * Retries persistence up to {@link HistoryManagerOptions.saveAttempts} times.
   * If every attempt fails, the batch is RETAINED in the active session and an
   * error indication is returned so the caller can surface it (Req 7.7).
   */
  async saveBatch(
    batch: GenerationBatch,
    brief: DesignBriefInput,
  ): Promise<SaveBatchResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.saveAttempts; attempt++) {
      try {
        await this.repo.saveBatch(batch, brief);
        // On a successful save, drop any earlier session retention for this id.
        this.retained.delete(batch.id);
        return { saved: true, retained: false, attempts: attempt };
      } catch (error) {
        lastError = error;
      }
    }

    // All attempts failed — keep the batch in the active session (Req 7.7).
    this.retained.set(batch.id, {
      batch: cloneBatch(batch),
      brief: cloneBrief(brief),
    });
    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    return {
      saved: false,
      retained: true,
      attempts: this.saveAttempts,
      message: `Penyimpanan riwayat gagal${detail}. Data batch tetap tersedia pada sesi ini.`,
    };
  }

  /**
   * List a user's batches newest → oldest, at most {@link HISTORY_PAGE_SIZE}
   * per page (Req 7.2). `page` is 1-indexed; values below 1 are clamped to 1.
   * Ordering + pagination are enforced here regardless of repository order.
   */
  async listBatches(userId: string, page = 1): Promise<GenerationBatch[]> {
    const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
    const records = await this.repo.listBatches(userId);
    records.sort(newestFirst);

    const start = (safePage - 1) * HISTORY_PAGE_SIZE;
    const pageRecords = records.slice(start, start + HISTORY_PAGE_SIZE);
    return pageRecords.map((record) => record.batch);
  }

  /**
   * Reload a batch together with its brief (Req 7.3). Returns `undefined` when
   * the batch is not found in the repository nor retained in the session.
   */
  async loadBatch(batchId: string): Promise<StoredBatchRecord | undefined> {
    const record = await this.repo.loadBatch(batchId);
    if (record) return record;
    // Fall back to a session-retained batch (failed persistence; Req 7.7).
    const retained = this.retained.get(batchId);
    if (!retained) return undefined;
    return {
      batch: cloneBatch(retained.batch),
      brief: cloneBrief(retained.brief),
    };
  }

  /**
   * Rate a variation on the integer scale 1..5.
   *
   * - Valid rating (Req 7.4): stored, accepted, and persisted. If storage is
   *   unavailable the rating is still accepted + shown, and persistence is
   *   retried SILENTLY up to {@link HistoryManagerOptions.ratingAttempts} times
   *   without surfacing an error (Req 7.5).
   * - Invalid rating (Req 7.8): rejected; the previous rating (if any) is
   *   preserved and returned, with an error indication.
   */
  async rateVariation(
    variationId: string,
    rating: number,
  ): Promise<RatingResult> {
    // Req 7.8 — reject out-of-range / non-integer values; preserve previous.
    if (!isValidRating(rating)) {
      const previous = await this.previousRating(variationId);
      return {
        accepted: false,
        storedRating: previous,
        message: `Nilai rating tidak valid. Gunakan bilangan bulat ${MIN_RATING} sampai ${MAX_RATING}.`,
      };
    }

    // Req 7.4 / 7.5 — accept at the UI level immediately and keep it visible
    // even if persistence is currently unavailable.
    this.sessionRatings.set(variationId, rating);

    // Silently (re)try persistence up to the configured limit (Req 7.5). Any
    // failure is swallowed: the user never sees a storage error for a rating.
    await this.persistRatingSilently(variationId, rating);

    return { accepted: true, storedRating: rating };
  }

  /** Batches retained in the active session after a failed save (Req 7.7). */
  getRetainedBatches(): StoredBatchRecord[] {
    return Array.from(this.retained.values()).map((record) => ({
      batch: cloneBatch(record.batch),
      brief: cloneBrief(record.brief),
    }));
  }

  /**
   * Resolve the previous rating for a variation, preferring the session value
   * (UI-visible) and falling back to a guarded repository read. Never throws.
   */
  private async previousRating(
    variationId: string,
  ): Promise<number | undefined> {
    if (this.sessionRatings.has(variationId)) {
      return this.sessionRatings.get(variationId);
    }
    try {
      return await this.repo.getRating(variationId);
    } catch {
      return undefined;
    }
  }

  /**
   * Attempt to persist a rating, retrying up to {@link ratingAttempts} times.
   * All errors are swallowed so no storage error reaches the user (Req 7.5).
   * Returns `true` if any attempt succeeded.
   */
  private async persistRatingSilently(
    variationId: string,
    rating: number,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= this.ratingAttempts; attempt++) {
      try {
        await this.repo.saveRating(variationId, rating);
        return true;
      } catch {
        // Swallow and retry silently (Req 7.5).
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a HistoryManager backed by an in-memory repository. */
export function createInMemoryHistoryManager(
  seed?: readonly StoredBatchRecord[],
  options?: HistoryManagerOptions,
): { manager: HistoryManager; repo: InMemoryHistoryRepository } {
  const repo = new InMemoryHistoryRepository(seed);
  return { manager: new HistoryManager(repo, options), repo };
}
