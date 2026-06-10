/**
 * Job Store (task 7.1) — persistence for `Job` + `JobStatus`, plus a
 * Prisma-backed {@link CreditRepository} that performs the credit
 * reserve → commit/refund pattern inside atomic DB transactions.
 *
 * Two implementations are provided for every persistence concern:
 *   1. In-memory implementations ({@link InMemoryJobStore},
 *      reuse {@link InMemoryCreditRepository}) — used by tests and local wiring.
 *   2. Prisma-backed implementations ({@link PrismaJobStore},
 *      {@link PrismaCreditRepository}) — wired in production.
 *
 * The Prisma-backed classes accept a structurally-typed client by injection
 * (see {@link PrismaClientLike}) and use dynamic/structural typing only. This
 * means this module compiles and the test-suite runs even when
 * `prisma generate` has NOT been run and `@prisma/client` types are absent.
 *
 * Requirements: 8.6 (balance never < 0), 2.10 (atomic refund on failure),
 *               7.1 (persist batch/job), 2.9 (job status polling).
 */

import {
  type CreditRepository,
  type Reservation,
} from "@/lib/credit/credit-manager";
import {
  type Job,
  type JobState,
  type JobStatus,
  type StepId,
  type StepStatus,
  type VariationCount,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All six step ids, in order. */
export const STEP_IDS: readonly StepId[] = [1, 2, 3, 4, 5, 6] as const;

/** Build an initial per-step status map with every step "pending". Req 2.9 */
export function initialStepStatuses(): Record<StepId, StepStatus> {
  return {
    1: "pending",
    2: "pending",
    3: "pending",
    4: "pending",
    5: "pending",
    6: "pending",
  };
}

/** Build the initial `JobStatus` for a freshly created job (queued at step 1). */
export function initialJobStatus(jobId: string, now: string): JobStatus {
  return {
    jobId,
    state: "queued",
    currentStep: 1,
    statuses: initialStepStatuses(),
    updatedAt: now,
  };
}

/** ISO timestamp helper (kept separate so tests can reason about ordering). */
function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// JobStore interface
// ---------------------------------------------------------------------------

/** Input for creating a new job. */
export interface CreateJobInput {
  userId: string;
  briefId: string;
  variationCount: VariationCount;
  reservationId: string;
  /** Optional explicit id (defaults to a generated id). */
  id?: string;
}

/** Patch applied by {@link JobStore.updateStatus}. */
export interface JobStatusPatch {
  state?: JobState;
  currentStep?: StepId;
  /** Replace the whole per-step status map. */
  statuses?: Record<StepId, StepStatus>;
  /** Update the status of a single step (merged into the existing map). */
  step?: { id: StepId; status: StepStatus };
  resultBatchId?: string;
  failedStep?: StepId;
  message?: string;
  /**
   * Design_Intelligence summary surfaced to pollers (Professional_Mode only).
   * Merged field-by-field into any existing `intelligence` object so partial
   * updates (e.g. setting `acceptedCount`/`warnings` after FASE PASCA) do not
   * clobber earlier flags. Req 4.5, 6.7, 11.2.
   */
  intelligence?: {
    briefAnalysisReady?: boolean;
    acceptedCount?: number;
    warnings?: string[];
  };
}

/**
 * Persistence boundary for jobs and their status.
 *
 * `getStatus` accepts an optional `ownerUserId`; when provided the store
 * enforces ownership (Req: only the owning user may poll a job) and returns
 * `undefined` if the job is not owned by that user.
 */
export interface JobStore {
  createJob(input: CreateJobInput): Promise<Job>;
  getJob(jobId: string): Promise<Job | undefined>;
  /**
   * Update a job's status. `updatedAt` is refreshed automatically (Req 2.9).
   * Returns the updated status, or `undefined` if the job is unknown.
   */
  updateStatus(
    jobId: string,
    patch: JobStatusPatch,
  ): Promise<JobStatus | undefined>;
  /**
   * Read a job's status. When `ownerUserId` is supplied, enforces ownership and
   * returns `undefined` for a non-owned/unknown job.
   */
  getStatus(jobId: string, ownerUserId?: string): Promise<JobStatus | undefined>;
}

/** Apply a {@link JobStatusPatch} to an existing status, returning a new copy. */
function applyPatch(
  current: JobStatus,
  patch: JobStatusPatch,
  now: string,
): JobStatus {
  const statuses: Record<StepId, StepStatus> = patch.statuses
    ? { ...patch.statuses }
    : { ...current.statuses };

  if (patch.step) {
    statuses[patch.step.id] = patch.step.status;
  }

  // Merge the optional Design_Intelligence summary field-by-field so partial
  // patches (FASE PRA sets `briefAnalysisReady`; FASE PASCA sets
  // `acceptedCount`/`warnings`) don't clobber one another (Req 6.7, 11.2).
  const intelligence =
    patch.intelligence !== undefined
      ? { ...current.intelligence, ...patch.intelligence }
      : current.intelligence;

  return {
    ...current,
    state: patch.state ?? current.state,
    currentStep: patch.currentStep ?? current.currentStep,
    statuses,
    resultBatchId:
      patch.resultBatchId !== undefined
        ? patch.resultBatchId
        : current.resultBatchId,
    failedStep:
      patch.failedStep !== undefined ? patch.failedStep : current.failedStep,
    message: patch.message !== undefined ? patch.message : current.message,
    intelligence,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// In-memory JobStore (tests + local wiring)
// ---------------------------------------------------------------------------

/** In-memory {@link JobStore} keeping jobs and statuses in maps. */
export class InMemoryJobStore implements JobStore {
  private jobs = new Map<string, Job>();
  private statuses = new Map<string, JobStatus>();
  private seq = 0;

  async createJob(input: CreateJobInput): Promise<Job> {
    const id = input.id ?? `job_${++this.seq}`;
    const now = nowIso();
    const job: Job = {
      id,
      userId: input.userId,
      briefId: input.briefId,
      variationCount: input.variationCount,
      reservationId: input.reservationId,
      createdAt: now,
    };
    this.jobs.set(id, job);
    this.statuses.set(id, initialJobStatus(id, now));
    return { ...job };
  }

  async getJob(jobId: string): Promise<Job | undefined> {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : undefined;
  }

  async updateStatus(
    jobId: string,
    patch: JobStatusPatch,
  ): Promise<JobStatus | undefined> {
    const current = this.statuses.get(jobId);
    if (!current) return undefined;
    const updated = applyPatch(current, patch, nowIso());
    this.statuses.set(jobId, updated);
    return { ...updated, statuses: { ...updated.statuses } };
  }

  async getStatus(
    jobId: string,
    ownerUserId?: string,
  ): Promise<JobStatus | undefined> {
    const status = this.statuses.get(jobId);
    if (!status) return undefined;
    if (ownerUserId !== undefined) {
      const job = this.jobs.get(jobId);
      if (!job || job.userId !== ownerUserId) return undefined;
    }
    return { ...status, statuses: { ...status.statuses } };
  }
}

// ---------------------------------------------------------------------------
// Structural Prisma client typing (compiles without @prisma/client generated)
// ---------------------------------------------------------------------------

/**
 * Minimal structural shape of a Prisma model delegate (`findUnique`, `create`,
 * `update`, `upsert`). Kept loose (`any`) so the real generated client is
 * assignable without importing its types.
 */
export interface PrismaModelDelegateLike {
  findUnique(args: any): Promise<any>;
  findFirst?(args: any): Promise<any>;
  create(args: any): Promise<any>;
  update(args: any): Promise<any>;
  upsert?(args: any): Promise<any>;
}

/**
 * Minimal structural shape of a `PrismaClient` exposing only what this module
 * needs. A real `PrismaClient` is structurally assignable to this type, so no
 * import of `@prisma/client` is required for typecheck.
 */
export interface PrismaClientLike {
  job: PrismaModelDelegateLike;
  jobStatus: PrismaModelDelegateLike;
  credit: PrismaModelDelegateLike;
  reservation: PrismaModelDelegateLike;
  /**
   * Interactive transaction. The callback receives a transactional client of
   * the same structural shape; all writes inside it are atomic.
   */
  $transaction<T>(fn: (tx: PrismaClientLike) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Prisma-backed JobStore
// ---------------------------------------------------------------------------

/**
 * Prisma-backed {@link JobStore}. Accepts a structurally-typed client by
 * injection so it compiles without a generated `@prisma/client`.
 */
export class PrismaJobStore implements JobStore {
  constructor(private readonly db: PrismaClientLike) {}

  async createJob(input: CreateJobInput): Promise<Job> {
    const now = nowIso();
    const created = await this.db.job.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        userId: input.userId,
        briefId: input.briefId,
        variationCount: input.variationCount,
        reservationId: input.reservationId,
        status: {
          create: {
            state: "queued",
            currentStep: 1,
            statuses: initialStepStatuses(),
          },
        },
      },
    });

    return {
      id: created.id,
      userId: created.userId,
      briefId: created.briefId,
      variationCount: created.variationCount as VariationCount,
      reservationId: created.reservationId,
      createdAt:
        created.createdAt instanceof Date
          ? created.createdAt.toISOString()
          : (created.createdAt ?? now),
    };
  }

  async getJob(jobId: string): Promise<Job | undefined> {
    const row = await this.db.job.findUnique({ where: { id: jobId } });
    if (!row) return undefined;
    return {
      id: row.id,
      userId: row.userId,
      briefId: row.briefId,
      variationCount: row.variationCount as VariationCount,
      reservationId: row.reservationId,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : row.createdAt,
    };
  }

  async updateStatus(
    jobId: string,
    patch: JobStatusPatch,
  ): Promise<JobStatus | undefined> {
    const existing = await this.db.jobStatus.findUnique({ where: { jobId } });
    if (!existing) return undefined;

    const current = rowToJobStatus(jobId, existing);
    const updated = applyPatch(current, patch, nowIso());

    await this.db.jobStatus.update({
      where: { jobId },
      data: {
        state: updated.state,
        currentStep: updated.currentStep,
        statuses: updated.statuses,
        resultBatchId: updated.resultBatchId ?? null,
        failedStep: updated.failedStep ?? null,
        message: updated.message ?? null,
      },
    });

    return updated;
  }

  async getStatus(
    jobId: string,
    ownerUserId?: string,
  ): Promise<JobStatus | undefined> {
    if (ownerUserId !== undefined) {
      const job = await this.db.job.findUnique({ where: { id: jobId } });
      if (!job || job.userId !== ownerUserId) return undefined;
    }
    const row = await this.db.jobStatus.findUnique({ where: { jobId } });
    if (!row) return undefined;
    return rowToJobStatus(jobId, row);
  }
}

/** Convert a `JobStatus` DB row (structural) to the domain {@link JobStatus}. */
function rowToJobStatus(jobId: string, row: any): JobStatus {
  return {
    jobId,
    state: row.state as JobState,
    currentStep: row.currentStep as StepId,
    statuses: (row.statuses ?? initialStepStatuses()) as Record<
      StepId,
      StepStatus
    >,
    resultBatchId: row.resultBatchId ?? undefined,
    failedStep: (row.failedStep ?? undefined) as StepId | undefined,
    message: row.message ?? undefined,
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : (row.updatedAt ?? nowIso()),
  };
}

// ---------------------------------------------------------------------------
// Prisma-backed CreditRepository (atomic reserve -> commit/refund)
// ---------------------------------------------------------------------------

/**
 * Prisma-backed {@link CreditRepository}. Implements the same contract as
 * {@link InMemoryCreditRepository} but performs each mutation inside a DB
 * transaction (`$transaction`) so:
 *   - the balance is checked-and-held atomically and NEVER goes < 0 (Req 8.6),
 *   - commit/refund are atomic and idempotent (Req 8.2, 2.10).
 *
 * Wires the existing `CreditManager` (lib/credit/credit-manager.ts) to Postgres
 * without changing the manager's logic.
 *
 * Injected with a structurally-typed client so it compiles without a generated
 * `@prisma/client`.
 */
export class PrismaCreditRepository implements CreditRepository {
  constructor(private readonly db: PrismaClientLike) {}

  /** Current available (unreserved) balance; 0 if the user has no credit row. */
  async getBalance(userId: string): Promise<number> {
    const credit = await this.db.credit.findUnique({ where: { userId } });
    const balance = credit?.balance ?? 0;
    return normalize(balance);
  }

  /**
   * Atomically check-and-hold `amount` credits. Inside one transaction it reads
   * the current balance, rejects (returns `undefined`) if insufficient, then
   * decrements the available balance and creates a "held" reservation. Because
   * the read + write happen in the same transaction, concurrent holds cannot
   * drive the balance below 0 (Req 8.6).
   */
  async hold(userId: string, amount: number): Promise<Reservation | undefined> {
    const normalizedAmount = Math.floor(amount);
    if (normalizedAmount <= 0) return undefined;

    return this.db.$transaction(async (tx) => {
      const credit = await tx.credit.findUnique({ where: { userId } });
      const available = normalize(credit?.balance ?? 0);

      // Req 8.3 / 8.6 — reject when insufficient; leave balance unchanged.
      if (available < normalizedAmount) {
        return undefined;
      }

      await tx.credit.update({
        where: { userId },
        data: { balance: available - normalizedAmount },
      });

      const reservation = await tx.reservation.create({
        data: {
          userId,
          amount: normalizedAmount,
          status: "held",
        },
      });

      return {
        id: reservation.id,
        userId,
        amount: normalizedAmount,
        status: "held",
      } satisfies Reservation;
    });
  }

  /**
   * Finalize a held reservation as committed. The held funds were already
   * removed from the available balance by {@link hold}; commit only marks the
   * reservation consumed (Req 8.2). Idempotent: a non-"held" reservation is a
   * no-op.
   */
  async commitReservation(reservationId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });
      if (!reservation || reservation.status !== "held") return;
      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: "committed" },
      });
    });
  }

  /**
   * Partially finalize a held reservation: commit `commitAmount` credits and
   * refund the remainder back to the user's available balance, atomically
   * (Req 11.4). `commitAmount` is clamped to `[0, reservation.amount]`, so a
   * full amount behaves like {@link commitReservation} (no balance change) and
   * `0` behaves like {@link refundReservation} (full refund). Atomic and
   * idempotent: a non-"held" reservation is a no-op. The balance never goes
   * below 0 and stays an integer (Req 8.6).
   */
  async commitPartialReservation(
    reservationId: string,
    commitAmount: number,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });
      if (!reservation || reservation.status !== "held") return;

      const amount = normalize(reservation.amount);
      const commit = clampCommit(commitAmount, amount);
      const refundAmount = amount - commit;

      if (refundAmount > 0) {
        const credit = await tx.credit.findUnique({
          where: { userId: reservation.userId },
        });
        const available = normalize(credit?.balance ?? 0);
        await tx.credit.update({
          where: { userId: reservation.userId },
          data: { balance: available + refundAmount },
        });
      }
      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: "committed" },
      });
    });
  }

  /**
   * Release a held reservation, returning the held funds to the user's
   * available balance (Req 2.10). Atomic and idempotent: a non-"held"
   * reservation is a no-op so refunds can never double-credit.
   */
  async refundReservation(reservationId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });
      if (!reservation || reservation.status !== "held") return;

      const credit = await tx.credit.findUnique({
        where: { userId: reservation.userId },
      });
      const available = normalize(credit?.balance ?? 0);

      await tx.credit.update({
        where: { userId: reservation.userId },
        data: { balance: available + reservation.amount },
      });
      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: "refunded" },
      });
    });
  }
}

/** Clamp a balance to a non-negative integer (Req 8.6). */
function normalize(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  return floored < 0 ? 0 : floored;
}

/**
 * Clamp a partial-commit amount to an integer in `[0, amount]` (Req 8.6).
 * Non-finite input is treated as 0 so the whole reservation is refunded.
 */
function clampCommit(commitAmount: number, amount: number): number {
  if (!Number.isFinite(commitAmount)) return 0;
  const floored = Math.floor(commitAmount);
  if (floored <= 0) return 0;
  return floored > amount ? amount : floored;
}

/** Factory: create an in-memory job store (test/local wiring). */
export function createInMemoryJobStore(): InMemoryJobStore {
  return new InMemoryJobStore();
}
