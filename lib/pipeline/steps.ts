/**
 * Pipeline step transforms (Layer 2) — the concrete per-step logic plugged into
 * the strict sequential state machine in `lib/pipeline/engine.ts`.
 *
 * Each transform conforms to the `StepTransform` contract (it receives the
 * current `PipelineState` with the active step already marked "running" and
 * returns a partial-state patch carrying that step's output). `runStep` merges
 * the patch and marks the step "done".
 *
 * The six steps (Req 2.3–2.8):
 *   1. Brand DNA Extraction   — derive `BrandDNA` from the brief (Property 5)
 *   2. Design System Selection — derive `DesignSystem` from Brand DNA (Req 2.4)
 *   3. Copy Generation        — call the LLM, align goal+tone (Property 6)
 *   4. Layout Composition     — pick a layout matching format + mandatory
 *                                elements superset (Property 7)
 *   5. Image Prompt Build     — combine the 3 sources into one prompt (Property 8)
 *   6. Render & Compose       — generate exactly `variationCount` variations,
 *                                same brand/design across all (Property 9)
 *
 * AI calls (steps 3 and 6) go through an INJECTED `AIServiceConnector`
 * (Req 3.1/3.2) so the transforms are mockable and deterministic in tests.
 * Everything else is pure and deterministic given a deterministic connector,
 * which lets tasks 4.4–4.8 assert the correctness properties.
 *
 * Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8
 */

