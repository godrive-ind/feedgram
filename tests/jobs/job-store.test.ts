import { describe, expect, it } from "vitest";

import {
  InMemoryJobStore,
  PrismaCreditRepository,
  PrismaJobStore,
  STEP_IDS,
  initialJobStatus,
  initialStepStatuses,
  createInMemoryJobStore,
  type PrismaClientLike,
} from "@/lib/jobs/job-store";
import { CreditManager } from "@/lib/credit/credit-manager";
import type { JobStatus, StepId } from "@/lib/types";

// ---------------------------------------------------------------------------
// In-memory JobStore unit tests
// ---------------------------------------------------------------------------

describe("InMemoryJobStore: create + initial status", () => {
  it("creates a job and seeds a queued status with all steps pending", async () => {
    const store = new InMemoryJobStore();
    const job = await store.createJob({
      userId: "u1",
      briefId: "b1",
      variationCount: 6,
      reservationId: "res_1",
    });

    expect(job.id).toBeTypeOf("string");
    expect(job.userId).toBe("u1");
    expect(job.variationCount).toBe(6);

    const status = await store.getStatus(job.id);
    expect(status).toBeDefined();
    expect(status!.state).toBe("queued");
    expect(status!.currentStep).toBe(1);
    for (const step of STEP_IDS) {
      expect(status!.statuses[step]).toBe("pending");
    }
  });

  it("initialStepStatuses returns all six steps pending", () => {
    const statuses = initialStepStatuses();
    expect(Object.keys(statuses)).toHaveLength(6);
    expect(Object.values(statuses).every((s) => s === "pending")).toBe(true);
  });

  it("initialJobStatus builds a queued status at step 1", () => {
    const status = initialJobStatus("job_x", "2024-01-01T00:00:00.000Z");
    expect(status.jobId).toBe("job_x");
    expect(status.state).toBe("queued");
    expect(status.currentStep).toBe(1);
  });
});

describe("InMemoryJobStore: updateStatus", () => {
  it("updates a single step and refreshes updatedAt", async () => {
    const store = createInMemoryJobStore();
    const job = await store.createJob({
      userId: "u1",
      briefId: "b1",
      variationCount: 3,
      reservationId: "res_1",
    });
    const before = await store.getStatus(job.id);

    await new Promise((r) => setTimeout(r, 2));
    const updated = await store.updateStatus(job.id, {
      state: "running",
      currentStep: 2,
      step: { id: 1, status: "done" },
    });

    expect(updated).toBeDefined();
    expect(updated!.state).toBe("running");
    expect(updated!.currentStep).toBe(2);
    expect(updated!.statuses[1]).toBe("done");
    expect(updated!.statuses[2]).toBe("pending");
    expect(updated!.updatedAt >= before!.updatedAt).toBe(true);
  });

  it("records done with resultBatchId", async () => {
    const store = new InMemoryJobStore();
    const job = await store.createJob({
      userId: "u1",
      briefId: "b1",
      variationCount: 3,
      reservationId: "res_1",
    });
    const updated = await store.updateStatus(job.id, {
      state: "done",
      statuses: { 1: "done", 2: "done", 3: "done", 4: "done", 5: "done", 6: "done" },
      resultBatchId: "batch_1",
    });
    expect(updated!.state).toBe("done");
    expect(updated!.resultBatchId).toBe("batch_1");
  });

  it("records failed with failedStep and message", async () => {
    const store = new InMemoryJobStore();
    const job = await store.createJob({
      userId: "u1",
      briefId: "b1",
      variationCount: 3,
      reservationId: "res_1",
    });
    const updated = await store.updateStatus(job.id, {
      state: "failed",
      failedStep: 3,
      message: "Langkah 3 (Copy Generation) gagal",
      step: { id: 3, status: "failed" },
    });
    expect(updated!.state).toBe("failed");
    expect(updated!.failedStep).toBe(3);
    expect(updated!.message).toContain("Langkah 3");
  });

  it("returns undefined when updating an unknown job", async () => {
    const store = new InMemoryJobStore();
    const result = await store.updateStatus("nope", { state: "running" });
    expect(result).toBeUndefined();
  });
});

