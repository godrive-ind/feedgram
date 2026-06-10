/**
 * Decision_Weights — purpose-driven weighting (pure, rule-based).
 *
 * Derives a normalized set of per-criterion weights (summing to 1.0) and a
 * priority ordering from a `Design_Purpose`. The prioritized criteria for a
 * purpose are ALWAYS weighted strictly higher than the non-prioritized ones.
 *
 * Rules (Req 7.1–7.5):
 *  - Marketing_Conversion -> Hierarchy & Readability tertinggi
 *  - Branding_Awareness   -> BrandingConsistency & PremiumPerception tertinggi
 *  - Education            -> Readability & Hierarchy tertinggi
 *  - Engagement           -> Originality & Composition tertinggi
 *
 * The normalized weights keep the weighted total score on the 1–10 scale and
 * are consumed by `Quality_Gate` (aggregation, Req 7.6); the `priority` order is
 * consumed by `Visual_Strategy` (hierarchy/composition decisions, Req 7.7).
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import type {
  DecisionWeights,
  DesignPurpose,
  QualityCriterionName,
} from "../types";

/**
 * Canonical list of all 7 quality criteria. Used to give non-prioritized
 * criteria a stable, deterministic ordering in the `priority` array.
 */
export const ALL_QUALITY_CRITERIA: readonly QualityCriterionName[] = [
  "Hierarchy",
  "Readability",
  "Composition",
  "BrandingConsistency",
  "Originality",
  "PremiumPerception",
  "Whitespace",
] as const;

/**
 * Raw (pre-normalization) weight assigned to each criterion based on its rank.
 *  - Top priority criterion  -> PRIMARY (highest)
 *  - Second priority criterion -> SECONDARY
 *  - All non-prioritized criteria -> BASE (lowest)
 *
 * PRIMARY > SECONDARY > BASE guarantees that, after normalization (which is a
 * strictly positive scaling), every prioritized criterion remains strictly
 * heavier than every non-prioritized criterion.
 */
const PRIMARY_RAW_WEIGHT = 3;
const SECONDARY_RAW_WEIGHT = 2;
const BASE_RAW_WEIGHT = 1;

/**
 * Ordered prioritized criteria per Design_Purpose (highest priority first).
 * Each purpose lists exactly the criteria that must outweigh the rest.
 */
const PRIORITY_BY_PURPOSE: Record<DesignPurpose, QualityCriterionName[]> = {
  // Req 7.2 — conversion: hierarchy & readability lead.
  Marketing_Conversion: ["Hierarchy", "Readability"],
  // Req 7.3 — branding: brand consistency & premium perception lead.
  Branding_Awareness: ["BrandingConsistency", "PremiumPerception"],
  // Req 7.4 — education: readability & hierarchy lead.
  Education: ["Readability", "Hierarchy"],
  // Req 7.5 — engagement: originality & composition lead.
  Engagement: ["Originality", "Composition"],
};

/**
 * Derive purpose-driven Decision_Weights.
 *
 * Returns normalized per-criterion weights (sum === 1.0) and a priority
 * ordering. Prioritized criteria are always strictly heavier than
 * non-prioritized criteria.
 *
 * @throws if `purpose` is not a known Design_Purpose.
 */
export function deriveDecisionWeights(purpose: DesignPurpose): DecisionWeights {
  const orderedPriority = PRIORITY_BY_PURPOSE[purpose];
  if (!orderedPriority) {
    throw new Error(`Unknown Design_Purpose: ${String(purpose)}`);
  }

  // Assign raw weights by rank: 1st priority -> PRIMARY, 2nd -> SECONDARY,
  // everything else -> BASE.
  const rawWeights = {} as Record<QualityCriterionName, number>;
  for (const name of ALL_QUALITY_CRITERIA) {
    const rank = orderedPriority.indexOf(name);
    if (rank === 0) {
      rawWeights[name] = PRIMARY_RAW_WEIGHT;
    } else if (rank === 1) {
      rawWeights[name] = SECONDARY_RAW_WEIGHT;
    } else {
      rawWeights[name] = BASE_RAW_WEIGHT;
    }
  }

  // Normalize so the weights sum to exactly 1.0 (within float precision).
  const rawTotal = ALL_QUALITY_CRITERIA.reduce(
    (sum, name) => sum + rawWeights[name],
    0,
  );
  const weights = {} as Record<QualityCriterionName, number>;
  for (const name of ALL_QUALITY_CRITERIA) {
    weights[name] = rawWeights[name] / rawTotal;
  }

  // Priority order: prioritized criteria first (in their declared order),
  // then the remaining criteria in canonical order for determinism.
  const priority: QualityCriterionName[] = [
    ...orderedPriority,
    ...ALL_QUALITY_CRITERIA.filter((name) => !orderedPriority.includes(name)),
  ];

  return { weights, priority, purpose };
}
