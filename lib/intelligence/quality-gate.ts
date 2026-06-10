/**
 * Quality_Gate — pure scoring & decision (Design Intelligence layer).
 *
 * This module is the AUTHORITATIVE accept/reject authority for a rendered
 * `DesignVariation` once its `QualityReport` is available (Req 6.1). It is a
 * pure module: no I/O, no AI calls, no mutation of its inputs. The AI
 * `Quality_Evaluator` produces the raw per-criterion scores and critique; the
 * indicative `QualityReport.decision` it returns is NOT authoritative. The gate
 * here re-derives the decision from the CONFIGURED per-criterion thresholds and
 * the CONFIGURED weighted-total threshold so the decision logic can be property
 * tested without any AI (design "Quality_Gate — pure scoring & decision").
 *
 * Decision rule (Req 6.1, 6.5, 6.8):
 *   - REJECTED if ANY configured criterion's score is below its per-criterion
 *     threshold, OR the weighted-total score is below `totalThreshold`.
 *   - ACCEPTED otherwise (all per-criterion thresholds met AND total met).
 *   - A missing score for a configured criterion is treated as failing that
 *     criterion (a variation can never be ACCEPTED on absent evidence).
 *   - Originality below its threshold follows the generic per-criterion rule —
 *     it triggers REJECTED with no special-casing (Req 10.3).
 *
 * Weighted total (Req 6.1, 7.6): aggregated using the normalized
 * `DecisionWeights` (weights sum to 1.0) so the result stays on the 1–10 scale.
 * The result is clamped into [1.0, 10.0] defensively.
 *
 * Configurability (Req 6.9): per-criterion thresholds, the total threshold, and
 * the maximum regeneration attempts all live in `QualityGateConfig`. The worker
 * regeneration loop reads `maxRegenerationAttempts` (A5, Req 6.6) and, once the
 * maximum is reached while still REJECTED, calls `selectBestAttempt` to return
 * the highest-scoring attempt as accept-with-warning (Req 6.7). Nothing here is
 * hardcoded into the engine.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 6.8, 6.9, 7.6, 10.3
 */

