/**
 * Pipeline worker (Layer 2 — background execution) — task 7.2.
 *
 * Bridges the async job model (Vercel-friendly) to the strict sequential
 * 6-step pipeline. It is the orchestration glue between:
 *   - the {@link JobStore} (task 7.1) — persists `Job` + `JobStatus`,
 *   - the {@link CreditManager} — reserve → commit/refund (Req 8.2, 2.10),
 *   - the pure pipeline core in `engine.ts` / `steps.ts` / `failure.ts`,
 *   - the batch consistency verifier in `consistency.ts` (Req 5.5, 5.6),
 *   - the (mockable) {@link AIServiceConnector} (Req 3.1, 3.2).
 *
 * Responsibilities (Req 2.9, 2.10):
 *   - `createJob`  — reserve credits, persist the brief, create the `Job`
 *                    (returns immediately so `POST /api/generate` can reply 202).
 *   - `runJob`     — run steps 1..6 in the background. On every transition it
 *                    updates `JobStatus` (`currentStep`, per-step `statuses`,
 *                    `updatedAt`). On failure it sets `state: "failed"` +
 *                    `failedStep` and refunds the unused credits. On success it
 *                    commits the credits and sets `state: "done"` +
 *                    `resultBatchId`.
 *   - `getJobStatus` — idempotent read of the persisted `JobStatus` (polling).
 *
 * The worker performs NO direct I/O of its own beyond the injected
 * dependencies, so it is fully unit-testable with in-memory stores and a mock
 * connector. External AI/storage adapters stay mockable via the connector.
 *
 * Requirements: 2.9, 2.10
 */

