/**
 * Visual_Strategy builder (FASE PRA — LLM-backed via connector, mockable).
 *
 * Produces a {@link VisualStrategy} artefact before the Image Prompt Build step
 * (step 5) so the layered prompt can consume it. The strategy is derived from:
 *   - the {@link DesignBriefAnalysis} (core message / audience / goal / emotion),
 *   - the purpose-driven {@link DecisionWeights} `priority` ordering, which drives
 *     the hierarchy plan and composition type decisions (Req 7.7), and
 *   - the {@link DesignDNA} (whitespace ratio, typography weight) for concrete
 *     stylistic parameters.
 *
 * The build is routed through `connector.callWithRetry` (timeout 30s, ≤3 attempts
 * by default, injectable scheduler via `opts`) so it is mockable in tests and
 * shares the same retry/timeout policy as the other FASE PRA artefacts.
 *
 * The resulting `whitespaceRatio` is always clamped to [0, 1] (Req 4.3).
 *
 * Requirements: 4.3, 7.7
 */

import type {
  AIServiceConnector,
  ConnectorCallOptions,
} from "../ai/connector";
import type {
  DecisionWeights,
  DesignBriefAnalysis,
  DesignDNA,
  QualityCriterionName,
  StepId,
  TypographyChoice,
  VisualStrategy,
} from "../types";

/**
 * Step id used to LABEL Visual_Strategy build failures. The artefact is produced
 * in FASE PRA, before step 5 (Image Prompt Build), so it borrows step 5's id but
 * carries a distinct step NAME so any failure is clearly attributed to strategy
 * synthesis rather than the image prompt step itself.
 */
const STEP_VISUAL_STRATEGY: StepId = 5;
const STEP_VISUAL_STRATEGY_NAME = "Visual Strategy";

/** Clamp a value into the closed range [0, 1]; non-finite -> 0. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Hierarchy plan keyed by the TOP-priority Quality_Criterion. Applying the
 * Decision_Weights priority ordering to the hierarchy decision (Req 7.7): the
 * highest-priority criterion dictates the dominant hierarchy approach.
 */
const HIERARCHY_PLAN_BY_PRIORITY: Record<QualityCriterionName, string> = {
  Hierarchy:
    "Hierarki eksplisit dan tegas: satu focal point dominan, urutan baca jelas dari headline ke CTA",
  Readability:
    "Hierarki mengutamakan keterbacaan: ukuran tipografi bertingkat, kontras tinggi, urutan baca linear",
  Composition:
    "Hierarki kompositoris dinamis: focal point ditegaskan lewat penempatan dan keseimbangan visual",
  BrandingConsistency:
    "Hierarki dipimpin brand: logo dan elemen brand menonjol, alur visual menegaskan identitas",
  Originality:
    "Hierarki tak terduga: penekanan asimetris dan focal point non-konvensional untuk kesan orisinal",
  PremiumPerception:
    "Hierarki minimalis premium: sedikit elemen menonjol dengan ruang napas luas mengarahkan fokus",
  Whitespace:
    "Hierarki berbasis ruang: pengelompokan dipandu whitespace, focal point dipisahkan oleh ruang kosong",
};

/**
 * Composition type keyed by the TOP-priority Quality_Criterion. Applying the
 * Decision_Weights priority ordering to the composition decision (Req 7.7).
 */
const COMPOSITION_TYPE_BY_PRIORITY: Record<QualityCriterionName, string> = {
  Hierarchy: "Komposisi grid terstruktur dengan satu titik berat dominan",
  Readability: "Komposisi terpusat/linear yang mengutamakan alur baca",
  Composition: "Komposisi dinamis (rule-of-thirds / diagonal) dengan keseimbangan aktif",
  BrandingConsistency: "Komposisi simetris terkurasi yang menegaskan konsistensi brand",
  Originality: "Komposisi asimetris eksperimental yang memecah pola template",
  PremiumPerception: "Komposisi minimalis lapang dengan banyak negative space",
  Whitespace: "Komposisi modular dengan whitespace sebagai elemen penyusun utama",
};

