/**
 * Pure, framework-agnostic helpers for the Left Panel (Brief/Configurator).
 *
 * Kept separate from the React component so the core form logic — default
 * brief construction, plan-based variation-count gating, and assembling a
 * {@link DesignBriefInput} from the form state — can be unit tested in a plain
 * Node environment without a DOM.
 *
 * Requirements: 1.1, 1.3, 8.4, 8.5
 */

import { PLAN_VARIATION_RULES } from "@/lib/credit/credit-manager";
import {
  CONTENT_GOALS,
  DESIGN_PURPOSES,
  OUTPUT_FORMATS,
  TONES,
  VISUAL_STYLES,
  type DesignBriefInput,
  type DesignPurpose,
  type ImageAsset,
  type MandatoryElement,
  type OutputFormat,
  type Plan,
  type ProfessionalBriefFields,
  type VariationCount,
} from "@/lib/types";

/**
 * Editable shape backing the form inputs. Keeps the output format as its
 * `name` discriminant (a single `<select>` value) and resolves it to the full
 * {@link OutputFormat} object when building the brief.
 *
 * Professional_Mode is additive: `professionalMode` defaults to `false`
 * (Req 1.1, 1.4) and the professional fields are flat strings backing their
 * inputs, assembled into {@link ProfessionalBriefFields} only when the toggle
 * is ON (Req 2.1).
 */
export interface BriefFormState {
  brandName: string;
  tagline: string;
  mainMessage: string;
  contentGoal: DesignBriefInput["contentGoal"];
  visualStyle: DesignBriefInput["visualStyle"];
  tone: DesignBriefInput["tone"];
  outputFormatName: OutputFormat["name"];
  variationCount: VariationCount;
  accentPalette: string[];
  mandatoryElements: MandatoryElement[];
  uploadedAssets: ImageAsset[];
  // --- Professional_Mode (additive, default OFF) ---
  professionalMode: boolean;
  designPurpose: DesignPurpose;
  audienceAge: string;
  audienceProfession: string;
  audiencePainPoint: string;
  primaryGoal: string;
  emotionTarget: string;
  coreMessage: string;
}

/** Sensible defaults so the form is valid except for the required brand name. */
export function createEmptyBriefFormState(): BriefFormState {
  return {
    brandName: "",
    tagline: "",
    mainMessage: "",
    contentGoal: CONTENT_GOALS[0],
    visualStyle: VISUAL_STYLES[0],
    tone: TONES[0],
    outputFormatName: OUTPUT_FORMATS[0].name,
    variationCount: 3,
    accentPalette: ["#2563eb"],
    mandatoryElements: [],
    uploadedAssets: [],
    // Professional_Mode defaults to OFF (Req 1.1, 1.4).
    professionalMode: false,
    designPurpose: DESIGN_PURPOSES[0],
    audienceAge: "",
    audienceProfession: "",
    audiencePainPoint: "",
    primaryGoal: "",
    emotionTarget: "",
    coreMessage: "",
  };
}

/** Resolve an output format `name` to its full object (width/height). Req 1.7 */
export function resolveOutputFormat(name: OutputFormat["name"]): OutputFormat {
  const match = OUTPUT_FORMATS.find((f) => f.name === name);
  // Fall back to the first format if an unknown name slips through.
  return (match ?? OUTPUT_FORMATS[0]) as OutputFormat;
}

/**
 * Whether a variation count is selectable for the given plan.
 * Mirrors `Credit_Manager` rules: Free → 3/6, Pro → 3/6/9 (Req 8.4, 8.5).
 */
export function isVariationCountEnabled(
  plan: Plan,
  count: VariationCount,
): boolean {
  return PLAN_VARIATION_RULES[plan].includes(count);
}

/**
 * Assemble {@link ProfessionalBriefFields} from the flat form state. Optional
 * audience sub-fields collapse to `undefined` when blank. Required-field and
 * 7-word checks live in `validateProfessionalBrief` — this only shapes the
 * data, preserving values unchanged (Req 2.1, 2.8).
 */
export function buildProfessionalFields(
  state: BriefFormState,
): ProfessionalBriefFields {
  const blankToUndefined = (v: string): string | undefined =>
    v.trim().length > 0 ? v : undefined;

  return {
    designPurpose: state.designPurpose,
    audience: {
      age: blankToUndefined(state.audienceAge),
      profession: blankToUndefined(state.audienceProfession),
      painPoint: blankToUndefined(state.audiencePainPoint),
    },
    primaryGoal: state.primaryGoal,
    emotionTarget: state.emotionTarget,
    coreMessage: state.coreMessage,
  };
}

/**
 * Build a {@link DesignBriefInput} from the form state.
 *
 * Optional text fields (`tagline`, `mainMessage`) collapse to `undefined` when
 * blank so they are omitted rather than sent as empty strings. The brand name
 * is passed through unchanged so validation/preservation works as specified
 * (Req 1.3) — trimming/required-checks live in `validateBrief`.
 *
 * When Professional_Mode is ON, `professionalMode` + the professional fields
 * are included so the server/worker activates the Design_Intelligence layer
 * (Req 1.1, 2.1, 2.8). When OFF they are omitted entirely (Req 1.4).
 */
export function buildBriefInput(state: BriefFormState): DesignBriefInput {
  const tagline = state.tagline.trim().length > 0 ? state.tagline : undefined;
  const mainMessage =
    state.mainMessage.trim().length > 0 ? state.mainMessage : undefined;

  const brief: DesignBriefInput = {
    brandName: state.brandName,
    tagline,
    mainMessage,
    contentGoal: state.contentGoal,
    visualStyle: state.visualStyle,
    tone: state.tone,
    outputFormat: resolveOutputFormat(state.outputFormatName),
    variationCount: state.variationCount,
    accentPalette: state.accentPalette,
    mandatoryElements: state.mandatoryElements,
    uploadedAssets: state.uploadedAssets,
  };

  if (state.professionalMode) {
    brief.professionalMode = true;
    brief.professional = buildProfessionalFields(state);
  }

  return brief;
}

/** Toggle a mandatory element on/off in an immutable way. */
export function toggleMandatoryElement(
  current: MandatoryElement[],
  element: MandatoryElement,
): MandatoryElement[] {
  return current.includes(element)
    ? current.filter((e) => e !== element)
    : [...current, element];
}

/** Human-readable labels for output formats (UI display only). */
export const OUTPUT_FORMAT_LABELS: Record<OutputFormat["name"], string> = {
  InstagramFeed: "Instagram Feed (1080×1350)",
  Carousel: "Carousel (1080×1080)",
  StoryReel: "Story/Reel (1080×1920)",
  Square: "Square (1080×1080)",
  Landscape: "Landscape (1200×628)",
};

/** Human-readable labels for mandatory elements (UI display only). */
export const MANDATORY_ELEMENT_LABELS: Record<MandatoryElement, string> = {
  LogoStrip: "Logo Strip",
  CTAButton: "CTA Button",
  StatCards: "Stat Cards",
  QRCode: "QR Code",
  BadgeFloating: "Badge Floating",
  ProgressBar: "Progress Bar",
};

/** Human-readable labels for Design_Purpose options (UI display only). Req 2.2 */
export const DESIGN_PURPOSE_LABELS: Record<DesignPurpose, string> = {
  Marketing_Conversion: "Marketing / Conversion",
  Branding_Awareness: "Branding / Awareness",
  Education: "Education",
  Engagement: "Engagement",
};