describe("InMemoryJobStore: ownership on getStatus", () => {
  it("returns status for the owner and undefined for a different user", async () => {
    const store = new InMemoryJobStore();
    const job = await store.createJob({
      userId: "owner",
      briefId: "b1",
      variationCount: 3,
      reservationId: "res_1",
    });

    expect(await store.getStatus(job.id, "owner")).toBeDefined();
    expect(await store.getStatus(job.id, "intruder")).toBeUndefined();
    // No owner filter still returns the status.
    expect(await store.getStatus(job.id)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Prisma-backed implementations against a lightweight fake client.
// Verifies the structural client contract + atomic transaction behaviour.
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory fake of the structural {@link PrismaClientLike}. Models the
 * `credit`, `reservation`, `job`, `jobStatus` tables and a synchronous
 * `$transaction` (sufficient to exercise the read-then-write atomic logic).
 */
function makeFakePrisma() {
  const credits = new Map<string, { userId: string; balance: number }>();
  const reservations = new Map<
    string,
    { id: string; userId: string; amount: number; status: string }
  >();
  const jobs = new Map<string, any>();
  const jobStatuses = new Map<string, any>();
  let seq = 0;

  const client: PrismaClientLike = {
    credit: {
      async findUnique({ where }: any) {
        return credits.get(where.userId) ?? null;
      },
      async create({ data }: any) {
        credits.set(data.userId, { userId: data.userId, balance: data.balance ?? 0 });
        return credits.get(data.userId);
      },
      async update({ where, data }: any) {
        const row = credits.get(where.userId);
        if (!row) throw new Error("credit not found");
        if (data.balance !== undefined) row.balance = data.balance;
        return row;
      },
    },
    reservation: {
      async findUnique({ where }: any) {
        return reservations.get(where.id) ?? null;
      },
      async create({ data }: any) {
        const id = `res_${++seq}`;
        const row = { id, userId: data.userId, amount: data.amount, status: data.status };
        reservations.set(id, row);
        return row;
      },
      async update({ where, data }: any) {
        const row = reservations.get(where.id);
        if (!row) throw new Error("reservation not found");
        Object.assign(row, data);
        return row;
      },
    },
    job: {
      async findUnique({ where }: any) {
        return jobs.get(where.id) ?? null;
      },
      async create({ data }: any) {
        const id = data.id ?? `job_${++seq}`;
        const row = {
          id,
          userId: data.userId,
          briefId: data.briefId,
          variationCount: data.variationCount,
          reservationId: data.reservationId,
          createdAt: new Date(),
        };
        jobs.set(id, row);
        if (data.status?.create) {
          jobStatuses.set(id, {
            jobId: id,
            ...data.status.create,
            updatedAt: new Date(),
          });
        }
        return row;
      },
      async update({ where, data }: any) {
        const row = jobs.get(where.id);
        Object.assign(row, data);
        return row;
      },
    },
    jobStatus: {
      async findUnique({ where }: any) {
        return jobStatuses.get(where.jobId) ?? null;
      },
      async create({ data }: any) {
        jobStatuses.set(data.jobId, { ...data, updatedAt: new Date() });
        return jobStatuses.get(data.jobId);
      },
      async update({ where, data }: any) {
        const row = jobStatuses.get(where.jobId);
        if (!row) throw new Error("jobStatus not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    async $transaction<T>(fn: (tx: PrismaClientLike) => Promise<T>): Promise<T> {
      // Sequential, all-or-nothing enough for these single-threaded tests.
      return fn(client);
    },
  };

  return { client, credits, reservations };
}

describe("PrismaJobStore against a fake structural client", () => {
  it("creates a job + status and reads it back with ownership", async () => {
    const { client } = makeFakePrisma();
    const store = new PrismaJobStore(client);

    const job = await store.createJob({
      userId: "u1",
      briefId: "b1",
      variationCount: 9,
      reservationId: "res_1",
    });
    expect(job.variationCount).toBe(9);

    const status = await store.getStatus(job.id, "u1");
    expect(status?.state).toBe("queued");
    expect(await store.getStatus(job.id, "intruder")).toBeUndefined();

    const updated = await store.updateStatus(job.id, {
      state: "running",
      currentStep: 2,
      step: { id: 1, status: "done" },
    });
    expect(updated?.statuses[1]).toBe("done");
    expect(updated?.currentStep).toBe(2);
  });
});

describe("PrismaCreditRepository: atomic reserve/commit/refund", () => {
  it("holds, commits, and never drops the balance below zero", async () => {
    const { client, credits } = makeFakePrisma();
    credits.set("u1", { userId: "u1", balance: 10 });
    const repo = new PrismaCreditRepository(client);
    const manager = new CreditManager(repo);

    // Insufficient -> rejected, balance unchanged.
    const reject = await manager.reserve("u1", 11);
    expect(reject.success).toBe(false);
    expect(reject.upgradePrompt).toBe(true);
    expect(await manager.getBalance("u1")).toBe(10);

    // Hold 6 -> available becomes 4.
    const res = await manager.reserve("u1", 6);
    expect(res.success).toBe(true);
    expect(await manager.getBalance("u1")).toBe(4);

    // Commit -> balance stays 4 (held funds consumed).
    await manager.commit(res.reservationId!);
    expect(await manager.getBalance("u1")).toBe(4);

    // Commit again is a no-op (idempotent).
    await manager.commit(res.reservationId!);
    expect(await manager.getBalance("u1")).toBe(4);
  });

  it("refunds held funds atomically and is idempotent", async () => {
    const { client, credits } = makeFakePrisma();
    credits.set("u1", { userId: "u1", balance: 5 });
    const repo = new PrismaCreditRepository(client);
    const manager = new CreditManager(repo);

    const res = await manager.reserve("u1", 3);
    expect(await manager.getBalance("u1")).toBe(2);

    await manager.refund(res.reservationId!);
    expect(await manager.getBalance("u1")).toBe(5);

    // Second refund must not double-credit.
    await manager.refund(res.reservationId!);
    expect(await manager.getBalance("u1")).toBe(5);
  });
});
