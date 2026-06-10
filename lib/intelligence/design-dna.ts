/**
 * Design_DNA — tunable style parameters (pure logic).
 *
 * Mirrors the "Design_DNA" section of the Design Intelligence System design.
 * Pure & deterministic module (no I/O): clamping, monotonic adjustment, and
 * default initialisation from Decision_Weights.
 *
 * Requirements: 8.3, 8.7, 9.4
 */

import type { DecisionWeights, DesignDNA, DnaAdjustment } from "../types";

// Re-export the shared types for ergonomic imports from this module.
export type { DesignDNA, DnaAdjustment } from "../types";

// ---------------------------------------------------------------------------
// Parameter ranges & defaults
// ---------------------------------------------------------------------------

/**
 * Valid range per Design_DNA parameter. `elementCount` is bounded below by 0
 * and unbounded above (Infinity); ratio-style parameters live in [0, 1].
 */
const DNA_RANGES: Record<keyof DesignDNA, { min: number; max: number }> = {
  whitespaceRatio: { min: 0, max: 1 },
  elementCount: { min: 0, max: Number.POSITIVE_INFINITY },
  typographyWeight: { min: 0, max: 1 },
  paletteRestraint: { min: 0, max: 1 },
  decorationLevel: { min: 0, max: 1 },
};

/** Neutral midpoint defaults. Req 8.3 */
export const DEFAULT_DESIGN_DNA: DesignDNA = {
  whitespaceRatio: 0.5,
  elementCount: 5,
  typographyWeight: 0.5,
  paletteRestraint: 0.5,
  decorationLevel: 0.5,
};

const DNA_PARAMETERS: (keyof DesignDNA)[] = [
  "whitespaceRatio",
  "elementCount",
  "typographyWeight",
  "paletteRestraint",
  "decorationLevel",
];

function clampValue(parameter: keyof DesignDNA, value: number): number {
  const { min, max } = DNA_RANGES[parameter];
  // Guard against NaN by falling back to the lower bound.
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Clamp every parameter into its valid range (invariant). Returns a new object.
 * Req 8.3
 */
export function clampDesignDna(dna: DesignDNA): DesignDNA {
  return {
    whitespaceRatio: clampValue("whitespaceRatio", dna.whitespaceRatio),
    elementCount: clampValue("elementCount", dna.elementCount),
    typographyWeight: clampValue("typographyWeight", dna.typographyWeight),
    paletteRestraint: clampValue("paletteRestraint", dna.paletteRestraint),
    decorationLevel: clampValue("decorationLevel", dna.decorationLevel),
  };
}

// ---------------------------------------------------------------------------
// Monotonic adjustment
// ---------------------------------------------------------------------------

/**
 * Apply Design_DNA adjustments monotonically: an "up" adjustment never lowers a
 * parameter and a "down" adjustment never raises it (after clamping to the
 * valid range). Returns a fresh DNA plus the list of parameters that actually
 * changed together with their net direction (for refinement explanations).
 *
 * The incoming DNA is clamped first so the monotonicity guarantee holds against
 * a valid baseline (Req 8.3, 8.7).
 */
export function applyDnaAdjustments(
  dna: DesignDNA,
  adjustments: DnaAdjustment[],
): { dna: DesignDNA; changes: DnaAdjustment[] } {
  const base = clampDesignDna(dna);
  const next: DesignDNA = { ...base };

  for (const adjustment of adjustments) {
    const { parameter, direction, delta } = adjustment;
    if (!(parameter in DNA_RANGES)) continue;
    // delta must be > 0 by contract; ignore non-positive/NaN deltas.
    if (!(delta > 0)) continue;
    const signed = direction === "up" ? delta : -delta;
    next[parameter] = clampValue(parameter, next[parameter] + signed);
  }

  const changes: DnaAdjustment[] = [];
  for (const parameter of DNA_PARAMETERS) {
    const diff = next[parameter] - base[parameter];
    if (diff === 0) continue;
    changes.push({
      parameter,
      direction: diff > 0 ? "up" : "down",
      delta: Math.abs(diff),
    });
  }

  return { dna: next, changes };
}

// ---------------------------------------------------------------------------
// Initialisation from Decision_Weights
// ---------------------------------------------------------------------------

/**
 * Initialise a default Design_DNA from Decision_Weights when no memory is
 * available (Req 9.4). The mapping is deterministic: criteria emphasis nudges
 * the related style parameters away from the neutral defaults, then everything
 * is clamped into range.
 */
export function initDesignDnaFromWeights(weights: DecisionWeights): DesignDNA {
  const w = weights.weights;
  const get = (name: keyof typeof w): number => {
    const value = w[name];
    return typeof value === "number" && !Number.isNaN(value) ? value : 0;
  };

  // Scale factor amplifies normalised weights (which sum to ~1 across criteria)
  // into meaningful offsets around the neutral baseline of ~0.3..0.5.
  const dna: DesignDNA = {
    whitespaceRatio: 0.3 + get("Whitespace") * 2,
    elementCount: DEFAULT_DESIGN_DNA.elementCount,
    typographyWeight: 0.3 + (get("Hierarchy") + get("Readability")) * 1.5,
    paletteRestraint:
      0.3 + (get("PremiumPerception") + get("BrandingConsistency")) * 1.5,
    decorationLevel: 0.3 + (get("Originality") + get("Composition")) * 1.5,
  };

  return clampDesignDna(dna);
}
