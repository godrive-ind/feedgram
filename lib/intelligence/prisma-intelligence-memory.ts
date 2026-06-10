/**
 * Prisma-backed {@link IntelligenceMemoryStore} (task 18.2) — a structural
 * drop-in for the default {@link InMemoryIntelligenceMemoryStore}.
 *
 * Mirrors the established Prisma-backed store pattern in
 * `lib/jobs/job-store.ts` (`PrismaJobStore`, `PrismaCreditRepository`): the
 * client is injected as a structurally-typed value ({@link PrismaClientLike})
 * so this module compiles and the test-suite runs even when `prisma generate`
 * has NOT been run and `@prisma/client` types are absent. A real `PrismaClient`
 * is structurally assignable to {@link PrismaClientLike}.
 *
 * Backing model: `IntelligenceMemory` (see `prisma/schema.prisma`), whose
 * columns map onto {@link IntelligenceMemoryEntry} as:
 *   - `industry` / `purpose` / `audience`  ↔ `context.{industry,purpose,audience}`
 *   - `designDna` (Json)                   ↔ `designDna`
 *   - `outcome` (String)                   ↔ `outcome` ("ACCEPTED" | "REJECTED")
 *   - `feedback` (String?)                 ↔ `feedback`
 *   - `userId` / `id` / `createdAt`        ↔ same-named fields
 *
 * Retention (Req 9.7): entries live at most {@link RETENTION_DAYS} (365) days.
 * It is enforced on read — `retrieve` filters out entries older than the
 * window — and on cleanup — `purgeExpired` deletes them. The 365-day constant
 * is reused from `intelligence-memory.ts` so both stores stay in lock-step.
 *
 * Wiring (Req 9.1, 9.2, 9.6, 9.7): this class implements the exact
 * {@link IntelligenceMemoryStore} contract, so swapping it in is a one-line
 * change in `lib/server/intelligence-memory-provider.ts`
 * (`setIntelligenceMemory(new PrismaIntelligenceMemoryStore(db))`) that does
 * NOT touch any caller. The provider keeps the in-memory default until a Prisma
 * client is available in the deployment environment.
 *
 * Requirements: 9.1, 9.2, 9.6, 9.7
 */

