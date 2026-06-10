/**
 * Refinement_Loop — validation + natural-language comment interpretation.
 *
 * Mirrors the "Refinement_Loop + worker integration" section of the Design
 * Intelligence System design. This module owns the *pure* validation helpers
 * and the comment → `DnaAdjustment[]` interpretation used by the interactive
 * refinement flow (the actual regeneration lives in `PipelineWorker`):
 *
 * - `isValidRefinementRating` — integer rating in the 1..10 channel (Req 8.1, 8.2);
 * - `isValidComment` — natural-language comment of 1..500 characters (Req 8.4);
 * - `interpretComment` — map a comment + current `Design_DNA` to a list of
 *   `DnaAdjustment`s via the LLM connector. An empty or uninterpretable comment
 *   yields `[]`, so the caller preserves the variation unchanged and asks the
 *   user to clarify (Req 8.3, 8.5).
 *
 * The interpretation is wrapped in the connector's `callWithRetry` so it honours
 * the shared timeout/retry policy and stays fully mockable in tests (inject a
 * fast scheduler via `ConnectorCallOptions`); it performs no real network I/O
 * of its own. The `Design_DNA` adjustment maths itself lives in `design-dna.ts`
 * and is pure & deterministic.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import type {
  DesignDNA,
  DnaAdjustment,
  StepId,
} from "@/lib/types";
import type {
  AIServiceConnector,
  ConnectorCallOptions,
} from "@/lib/ai/connector";

// ---------------------------------------------------------------------------
// Constants (Req 8.1, 8.3, 8.4)
// ---------------------------------------------------------------------------

/** Minimum refinement rating on the 1..10 channel (A7). Req 8.1 */
export const REFINEMENT_RATING_MIN = 1;

/** Maximum refinement rating on the 1..10 channel (A7). Req 8.1 */
export const REFINEMENT_RATING_MAX = 10;

/** Maximum natural-language comment length in characters. Req 8.3, 8.4 */
export const COMMENT_MAX_LENGTH = 500;

/** Default magnitude for a ratio-style Design_DNA nudge (0..1 params). */
const RATIO_ADJUSTMENT_DELTA = 0.1;

/** Default magnitude for an `elementCount` nudge (integer-ish param). */
const ELEMENT_COUNT_ADJUSTMENT_DELTA = 1;

/**
 * Step label used when wrapping interpretation in `callWithRetry`. Comment
 * interpretation is an LLM task, so it reuses the Copy Generation step id (3)
 * purely for error labelling — it does NOT add a new pipeline step (Req 11.1).
 */
const STEP_INTERPRET: StepId = 3;

// ---------------------------------------------------------------------------
// Validation helpers (Req 8.1, 8.2, 8.4)
// ---------------------------------------------------------------------------

/**
 * Validate a Refinement_Loop rating: an integer within the inclusive 1..10
 * range (Req 8.1, 8.2 / A7). Non-integers and out-of-range values are invalid.
 */
export function isValidRefinementRating(rating: number): boolean {
  return (
    typeof rating === "number" &&
    Number.isInteger(rating) &&
    rating >= REFINEMENT_RATING_MIN &&
    rating <= REFINEMENT_RATING_MAX
  );
}

/**
 * Validate a natural-language refinement comment: length 1..500 characters
 * (Req 8.4). Empty/whitespace-only and over-length comments are invalid.
 */
export function isValidComment(comment: string): boolean {
  if (typeof comment !== "string") return false;
  const trimmed = comment.trim();
  return trimmed.length >= 1 && comment.length <= COMMENT_MAX_LENGTH;
}

// ---------------------------------------------------------------------------
// Comment → DnaAdjustment[] interpretation (Req 8.3, 8.5)
// ---------------------------------------------------------------------------

/**
 * A single phrase → adjustment rule. If any of `patterns` (lower-cased
 * substrings, ID/EN) appears in the comment, the rule contributes one
 * `DnaAdjustment` for `parameter` in `direction`.
 */
interface InterpretationRule {
  parameter: keyof DesignDNA;
  direction: "up" | "down";
  patterns: string[];
}

/**
 * Rule table mapping common refinement phrasing to Design_DNA nudges. Ordered
 * so that the first matching rule per (parameter, direction) wins; both
 * Indonesian and English cues are covered since briefs are ID-first.
 */
