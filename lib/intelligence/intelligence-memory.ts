/**
 * Intelligence_Memory (Design Intelligence) — continuous-learning store for
 * Design_DNA outcomes per aggregated context (task 11.1).
 *
 * Records the `Design_DNA` used for a design together with the accept/reject
 * outcome, optional aggregated feedback, and an aggregated `MemoryContext`
 * (industry, Design_Purpose, audience) so future generations in a SIMILAR
 * context can be seeded from prior learning (Req 9.1, 9.2). Storage access is
 * abstracted behind {@link IntelligenceMemoryStore} so the default in-memory
 * implementation can be unit/property tested and later swapped for a
 * Prisma-backed drop-in WITHOUT changing callers — mirroring the seam pattern
 * used by `History_Manager` (`lib/history/history-manager.ts`) and the
 * `VariationStore` (`lib/server/variation-store.ts`).
 *
 * Privacy (Req 9.5): the store ONLY accepts `DesignDNA` + an aggregated
 * `MemoryContext` + outcome + optional aggregated feedback. It NEVER stores raw
 * brief fields or PII — the {@link IntelligenceMemoryEntry} shape (defined in
 * `lib/types.ts`) structurally excludes such data.
 *
 * Retention (Req 9.7): entries live at most {@link RETENTION_DAYS} (365) days.
 * Retention is enforced both on read — `retrieve` filters out expired entries —
 * and on cleanup — `purgeExpired` deletes them (cron/route triggerable).
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
 */

import type {
  DesignDNA,
  IntelligenceMemoryEntry,
  MemoryContext,
} from "@/lib/types";

// Re-export the memory types so consumers can import them from this module
// (the canonical definitions live in `lib/types.ts`).
export type { DesignDNA, IntelligenceMemoryEntry, MemoryContext };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum retention period for a memory entry, in days (Req 9.7, Asumsi A8). */
export const RETENTION_DAYS = 365;

/** Retention period expressed in milliseconds. */
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/**
 * Persistent, mockable store for intelligence-memory entries.
 *
 * Implementations persist {@link IntelligenceMemoryEntry} records. The
 * in-memory implementation below is the default; a Prisma-backed implementation
 * is a drop-in. Retention (Req 9.7) is enforced inside `retrieve` (filtering)
 * and `purgeExpired` (deletion) regardless of the backing store.
 */
export interface IntelligenceMemoryStore {
  /**
   * Persist an entry (Req 9.1). The caller supplies only the aggregated,
   * PII-free payload (Req 9.5); `id` and `createdAt` are generated unless
   * provided via `opts`. Returns the stored entry.
   */
  save(
    entry: Omit<IntelligenceMemoryEntry, "id" | "createdAt">,
    opts?: { id?: string; createdAt?: string },
  ): Promise<IntelligenceMemoryEntry>;

  /**
   * Retrieve entries for `userId` whose aggregated `context` matches, newest
   * first, excluding entries older than {@link RETENTION_DAYS} (Req 9.2, 9.7).
   * `opts.now` overrides the reference time (testing/cron).
   */
  retrieve(
    userId: string,
    context: MemoryContext,
    opts?: { now?: string },
  ): Promise<IntelligenceMemoryEntry[]>;

  /** Delete all entries owned by `userId`; returns the count removed (Req 9.6). */
  deleteByUser(userId: string): Promise<number>;

