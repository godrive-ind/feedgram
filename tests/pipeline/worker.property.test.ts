import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  PipelineWorker,
  InMemoryBriefStore,
} from "@/lib/pipeline/worker";
import {
  CreditManager,
  InMemoryCreditRepository,
} from "@/lib/credit/credit-manager";
import {
  InMemoryJobStore,
  type CreateJobInput,
  type JobStatusPatch,
  type JobStore,
} from "@/lib/jobs/job-store";
import {
  MockAIServiceConnector,
  createControllableScheduler,
  type AIServiceConnector,
} from "@/lib/ai/connector";
import { STEP_IDS, STEP_NAMES, getStepName } from "@/lib/pipeline/engine";
import {
  CONTENT_GOALS,
  VISUAL_STYLES,
  TONES,
  MANDATORY_ELEMENTS,
  OUTPUT_FORMATS,
  VARIATION_COUNTS,
  type DesignBriefInput,
  type Job,
  type JobStatus,
  type StepId,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Arbitraries — valid design briefs constrained to the real input space.
// ---------------------------------------------------------------------------

const hexColorArb = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, "0")}`);

const validBriefArb: fc.Arbitrary<DesignBriefInput> = fc.record({
  brandName: fc
    .string({ minLength: 1, maxLength: 50 })
    .filter((s) => s.trim().length > 0),
  tagline: fc.string({ maxLength: 100 }),
  mainMessage: fc.string({ maxLength: 500 }),
  contentGoal: fc.constantFrom(...CONTENT_GOALS),
  visualStyle: fc.constantFrom(...VISUAL_STYLES),
  tone: fc.constantFrom(...TONES),
  outputFormat: fc.constantFrom(...OUTPUT_FORMATS),
  variationCount: fc.constantFrom(...VARIATION_COUNTS),
  accentPalette: fc.array(hexColorArb, { minLength: 1, maxLength: 5 }),
  mandatoryElements: fc.uniqueArray(fc.constantFrom(...MANDATORY_ELEMENTS), {
    maxLength: MANDATORY_ELEMENTS.length,
  }),
  uploadedAssets: fc.constant([]),
}) as fc.Arbitrary<DesignBriefInput>;

const variationCountArb = fc.constantFrom(...VARIATION_COUNTS);

/**
 * Failure mode for a run. Steps 1, 2, 4, 5 are pure (cannot fail in this
 * wiring); the connector-backed steps 3 (copy) and 6 (image) can be driven to
 * fail to exercise the failed-state progress indicator.
 */
const failureModeArb = fc.constantFrom<"none" | "step3" | "step6">(
  "none",
  "step3",
  "step6",
);

// ---------------------------------------------------------------------------
// A recording JobStore decorator.
//
// It wraps an InMemoryJobStore and, on EVERY status mutation, captures the
// just-published JobStatus AND immediately re-polls via getStatus. This lets
// the property assert that what a poller observes (getStatus) is always
// consistent with the worker's internal published state, at every transition.
// ---------------------------------------------------------------------------

interface Snapshot {
  /** Status returned by the mutation (the worker's internal published state). */
  published: JobStatus;
  /** Status observed by an independent poll right after the mutation. */
  polled: JobStatus;
}

class RecordingJobStore implements JobStore {
  readonly snapshots: Snapshot[] = [];
  constructor(private readonly inner: InMemoryJobStore) {}

  createJob(input: CreateJobInput): Promise<Job> {
    return this.inner.createJob(input);
  }
  getJob(jobId: string) {
    return this.inner.getJob(jobId);
  }
  async updateStatus(
    jobId: string,
    patch: JobStatusPatch,
  ): Promise<JobStatus | undefined> {
    const published = await this.inner.updateStatus(jobId, patch);
    if (published) {
      const polled = await this.inner.getStatus(jobId);
      // The poll must observe exactly the published state (Req 2.9).
      this.snapshots.push({ published, polled: polled! });
    }
    return published;
  }
  getStatus(jobId: string, ownerUserId?: string) {
    return this.inner.getStatus(jobId, ownerUserId);
  }
}

// ---------------------------------------------------------------------------
// Worker wiring helpers (in-memory + mock connector).
// ---------------------------------------------------------------------------

function makeConnector(mode: "none" | "step3" | "step6"): AIServiceConnector {
  const scheduler = createControllableScheduler();
  if (mode === "step3") {
    return new MockAIServiceConnector({
      copy: { behavior: "fail", error: new Error("llm down") },
      defaults: { scheduler, maxAttempts: 1 },
    });
  }
  if (mode === "step6") {
    return new MockAIServiceConnector({
      image: { behavior: "fail", error: new Error("image gen down") },
      defaults: { scheduler, maxAttempts: 1 },
    });
  }
  return new MockAIServiceConnector({ defaults: { scheduler } });
}

/** The step expected to fail for a given mode (undefined = full success). */
function expectedFailedStep(mode: "none" | "step3" | "step6"): StepId | undefined {
  if (mode === "step3") return 3;
  if (mode === "step6") return 6;
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-snapshot consistency check between the exposed indicator and the engine.
// ---------------------------------------------------------------------------

function assertIndicatorConsistent(status: JobStatus): void {
  const { currentStep, statuses } = status;

  // currentStep must be a valid active step number (1..6).
  expect(STEP_IDS).toContain(currentStep);

  // The exposed step NAME must match the engine's name for currentStep.
  expect(getStepName(currentStep)).toBe(STEP_NAMES[currentStep]);
  expect(getStepName(currentStep).length).toBeGreaterThan(0);

  // The statuses map must cover exactly the six pipeline steps.
  const keys = Object.keys(statuses)
    .map((k) => Number(k) as StepId)
    .sort((a, b) => a - b);
  expect(keys).toEqual([...STEP_IDS]);

  // Each per-step status is a valid enum value.
  for (const step of STEP_IDS) {
    expect(["pending", "running", "done", "failed"]).toContain(statuses[step]);
  }

  // Every step strictly before the active step has already completed ("done").
  for (const step of STEP_IDS) {
    if (step < currentStep) {
      expect(statuses[step]).toBe("done");
    }
  }
}

// ---------------------------------------------------------------------------
// Property 10: Indikator progres mencerminkan state pipeline
// ---------------------------------------------------------------------------

describe("PipelineWorker — progress indicator reflects pipeline state", () => {
  // Feature: feed-design-generator, Property 10: Indikator progres mencerminkan state pipeline
  // Validates: Requirements 2.9
  it("keeps every published JobStatus (and its poll) consistent with the engine's currentStep, step name, and per-step statuses", async () => {
    await fc.assert(
      fc.asyncProperty(
        validBriefArb,
        variationCountArb,
        failureModeArb,
        async (brief, variationCount, mode) => {
          const inner = new InMemoryJobStore();
          const jobStore = new RecordingJobStore(inner);
          const briefStore = new InMemoryBriefStore();
          const creditManager = new CreditManager(
            new InMemoryCreditRepository({ u1: 9 }),
          );
          const worker = new PipelineWorker({
            jobStore,
            creditManager,
            briefStore,
            connector: makeConnector(mode),
          });

          const job = await worker.createJob(brief, variationCount, "u1");
          await worker.runJob(job.id);

          // At least the creation + run transitions were published.
          expect(jobStore.snapshots.length).toBeGreaterThan(0);

          // Every published state and every independent poll of it must be a
          // consistent indicator, and the poll must equal the published state.
          let prevStep = 0;
          for (const { published, polled } of jobStore.snapshots) {
            assertIndicatorConsistent(published);
            assertIndicatorConsistent(polled);
            // Polling observes exactly the worker's internal published state.
            expect(polled).toEqual(published);
            // currentStep never moves backward across transitions (strict seq).
            expect(published.currentStep).toBeGreaterThanOrEqual(prevStep);
            prevStep = published.currentStep;
          }

          // Final poll equals the last published snapshot (idempotent read).
          const finalStatus = await worker.getJobStatus(job.id, "u1");
          expect(finalStatus).toBeDefined();
          const last = jobStore.snapshots[jobStore.snapshots.length - 1];
          expect(finalStatus).toEqual(last.published);

          const failedStep = expectedFailedStep(mode);
          if (failedStep === undefined) {
            // Success terminal state: done at step 6, all steps done.
            expect(finalStatus!.state).toBe("done");
            expect(finalStatus!.currentStep).toBe(6);
            for (const step of STEP_IDS) {
              expect(finalStatus!.statuses[step]).toBe("done");
            }
          } else {
            // Failure terminal state: failed at K, K failed, 1..K-1 done.
            expect(finalStatus!.state).toBe("failed");
            expect(finalStatus!.currentStep).toBe(failedStep);
            expect(finalStatus!.failedStep).toBe(failedStep);
            expect(finalStatus!.statuses[failedStep]).toBe("failed");
            for (const step of STEP_IDS) {
              if (step < failedStep) {
                expect(finalStatus!.statuses[step]).toBe("done");
              }
            }
            // The failure message names the step number + name (Req 2.9/2.10).
            expect(finalStatus!.message).toContain(`Langkah ${failedStep}`);
            expect(finalStatus!.message).toContain(STEP_NAMES[failedStep]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