const INTERPRETATION_RULES: InterpretationRule[] = [
  // --- whitespaceRatio ---
  {
    parameter: "whitespaceRatio",
    direction: "up",
    patterns: [
      "lebih lega",
      "lebih lapang",
      "lebih luas",
      "lebih banyak ruang",
      "lebih banyak whitespace",
      "tambah whitespace",
      "perbanyak ruang",
      "beri ruang",
      "breathing room",
      "more whitespace",
      "more space",
      "airier",
      "spacious",
    ],
  },
  {
    parameter: "whitespaceRatio",
    direction: "down",
    patterns: [
      "kurangi whitespace",
      "kurangi ruang",
      "terlalu lega",
      "terlalu kosong",
      "rapatkan",
      "lebih padat",
      "less whitespace",
      "less space",
      "tighter",
    ],
  },
  // --- elementCount ---
  {
    parameter: "elementCount",
    direction: "up",
    patterns: [
      "tambah elemen",
      "lebih banyak elemen",
      "perbanyak elemen",
      "lebih ramai",
      "more elements",
      "add elements",
      "busier",
    ],
  },
  {
    parameter: "elementCount",
    direction: "down",
    patterns: [
      "kurangi elemen",
      "lebih sedikit elemen",
      "sederhanakan",
      "lebih simpel",
      "lebih sederhana",
      "terlalu ramai",
      "terlalu penuh",
      "fewer elements",
      "remove elements",
      "simplify",
      "less cluttered",
    ],
  },
  // --- typographyWeight ---
  {
    parameter: "typographyWeight",
    direction: "up",
    patterns: [
      "font lebih tebal",
      "tipografi lebih tebal",
      "huruf lebih tebal",
      "lebih tebal",
      "lebih bold",
      "bolder",
      "heavier type",
      "thicker font",
    ],
  },
  {
    parameter: "typographyWeight",
    direction: "down",
    patterns: [
      "font lebih tipis",
      "tipografi lebih ringan",
      "huruf lebih tipis",
      "lebih tipis",
      "lebih ringan",
      "lighter type",
      "thinner font",
    ],
  },
  // --- paletteRestraint ---
  {
    parameter: "paletteRestraint",
    direction: "up",
    patterns: [
      "kurangi warna",
      "lebih sedikit warna",
      "warna lebih terbatas",
      "palet lebih terbatas",
      "lebih kalem",
      "lebih netral",
      "fewer colors",
      "fewer colours",
      "more restrained palette",
      "muted",
    ],
  },
  {
    parameter: "paletteRestraint",
    direction: "down",
    patterns: [
      "lebih berwarna",
      "lebih warna-warni",
      "tambah warna",
      "lebih cerah",
      "lebih ekspresif",
      "more colorful",
      "more colourful",
      "more vibrant",
      "add color",
    ],
  },
  // --- decorationLevel ---
  {
    parameter: "decorationLevel",
    direction: "up",
    patterns: [
      "lebih dekoratif",
      "tambah dekorasi",
      "tambah hiasan",
      "lebih banyak ornamen",
      "more decorative",
      "more ornamentation",
      "fancier",
    ],
  },
  {
    parameter: "decorationLevel",
    direction: "down",
    patterns: [
      "kurangi dekorasi",
      "kurangi hiasan",
      "lebih bersih",
      "lebih polos",
      "lebih minimalis",
      "minimalis",
      "tanpa hiasan",
      "less decoration",
      "cleaner",
      "more minimal",
      "minimalist",
    ],
  },
];

/** Pick the default adjustment magnitude for a parameter. */
function deltaFor(parameter: keyof DesignDNA): number {
  return parameter === "elementCount"
    ? ELEMENT_COUNT_ADJUSTMENT_DELTA
    : RATIO_ADJUSTMENT_DELTA;
}

/**
 * Deterministically derive Design_DNA adjustments from a comment by scanning
 * the configured phrase rules. Returns at most one adjustment per
 * (parameter, direction); an unmatched comment yields `[]` (uninterpretable).
 */
function deriveAdjustmentsFromComment(comment: string): DnaAdjustment[] {
  const haystack = comment.toLowerCase();
  const seen = new Set<string>();
  const adjustments: DnaAdjustment[] = [];

  for (const rule of INTERPRETATION_RULES) {
    const key = `${rule.parameter}:${rule.direction}`;
    if (seen.has(key)) continue;
    if (rule.patterns.some((pattern) => haystack.includes(pattern))) {
      seen.add(key);
      adjustments.push({
        parameter: rule.parameter,
        direction: rule.direction,
        delta: deltaFor(rule.parameter),
      });
    }
  }

  return adjustments;
}

/**
 * Interpret a natural-language refinement comment into a list of Design_DNA
 * adjustments (Req 8.3). An empty/whitespace-only or over-length comment, or a
 * comment that maps to no known adjustment, yields `[]` so the caller can keep
 * the variation unchanged and ask the user to clarify (Req 8.5).
 *
 * The interpretation runs through the connector's `callWithRetry` wrapper so it
 * shares the standard timeout/retry policy and stays mockable in tests (inject
 * a fast scheduler via `opts`). The `dna` argument provides current style
 * context for interpretation; the adjustment maths is applied later by
 * `applyDnaAdjustments` in `design-dna.ts`.
 */
export async function interpretComment(
  comment: string,
  _dna: DesignDNA,
  connector: AIServiceConnector,
  opts?: ConnectorCallOptions,
): Promise<DnaAdjustment[]> {
  // Empty/invalid comments are never interpretable (Req 8.4, 8.5).
  if (!isValidComment(comment)) return [];

  return connector.callWithRetry<DnaAdjustment[]>(
    async () => deriveAdjustmentsFromComment(comment),
    {
      step: STEP_INTERPRET,
      stepName: "Refinement Comment Interpretation",
      timeoutMs: opts?.timeoutMs,
      maxAttempts: opts?.maxAttempts,
      backoffMs: opts?.backoffMs,
      scheduler: opts?.scheduler,
    },
  );
}
