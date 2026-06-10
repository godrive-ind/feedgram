import { describe, expect, it } from "vitest";

import {
  HISTORY_PAGE_SIZE,
  STEP_IDS,
  describeProgress,
  isTerminalState,
  isValidRating,
  normalizeBalance,
  resolveDisplayedRating,
  shapeHistory,
  shouldContinuePolling,
  toProgressRows,
  toRatingRows,
} from "@/app/components/progress-helpers";
import type {
  DesignVariation,
  GenerationBatch,
  JobStatus,
  StepId,
  StepStatus,
} from "@/lib/types";

// Unit tests for the Right Panel (Properties/Prompt-Chain/History/Credit) pure
// helpers (task 11.3).
// Requirements: 2.9 (progress), 7.2 (history), 7.4/7.8 (rating), 8.1 (credit)

function makeStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  const statuses: Record<StepId, StepStatus> = {
    1: "pending",
    2: "pending",
    3: "pending",
    4: "pending",
    5: "pending",
    6: "pending",
  };
  return {
    jobId: "job-1",
    state: "running",
    currentStep: 1,
    statuses,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBatch(overrides: Partial<GenerationBatch> = {}): GenerationBatch {
  return {
    id: "batch-1",
    userId: "user-1",
    briefId: "brief-1",
    variations: [],
    status: "done",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("progress-helpers", () => {
  describe("toProgressRows (Req 2.9)", () => {
    it("returns one row per step in order 1..6 with names + status labels", () => {
      const status = makeStatus({
        currentStep: 3,
        statuses: {
          1: "done",
          2: "done",
          3: "running",
          4: "pending",
          5: "pending",
          6: "pending",
        },
      });
      const rows = toProgressRows(status);
      expect(rows.map((r) => r.step)).toEqual([...STEP_IDS]);
      expect(rows[0].name).toBe("Brand DNA Extraction");
      expect(rows[2].name).toBe("Copy Generation");
      expect(rows[2].status).toBe("running");
      expect(rows[2].statusLabel).toBe("Sedang berjalan");
    });

    it("marks the current step active while running", () => {
      const rows = toProgressRows(makeStatus({ currentStep: 2 }));
      expect(rows.find((r) => r.isActive)?.step).toBe(2);
    });

    it("marks no step active in a terminal state", () => {
      const done = toProgressRows(makeStatus({ state: "done", currentStep: 6 }));
      expect(done.some((r) => r.isActive)).toBe(false);
      const failed = toProgressRows(
        makeStatus({ state: "failed", currentStep: 4 }),
      );
      expect(failed.some((r) => r.isActive)).toBe(false);
    });

    it("defaults a missing step status to pending", () => {
      // @ts-expect-error intentionally drop a key to test defensiveness
      const status = makeStatus({ statuses: { 1: "done" } });
      const rows = toProgressRows(status);
      expect(rows[5].status).toBe("pending");
    });
  });

  describe("isTerminalState / shouldContinuePolling (Req 2.9)", () => {
    it("treats done and failed as terminal", () => {
      expect(isTerminalState("done")).toBe(true);
      expect(isTerminalState("failed")).toBe(true);
      expect(isTerminalState("running")).toBe(false);
      expect(isTerminalState("queued")).toBe(false);
    });

    it("continues polling for null/queued/running and stops on terminal", () => {
      expect(shouldContinuePolling(null)).toBe(true);
      expect(shouldContinuePolling(makeStatus({ state: "queued" }))).toBe(true);
      expect(shouldContinuePolling(makeStatus({ state: "running" }))).toBe(true);
      expect(shouldContinuePolling(makeStatus({ state: "done" }))).toBe(false);
      expect(shouldContinuePolling(makeStatus({ state: "failed" }))).toBe(false);
    });
  });

  describe("describeProgress (Req 2.9)", () => {
    it("describes the active step while running", () => {
      expect(describeProgress(makeStatus({ currentStep: 3 }))).toBe(
        "Langkah 3/6: Copy Generation",
      );
    });

    it("reports success on done", () => {
      expect(describeProgress(makeStatus({ state: "done" }))).toContain(
        "Selesai",
      );
    });

    it("reports the failed step on failure", () => {
      const msg = describeProgress(
        makeStatus({ state: "failed", failedStep: 5, currentStep: 5 }),
      );
      expect(msg).toContain("Gagal pada langkah 5/6");
      expect(msg).toContain("Image Prompt Build");
    });
  });

  describe("shapeHistory (Req 7.2)", () => {
    it("orders batches newest-first", () => {
      const batches = [
        makeBatch({ id: "old", createdAt: "2024-01-01T00:00:00.000Z" }),
        makeBatch({ id: "new", createdAt: "2024-03-01T00:00:00.000Z" }),
        makeBatch({ id: "mid", createdAt: "2024-02-01T00:00:00.000Z" }),
      ];
      expect(shapeHistory(batches).map((r) => r.batchId)).toEqual([
        "new",
        "mid",
        "old",
      ]);
    });

    it("caps the page to 20 entries", () => {
      const batches = Array.from({ length: 25 }, (_, i) =>
        makeBatch({
          id: `b-${i}`,
          createdAt: new Date(2024, 0, i + 1).toISOString(),
        }),
      );
      expect(shapeHistory(batches)).toHaveLength(HISTORY_PAGE_SIZE);
    });

    it("does not mutate the input array", () => {
      const batches = [
        makeBatch({ id: "a", createdAt: "2024-01-01T00:00:00.000Z" }),
        makeBatch({ id: "b", createdAt: "2024-02-01T00:00:00.000Z" }),
      ];
      const before = batches.map((b) => b.id);
      shapeHistory(batches);
      expect(batches.map((b) => b.id)).toEqual(before);
    });

    it("derives variation counts", () => {
      const variation = {} as DesignVariation;
      const rows = shapeHistory([
        makeBatch({ variations: [variation, variation] }),
      ]);
      expect(rows[0].variationCount).toBe(2);
    });
  });

  describe("rating validation (Req 7.4, 7.8)", () => {
    it("accepts integers 1..5", () => {
      for (const r of [1, 2, 3, 4, 5]) expect(isValidRating(r)).toBe(true);
    });

    it("rejects out-of-range and non-integer values", () => {
      expect(isValidRating(0)).toBe(false);
      expect(isValidRating(6)).toBe(false);
      expect(isValidRating(-1)).toBe(false);
      expect(isValidRating(2.5)).toBe(false);
      expect(isValidRating(Number.NaN)).toBe(false);
    });

    it("preserves the previous rating when an invalid value is attempted (Req 7.8)", () => {
      expect(resolveDisplayedRating(3, 9)).toBe(3);
      expect(resolveDisplayedRating(undefined, 0)).toBeUndefined();
    });

    it("stores a valid new rating", () => {
      expect(resolveDisplayedRating(2, 4)).toBe(4);
      expect(resolveDisplayedRating(undefined, 5)).toBe(5);
    });
  });

  describe("toRatingRows", () => {
    it("maps variations to id + current rating", () => {
      const variations = [
        { id: "v1", rating: 4 } as DesignVariation,
        { id: "v2" } as DesignVariation,
      ];
      expect(toRatingRows(variations)).toEqual([
        { variationId: "v1", rating: 4 },
        { variationId: "v2", rating: undefined },
      ]);
    });
  });

  describe("normalizeBalance (Req 8.1)", () => {
    it("returns a non-negative integer", () => {
      expect(normalizeBalance(10)).toBe(10);
      expect(normalizeBalance(3.9)).toBe(3);
      expect(normalizeBalance(-5)).toBe(0);
    });

    it("falls back to 0 for bad values", () => {
      expect(normalizeBalance(undefined)).toBe(0);
      expect(normalizeBalance("12")).toBe(0);
      expect(normalizeBalance(Number.NaN)).toBe(0);
      expect(normalizeBalance(Infinity)).toBe(0);
    });
  });
});