import {
  CreditManager,
  type CreditRepository,
  InMemoryCreditRepository,
} from "@/lib/credit/credit-manager";
import {
  type JobStore,
  InMemoryJobStore,
} from "@/lib/jobs/job-store";
import { markBatchConsistency } from "@/lib/pipeline/consistency";
import { LAST_STEP, start } from "@/lib/pipeline/engine";
import {
  runPipeline,
  type PipelineStepEvent,
} from "@/lib/pipeline/failure";
import {
  createStepTransforms,
  type StepTransformsOptions,
} from "@/lib/pipeline/steps";
import type {
  AIServiceConnector,
  ConnectorCallOptions,
} from "@/lib/ai/connector";
import { AIServiceError } from "@/lib/ai/connector";
import { composeVariation } from "@/lib/canvas/renderer";
import { resolveProfessionalMode } from "@/lib/intelligence/professional-mode";
import { deriveDecisionWeights } from "@/lib/intelligence/decision-weights";
import { buildBriefAnalysis } from "@/lib/intelligence/brief-analysis";
import { buildVisualStrategy } from "@/lib/intelligence/visual-strategy";
import { buildLayeredSystemPrompt } from "@/lib/intelligence/prompt-layers";
import {
  applyDnaAdjustments,
  DEFAULT_DESIGN_DNA,
  initDesignDnaFromWeights,
} from "@/lib/intelligence/design-dna";
import {
  COMMENT_MAX_LENGTH,
  REFINEMENT_RATING_MAX,
  REFINEMENT_RATING_MIN,
  interpretComment,
  isValidComment,
  isValidRefinementRating,
} from "@/lib/intelligence/refinement";
import { regenerateVariation } from "@/lib/pipeline/derive";
import { authorizeOwnership } from "@/lib/auth";
import {
  getVariationStore,
  type VariationStore,
} from "@/lib/server/variation-store";
import {
  type IntelligenceMemoryStore,
  seedDesignDnaFromMemory,
} from "@/lib/intelligence/intelligence-memory";
import {
  DEFAULT_QUALITY_GATE_CONFIG,
  type AttemptRecord,
  type QualityGateConfig,
  evaluateGate,
  selectBestAttempt,
} from "@/lib/intelligence/quality-gate";
import type {
  DecisionWeights,
  DesignBriefAnalysis,
  DesignBriefInput,
  DesignDNA,
  DesignVariation,
  DnaAdjustment,
  GenerationBatch,
  ImagePrompt,
  Job,
  JobStatus,
  LayeredSystemPrompt,
  MemoryContext,
  OutputFormat,
  ProfessionalBriefFields,
  QualityReport,
  StepId,
  StepStatus,
  VariationCount,
  VisualStrategy,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Brief store (mockable persistence for the brief behind a job)
// ---------------------------------------------------------------------------

/**
 * Persistence boundary for design briefs. `createJob` stores the submitted
 * brief and `runJob` reads it back by `briefId` (a job only carries a
 * `briefId`, not the brief itself). Kept as an injectable interface so the
 * worker is testable in memory and wired to Postgres (`DesignBrief` model) in
 * production without changing this logic.
 */
export interface BriefStore {
  /** Persist a brief, returning its assigned id. */
  saveBrief(brief: DesignBriefInput, id?: string): Promise<{ briefId: string }>;
  /** Read a previously-saved brief, or `undefined` if unknown. */
  getBrief(briefId: string): Promise<DesignBriefInput | undefined>;
}

/** In-memory {@link BriefStore} for tests and local wiring. */
export class InMemoryBriefStore implements BriefStore {
  private briefs = new Map<string, DesignBriefInput>();
  private seq = 0;

  async saveBrief(
    brief: DesignBriefInput,
    id?: string,
  ): Promise<{ briefId: string }> {
    const briefId = id ?? `brief_${++this.seq}`;
    // Store a defensive deep-ish copy so callers can't mutate the persisted brief.
    this.briefs.set(briefId, cloneBrief(brief));
    return { briefId };
  }

  async getBrief(briefId: string): Promise<DesignBriefInput | undefined> {
    const brief = this.briefs.get(briefId);
    return brief ? cloneBrief(brief) : undefined;
  }
}

/** Shallow+array clone of a brief (enough to prevent cross-mutation). */
function cloneBrief(brief: DesignBriefInput): DesignBriefInput {
  return {
    ...brief,
    accentPalette: [...brief.accentPalette],
    mandatoryElements: [...brief.mandatoryElements],
    uploadedAssets: brief.uploadedAssets.map((a) => ({ ...a })),
    outputFormat: { ...brief.outputFormat },
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link PipelineWorker.createJob} when the user lacks sufficient
 * credit for the requested variation count (Req 8.3). Carries the
 * upgrade-prompt flag so the API layer can surface the Pro upgrade CTA.
 */
export class InsufficientCreditError extends Error {
  readonly upgradePrompt: boolean;
  constructor(message: string, upgradePrompt: boolean) {
    super(message);
    this.name = "InsufficientCreditError";
    this.upgradePrompt = upgradePrompt;
  }
}

// ---------------------------------------------------------------------------
// Refinement_Loop result (Req 8.1, 8.6, 8.7, 8.8)
// ---------------------------------------------------------------------------

/**
 * Max wall-clock budget for a single Refinement_Loop regeneration (Req 8.6).
 * Forwarded as the connector `timeoutMs` so a stalled regeneration is aborted
 * and surfaced as a failure that preserves the original variation (Req 8.8).
 */
export const REFINEMENT_REGEN_TIMEOUT_MS = 30_000;

/**
 * Outcome of {@link PipelineWorker.runRefinement}.
 *
 * Mirrors the {@link DeriveResult} discriminated shape so the
 * preserve-on-failure contract is explicit (Req 8.8):
 *
 * - `ok: true`  → the (possibly regenerated) `variation`, the stored
 *   `refinementRating` (1–10 channel, A7), the structured `changes` (Design_DNA
 *   parameter + direction) and a human-readable `explanation` of them (Req 8.7).
 *   A valid comment that maps to no adjustment keeps the variation unchanged and
 *   carries a clarification `message` (Req 8.5), with empty `changes`.
 * - `ok: false` → the refinement was rejected/failed; the UNCHANGED `source`
 *   variation (when one was resolved) is returned together with the preserved
 *   previous `refinementRating` and a `message`. `reason` distinguishes an
 *   unknown/unauthorized variation, invalid rating (Req 8.2), invalid comment
 *   (Req 8.4), and a failed/timed-out regeneration (Req 8.8).
 */
export type RefinementResult =
  | {
      ok: true;
      variation: DesignVariation;
      /** Stored refinement rating on the separate 1–10 channel (A7), if any. */
      refinementRating?: number;
      /** Applied Design_DNA changes (parameter + direction + net delta). */
      changes: DnaAdjustment[];
      /** Human-readable explanation of the Design_DNA changes (Req 8.7). */
      explanation: string;
      /** Optional clarification message when a comment was uninterpretable. */
      message?: string;
    }
  | {
      ok: false;
      reason: "not_found" | "invalid_rating" | "invalid_comment" | "regeneration_failed";
      /** The preserved, unchanged source variation when one was resolved. */
      source?: DesignVariation;
      /** The preserved previous refinement rating (Req 8.2), if any. */
      refinementRating?: number;
      message: string;
    };

/** Indonesian labels for Design_DNA parameters used in refinement explanations. */
const DNA_PARAMETER_LABELS: Record<keyof DesignDNA, string> = {
  whitespaceRatio: "rasio whitespace",
  elementCount: "jumlah elemen",
  typographyWeight: "bobot tipografi",
  paletteRestraint: "tingkat restraint palet",
  decorationLevel: "tingkat dekorasi",
};

// ---------------------------------------------------------------------------
// Worker dependencies
// ---------------------------------------------------------------------------

/** Map every step to "done" — used when finalizing a successful run. */
function allStepsDone(): Record<StepId, StepStatus> {
  return { 1: "done", 2: "done", 3: "done", 4: "done", 5: "done", 6: "done" };
}

/** Dependencies injected into the {@link PipelineWorker}. */
export interface PipelineWorkerDeps {
  /** Persists `Job` + `JobStatus`. */
  jobStore: JobStore;
  /** Reserve / commit / refund credits (Req 8.2, 2.10). */
  creditManager: CreditManager;
  /** Persists & reads the brief behind a job. */
  briefStore: BriefStore;
  /** Mockable AI connector wired into pipeline steps 3 and 6 (Req 3.1, 3.2). */
  connector: AIServiceConnector;
  /**
   * Extra options forwarded to the step transforms (e.g. deterministic
   * `batchId`/`createdAt` for tests, retry overrides). `userId`/`briefId` are
   * always overridden per-job by the worker.
   */
  stepOptions?: StepTransformsOptions;
  /**
   * Optional sink for the produced batch on success (e.g. History_Manager
   * persistence + variation store population, wired in task 14.1). Receives the
   * finalized batch together with the brief it was generated from so the sink
   * can call `History_Manager.saveBatch(batch, brief)` (Req 7.1). Failures here
   * are swallowed by `runJob` and do NOT fail the job.
   *
   * The optional third argument carries the FASE PRA reasoning artefacts
   * (Brief_Analysis + Visual_Strategy) and the per-variation Quality_Reports so
   * the sink can persist them alongside the `Generation_Batch` (Req 4.4). It is
   * only populated when Professional_Mode produced those artefacts; the legacy
   * path passes `undefined`, and existing sinks that ignore the argument keep
   * working unchanged (additive/non-breaking).
   */
  onBatch?: (
    batch: GenerationBatch,
    brief: DesignBriefInput,
    artifacts?: BatchArtifacts,
  ) => void | Promise<void>;
  /**
   * Optional Intelligence_Memory store used in FASE PRA to seed the Design_DNA
   * from prior accepted outcomes for a similar aggregated context (Req 9.2,
   * 9.4). When absent, FASE PRA skips memory retrieval and seeds the DNA from
   * the purpose-driven Decision_Weights via `initDesignDnaFromWeights`.
   */
  intelligenceMemory?: IntelligenceMemoryStore;
  /**
   * Optional Quality_Gate configuration (Req 6.9). Its `criteria` list (name +
   * per-criterion threshold) is surfaced into the L3 Quality_Gate layer of the
   * composed System_Prompt during FASE PRA. Defaults to
   * {@link DEFAULT_QUALITY_GATE_CONFIG} when not provided.
   */
  qualityGateConfig?: QualityGateConfig;
  /**
   * Optional variation store used by {@link PipelineWorker.runRefinement} to
   * resolve a {@link DesignVariation} + its owning user (for ownership
   * enforcement) and to persist the refined variation back (Req 8.1, 8.6–8.8).
   * When absent, the worker falls back to the process-wide
   * {@link getVariationStore} singleton — consistent with the refinement route
   * (`POST /api/refine/[id]`). Injectable so refinement stays unit-testable with
   * an in-memory store. (Additive/non-breaking.)
   */
  variationStore?: VariationStore;
}

// ---------------------------------------------------------------------------
// FASE PRA artefacts (Professional_Mode only)
// ---------------------------------------------------------------------------

/**
 * The Design_Intelligence artefacts produced during FASE PRA (before steps
 * 1..6 run) when Professional_Mode is active. They are threaded into the step
 * transforms (steps 3 & 5) via {@link StepTransformsOptions.intelligence} and
 * surfaced on the `PipelineState` for later phases.
 */
interface PreGenerationArtifacts {
  decisionWeights: DecisionWeights;
  designDna: DesignDNA;
  briefAnalysis: DesignBriefAnalysis;
  visualStrategy: VisualStrategy;
  layeredPrompt: LayeredSystemPrompt;
}

/**
 * Reasoning artefacts persisted ALONGSIDE a `Generation_Batch` when
 * Professional_Mode is active (Req 4.4). Threaded into the optional `onBatch`
 * sink so the persistence layer (Prisma columns added in task 18.1:
 * `GenerationBatch.briefAnalysis`/`visualStrategy`, `DesignVariation.qualityReport`)
 * can store them with the batch. All fields are optional so the legacy path can
 * omit them without breaking existing sinks.
 */
export interface BatchArtifacts {
  briefAnalysis?: DesignBriefAnalysis;
  visualStrategy?: VisualStrategy;
  qualityReports?: QualityReport[];
}

/**
 * Per-variation final outcome distilled from FASE PASCA, used to persist an
 * {@link IntelligenceMemoryEntry} per variation (Req 9.1). `outcome` maps the
 * authoritative Quality_Gate decision: a cleanly accepted variation is
 * `"ACCEPTED"`, while an accept-with-warning one (kept for delivery but still
 * below threshold) is recorded as `"REJECTED"` so future generations AVOID its
 * Design_DNA (Req 9.3). `feedback` is the aggregated, PII-free critique.
 */
interface VariationOutcome {
  variationId: string;
  outcome: "ACCEPTED" | "REJECTED";
  feedback?: string;
}

// ---------------------------------------------------------------------------
// PipelineWorker
// ---------------------------------------------------------------------------

/**
 * Background pipeline worker implementing the async job model.
 *
 * See the "Alur Permintaan Generasi (model job asinkron)" sequence diagram in
 * the design. `createJob` is called from `POST /api/generate`; `runJob` runs in
 * the background (`waitUntil`/queue); `getJobStatus` backs `GET /api/jobs/{id}`.
 */
export class PipelineWorker {
  constructor(private readonly deps: PipelineWorkerDeps) {}

  /**
   * Expose the injected (mockable) {@link AIServiceConnector}. Route handlers
   * that derive variations (`regenerateVariation` / `fineTuneVariation`, task
   * 11.4) use this so they share the SAME connector the pipeline uses — and so
   * tests that inject a worker with a mock connector are exercised end-to-end.
   */
  getConnector(): AIServiceConnector {
    return this.deps.connector;
  }

  /**
   * Create a job: reserve credits (1 per variation), persist the brief, and
   * create the `Job` (status seeded `queued` at step 1). Returns immediately so
   * the API can reply `202 { jobId }` and kick off {@link runJob} in the
   * background.
   *
   * @throws {InsufficientCreditError} when the balance is below the requested
   *   variation count (Req 8.3) — no credit is deducted in that case.
   */
  async createJob(
    brief: DesignBriefInput,
    variationCount: VariationCount,
    userId: string,
  ): Promise<Job> {
    // Atomic reserve: 1 credit per variation (Req 8.2). Insufficient → reject
    // without deducting and surface the Pro upgrade prompt (Req 8.3).
    const reservation = await this.deps.creditManager.reserve(
      userId,
      variationCount,
    );
    if (!reservation.success || !reservation.reservationId) {
      throw new InsufficientCreditError(
        reservation.message ??
          "Kredit tidak mencukupi untuk jumlah variasi yang diminta.",
        reservation.upgradePrompt ?? false,
      );
    }

    try {
      const { briefId } = await this.deps.briefStore.saveBrief(brief);
      return await this.deps.jobStore.createJob({
        userId,
        briefId,
        variationCount,
        reservationId: reservation.reservationId,
      });
    } catch (error) {
      // Roll back the held credits if we couldn't persist the job (Req 8.6).
      await this.deps.creditManager.refund(reservation.reservationId);
      throw error;
    }
  }

  /**
   * Run the 6-step pipeline for `jobId` in the background.
   *
   * Updates `JobStatus` on every transition (Req 2.9):
   *   - marks `state: "running"` and the active step "running" as each step starts,
   *   - marks each step "done" as it completes (advancing `currentStep`).
   *
   * On the first failing step K (Req 2.10): the pipeline stops, the unused
   * credits are refunded (handled inside {@link runPipeline}), and the job is
   * set `state: "failed"` with `failedStep` + a message naming the step; the
   * brief is preserved unchanged.
   *
   * On full success: the batch consistency is verified (Req 5.6), the reserved
   * credits are committed (Req 8.2), the produced batch is handed to `onBatch`,
   * and the job is set `state: "done"` with `resultBatchId`.
   *
   * Idempotent against unknown jobs (no-op). Never throws for pipeline failures
   * — those are recorded in `JobStatus`.
   */
  async runJob(jobId: string): Promise<void> {
    const job = await this.deps.jobStore.getJob(jobId);
    if (!job) return; // unknown job — nothing to run

    const brief = await this.deps.briefStore.getBrief(job.briefId);
    if (!brief) {
      // Brief vanished — refund and fail at step 1 (cannot derive Brand DNA).
      await this.deps.creditManager.refund(job.reservationId);
      await this.deps.jobStore.updateStatus(jobId, {
        state: "failed",
        failedStep: 1,
        message:
          "Langkah 1 (Brand DNA Extraction) gagal: design brief tidak ditemukan",
        step: { id: 1, status: "failed" },
      });
      return;
    }

    // Resolve Professional_Mode (Req 1.1, 1.4). When OFF the legacy path runs
    // unchanged; when ON, FASE PRA produces the Design_Intelligence artefacts
    // BEFORE the strict 6-step pipeline runs (Req 1.2, 1.3, 1.5).
    const professionalMode = resolveProfessionalMode(brief);

    // FASE PRA (Professional_Mode only): retrieve memory + seed DNA, derive
    // Decision_Weights, build Brief_Analysis + Visual_Strategy (before step 5),
    // and compose the Layered_System_Prompt. Failure to build any artefact
    // halts the job, refunds the FULL reservation, and preserves the brief
    // (Req 4.1, 4.4, 4.6, 9.2, 9.4, 11.1, 11.2).
    let preGeneration: PreGenerationArtifacts | undefined;
    if (professionalMode) {
      try {
        preGeneration = await this.buildPreGenerationArtifacts(job, brief);
      } catch (error) {
        // Halt + full refund + preserve brief (Req 4.6, 11.5). No credits are
        // consumed because nothing was committed.
        await this.deps.creditManager.refund(job.reservationId);
        const failedStep: StepId =
          error instanceof AIServiceError ? error.step : 1;
        await this.deps.jobStore.updateStatus(jobId, {
          state: "failed",
          currentStep: failedStep,
          failedStep,
          message:
            error instanceof Error
              ? `FASE PRA gagal: ${error.message}`
              : `FASE PRA gagal: ${String(error)}`,
          step: { id: failedStep, status: "failed" },
        });
        return;
      }
    }

    // Mark the job running and step 1 active.
    await this.deps.jobStore.updateStatus(jobId, {
      state: "running",
      currentStep: 1,
      step: { id: 1, status: "running" },
    });

    const transforms = createStepTransforms(this.deps.connector, {
      ...this.deps.stepOptions,
      userId: job.userId,
      briefId: job.briefId,
      // Thread the layered System_Prompt into steps 3 & 5 ONLY when
      // Professional_Mode produced FASE PRA artefacts; otherwise preserve the
      // exact legacy transforms (Req 3.7, 10.2, 11.1).
      ...(preGeneration
        ? {
            intelligence: { layeredPrompt: preGeneration.layeredPrompt },
          }
        : {}),
    });

    const initialState = start(brief, job.variationCount);

    // Surface FASE PRA artefacts onto the pipeline state (additive, optional)
    // so later phases (FASE PASCA, task 15.2) and persistence can consume them.
    // The strict 6-step order [1..6] is unchanged — FASE PRA is NOT a step.
    if (professionalMode && preGeneration) {
      initialState.professionalMode = true;
      initialState.briefAnalysis = preGeneration.briefAnalysis;
      initialState.visualStrategy = preGeneration.visualStrategy;
      initialState.designDna = preGeneration.designDna;
      initialState.decisionWeights = preGeneration.decisionWeights;
      initialState.layeredPrompt = preGeneration.layeredPrompt;
    }

    // Drive the pipeline; mirror each step transition into JobStatus (Req 2.9).
    // runPipeline refunds the reservation itself on failure (Req 2.10).
    const result = await runPipeline(initialState, transforms, {
      creditManager: this.deps.creditManager,
      reservationId: job.reservationId,
      onStep: (event) => this.persistStepEvent(jobId, event),
    });

    if (!result.succeeded) {
      // Credits already refunded by runPipeline. Record the failure (Req 2.10).
      await this.deps.jobStore.updateStatus(jobId, {
        state: "failed",
        currentStep: result.failedStep ?? result.state.current,
        failedStep: result.failedStep,
        message: result.message,
        step: result.failedStep
          ? { id: result.failedStep, status: "failed" }
          : undefined,
      });
      return;
    }

    // Success: the step-6 transform produced the batch.
    const batch = result.state.batch;
    if (!batch) {
      // Defensive: a "succeeded" run must carry a batch. Treat as a step-6
      // failure and refund so credits are never silently consumed (Req 2.10).
      await this.deps.creditManager.refund(job.reservationId);
      await this.deps.jobStore.updateStatus(jobId, {
        state: "failed",
        currentStep: LAST_STEP,
        failedStep: LAST_STEP,
        message:
          "Langkah 6 (Render & Compose) gagal: batch tidak dihasilkan",
        step: { id: LAST_STEP, status: "failed" },
      });
      return;
    }

    // FASE PASCA (Professional_Mode only): for every produced variation run the
    // separate Quality_Evaluator + the authoritative Quality_Gate, regenerate
    // REJECTED variations using the critique (without consuming extra credit),
    // and — once the configured cap is reached while still REJECTED — keep the
    // highest-scoring attempt as accept-with-warning. Attaches the final
    // `qualityReport` to every variation and produces the intelligence summary
    // (`acceptedCount` + `warnings`) surfaced via `JobStatus.intelligence`
    // (Req 5.9, 6.6, 6.7, 6.10, 10.3, 11.2). When Professional_Mode is OFF the
    // legacy path is preserved exactly — no evaluation, no extra fields.
    let evaluatedBatch = batch;
    let intelligenceSummary:
      | { acceptedCount: number; warnings: string[] }
      | undefined;
    let memoryOutcomes: VariationOutcome[] = [];
    if (professionalMode && preGeneration) {
      const pasca = await this.runPostGenerationQualityGate(
        batch,
        preGeneration,
        result.state.imagePrompt,
      );
      evaluatedBatch = pasca.batch;
      intelligenceSummary = {
        acceptedCount: pasca.acceptedCount,
        warnings: pasca.warnings,
      };
      memoryOutcomes = pasca.outcomes;
    }

    // Verify brand consistency before finalizing (Req 5.6). Successful
    // variations are preserved either way (Req 5.5); the status reflects the
    // outcome on the batch object.
    const { batch: finalBatch } = markBatchConsistency(evaluatedBatch, {
      mandatoryElements: brief.mandatoryElements,
    });

    // Commit the reserved credits — the batch was generated (Req 8.2). The
    // policy depends on the mode (Req 11.4):
    //   - Professional_Mode: commit ONLY the accepted variations (accept count
    //     includes accept-with-warning, per the FASE PASCA summary) and refund
    //     the unused remainder (N − acceptedCount). Internal Quality_Gate
    //     regenerations never touched the CreditManager, so they add no
    //     consumption (A6). When acceptedCount === N this is a full commit; when
    //     acceptedCount === 0 it degrades to a full refund.
    //   - Basic mode: preserve the existing full commit of the whole reservation.
    if (intelligenceSummary) {
      await this.deps.creditManager.commitPartial(
        job.reservationId,
        intelligenceSummary.acceptedCount,
      );
    } else {
      await this.deps.creditManager.commit(job.reservationId);
    }

    // Persist Intelligence_Memory learning entries for every variation outcome
    // (Req 9.1). Wrapped so a persistence failure is NON-FATAL: the batch is
    // already finalized + credits committed, so a memory error is logged and
    // swallowed and the job still completes successfully (Req 9.8).
    if (professionalMode && preGeneration && memoryOutcomes.length > 0) {
      await this.persistMemoryOutcomes(
        job,
        brief,
        preGeneration.designDna,
        memoryOutcomes,
      );
    }

    // Hand the batch to the optional sink (e.g. history persistence, task 14.1).
    // The brief is passed alongside so the sink can persist both (Req 7.1). When
    // Professional_Mode produced FASE PRA artefacts, thread Brief_Analysis +
    // Visual_Strategy + the per-variation Quality_Reports so they are persisted
    // ALONGSIDE the batch (Req 4.4). Failures in the sink must not fail an
    // already-successful job, so they are swallowed here (the batch + credits
    // are already finalized).
    if (this.deps.onBatch) {
      const artifacts =
        professionalMode && preGeneration
          ? buildBatchArtifacts(preGeneration, finalBatch)
          : undefined;
      try {
        await this.deps.onBatch(finalBatch, brief, artifacts);
      } catch (error) {
        console.error("[worker] onBatch sink failed:", error);
      }
    }

    // Mark the job done with the resulting batch id (Req 2.9, 2.10). When
    // Professional_Mode produced a FASE PASCA summary, surface the accepted
    // count + warnings so pollers see the quality outcome (Req 6.7, 11.2). The
    // credit commit/refund policy keyed off `acceptedCount` is task 15.4.
    await this.deps.jobStore.updateStatus(jobId, {
      state: "done",
      currentStep: LAST_STEP,
      statuses: allStepsDone(),
      resultBatchId: finalBatch.id,
      ...(intelligenceSummary
        ? {
            intelligence: {
              briefAnalysisReady: true,
              acceptedCount: intelligenceSummary.acceptedCount,
              warnings: intelligenceSummary.warnings,
            },
          }
        : {}),
    });
  }

  /**
   * Read a job's current status (polling). Idempotent — never triggers
   * execution (Req 2.9). When `ownerUserId` is provided, ownership is enforced
   * and a non-owned/unknown job yields `undefined`.
   */
  async getJobStatus(
    jobId: string,
    ownerUserId?: string,
  ): Promise<JobStatus | undefined> {
    return this.deps.jobStore.getStatus(jobId, ownerUserId);
  }

  /**
   * Interactive Refinement_Loop (Req 8.1, 8.6, 8.7, 8.8). Runs inside the
   * background worker behind an authenticated, ownership-checked endpoint
   * (`POST /api/refine/[id]`, Req 8.9); this method assumes the caller already
   * authenticated and passes the authenticated `userId` for the ownership
   * check.
   *
   * Flow:
   *   1. Resolve the variation + owner via the {@link VariationStore} (injected
   *      or the process-wide singleton). Unknown OR not-owned → an `ok: false`
   *      `not_found` result (no existence leak), mirroring the variations route.
   *   2. Validate the rating against the separate 1–10 channel
   *      ({@link isValidRefinementRating}, A7). Invalid → reject and preserve the
   *      previous rating (Req 8.2). A valid rating is stored into
   *      `variation.refinementRating` (distinct from the 1–5 history `rating`).
   *   3. Validate the comment ({@link isValidComment}, 1–500 chars). Invalid →
   *      reject and preserve the variation unchanged (Req 8.4).
   *   4. With a valid comment, interpret it into `DnaAdjustment[]`
   *      ({@link interpretComment}) and apply them to the current Design_DNA
   *      ({@link applyDnaAdjustments}). An empty interpretation keeps the
   *      variation unchanged and returns a clarification message (Req 8.5).
   *   5. Regenerate the variation using the adjusted Design_DNA within ≤30s
   *      (Req 8.6); on failure/timeout the ORIGINAL variation is preserved and a
   *      failure result following the {@link DeriveResult} `{ ok: false, source }`
   *      pattern is returned (Req 8.8).
   *
   * On success the (possibly new) variation is persisted back to the store, and
   * the result carries the stored `refinementRating` plus a human-readable
   * explanation of the Design_DNA changes (parameter + direction, Req 8.7).
   *
   * Current-DNA assumption: a {@link DesignVariation} does NOT persist the
   * Design_DNA it was generated from (the type carries brand/design/copy/layout
   * only). Until DNA is persisted per variation, refinement starts from the
   * neutral {@link DEFAULT_DESIGN_DNA} baseline so the monotonic adjustment in
   * `applyDnaAdjustments` is well-defined and deterministic; the adjusted DNA is
   * folded into regeneration through a deterministic seed so different DNA
   * yields a different render. This keeps the method non-breaking.
   */
  async runRefinement(
    variationId: string,
    input: { rating?: number; comment?: string },
    userId: string,
  ): Promise<RefinementResult> {
    const store = this.deps.variationStore ?? getVariationStore();

    // 1. Resolve + authorize. Unknown OR not-owned → not_found (no leak).
    const owned = await store.getVariation(variationId);
    if (!owned || !authorizeOwnership(userId, owned.ownerUserId)) {
      return {
        ok: false,
        reason: "not_found",
        message: "Variasi tidak ditemukan.",
      };
    }
    const { variation, ownerUserId } = owned;
    const previousRating = variation.refinementRating;

    // 2. Validate the rating (separate 1–10 channel, A7). Invalid → reject and
    //    preserve the previous rating (Req 8.2).
    let storedRating = previousRating;
    if (input.rating !== undefined) {
      if (!isValidRefinementRating(input.rating)) {
        return {
          ok: false,
          reason: "invalid_rating",
          source: variation,
          refinementRating: previousRating,
          message:
            `Nilai rating tidak valid: harus bilangan bulat ` +
            `${REFINEMENT_RATING_MIN}–${REFINEMENT_RATING_MAX}.`,
        };
      }
      storedRating = input.rating;
    }

    // 3. Validate the comment (1–500 chars). Invalid → reject and preserve the
    //    variation unchanged (Req 8.4). An absent comment is allowed (rating-only).
    const hasComment =
      input.comment !== undefined && input.comment !== null;
    if (hasComment && !isValidComment(input.comment as string)) {
      return {
        ok: false,
        reason: "invalid_comment",
        source: variation,
        refinementRating: previousRating,
        message:
          `Komentar tidak valid: panjang harus 1–${COMMENT_MAX_LENGTH} karakter.`,
      };
    }

    // Persist a valid rating onto the separate channel up front (Req 8.1). This
    // metadata channel is independent of the regenerated design content, so it
    // is kept even if a later regeneration fails (the design itself stays
    // preserved, Req 8.8).
    const ratedVariation: DesignVariation =
      storedRating !== undefined
        ? { ...variation, refinementRating: storedRating }
        : variation;

    // 4a. No comment → rating-only update (or a no-op). Persist + return.
    if (!hasComment) {
      if (storedRating !== undefined) {
        await store.saveVariation(ratedVariation, ownerUserId);
      }
      return {
        ok: true,
        variation: ratedVariation,
        refinementRating: storedRating,
        changes: [],
        explanation:
          storedRating !== undefined
            ? `Rating refinement ${storedRating}/${REFINEMENT_RATING_MAX} disimpan.`
            : "Tidak ada perubahan.",
      };
    }

    const connector = this.deps.connector;
    const connectorOptions = this.refinementConnectorOptions();

    // 4b. Interpret the comment into Design_DNA adjustments (Req 8.3). The
    //     current DNA baseline is DEFAULT_DESIGN_DNA (see method doc assumption).
    const currentDna = DEFAULT_DESIGN_DNA;
    const adjustments = await interpretComment(
      input.comment as string,
      currentDna,
      connector,
      connectorOptions,
    );

    // 4c. Uninterpretable comment ([]) → preserve the variation unchanged and
    //     ask the user to clarify (Req 8.5). A valid rating is still persisted.
    if (adjustments.length === 0) {
      if (storedRating !== undefined) {
        await store.saveVariation(ratedVariation, ownerUserId);
      }
      return {
        ok: true,
        variation: ratedVariation,
        refinementRating: storedRating,
        changes: [],
        explanation: "",
        message:
          "Komentar tidak dapat ditafsirkan menjadi penyesuaian desain. " +
          "Mohon perjelas masukan Anda.",
      };
    }

    // 4d. Apply the adjustments monotonically → adjusted DNA + net changes
    //     (parameter + direction) for the explanation (Req 8.7).
    const { dna: adjustedDna, changes } = applyDnaAdjustments(
      currentDna,
      adjustments,
    );

    // 5. Regenerate using the adjusted DNA within ≤30s (Req 8.6). The adjusted
    //    DNA is folded into the render via a deterministic seed so different DNA
    //    yields a different image; the connector enforces the 30s timeout. On
    //    failure/timeout the ORIGINAL variation is preserved (Req 8.8).
    const result = await regenerateVariation(ratedVariation, {
      connector,
      seed: deriveDnaSeed(variation.id, adjustedDna),
      connectorOptions,
    });

    if (!result.ok) {
      // Failure/timeout → preserve the original variation (Req 8.8). Follows the
      // DeriveResult { ok: false, source } pattern.
      return {
        ok: false,
        reason: "regeneration_failed",
        source: result.source,
        refinementRating: storedRating,
        message: `Penyempurnaan gagal: ${result.message}`,
      };
    }

    // Success: carry the refinement rating onto the regenerated variation and
    // persist it back to the store.
    const refined: DesignVariation =
      storedRating !== undefined
        ? { ...result.variation, refinementRating: storedRating }
        : result.variation;
    await store.saveVariation(refined, ownerUserId);

    return {
      ok: true,
      variation: refined,
      refinementRating: storedRating,
      changes,
      explanation: explainDnaChanges(changes),
    };
  }

  /**
   * Connector options for Refinement_Loop regeneration: reuse the shared
   * `stepOptions.connectorOptions` (so tests can inject a fast scheduler) while
   * pinning the regeneration timeout to {@link REFINEMENT_REGEN_TIMEOUT_MS}
   * (Req 8.6) unless an explicit override is already provided.
   */
  private refinementConnectorOptions(): ConnectorCallOptions {
    const base = this.deps.stepOptions?.connectorOptions;
    return {
      ...base,
      timeoutMs: base?.timeoutMs ?? REFINEMENT_REGEN_TIMEOUT_MS,
    };
  }

  /** Translate a pipeline step event into the matching `JobStatus` patch. */
  private async persistStepEvent(
    jobId: string,
    event: PipelineStepEvent,
  ): Promise<void> {
    if (event.status === "running") {
      await this.deps.jobStore.updateStatus(jobId, {
        state: "running",
        currentStep: event.step,
        step: { id: event.step, status: "running" },
      });
      return;
    }
    // "done" or "failed" for the active step. `currentStep` follows the step so
    // the progress indicator reflects where the pipeline is (Req 2.9). The
    // overall `state` transition to done/failed is applied by runJob afterwards.
    await this.deps.jobStore.updateStatus(jobId, {
      currentStep: event.step,
      step: { id: event.step, status: event.status },
    });
  }

  /**
   * FASE PRA (Professional_Mode only): build the Design_Intelligence artefacts
   * BEFORE the strict 6-step pipeline runs (Req 4.1, 11.1).
   *
   * Steps:
   *   1. Derive purpose-driven Decision_Weights from the professional
   *      `designPurpose` (Req 7.x via `deriveDecisionWeights`).
   *   2. Seed the Design_DNA from Intelligence_Memory when a matching, accepted
   *      entry exists (Req 9.2, 9.3); otherwise fall back to
   *      `initDesignDnaFromWeights(weights)` without surfacing an error
   *      (Req 9.4). Skipped entirely when no `intelligenceMemory` is wired.
   *   3. Build the Brief_Analysis (Req 4.2) and Visual_Strategy (Req 4.3) via
   *      the connector — both completed before step 5 runs (Req 4.1).
   *   4. Compose the Layered_System_Prompt from the configured Quality_Gate
   *      criteria, the weights, DNA, analysis, and strategy (Req 3.x).
   *
   * Any artefact failure propagates (the connector throws `AIServiceError` on
   * exhausted retries); the caller halts the job, refunds the FULL reservation,
   * and preserves the brief (Req 4.6).
   *
   * @throws when the professional brief fields are missing or any artefact
   *   build fails.
   */
  private async buildPreGenerationArtifacts(
    job: Job,
    brief: DesignBriefInput,
  ): Promise<PreGenerationArtifacts> {
    const professional = brief.professional;
    if (!professional) {
      // Professional_Mode is active but the enhanced brief fields are absent —
      // we cannot derive weights/analysis. Treat as a FASE PRA failure.
      throw new Error(
        "field brief profesional tidak tersedia untuk Professional_Mode",
      );
    }

    // 1. Purpose-driven Decision_Weights (Req 7.1–7.5).
    const decisionWeights = deriveDecisionWeights(professional.designPurpose);

    // 2. Seed the Design_DNA from memory, else from the Decision_Weights
    //    (Req 9.2, 9.4). Missing/empty memory falls back without error.
    let designDna: DesignDNA | undefined;
    if (this.deps.intelligenceMemory) {
      const context = buildMemoryContext(brief, professional);
      const entries = await this.deps.intelligenceMemory.retrieve(
        job.userId,
        context,
      );
      designDna = seedDesignDnaFromMemory(entries);
    }
    if (!designDna) {
      designDna = initDesignDnaFromWeights(decisionWeights);
    }

    // 3. Brief_Analysis + Visual_Strategy via the connector (Req 4.2, 4.3),
    //    both produced before step 5 (Req 4.1). Connector options come from the
    //    shared stepOptions so tests can inject a fast scheduler.
    const connectorOptions = this.deps.stepOptions?.connectorOptions;
    const briefAnalysis = await buildBriefAnalysis(
      professional,
      this.deps.connector,
      connectorOptions,
    );
    const visualStrategy = await buildVisualStrategy(
      briefAnalysis,
      decisionWeights,
      designDna,
      this.deps.connector,
      connectorOptions,
    );

    // 4. Compose the Layered_System_Prompt (Req 3.1–3.6). The L3 Quality_Gate
    //    layer lists the configured criteria + thresholds (Req 3.5, 6.9).
    const qualityGateConfig =
      this.deps.qualityGateConfig ?? DEFAULT_QUALITY_GATE_CONFIG;
    const layeredPrompt = buildLayeredSystemPrompt({
      briefAnalysis,
      visualStrategy,
      criteria: qualityGateConfig.criteria,
      decisionWeights,
      designDna,
    });

    return {
      decisionWeights,
      designDna,
      briefAnalysis,
      visualStrategy,
      layeredPrompt,
    };
  }

  /**
   * FASE PASCA (Professional_Mode only): the quality-gate evaluation +
   * bounded-regeneration loop that runs AFTER the strict 6-step pipeline
   * produced the batch and BEFORE credits are committed (design "Loop
   * regenerasi quality-gate" seam). It is NOT a 7th pipeline step — it is a loop
   * around render (step 6) executed inside the worker (Req 5.9, 11.2).
   *
   * For each variation in the produced batch:
   *   1. Evaluate it via the separate Quality_Evaluator role
   *      (`connector.evaluateQuality`) to obtain a {@link QualityReport}
   *      (Req 5.1). The criteria + per-criterion thresholds, the purpose-driven
   *      Decision_Weights, and the Brief_Analysis are passed as judging context.
   *   2. Run the authoritative {@link evaluateGate} against the configured
   *      thresholds + weights (Req 6.1, 6.5, 6.8). Originality below its
   *      threshold follows the generic per-criterion rule (Req 10.3).
   *   3. While REJECTED and the attempt index is below
   *      `maxRegenerationAttempts`, regenerate the variation using the previous
   *      report's critique to strengthen the prompt (Req 6.6). Regeneration
   *      re-runs ONLY image generation via the connector — it never touches the
   *      CreditManager, so no additional credit is consumed (A6).
   *   4. If still REJECTED once the cap is reached, pick the highest-scoring
   *      attempt via {@link selectBestAttempt}, mark it
   *      `acceptedWithWarning = true`, and record a warning (Req 6.7).
   *   5. Attach the final {@link QualityReport} to every variation (accepted or
   *      accept-with-warning).
   *
   * Total attempts are bounded per variation by `maxRegenerationAttempts` (A5)
   * so the worker stays within `maxDuration` (Req 6.10, A10).
   *
   * Returns a NEW batch (inputs are not mutated) plus the `acceptedCount` and
   * `warnings` for the intelligence summary. `acceptedCount` counts variations
   * whose final outcome is accepted — including accept-with-warning, since those
   * are still delivered to the user (the credit-counting policy itself is task
   * 15.4).
   */
  private async runPostGenerationQualityGate(
    batch: GenerationBatch,
    preGeneration: PreGenerationArtifacts,
    imagePrompt: ImagePrompt | undefined,
  ): Promise<{
    batch: GenerationBatch;
    acceptedCount: number;
    warnings: string[];
    outcomes: VariationOutcome[];
  }> {
    const qualityGateConfig =
      this.deps.qualityGateConfig ?? DEFAULT_QUALITY_GATE_CONFIG;
    const maxAttempts = Math.max(
      1,
      Math.floor(qualityGateConfig.maxRegenerationAttempts),
    );
    const connectorOptions = this.deps.stepOptions?.connectorOptions;

    const evaluatedVariations: DesignVariation[] = [];
    const warnings: string[] = [];
    const outcomes: VariationOutcome[] = [];
    let acceptedCount = 0;

    for (const original of batch.variations) {
      const attempts: AttemptRecord[] = [];
      let current = original;

      // attempt 0 = initial render; each REJECTED result below the cap drives
      // one regeneration (Req 6.6). The loop performs at most `maxAttempts`
      // evaluations per variation, bounding total work (Req 6.10, A5/A10).
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const report = await this.deps.connector.evaluateQuality(
          {
            variation: current,
            criteria: qualityGateConfig.criteria,
            decisionWeights: preGeneration.decisionWeights,
            briefAnalysis: preGeneration.briefAnalysis,
          },
          connectorOptions,
        );
        const gateResult = evaluateGate(
          report,
          qualityGateConfig,
          preGeneration.decisionWeights,
        );
        attempts.push({ attempt, variation: current, report, gateResult });

        if (gateResult.decision === "ACCEPTED") break;

        // REJECTED and more attempts remain → regenerate using the critique to
        // strengthen the prompt, WITHOUT consuming additional credit (A6).
        if (attempt < maxAttempts - 1) {
          current = await this.regenerateVariationWithCritique(
            current,
            report,
            preGeneration,
            imagePrompt,
            attempt + 1,
            connectorOptions,
          );
        }
      }

      const last = attempts[attempts.length - 1];
      if (last.gateResult.decision === "ACCEPTED") {
        // Accepted on its latest attempt → attach the report, count it.
        evaluatedVariations.push({
          ...last.variation,
          qualityReport: last.report,
        });
        acceptedCount += 1;
        // Record an ACCEPTED learning outcome for Intelligence_Memory (Req 9.1,
        // 9.3): future generations in a similar context PRIORITISE this DNA.
        outcomes.push({
          variationId: last.variation.id,
          outcome: "ACCEPTED",
          feedback: aggregateMemoryFeedback(last.report),
        });
      } else {
        // Still REJECTED at the cap → keep the best-scoring attempt as
        // accept-with-warning + attach its report (Req 6.7).
        const best = selectBestAttempt(attempts);
        evaluatedVariations.push({
          ...best.variation,
          qualityReport: best.report,
          acceptedWithWarning: true,
        });
        acceptedCount += 1;
        warnings.push(
          `Variasi ${best.variation.id} diterima dengan peringatan: ` +
            `skor total ${best.gateResult.weightedTotal.toFixed(1)}/10 di bawah ambang ` +
            `setelah ${attempts.length} percobaan` +
            (best.gateResult.failedCriteria.length > 0
              ? ` (kriteria di bawah ambang: ${best.gateResult.failedCriteria.join(", ")})`
              : ""),
        );
        // Record a REJECTED learning outcome (Req 9.1, 9.3): an
        // accept-with-warning variation never cleared the Quality_Gate, so its
        // Design_DNA is recorded as REJECTED to be AVOIDED in future seeding.
        outcomes.push({
          variationId: best.variation.id,
          outcome: "REJECTED",
          feedback: aggregateMemoryFeedback(best.report),
        });
      }
    }

    return {
      batch: { ...batch, variations: evaluatedVariations },
      acceptedCount,
      warnings,
      outcomes,
    };
  }

  /**
   * Regenerate a single REJECTED variation using the Quality_Evaluator critique
   * to strengthen the image prompt (Req 6.6). Re-runs ONLY image generation via
   * the injected connector (steps 1–5 outputs — brand DNA, design system, copy,
   * layout — are reused so the brand stays consistent across attempts, Req
   * 5.1–5.3) and re-composes the variation with the SAME id so it replaces the
   * prior attempt. Never touches the CreditManager → no extra credit (A6).
   *
   * The critique + detected Negative_Patterns from the prior report are folded
   * into the image prompt's `negativePrompt`, and the seed is perturbed per
   * attempt so the regenerated render differs from the rejected one.
   */
  private async regenerateVariationWithCritique(
    variation: DesignVariation,
    report: QualityReport,
    preGeneration: PreGenerationArtifacts,
    imagePrompt: ImagePrompt | undefined,
    attempt: number,
    connectorOptions: ConnectorCallOptions | undefined,
  ): Promise<DesignVariation> {
    const format: OutputFormat = variation.layout.format;

    // Base the regeneration prompt on the pipeline's step-5 image prompt when
    // available; otherwise reconstruct a minimal prompt from the variation.
    const basePrompt = imagePrompt?.prompt ?? variation.imageAsset.url;
    const baseNegative = imagePrompt?.negativePrompt;

    // Fold the critique + detected Negative_Patterns into the negative prompt so
    // the regenerated render steers away from the rejected attempt's issues.
    const critiqueNegative = [
      baseNegative,
      report.critique,
      ...report.detectedNegativePatterns,
    ]
      .filter((part): part is string => Boolean(part && part.length > 0))
      .join(", ");

    const regenPrompt: ImagePrompt = {
      prompt: basePrompt,
      negativePrompt: critiqueNegative.length > 0 ? critiqueNegative : undefined,
      // Perturb the seed per attempt so each regeneration differs (Req 6.6).
      seed: (imagePrompt?.seed ?? 0) + attempt,
    };

    const imageAsset = await this.deps.connector.generateImage(
      { imagePrompt: regenPrompt, format },
      connectorOptions,
    );

    // Re-compose with the SAME id (reusing brand DNA / design system / copy /
    // layout) so the regenerated variation replaces the rejected one while the
    // brand stays identical across attempts (Req 5.1–5.3).
    return composeVariation(
      {
        batchId: variation.batchId,
        brandDna: variation.brandDna,
        designSystem: variation.designSystem,
        copy: variation.copy,
        layout: variation.layout,
        imageAsset,
      },
      { id: variation.id },
    );
  }

  /**
   * Persist one {@link IntelligenceMemoryEntry} per FASE PASCA variation outcome
   * (Req 9.1). Each entry stores the aggregated PII-free {@link MemoryContext},
   * the Design_DNA used for the batch, the gate-derived outcome, and optional
   * aggregated feedback — never raw brief fields/PII (Req 9.5).
   *
   * Every `save` is wrapped in its own try/catch so a persistence failure is
   * NON-FATAL (Req 9.8): the failure is logged internally and the loop
   * continues, leaving the already-successful job/batch untouched. No-op when
   * no store is wired or the professional brief fields are absent.
   */
  private async persistMemoryOutcomes(
    job: Job,
    brief: DesignBriefInput,
    designDna: DesignDNA,
    outcomes: VariationOutcome[],
  ): Promise<void> {
    const store = this.deps.intelligenceMemory;
    const professional = brief.professional;
    if (!store || !professional) return;

    const context = buildMemoryContext(brief, professional);
    for (const outcome of outcomes) {
      try {
        await store.save({
          userId: job.userId,
          context,
          designDna,
          outcome: outcome.outcome,
          ...(outcome.feedback !== undefined
            ? { feedback: outcome.feedback }
            : {}),
        });
      } catch (error) {
        // Non-fatal: log internally and continue (Req 9.8). The batch is already
        // finalized and credits committed, so a memory error never fails the job.
        console.error(
          `[worker] Intelligence_Memory save gagal untuk variasi ${outcome.variationId} ` +
            "(non-fatal, Req 9.8):",
          error,
        );
      }
    }
  }
}

/**
 * Build the aggregated, PII-free {@link MemoryContext} used to retrieve prior
 * Intelligence_Memory entries (Req 9.2, 9.5). The `industry` dimension is not a
 * dedicated brief field, so the brief's `contentGoal` is used as the
 * aggregated industry/context proxy; `purpose` comes from the professional
 * `designPurpose`; `audience` is the aggregated profession label (falling back
 * to a neutral value), never raw PII.
 */
function buildMemoryContext(
  brief: DesignBriefInput,
  professional: ProfessionalBriefFields,
): MemoryContext {
  const profession = professional.audience.profession?.trim();
  return {
    industry: brief.contentGoal,
    purpose: professional.designPurpose,
    audience: profession && profession.length > 0 ? profession : "general",
  };
}

/**
 * Derive aggregated, PII-free feedback for an {@link IntelligenceMemoryEntry}
 * from a {@link QualityReport} (Req 9.1, 9.5). Uses the evaluator critique —
 * which describes design qualities (hierarchy, readability, …), not the raw
 * brief — trimmed to a bounded length. Returns `undefined` when there is no
 * meaningful critique so the optional `feedback` field is simply omitted.
 */
function aggregateMemoryFeedback(report: QualityReport): string | undefined {
  const critique = report.critique?.trim();
  if (!critique) return undefined;
  const MAX = 500;
  return critique.length > MAX ? `${critique.slice(0, MAX - 1)}…` : critique;
}

/**
 * Assemble the {@link BatchArtifacts} persisted alongside a batch (Req 4.4) from
 * the FASE PRA artefacts and the finalized batch. Collects the per-variation
 * Quality_Reports so the sink can persist them with the batch
 * (`DesignVariation.qualityReport`, task 18.1).
 */
function buildBatchArtifacts(
  preGeneration: PreGenerationArtifacts,
  batch: GenerationBatch,
): BatchArtifacts {
  const qualityReports = batch.variations
    .map((variation) => variation.qualityReport)
    .filter((report): report is QualityReport => report !== undefined);
  return {
    briefAnalysis: preGeneration.briefAnalysis,
    visualStrategy: preGeneration.visualStrategy,
    ...(qualityReports.length > 0 ? { qualityReports } : {}),
  };
}

/**
 * Deterministic non-negative integer seed derived from a variation id and the
 * adjusted Design_DNA (FNV-1a). Folding the DNA into the regeneration seed makes
 * a refinement with different adjustments produce a different render while
 * staying reproducible in tests (Req 8.6).
 */
function deriveDnaSeed(variationId: string, dna: DesignDNA): number {
  const input =
    `${variationId}|refine|` +
    `${dna.whitespaceRatio}|${dna.elementCount}|${dna.typographyWeight}|` +
    `${dna.paletteRestraint}|${dna.decorationLevel}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Build a human-readable Indonesian explanation of the applied Design_DNA
 * changes, naming each parameter and its direction (naik/turun) (Req 8.7).
 */
function explainDnaChanges(changes: DnaAdjustment[]): string {
  if (changes.length === 0) return "Tidak ada perubahan Design_DNA.";
  const parts = changes.map((change) => {
    const label = DNA_PARAMETER_LABELS[change.parameter] ?? change.parameter;
    const arrow = change.direction === "up" ? "naik" : "turun";
    return `${label} ${arrow}`;
  });
  return `Penyesuaian Design_DNA: ${parts.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Factory — in-memory wiring (tests + local dev)
// ---------------------------------------------------------------------------

/** Options for {@link createInMemoryPipelineWorker}. */
export interface InMemoryWorkerOptions {
  connector: AIServiceConnector;
  /** Seed initial credit balances per user id. */
  initialCredits?: Record<string, number>;
  /** Reuse an existing credit repository (e.g. to share with the API). */
  creditRepo?: CreditRepository;
  stepOptions?: StepTransformsOptions;
  onBatch?: (
    batch: GenerationBatch,
    brief: DesignBriefInput,
    artifacts?: BatchArtifacts,
  ) => void | Promise<void>;
  /** Optional Intelligence_Memory store wired into FASE PRA (Req 9.2). */
  intelligenceMemory?: IntelligenceMemoryStore;
  /** Optional Quality_Gate config surfaced into the layered prompt (Req 6.9). */
  qualityGateConfig?: QualityGateConfig;
  /** Optional variation store used by `runRefinement` (Req 8.1, 8.6–8.8). */
  variationStore?: VariationStore;
}

/**
 * Build a {@link PipelineWorker} backed entirely by in-memory stores. Returns
 * the worker plus its stores/manager so tests can assert balances and statuses.
 */
export function createInMemoryPipelineWorker(options: InMemoryWorkerOptions): {
  worker: PipelineWorker;
  jobStore: InMemoryJobStore;
  briefStore: InMemoryBriefStore;
  creditManager: CreditManager;
} {
  const jobStore = new InMemoryJobStore();
  const briefStore = new InMemoryBriefStore();
  const creditRepo =
    options.creditRepo ?? new InMemoryCreditRepository(options.initialCredits);
  const creditManager = new CreditManager(creditRepo);

  const worker = new PipelineWorker({
    jobStore,
    creditManager,
    briefStore,
    connector: options.connector,
    stepOptions: options.stepOptions,
    onBatch: options.onBatch,
    intelligenceMemory: options.intelligenceMemory,
    qualityGateConfig: options.qualityGateConfig,
    variationStore: options.variationStore,
  });

  return { worker, jobStore, briefStore, creditManager };
}

/** Convenience aggregate grouping the worker building blocks. */
export const PipelineWorkerModule = {
  PipelineWorker,
  InMemoryBriefStore,
  createInMemoryPipelineWorker,
} as const;
