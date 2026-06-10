/**
 * Brief_Analysis (FASE PRA) — LLM-backed Design_Brief_Analysis builder.
 *
 * Mirrors the "Brief_Analysis & Visual_Strategy (Req 4)" section of the Design
 * Intelligence System design. This module owns the construction of the
 * structured reasoning artefact produced BEFORE generation (FASE PRA), turning
 * the professional brief fields into a `DesignBriefAnalysis`:
 *
 * - `buildBriefAnalysis` — derive a `DesignBriefAnalysis` (coreMessage,
 *   targetAudience, primaryGoal, emotionTarget) from `ProfessionalBriefFields`
 *   via the `AI_Service_Connector` LLM role (Req 4.2). The professional brief
 *   fields (Design_Purpose, target audience, primary goal, emotion target, core
 *   message) are passed through to the analysis input (Req 2.8).
 *
 * The call is wrapped in the connector's `callWithRetry` so it honours the
 * shared timeout/retry policy (30s, ≤3 attempts) and stays fully mockable in
 * tests (inject a fast scheduler via `ConnectorCallOptions`); it performs no
 * real network I/O of its own. If artefact construction ultimately fails,
 * `callWithRetry` throws an `AIServiceError` which the worker turns into a
 * job-halt + refund + brief preservation (Req 4.6) — handled by the caller.
 *
 * Requirements: 4.2, 2.8
 */

import type {
  DesignBriefAnalysis,
  ProfessionalBriefFields,
  StepId,
} from "@/lib/types";
import type {
  AIServiceConnector,
  ConnectorCallOptions,
} from "@/lib/ai/connector";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Step label used when wrapping analysis construction in `callWithRetry`.
 * Brief_Analysis is an LLM task produced before step 5, so it reuses the Copy
 * Generation step id (3) purely for error labelling — it does NOT add a new
 * pipeline step, keeping the strict 6-step order intact (Req 11.1).
 */
const STEP_BRIEF_ANALYSIS: StepId = 3;

/** Human-readable step name surfaced in failure messages (Req 4.6). */
const STEP_BRIEF_ANALYSIS_NAME = "Brief Analysis";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compose a single aggregated `targetAudience` description from the structured
 * audience fields (age, profession, pain point). Only the parts the user filled
 * in contribute, so the analysis never invents data. Falls back to a neutral
 * label when no audience detail was supplied.
 */
function composeTargetAudience(
  audience: ProfessionalBriefFields["audience"],
): string {
  const parts: string[] = [];

  const profession = audience.profession?.trim();
  const age = audience.age?.trim();
  const painPoint = audience.painPoint?.trim();

  if (profession) parts.push(profession);
  if (age) parts.push(`usia ${age}`);
  if (painPoint) parts.push(`dengan pain point ${painPoint}`);

  if (parts.length === 0) return "Audiens umum";
  return parts.join(", ");
}

/**
 * Deterministically derive the `DesignBriefAnalysis` from the professional
 * brief fields. This is the pass-through mapping (Req 2.8): the Design_Purpose,
 * target audience, primary goal, emotion target, and core message all flow into
 * the analysis input. Trimming keeps the artefact tidy without altering meaning.
 */
function deriveBriefAnalysis(
  professional: ProfessionalBriefFields,
): DesignBriefAnalysis {
  return {
    coreMessage: professional.coreMessage.trim(),
    targetAudience: composeTargetAudience(professional.audience),
    primaryGoal: professional.primaryGoal.trim(),
    emotionTarget: professional.emotionTarget.trim(),
  };
}

// ---------------------------------------------------------------------------
// buildBriefAnalysis (Req 4.2, 2.8)
// ---------------------------------------------------------------------------

/**
 * Build the Design_Brief_Analysis artefact from the professional brief fields
 * via the `AI_Service_Connector` LLM role (Req 4.2). The professional brief
 * fields are passed through as the analysis input (Req 2.8): core message,
 * target audience, primary goal, and emotion target.
 *
 * The construction runs through the connector's `callWithRetry` wrapper so it
 * shares the standard 30s timeout / ≤3 attempt policy and stays mockable in
 * tests (inject a fast scheduler via `opts`). On exhausted retries it propagates
 * the connector's `AIServiceError` so the worker can halt the job, refund unused
 * credit, and preserve the brief (Req 4.6).
 */
export async function buildBriefAnalysis(
  professional: ProfessionalBriefFields,
  connector: AIServiceConnector,
  opts?: ConnectorCallOptions,
): Promise<DesignBriefAnalysis> {
  return connector.callWithRetry<DesignBriefAnalysis>(
    async () => deriveBriefAnalysis(professional),
    {
      step: STEP_BRIEF_ANALYSIS,
      stepName: opts?.stepName ?? STEP_BRIEF_ANALYSIS_NAME,
      timeoutMs: opts?.timeoutMs,
      maxAttempts: opts?.maxAttempts,
      backoffMs: opts?.backoffMs,
      scheduler: opts?.scheduler,
    },
  );
}
