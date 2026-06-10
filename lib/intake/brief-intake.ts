/**
 * Brief_Intake (Layer 1) — pure validation logic for the design brief.
 *
 * Implements `validateBrief` (required-field & character-limit validation that
 * preserves input values unchanged) and `getOptions` (the enum option lists
 * consumed by the configurator UI and downstream tasks).
 *
 * Pure logic only — no I/O. See design "Components and Interfaces → Brief_Intake".
 *
 * Requirements: 1.1, 1.2, 1.3, 1.13, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9
 */

import {
  CONTENT_GOALS,
  VISUAL_STYLES,
  TONES,
  OUTPUT_FORMATS,
  VARIATION_COUNTS,
  MANDATORY_ELEMENTS,
  type BriefOptions,
  type DesignBriefInput,
  type FieldError,
  type ValidationResult,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Validation limits (Req 1.13)
// ---------------------------------------------------------------------------

/** Maximum character lengths for free-text brief fields. Req 1.13 */
export const BRIEF_FIELD_LIMITS = {
  brandName: 50,
  tagline: 100,
  mainMessage: 500,
} as const;

// ---------------------------------------------------------------------------
// validateBrief — Req 1.2, 1.3, 1.13
// ---------------------------------------------------------------------------

/**
 * Validate a design brief input.
 *
 * Collects ALL field errors (does not stop at the first one) and returns the
 * input values unchanged in `preservedValues` so the UI can keep what the user
 * already typed (Req 1.3).
 *
 * Rules:
 * - `brandName` is required: empty or whitespace-only is invalid (Req 1.2, 1.3).
 * - `brandName` ≤ 50, `tagline` ≤ 100, `mainMessage` ≤ 500 characters (Req 1.13).
 */
export function validateBrief(input: DesignBriefInput): ValidationResult {
  const errors: FieldError[] = [];

  // Req 1.2, 1.3 — brandName is required (reject empty/whitespace-only).
  if (input.brandName === undefined || input.brandName.trim().length === 0) {
    errors.push({
      field: "brandName",
      message: "Nama brand wajib diisi",
    });
  } else if (input.brandName.length > BRIEF_FIELD_LIMITS.brandName) {
    // Req 1.13 — brandName max 50 characters.
    errors.push({
      field: "brandName",
      message: `Nama brand maksimum ${BRIEF_FIELD_LIMITS.brandName} karakter`,
    });
  }

  // Req 1.13 — tagline max 100 characters (optional field).
  if (
    input.tagline !== undefined &&
    input.tagline.length > BRIEF_FIELD_LIMITS.tagline
  ) {
    errors.push({
      field: "tagline",
      message: `Tagline maksimum ${BRIEF_FIELD_LIMITS.tagline} karakter`,
    });
  }

  // Req 1.13 — mainMessage max 500 characters (optional field).
  if (
    input.mainMessage !== undefined &&
    input.mainMessage.length > BRIEF_FIELD_LIMITS.mainMessage
  ) {
    errors.push({
      field: "mainMessage",
      message: `Topik/pesan utama maksimum ${BRIEF_FIELD_LIMITS.mainMessage} karakter`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    // Req 1.3 — preserve every field value exactly as provided, unchanged.
    preservedValues: input,
  };
}

// ---------------------------------------------------------------------------
// getOptions — Req 1.4, 1.5, 1.6, 1.7, 1.8, 1.9
// ---------------------------------------------------------------------------

/**
 * Return the brief option lists (content goals, visual styles, tones, output
 * formats, variation counts, mandatory elements) consumed by the configurator
 * UI and downstream tasks.
 *
 * Requirements: 1.4, 1.5, 1.6, 1.7, 1.8, 1.9
 */
export function getOptions(): BriefOptions {
  return {
    contentGoals: CONTENT_GOALS, // Req 1.4
    visualStyles: VISUAL_STYLES, // Req 1.5
    tones: TONES, // Req 1.6
    outputFormats: OUTPUT_FORMATS, // Req 1.7
    variationCounts: VARIATION_COUNTS, // Req 1.8
    mandatoryElements: MANDATORY_ELEMENTS, // Req 1.9
  };
}

// ---------------------------------------------------------------------------
// BriefIntake aggregate (convenience object for API/UI imports)
// ---------------------------------------------------------------------------

/** Convenience object grouping the Brief_Intake pure-logic functions. */
export const BriefIntake = {
  validateBrief,
  getOptions,
} as const;