import type { AIServiceConnector, ConnectorCallOptions } from "@/lib/ai/connector";
import { composeVariation } from "@/lib/canvas/renderer";
import { applyLayeredPrompt } from "@/lib/intelligence/prompt-layers";
import type { StepTransform, StepTransforms } from "@/lib/pipeline/engine";
import type {
  BrandDNA,
  CopyContent,
  DesignBriefInput,
  DesignSystem,
  GenerationBatch,
  ImagePrompt,
  LayeredSystemPrompt,
  LayoutSlot,
  LayoutTemplate,
  MandatoryElement,
  OutputFormat,
  PipelineState,
  VisualStyle,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

/**
 * Options for {@link createStepTransforms}. All identity/timestamp values are
 * injectable so the step-6 batch output is deterministic in tests; sensible
 * deterministic defaults are derived from the brief when omitted.
 */
export interface StepTransformsOptions {
  /** Batch id for the produced `GenerationBatch`. Defaults derived from brief. */
  batchId?: string;
  /** Owning user id stamped on the batch. Defaults to `"anonymous"`. */
  userId?: string;
  /** Brief id stamped on the batch. Defaults derived from brief. */
  briefId?: string;
  /** ISO timestamp for `createdAt`. Defaults to a deterministic epoch string. */
  createdAt?: string;
  /** Base seed for per-variation image prompts. Defaults derived from brief. */
  baseSeed?: number;
  /** Retry/timeout overrides forwarded to the AI connector calls. */
  connectorOptions?: ConnectorCallOptions;
  /**
   * Optional Design_Intelligence enrichment (Req 3.7, 10.2). Present ONLY when
   * Professional_Mode is active. When present:
   *   - step 3 (Copy Generation) attaches `layeredPrompt.composed` as the
   *     `systemPrompt` on the `CopyRequest`;
   *   - step 5 (Image Prompt Build) prepends `layeredPrompt.composed` to the
   *     prompt and strengthens the `negativePrompt` to steer away from generic
   *     template / "AI-generated look" / over-decorated results.
   * When ABSENT, steps 3 and 5 preserve their exact legacy behavior.
   */
  intelligence?: {
    /** The composed four-layer System_Prompt (L1->L2->L3->L4). */
    layeredPrompt: LayeredSystemPrompt;
    /**
     * Optional caller-provided negative prompt merged into step 5's negative
     * prompt alongside the Negative_Pattern reinforcement.
     */
    negativePrompt?: string;
  };
}

/**
 * Negative_Pattern reinforcement appended to the image prompt's negative prompt
 * when Professional_Mode is active, steering generation away from generic
 * template looks, "AI-generated" feel, and over-decoration (Req 10.2).
 */
const NEGATIVE_PATTERN_REINFORCEMENT =
  "generic template, AI-generated look, over-decorated";

// ---------------------------------------------------------------------------
// Step 1 — Brand DNA Extraction (Req 2.3, Property 5)
// ---------------------------------------------------------------------------

/**
 * Derive a {@link BrandDNA} from the brief. The brand-identity fields
 * (`brandName`, `tagline`, `accentPalette`, `tone`, `visualStyle`) are copied
 * EXACTLY from the brief so they match the source (Property 5). The accent
 * palette is cloned (not aliased) so later steps cannot mutate the brief.
 */
export function deriveBrandDna(brief: DesignBriefInput): BrandDNA {
  return {
    brandName: brief.brandName,
    tagline: brief.tagline,
    accentPalette: [...brief.accentPalette],
    tone: brief.tone,
    visualStyle: brief.visualStyle,
  };
}

const brandDnaStep: StepTransform = (state) => {
  return { brandDna: deriveBrandDna(state.brief) };
};

// ---------------------------------------------------------------------------
// Step 2 — Design System Selection (Req 2.4)
// ---------------------------------------------------------------------------

/** Static, deterministic design-system preset for each visual style. */
interface VisualStylePreset {
  headlineFont: string;
  bodyFont: string;
  typographyScale: number[];
  radius: number;
  layoutDensity: DesignSystem["layoutDensity"];
  ctaStyle: string;
}

/**
 * Deterministic mapping from visual style → design-system preset. Keyed by the
 * `VisualStyle` literal union so every style has an entry (Req 2.4).
 */
export const VISUAL_STYLE_PRESETS: Record<VisualStyle, VisualStylePreset> = {
  BoldDark: {
    headlineFont: "Montserrat",
    bodyFont: "Inter",
    typographyScale: [48, 32, 20, 16],
    radius: 4,
    layoutDensity: "compact",
    ctaStyle: "solid",
  },
  VibrantCleanModern: {
    headlineFont: "Poppins",
    bodyFont: "Inter",
    typographyScale: [44, 30, 20, 16],
    radius: 12,
    layoutDensity: "regular",
    ctaStyle: "solid",
  },
  CorporateBlue: {
    headlineFont: "Roboto",
    bodyFont: "Open Sans",
    typographyScale: [40, 28, 18, 14],
    radius: 6,
    layoutDensity: "regular",
    ctaStyle: "outline",
  },
  Minimalis: {
    headlineFont: "Helvetica Neue",
    bodyFont: "Helvetica Neue",
    typographyScale: [40, 26, 18, 14],
    radius: 0,
    layoutDensity: "spacious",
    ctaStyle: "ghost",
  },
  WarmEarth: {
    headlineFont: "Merriweather",
    bodyFont: "Lora",
    typographyScale: [42, 28, 19, 15],
    radius: 10,
    layoutDensity: "regular",
    ctaStyle: "solid",
  },
  NeonCyber: {
    headlineFont: "Orbitron",
    bodyFont: "Rajdhani",
    typographyScale: [46, 30, 20, 15],
    radius: 2,
    layoutDensity: "compact",
    ctaStyle: "glow",
  },
  Luxury: {
    headlineFont: "Playfair Display",
    bodyFont: "EB Garamond",
    typographyScale: [50, 32, 21, 16],
    radius: 8,
    layoutDensity: "spacious",
    ctaStyle: "outline",
  },
  Gradient: {
    headlineFont: "Sora",
    bodyFont: "Manrope",
    typographyScale: [44, 30, 20, 16],
    radius: 16,
    layoutDensity: "regular",
    ctaStyle: "gradient",
  },
};

/**
 * Derive a {@link DesignSystem} deterministically from the Brand DNA. The font
 * pair, typography scale, radius, layout density, brand-element position, and
 * CTA style are selected from the visual style preset so the same brand always
 * yields the same design system (Req 2.4). The result is identical for every
 * variation in a batch, satisfying the brand-consistency contract (Req 5.3).
 */
export function deriveDesignSystem(brandDna: BrandDNA): DesignSystem {
  const preset =
    VISUAL_STYLE_PRESETS[brandDna.visualStyle as VisualStyle] ??
    VISUAL_STYLE_PRESETS.VibrantCleanModern;

  return {
    headlineFont: preset.headlineFont,
    bodyFont: preset.bodyFont,
    typographyScale: [...preset.typographyScale],
    radius: preset.radius,
    layoutDensity: preset.layoutDensity,
    brandElementPosition: { logo: "top-left", watermark: "bottom-right" },
    ctaStyle: preset.ctaStyle,
  };
}

const designSystemStep: StepTransform = (state) => {
  const brandDna = requireField(state.brandDna, "brandDna", 2);
  return { designSystem: deriveDesignSystem(brandDna) };
};

// ---------------------------------------------------------------------------
// Step 3 — Copy Generation (Req 2.5, Property 6)
// ---------------------------------------------------------------------------

/**
 * Build the step-3 transform. Calls `connector.generateCopy` (Req 3.1) and then
 * forces `alignedGoal`/`alignedTone` to the brief's `contentGoal`/`tone`
 * regardless of what the LLM echoes back, so the copy is always aligned with
 * the user's chosen goal and tone (Property 6).
 */
function makeCopyStep(
  connector: AIServiceConnector,
  options: StepTransformsOptions,
): StepTransform {
  return async (state) => {
    const brandDna = requireField(state.brandDna, "brandDna", 3);
    const { brief } = state;

    const generated = await connector.generateCopy(
      {
        brief,
        brandDna,
        contentGoal: brief.contentGoal,
        tone: brief.tone,
        // Attach the layered System_Prompt only when Professional_Mode supplied
        // intelligence options; absent => legacy behavior (no systemPrompt).
        ...(options.intelligence
          ? { systemPrompt: options.intelligence.layeredPrompt.composed }
          : {}),
      },
      options.connectorOptions,
    );

    // Force alignment to the brief, independent of the LLM echo (Property 6).
    const copy: CopyContent = {
      ...generated,
      alignedGoal: brief.contentGoal,
      alignedTone: brief.tone,
    };

    return { copy };
  };
}

// ---------------------------------------------------------------------------
// Step 4 — Layout Composition (Req 2.6, Property 7)
// ---------------------------------------------------------------------------

/**
 * Build a deterministic {@link LayoutTemplate} whose `format` equals the brief's
 * output format and whose `includedElements` is a SUPERSET of the brief's
 * mandatory elements (Property 7). Slots are laid out vertically and scaled to
 * the chosen format and the design system's layout density.
 */
export function buildLayout(
  format: OutputFormat,
  mandatoryElements: MandatoryElement[],
  designSystem: DesignSystem,
): LayoutTemplate {
  const includedElements = unique(mandatoryElements);
  const slots = buildSlots(format, includedElements.length, designSystem);
  const id = `layout-${format.name}-${designSystem.layoutDensity}-${includedElements.length}`;

  return {
    id,
    format,
    slots,
    includedElements,
  };
}

/** Build layout slots sized to the format and density. */
function buildSlots(
  format: OutputFormat,
  elementCount: number,
  designSystem: DesignSystem,
): LayoutSlot[] {
  const margin = densityMargin(designSystem.layoutDensity);
  const innerW = format.width - margin * 2;
  const slots: LayoutSlot[] = [];

  // Headline text slot near the top.
  slots.push({
    type: "text",
    x: margin,
    y: margin,
    w: innerW,
    h: Math.round(format.height * 0.18),
  });

  // Primary image slot in the middle.
  slots.push({
    type: "image",
    x: margin,
    y: Math.round(format.height * 0.22),
    w: innerW,
    h: Math.round(format.height * 0.5),
  });

  // One element slot per mandatory element along the bottom band.
  const bandTop = Math.round(format.height * 0.74);
  const slotH = 48;
  for (let i = 0; i < elementCount; i++) {
    slots.push({
      type: "element",
      x: margin,
      y: bandTop + i * (slotH + 8),
      w: innerW,
      h: slotH,
    });
  }

  return slots;
}

/** Margin (px) derived from layout density. */
function densityMargin(density: DesignSystem["layoutDensity"]): number {
  switch (density) {
    case "compact":
      return 32;
    case "spacious":
      return 96;
    case "regular":
    default:
      return 64;
  }
}

const layoutStep: StepTransform = (state) => {
  const designSystem = requireField(state.designSystem, "designSystem", 4);
  const layout = buildLayout(
    state.brief.outputFormat,
    state.brief.mandatoryElements,
    designSystem,
  );
  return { layout };
};

// ---------------------------------------------------------------------------
// Step 5 — Image Prompt Build (Req 2.7, Property 8)
// ---------------------------------------------------------------------------

/**
 * Build an {@link ImagePrompt} whose `prompt` combines identifiable markers
 * from all three sources — Brand DNA (brand identity), Design System (fonts),
 * and Layout Template (structure) — so the prompt provably merges the three
 * (Property 8). Tokens are emitted in a stable, labeled form.
 *
 * When `intelligence` is provided (Professional_Mode active), the composed
 * layered System_Prompt is PREPENDED to the prompt (without altering the
 * three-source merge) and the `negativePrompt` is strengthened with the
 * Negative_Pattern reinforcement (Req 3.7, 10.2). When omitted, the legacy
 * prompt and negative prompt are preserved exactly.
 */
export function buildImagePrompt(
  brandDna: BrandDNA,
  designSystem: DesignSystem,
  layout: LayoutTemplate,
  intelligence?: StepTransformsOptions["intelligence"],
): ImagePrompt {
  // Brand DNA markers (identity).
  const brandTokens = [
    `brand:${brandDna.brandName}`,
    `style:${brandDna.visualStyle}`,
    `tone:${brandDna.tone}`,
    `palette:${brandDna.accentPalette.join(",")}`,
  ];

  // Design System markers (fonts/typography).
  const designTokens = [
    `headlineFont:${designSystem.headlineFont}`,
    `bodyFont:${designSystem.bodyFont}`,
    `density:${designSystem.layoutDensity}`,
    `cta:${designSystem.ctaStyle}`,
  ];

  // Layout Template markers (structure).
  const layoutTokens = [
    `layout:${layout.id}`,
    `format:${layout.format.name}`,
    `dimensions:${layout.format.width}x${layout.format.height}`,
    `elements:${layout.includedElements.join(",")}`,
  ];

  const basePrompt = [
    "[BRAND] " + brandTokens.join(" | "),
    "[DESIGN] " + designTokens.join(" | "),
    "[LAYOUT] " + layoutTokens.join(" | "),
  ].join("\n");

  const baseNegativePrompt = "low quality, distorted, off-brand, inconsistent";

  if (!intelligence) {
    // Legacy behavior preserved exactly when no intelligence enrichment.
    return {
      prompt: basePrompt,
      negativePrompt: baseNegativePrompt,
      seed: undefined,
    };
  }

  // Professional_Mode: prepend the composed layered System_Prompt (Req 3.7) and
  // strengthen the negative prompt with the Negative_Pattern reinforcement
  // (Req 10.2), merging any caller-provided negative prompt.
  const prompt = applyLayeredPrompt(basePrompt, intelligence.layeredPrompt);
  const negativePrompt = [
    baseNegativePrompt,
    intelligence.negativePrompt,
    NEGATIVE_PATTERN_REINFORCEMENT,
  ]
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join(", ");

  return {
    prompt,
    negativePrompt,
    seed: undefined,
  };
}

const imagePromptStep: StepTransform = (state) => {
  const brandDna = requireField(state.brandDna, "brandDna", 5);
  const designSystem = requireField(state.designSystem, "designSystem", 5);
  const layout = requireField(state.layout, "layout", 5);
  return {
    imagePrompt: buildImagePrompt(brandDna, designSystem, layout),
  };
};

/**
 * Build the step-5 transform. Pure given its inputs; when `options.intelligence`
 * is present (Professional_Mode), the layered System_Prompt is prepended and the
 * negative prompt is strengthened (Req 3.7, 10.2). When absent, legacy behavior
 * is preserved exactly.
 */
function makeImagePromptStep(options: StepTransformsOptions): StepTransform {
  if (!options.intelligence) {
    // Preserve the exact legacy transform when no enrichment is supplied.
    return imagePromptStep;
  }
  return (state) => {
    const brandDna = requireField(state.brandDna, "brandDna", 5);
    const designSystem = requireField(state.designSystem, "designSystem", 5);
    const layout = requireField(state.layout, "layout", 5);
    return {
      imagePrompt: buildImagePrompt(
        brandDna,
        designSystem,
        layout,
        options.intelligence,
      ),
    };
  };
}

// ---------------------------------------------------------------------------
// Step 6 — Render & Compose (Req 2.8, Property 9)
// ---------------------------------------------------------------------------

/**
 * Build the step-6 transform. Generates EXACTLY `variationCount` variations
 * (Property 9), all sharing the SAME `brandDna` and `designSystem` (brand
 * consistency, Req 5.1–5.3). For each variation it calls
 * `connector.generateImage` (Req 3.2) with the shared image prompt and a
 * per-variation seed, then composes the variation via `composeVariation`.
 * Produces a `GenerationBatch` whose `status` is `"running"` (final
 * consistency verification + `"done"` happens in task 4.12).
 */
function makeRenderComposeStep(
  connector: AIServiceConnector,
  options: StepTransformsOptions,
): StepTransform {
  return async (state) => {
    const brandDna = requireField(state.brandDna, "brandDna", 6);
    const designSystem = requireField(state.designSystem, "designSystem", 6);
    const copy = requireField(state.copy, "copy", 6);
    const layout = requireField(state.layout, "layout", 6);
    const imagePrompt = requireField(state.imagePrompt, "imagePrompt", 6);

    const { brief } = state;
    const variationCount = brief.variationCount;

    const batchId = options.batchId ?? `batch-${stableHash(briefSeed(brief))}`;
    const userId = options.userId ?? "anonymous";
    const briefId = options.briefId ?? `brief-${stableHash(briefSeed(brief))}`;
    const createdAt = options.createdAt ?? EPOCH_ISO;
    const baseSeed = options.baseSeed ?? stableSeed(briefSeed(brief));

    const variations = [];
    // Generate EXACTLY variationCount variations (Property 9).
    for (let i = 0; i < variationCount; i++) {
      // Same prompt + brand/design for all variations; vary only the seed so
      // each render differs while the brand stays identical.
      const variationPrompt: ImagePrompt = {
        ...imagePrompt,
        seed: baseSeed + i,
      };

      const imageAsset = await connector.generateImage(
        { imagePrompt: variationPrompt, format: layout.format },
        options.connectorOptions,
      );

      const variation = composeVariation(
        {
          batchId,
          brandDna,
          designSystem,
          copy,
          layout,
          imageAsset,
        },
        { id: `${batchId}-v${i + 1}` },
      );

      variations.push(variation);
    }

    const batch: GenerationBatch = {
      id: batchId,
      userId,
      briefId,
      variations,
      status: "running",
      createdAt,
    };

    return { batch };
  };
}

// ---------------------------------------------------------------------------
// Factory — assemble the StepTransforms map
// ---------------------------------------------------------------------------

/**
 * Create the {@link StepTransforms} map for the six pipeline steps, wiring the
 * injected {@link AIServiceConnector} into steps 3 and 6. The returned map
 * plugs directly into `runStep` from `lib/pipeline/engine.ts`.
 *
 * Steps 1, 2, 4, and 5 are pure/deterministic; steps 3 and 6 call the
 * (mockable) connector. Given a deterministic connector the entire pipeline is
 * deterministic, which the correctness-property tests rely on.
 */
export function createStepTransforms(
  connector: AIServiceConnector,
  options: StepTransformsOptions = {},
): StepTransforms {
  return {
    1: brandDnaStep,
    2: designSystemStep,
    3: makeCopyStep(connector, options),
    4: layoutStep,
    5: makeImagePromptStep(options),
    6: makeRenderComposeStep(connector, options),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Deterministic epoch ISO string used as the default batch timestamp. */
const EPOCH_ISO = new Date(0).toISOString();

/**
 * Assert a prerequisite step output is present. Strict sequencing guarantees
 * earlier steps ran, but this guards against misuse and yields a clear error.
 */
function requireField<T>(
  value: T | undefined,
  field: keyof PipelineState,
  step: number,
): T {
  if (value === undefined || value === null) {
    throw new Error(
      `Langkah ${step} membutuhkan hasil "${String(field)}" dari langkah sebelumnya, tetapi tidak tersedia`,
    );
  }
  return value;
}

/** Return the input array with duplicates removed, order preserved. */
function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

/** Build a stable seed string from the brief's identity-bearing fields. */
function briefSeed(brief: DesignBriefInput): string {
  return [
    brief.brandName,
    brief.tagline ?? "",
    brief.contentGoal,
    brief.visualStyle,
    brief.tone,
    brief.outputFormat.name,
    String(brief.variationCount),
    brief.accentPalette.join(","),
    brief.mandatoryElements.join(","),
  ].join("|");
}

/** Stable, non-cryptographic 32-bit string hash (FNV-1a) as base36. */
function stableHash(input: string): string {
  return (fnv1a(input) >>> 0).toString(36);
}

/** Stable numeric seed (non-negative integer) from a string. */
function stableSeed(input: string): number {
  return fnv1a(input) >>> 0;
}

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

// ---------------------------------------------------------------------------
// Convenience aggregate
// ---------------------------------------------------------------------------

/** Convenience object grouping the pure step-derivation helpers. */
export const PipelineSteps = {
  createStepTransforms,
  deriveBrandDna,
  deriveDesignSystem,
  buildLayout,
  buildImagePrompt,
  VISUAL_STYLE_PRESETS,
} as const;