import type {
  DecisionWeights,
  DesignVariation,
  QualityCriterion,
  QualityCriterionName,
  QualityReport,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Tunable Quality_Gate configuration (Req 6.9). */
export interface QualityGateConfig {
  /** Per-criterion name + threshold (A2, A3). */
  criteria: QualityCriterion[];
  /** Weighted-total threshold on the 1–10 scale (default 7.5, A4, Req 6.4). */
  totalThreshold: number;
  /** Max quality-gate regeneration attempts per variation (default 3, A5, Req 6.6). */
  maxRegenerationAttempts: number;
}

/**
 * Default per-criterion thresholds (A3, Req 6.3): Readability ≥ 8 and Branding
 * Consistency ≥ 8; every other criterion ≥ 7.
 */
const DEFAULT_CRITERIA: QualityCriterion[] = [
  { name: "Hierarchy", threshold: 7 },
  { name: "Readability", threshold: 8 },
  { name: "Composition", threshold: 7 },
  { name: "BrandingConsistency", threshold: 8 },
  { name: "Originality", threshold: 7 },
  { name: "PremiumPerception", threshold: 7 },
  { name: "Whitespace", threshold: 7 },
];

/**
 * Default Quality_Gate configuration (Req 6.2–6.4, 6.9). The 7 default criteria
 * (A2), per-criterion thresholds (A3), the 7.5/10 weighted-total threshold (A4),
 * and the 3-attempt regeneration cap (A5). Overridable without touching engine
 * code.
 */
export const DEFAULT_QUALITY_GATE_CONFIG: QualityGateConfig = {
  criteria: DEFAULT_CRITERIA,
  totalThreshold: 7.5,
  maxRegenerationAttempts: 3,
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Authoritative gate decision. */
export type GateDecision = "ACCEPTED" | "REJECTED";

/** Outcome of evaluating one variation against the gate. */
export interface GateResult {
  decision: GateDecision;
  /** Weighted-total score on the 1.0–10.0 scale. */
  weightedTotal: number;
  /** Criteria whose score was below their per-criterion threshold (Req 6.5). */
  failedCriteria: QualityCriterionName[];
}

/**
 * One regeneration attempt for a variation, retained so the worker can pick the
 * best attempt for accept-with-warning when the cap is reached (Req 6.6, 6.7).
 */
export interface AttemptRecord {
  /** Regeneration attempt index (0 = initial render). */
  attempt: number;
  /** The rendered variation produced by this attempt. */
  variation: DesignVariation;
  /** The evaluator report for this attempt. */
  report: QualityReport;
  /** The authoritative gate result for this attempt. */
  gateResult: GateResult;
}

// ---------------------------------------------------------------------------
// Pure scoring & decision
// ---------------------------------------------------------------------------

/** Clamp a value into the inclusive [1.0, 10.0] quality scale. */
function clampScore(value: number): number {
  if (Number.isNaN(value)) return 1.0;
  if (value < 1.0) return 1.0;
  if (value > 10.0) return 10.0;
  return value;
}

/**
 * Weighted-total score using the normalized `DecisionWeights` (Req 6.1, 7.6).
 *
 * Because weights are normalized to sum to 1.0 and each score lies in [1, 10],
 * the weighted sum naturally lands in [1.0, 10.0]; the result is clamped
 * defensively to guarantee that range even with imperfectly normalized input or
 * missing scores. A criterion absent from `scores` contributes its minimum
 * (1.0) so missing evidence can never inflate the total.
 */
export function computeWeightedTotal(
  scores: Record<QualityCriterionName, number>,
  weights: DecisionWeights,
): number {
  let total = 0;
  for (const [criterion, weight] of Object.entries(weights.weights) as [
    QualityCriterionName,
    number,
  ][]) {
    const raw = scores[criterion];
    const score = clampScore(typeof raw === "number" ? raw : 1.0);
    total += score * weight;
  }
  return clampScore(total);
}

/**
 * Authoritative gate decision (Req 6.1, 6.5, 6.8). REJECTED when any configured
 * criterion is below its threshold OR the weighted total is below
 * `config.totalThreshold`; ACCEPTED otherwise. Pure — never mutates inputs.
 */
export function evaluateGate(
  report: QualityReport,
  config: QualityGateConfig,
  weights: DecisionWeights,
): GateResult {
  // Index the report's per-criterion scores by criterion name.
  const scoreByCriterion = {} as Record<QualityCriterionName, number>;
  for (const { criterion, score } of report.scores) {
    scoreByCriterion[criterion] = score;
  }

  // A configured criterion with no score is treated as failing.
  const failedCriteria: QualityCriterionName[] = [];
  for (const { name, threshold } of config.criteria) {
    const score = scoreByCriterion[name];
    if (typeof score !== "number" || score < threshold) {
      failedCriteria.push(name);
    }
  }

  const weightedTotal = computeWeightedTotal(scoreByCriterion, weights);

  const decision: GateDecision =
    failedCriteria.length > 0 || weightedTotal < config.totalThreshold
      ? "REJECTED"
      : "ACCEPTED";

  return { decision, weightedTotal, failedCriteria };
}

/**
 * Pick the attempt with the highest weighted-total score for accept-with-warning
 * (Req 6.7). Ties resolve to the earliest such attempt so the result is
 * deterministic. Throws on an empty list — the worker always records at least
 * the initial attempt before invoking this.
 */
export function selectBestAttempt(attempts: AttemptRecord[]): AttemptRecord {
  if (attempts.length === 0) {
    throw new Error("selectBestAttempt: attempts must not be empty");
  }
  let best = attempts[0];
  for (let i = 1; i < attempts.length; i++) {
    if (attempts[i].gateResult.weightedTotal > best.gateResult.weightedTotal) {
      best = attempts[i];
    }
  }
  return best;
}