  /**
   * Delete entries older than {@link RETENTION_DAYS} (Req 9.7); returns the
   * count removed. `opts.now` overrides the reference time (testing/cron).
   */
  purgeExpired(opts?: { now?: string }): Promise<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a reference timestamp (ms) from an optional ISO string. */
function resolveNow(now?: string): number {
  if (now !== undefined) {
    const parsed = Date.parse(now);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/**
 * Whether `entry` is still within the retention window relative to `nowMs`
 * (Req 9.7). Entries with an unparseable `createdAt` are treated as expired so
 * malformed data cannot linger or seed future generations.
 */
function isWithinRetention(
  entry: IntelligenceMemoryEntry,
  nowMs: number,
): boolean {
  const created = Date.parse(entry.createdAt);
  if (!Number.isFinite(created)) return false;
  return nowMs - created <= RETENTION_MS;
}

/** Whether two aggregated contexts match across all dimensions (Req 9.2). */
function contextMatches(a: MemoryContext, b: MemoryContext): boolean {
  return (
    a.industry === b.industry &&
    a.purpose === b.purpose &&
    a.audience === b.audience
  );
}

/** Deep clone of a context so stored/returned copies cannot be mutated. */
function cloneContext(context: MemoryContext): MemoryContext {
  return { industry: context.industry, purpose: context.purpose, audience: context.audience };
}

/** Deep clone of a Design_DNA so stored/returned copies cannot be mutated. */
function cloneDesignDna(dna: DesignDNA): DesignDNA {
  return {
    whitespaceRatio: dna.whitespaceRatio,
    elementCount: dna.elementCount,
    typographyWeight: dna.typographyWeight,
    paletteRestraint: dna.paletteRestraint,
    decorationLevel: dna.decorationLevel,
  };
}

/** Deep clone of a full entry so stored/returned copies cannot be mutated. */
function cloneEntry(entry: IntelligenceMemoryEntry): IntelligenceMemoryEntry {
  return {
    id: entry.id,
    userId: entry.userId,
    context: cloneContext(entry.context),
    designDna: cloneDesignDna(entry.designDna),
    outcome: entry.outcome,
    ...(entry.feedback !== undefined ? { feedback: entry.feedback } : {}),
    createdAt: entry.createdAt,
  };
}

/**
 * Compare two entries for newest-first ordering. Sorts by `createdAt`
 * descending; ties are broken by `id` descending so the order is deterministic
 * even when timestamps are identical (Req 9.2).
 */
function newestFirst(
  a: IntelligenceMemoryEntry,
  b: IntelligenceMemoryEntry,
): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const aValid = Number.isFinite(ta);
  const bValid = Number.isFinite(tb);
  if (aValid && bValid && ta !== tb) return tb - ta;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

// ---------------------------------------------------------------------------
// In-memory store (tests + local wiring; not for production)
// ---------------------------------------------------------------------------

/**
 * In-memory {@link IntelligenceMemoryStore} keeping entries in a map keyed by
 * id. Used by tests and local wiring; the production Prisma-backed store is a
 * drop-in. By construction it only retains the aggregated, PII-free payload
 * (Req 9.5) — the {@link IntelligenceMemoryEntry} shape excludes raw brief data.
 */
export class InMemoryIntelligenceMemoryStore
  implements IntelligenceMemoryStore
{
  private readonly entries = new Map<string, IntelligenceMemoryEntry>();
  private sequence = 0;

  constructor(seed: readonly IntelligenceMemoryEntry[] = []) {
    for (const entry of seed) {
      this.entries.set(entry.id, cloneEntry(entry));
    }
  }

  async save(
    entry: Omit<IntelligenceMemoryEntry, "id" | "createdAt">,
    opts?: { id?: string; createdAt?: string },
  ): Promise<IntelligenceMemoryEntry> {
    const id = opts?.id ?? this.nextId();
    const createdAt = opts?.createdAt ?? new Date().toISOString();
    const stored: IntelligenceMemoryEntry = cloneEntry({
      ...entry,
      id,
      createdAt,
    });
    this.entries.set(id, stored);
    return cloneEntry(stored);
  }

  async retrieve(
    userId: string,
    context: MemoryContext,
    opts?: { now?: string },
  ): Promise<IntelligenceMemoryEntry[]> {
    const nowMs = resolveNow(opts?.now);
    const matches: IntelligenceMemoryEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.userId !== userId) continue;
      if (!contextMatches(entry.context, context)) continue;
      if (!isWithinRetention(entry, nowMs)) continue; // Req 9.7
      matches.push(cloneEntry(entry));
    }
    matches.sort(newestFirst); // newest first (Req 9.2)
    return matches;
  }

  async deleteByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.userId === userId) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  async purgeExpired(opts?: { now?: string }): Promise<number> {
    const nowMs = resolveNow(opts?.now);
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (!isWithinRetention(entry, nowMs)) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Generate a collision-resistant, monotonic id for a new entry. */
  private nextId(): string {
    this.sequence += 1;
    return `mem_${Date.now().toString(36)}_${this.sequence.toString(36)}`;
  }
}

// ---------------------------------------------------------------------------
// Design_DNA seeding from memory (Req 9.2, 9.3, 9.4)
// ---------------------------------------------------------------------------

/**
 * Seed a `Design_DNA` from prior memory entries (Req 9.2, 9.3).
 *
 * Prioritises the Design_DNA of the most recent ACCEPTED entry and AVOIDS the
 * Design_DNA of REJECTED entries. When no ACCEPTED entry exists (all matching
 * entries were rejected, or the list is empty), returns `undefined` so the
 * caller falls back to `initDesignDnaFromWeights` from default Decision_Weights
 * without surfacing an error (Req 9.4).
 *
 * `entries` are expected to be already context-matched (e.g. from
 * {@link IntelligenceMemoryStore.retrieve}); ordering is not assumed here, so
 * the newest ACCEPTED entry is selected defensively regardless of input order.
 */
export function seedDesignDnaFromMemory(
  entries: IntelligenceMemoryEntry[],
): DesignDNA | undefined {
  const accepted = entries
    .filter((entry) => entry.outcome === "ACCEPTED")
    .sort(newestFirst);
  if (accepted.length === 0) return undefined; // Req 9.4
  return cloneDesignDna(accepted[0].designDna);
}
