/**
 * Layered System Prompt builder (pure logic).
 *
 * Mirrors the "Layered System Prompt builder" section of the Design
 * Intelligence System design. Composes a four-layer system prompt in a FIXED
 * order L1 → L2 → L3 → L4 (Req 3.1, 3.2) that enriches the Copy Generation
 * (step 3) and Image Prompt Build (step 5) prompts WITHOUT altering the strict
 * six-step pipeline order (Req 3.7).
 *
 * The four layers (Req 3.3–3.6):
 *  - L1 Identity/Persona     -> senior art director persona (Req 3.3)
 *  - L2 Thinking_Process     -> mandatory reasoning that yields the
 *                               Design_Brief_Analysis & Visual_Strategy (Req 3.4)
 *  - L3 Quality_Gate_Directive -> the configured Quality_Criterion list +
 *                               per-criterion Quality_Threshold (Req 3.5)
 *  - L4 Design_DNA_Weights   -> style-mixing weights derived from
 *                               Decision_Weights for the chosen
 *                               Design_Purpose, plus the seeded Design_DNA (Req 3.6)
 *
 * Pure & deterministic: no I/O, no AI calls, no mutation of inputs — so it can
 * be property tested without any AI.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */

import type {
  DecisionWeights,
  DesignBriefAnalysis,
  DesignDNA,
  LayeredSystemPrompt,
  QualityCriterion,
  VisualStrategy,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Inputs needed to compose the four System_Prompt_Layer values. */
export interface LayeredSystemPromptInput {
  /** Reasoning context surfaced into L2 (Req 3.4). */
  briefAnalysis: DesignBriefAnalysis;
  /** Optional strategy context surfaced into L2 (Req 3.4). */
  visualStrategy?: VisualStrategy;
  /** Quality criteria + per-criterion thresholds listed in L3 (Req 3.5). */
  criteria: QualityCriterion[];
  /** Purpose-driven weights + priority surfaced into L4 (Req 3.6). */
  decisionWeights: DecisionWeights;
  /** Seeded style parameters surfaced into L4 (Req 3.6). */
  designDna: DesignDNA;
}

// ---------------------------------------------------------------------------
// Layer composition helpers (pure)
// ---------------------------------------------------------------------------

/**
 * L1 — Identity/Persona. A fixed senior art director persona definition that
 * establishes the standard the AI must uphold (Req 3.3).
 */
function buildL1Identity(): string {
  return [
    "[L1 — IDENTITY]",
    "You are a senior art director with deep expertise in brand-driven visual",
    "design. You design with intent (purpose-driven), reason explicitly before",
    "creating, critique your own output against professional standards, and",
    "never settle for generic, template-like, or over-decorated results.",
  ].join("\n");
}

/**
 * L2 — Thinking_Process. The mandatory reasoning steps that produce the
 * Design_Brief_Analysis and Visual_Strategy, seeded with the available
 * analysis/strategy context (Req 3.4).
 */
function buildL2Thinking(
  analysis: DesignBriefAnalysis,
  strategy: VisualStrategy | undefined,
): string {
  const lines: string[] = [
    "[L2 — THINKING PROCESS]",
    "Before producing any output, reason through these mandatory steps:",
    "1. Design_Brief_Analysis — establish the core message, target audience,",
    "   primary goal, and emotion target.",
    "2. Visual_Strategy — decide the hierarchy plan, composition type, color",
    "   psychology, typography system (with reasoning), and whitespace ratio.",
    "",
    "Design_Brief_Analysis context:",
    `- Core message: ${analysis.coreMessage}`,
    `- Target audience: ${analysis.targetAudience}`,
    `- Primary goal: ${analysis.primaryGoal}`,
    `- Emotion target: ${analysis.emotionTarget}`,
  ];

  if (strategy) {
    lines.push(
      "",
      "Visual_Strategy context:",
      `- Hierarchy plan: ${strategy.hierarchyPlan}`,
      `- Composition type: ${strategy.compositionType}`,
      `- Color psychology: ${strategy.colorPsychology}`,
      `- Typography: ${strategy.typography.system} (${strategy.typography.reasoning})`,
      `- Whitespace ratio: ${strategy.whitespaceRatio}`,
    );
  }

  return lines.join("\n");
}

/**
 * L3 — Quality_Gate_Directive. The non-negotiable quality gate: every
 * configured Quality_Criterion and its per-criterion Quality_Threshold (Req 3.5).
 */
function buildL3QualityGate(criteria: QualityCriterion[]): string {
  const lines: string[] = [
    "[L3 — QUALITY GATE]",
    "Your output must satisfy every quality criterion at or above its",
    "threshold (scale 1-10). Treat these as non-negotiable:",
  ];
  for (const { name, threshold } of criteria) {
    lines.push(`- ${name}: >= ${threshold}`);
  }
  return lines.join("\n");
}

/**
 * L4 — Design_DNA_Weights. The style-mixing weights derived from
 * Decision_Weights for the selected Design_Purpose, plus the seeded
 * Design_DNA parameters (Req 3.6).
 */
function buildL4DesignDnaWeights(
  weights: DecisionWeights,
  dna: DesignDNA,
): string {
  const lines: string[] = [
    "[L4 — DESIGN DNA & WEIGHTS]",
    `Design_Purpose: ${weights.purpose}`,
    `Priority order: ${weights.priority.join(" > ")}`,
    "Criterion weights (normalized, total 1.0):",
  ];
  // Emit weights in the purpose-driven priority order for determinism.
  for (const name of weights.priority) {
    lines.push(`- ${name}: ${weights.weights[name]}`);
  }
  lines.push(
    "Design_DNA parameters:",
    `- whitespaceRatio: ${dna.whitespaceRatio}`,
    `- elementCount: ${dna.elementCount}`,
    `- typographyWeight: ${dna.typographyWeight}`,
    `- paletteRestraint: ${dna.paletteRestraint}`,
    `- decorationLevel: ${dna.decorationLevel}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose the four System_Prompt_Layer values into a LayeredSystemPrompt.
 *
 * The four layers are always composed in the FIXED order L1 → L2 → L3 → L4
 * (Req 3.2); `composed` joins them with a single newline between each layer.
 * Pure — never mutates `input`.
 */
export function buildLayeredSystemPrompt(
  input: LayeredSystemPromptInput,
): LayeredSystemPrompt {
  const l1Identity = buildL1Identity();
  const l2Thinking = buildL2Thinking(input.briefAnalysis, input.visualStrategy);
  const l3QualityGate = buildL3QualityGate(input.criteria);
  const l4DesignDnaWeights = buildL4DesignDnaWeights(
    input.decisionWeights,
    input.designDna,
  );

  // Fixed positional order L1\nL2\nL3\nL4 (Req 3.2).
  const composed = [
    l1Identity,
    l2Thinking,
    l3QualityGate,
    l4DesignDnaWeights,
  ].join("\n");

  return {
    l1Identity,
    l2Thinking,
    l3QualityGate,
    l4DesignDnaWeights,
    composed,
  };
}

/**
 * Prepend the composed layered prompt to a step's base prompt without altering
 * the six-step pipeline order (Req 3.7). The base prompt is preserved verbatim
 * after the layered prompt; an empty base returns just the composed prompt.
 */
export function applyLayeredPrompt(
  basePrompt: string,
  layered: LayeredSystemPrompt,
): string {
  if (basePrompt.length === 0) {
    return layered.composed;
  }
  return `${layered.composed}\n${basePrompt}`;
}