/** Human-readable color-psychology framing derived from the emotion target. */
function deriveColorPsychology(analysis: DesignBriefAnalysis): string {
  const emotion = analysis.emotionTarget?.trim();
  if (emotion) {
    return `Palet dipilih untuk membangkitkan ${emotion}, mendukung primary goal "${analysis.primaryGoal}"`;
  }
  return `Palet selaras dengan primary goal "${analysis.primaryGoal}" dan pesan inti "${analysis.coreMessage}"`;
}

/** Map a typography weight in [0,1] to a concrete typographic system + reasoning. */
function deriveTypography(
  designDna: DesignDNA,
  topPriority: QualityCriterionName,
): TypographyChoice {
  const weight = clamp01(designDna.typographyWeight);
  let system: string;
  let weightReasoning: string;
  if (weight < 0.34) {
    system = "Sistem sans-serif ringan dengan kontras lembut";
    weightReasoning = "bobot tipografi rendah menjaga kesan ringan dan lapang";
  } else if (weight < 0.67) {
    system = "Sistem sans-serif seimbang dengan dua tingkat berat";
    weightReasoning = "bobot tipografi sedang menyeimbangkan keterbacaan dan penekanan";
  } else {
    system = "Sistem tipografi tebal berkontras tinggi";
    weightReasoning = "bobot tipografi tinggi memperkuat penekanan dan dampak visual";
  }
  return {
    system,
    reasoning: `${system} dipilih karena ${weightReasoning}; selaras dengan prioritas utama ${topPriority}`,
  };
}

/**
 * Synthesise the Visual_Strategy deterministically from the brief analysis, the
 * purpose-driven priority ordering (Req 7.7), and the Design_DNA. This is the
 * unit of work routed through the connector's retry/timeout wrapper.
 */
function synthesizeVisualStrategy(
  analysis: DesignBriefAnalysis,
  weights: DecisionWeights,
  designDna: DesignDNA,
): VisualStrategy {
  // Decision_Weights priority drives hierarchy & composition (Req 7.7).
  const priority = weights.priority;
  const topPriority = priority[0];
  if (!topPriority) {
    throw new Error(
      "Decision_Weights.priority kosong: tidak dapat menyusun Visual_Strategy",
    );
  }

  return {
    hierarchyPlan: HIERARCHY_PLAN_BY_PRIORITY[topPriority],
    compositionType: COMPOSITION_TYPE_BY_PRIORITY[topPriority],
    colorPsychology: deriveColorPsychology(analysis),
    typography: deriveTypography(designDna, topPriority),
    // whitespaceRatio always clamped to [0, 1] (Req 4.3).
    whitespaceRatio: clamp01(designDna.whitespaceRatio),
  };
}

/**
 * Build the Visual_Strategy artefact (Req 4.3) applying the Decision_Weights
 * priority ordering to hierarchy/composition decisions (Req 7.7).
 *
 * LLM-backed via the connector and mockable: the synthesis is wrapped in
 * `connector.callWithRetry` so it shares the standard timeout (30s) / retry
 * (≤3 attempts) policy and an injectable scheduler through `opts`.
 */
export async function buildVisualStrategy(
  analysis: DesignBriefAnalysis,
  weights: DecisionWeights,
  designDna: DesignDNA,
  connector: AIServiceConnector,
  opts?: ConnectorCallOptions,
): Promise<VisualStrategy> {
  return connector.callWithRetry(
    async () => synthesizeVisualStrategy(analysis, weights, designDna),
    {
      step: STEP_VISUAL_STRATEGY,
      stepName: opts?.stepName ?? STEP_VISUAL_STRATEGY_NAME,
      timeoutMs: opts?.timeoutMs,
      maxAttempts: opts?.maxAttempts,
      backoffMs: opts?.backoffMs,
      scheduler: opts?.scheduler,
    },
  );
}