import {
  RETENTION_DAYS,
  RETENTION_MS,
  type IntelligenceMemoryStore,
} from "@/lib/intelligence/intelligence-memory";
import type {
  DesignDNA,
  IntelligenceMemoryEntry,
  MemoryContext,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Structural Prisma client typing (compiles without @prisma/client generated)
// ---------------------------------------------------------------------------

/**
 * Minimal structural shape of the `intelligenceMemory` model delegate exposing
 * only the operations this store needs (`findMany`, `create`, `deleteMany`).
 * Kept loose (`any`) so the real generated delegate is assignable without
 * importing `@prisma/client` types.
 */
export interface IntelligenceMemoryDelegateLike {
  findMany(args?: any): Promise<any[]>;
  create(args: any): Promise<any>;
  deleteMany(args?: any): Promise<{ count: number }>;
}

/**
 * Minimal structural shape of a `PrismaClient` exposing only the
 * `intelligenceMemory` delegate. A real `PrismaClient` is structurally
 * assignable to this type, so no import of `@prisma/client` is required for
 * typecheck.
 */
export interface IntelligenceMemoryClientLike {
  intelligenceMemory: IntelligenceMemoryDelegateLike;
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

/** Normalise a row's `createdAt` (Date or string) to an ISO string. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  // Defensive: an unparseable/missing timestamp is treated as the epoch so the
  // entry falls outside the retention window and cannot linger (Req 9.7).
  return new Date(0).toISOString();
}

/** Whether `createdAtIso` is still within the retention window vs `nowMs`. */
function isWithinRetention(createdAtIso: string, nowMs: number): boolean {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return false;
  return nowMs - created <= RETENTION_MS;
}

/** Map a structural DB row back to the domain {@link IntelligenceMemoryEntry}. */
function rowToEntry(row: any): IntelligenceMemoryEntry {
  const context: MemoryContext = {
    industry: row.industry,
    purpose: row.purpose,
    audience: row.audience,
  };
  const entry: IntelligenceMemoryEntry = {
    id: row.id,
    userId: row.userId,
    context,
    designDna: row.designDna as DesignDNA,
    outcome: row.outcome as IntelligenceMemoryEntry["outcome"],
    createdAt: toIso(row.createdAt),
  };
  if (row.feedback !== undefined && row.feedback !== null) {
    entry.feedback = row.feedback;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Prisma-backed IntelligenceMemoryStore
// ---------------------------------------------------------------------------

/**
 * Prisma-backed {@link IntelligenceMemoryStore}. Accepts a structurally-typed
 * client by injection so it compiles without a generated `@prisma/client`.
 */
export class PrismaIntelligenceMemoryStore implements IntelligenceMemoryStore {
  constructor(private readonly db: IntelligenceMemoryClientLike) {}

  /**
   * Persist an entry (Req 9.1). Only the aggregated, PII-free payload is stored
   * (Req 9.5) — the {@link IntelligenceMemoryEntry} shape excludes raw brief
   * data. `id` and `createdAt` come from `opts` when provided, otherwise from
   * the DB defaults (`cuid()` / `now()`).
   */
  async save(
    entry: Omit<IntelligenceMemoryEntry, "id" | "createdAt">,
    opts?: { id?: string; createdAt?: string },
  ): Promise<IntelligenceMemoryEntry> {
    const created = await this.db.intelligenceMemory.create({
      data: {
        ...(opts?.id ? { id: opts.id } : {}),
        ...(opts?.createdAt ? { createdAt: new Date(opts.createdAt) } : {}),
        userId: entry.userId,
        industry: entry.context.industry,
        purpose: entry.context.purpose,
        audience: entry.context.audience,
        designDna: entry.designDna,
        outcome: entry.outcome,
        feedback: entry.feedback ?? null,
      },
    });
    return rowToEntry(created);
  }

  /**
   * Retrieve entries for `userId` whose aggregated `context` matches, newest
   * first, excluding entries older than {@link RETENTION_DAYS} (Req 9.2, 9.7).
   * The context filter is applied in the query (industry + purpose + audience)
   * and retention is enforced in-process relative to `opts.now`/`Date.now()`.
   */
  async retrieve(
    userId: string,
    context: MemoryContext,
    opts?: { now?: string },
  ): Promise<IntelligenceMemoryEntry[]> {
    const nowMs = resolveNow(opts?.now);
    const rows = await this.db.intelligenceMemory.findMany({
      where: {
        userId,
        industry: context.industry,
        purpose: context.purpose,
        audience: context.audience,
      },
      orderBy: { createdAt: "desc" }, // newest first (Req 9.2)
    });
    const entries: IntelligenceMemoryEntry[] = [];
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (!isWithinRetention(entry.createdAt, nowMs)) continue; // Req 9.7
      entries.push(entry);
    }
    return entries;
  }

  /** Delete all entries owned by `userId`; returns the count removed (Req 9.6). */
  async deleteByUser(userId: string): Promise<number> {
    const result = await this.db.intelligenceMemory.deleteMany({
      where: { userId },
    });
    return result.count;
  }

  /**
   * Delete entries older than {@link RETENTION_DAYS} (Req 9.7); returns the
   * count removed. Entries strictly older than the 365-day window relative to
   * `opts.now`/`Date.now()` are removed (cron/route triggerable).
   */
  async purgeExpired(opts?: { now?: string }): Promise<number> {
    const nowMs = resolveNow(opts?.now);
    const cutoff = new Date(nowMs - RETENTION_MS);
    const result = await this.db.intelligenceMemory.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return result.count;
  }
}
