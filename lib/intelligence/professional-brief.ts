/**
 * Enhanced Brief_Intake — pure validation logic for the professional brief.
 *
 * Implements `validateProfessionalBrief`, the conditional validation layer that
 * runs ONLY when `professionalMode === true`. It enforces the enhanced brief
 * rules without touching the existing base `validateBrief`:
 * - core message limited to a maximum of 7 words (Req 2.3, 2.4);
 * - `designPurpose`, `primaryGoal`, and `coreMessage` are required (Req 2.5, 2.6);
 * - every other field value is preserved unchanged via `preservedValues`
 *   (Req 2.4, 2.6).
 *
 * Optional reference-asset upload validation is delegated to the existing
 * `validateUpload` (PNG/JPG/JPEG, ≤10 MB, ≤10 files) so there is a single
 * source of truth for upload rules (Req 2.7).
 *
 * The Design_Purpose enum (`DESIGN_PURPOSES` / `DesignPurpose`) and
 * `ProfessionalBriefFields` are already declared in `lib/types.ts`; they are
 * re-exported here for ergonomic imports rather than duplicated.
 *
 * Pure logic only — no I/O. See design "Components and Interfaces →
 * Enhanced Brief_Intake".
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */

import {
  DESIGN_PURPOSES,
  type DesignBriefInput,
  type DesignPurpose,
  type FieldError,
  type ProfessionalBriefFields,
  type UploadedFile,
  type UploadValidationResult,
  type ValidationResult,
} from "@/lib/types";
import { validateUpload } from "@/lib/intake/upload-validation";

// ---------------------------------------------------------------------------
// Constants & re-exports (Req 2.2, 2.3)
// ---------------------------------------------------------------------------

/** Maximum number of words allowed in the core message. Req 2.3 */
export const CORE_MESSAGE_MAX_WORDS = 7;

// Re-export the shared enum + types so callers can import everything related to
// the professional brief from this module (no duplication — single source of
// truth lives in `lib/types.ts`).
export { DESIGN_PURPOSES };
export type { DesignPurpose, ProfessionalBriefFields };

// ---------------------------------------------------------------------------
// countWords — whitespace-collapsed word count (Req 2.3, 2.4)
// ---------------------------------------------------------------------------

/**
 * Count non-empty, whitespace-collapsed words in `text`.
 *
 * Leading/trailing whitespace is ignored and any run of whitespace counts as a
 * single separator, so `"  hello   world  "` yields `2`. An empty or
 * whitespace-only string yields `0`.
 */
export function countWords(text: string): number {
  if (typeof text !== "string") return 0;
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A string field is "missing" when absent or whitespace-only. */
function isBlank(value: string | undefined | null): boolean {
  return value === undefined || value === null || value.trim().length === 0;
}

/** True when `purpose` is one of the valid Design_Purpose values. Req 2.2 */
function isValidDesignPurpose(
  purpose: string | undefined | null,
): purpose is DesignPurpose {
  return (
    typeof purpose === "string" &&
    (DESIGN_PURPOSES as readonly string[]).includes(purpose)
  );
}

// ---------------------------------------------------------------------------
// validateProfessionalBrief — Req 2.1, 2.3, 2.4, 2.5, 2.6
// ---------------------------------------------------------------------------

/**
 * Validate the professional brief fields layered on top of the base brief.
 *
 * Active ONLY when `brief.professionalMode === true` (Req 2.1). When
 * Professional_Mode is OFF the professional fields are not inspected and the
 * brief is considered valid by this layer (the base `validateBrief` still
 * applies independently).
 *
 * When active it collects ALL field errors (does not stop at the first):
 * - `coreMessage` exceeding {@link CORE_MESSAGE_MAX_WORDS} words is rejected
 *   with a message naming the 7-word limit (Req 2.3, 2.4);
 * - the required fields `designPurpose`, `primaryGoal`, and `coreMessage` are
 *   rejected when empty/blank, with a message naming the missing field
 *   (Req 2.5, 2.6); `designPurpose` must also be one of the valid options
 *   (Req 2.2).
 *
 * Regardless of outcome, every field value is returned unchanged in
 * `preservedValues` so the UI can keep what the user already entered (Req 2.4,
 * 2.6).
 */
export function validateProfessionalBrief(
  brief: DesignBriefInput,
): ValidationResult {
  const errors: FieldError[] = [];

  // Req 2.1 — professional validation is conditional on Professional_Mode.
  if (brief.professionalMode !== true) {
    return { valid: true, errors, preservedValues: brief };
  }

  const professional = brief.professional;

  // Req 2.5, 2.6 — designPurpose is required and must be a valid option.
  if (professional === undefined || isBlank(professional.designPurpose)) {
    errors.push({
      field: "professional.designPurpose",
      message: "Design Purpose wajib diisi",
    });
  } else if (!isValidDesignPurpose(professional.designPurpose)) {
    // Req 2.2 — value outside the allowed Design_Purpose set.
    errors.push({
      field: "professional.designPurpose",
      message: `Design Purpose harus salah satu dari: ${DESIGN_PURPOSES.join(
        ", ",
      )}`,
    });
  }

  // Req 2.5, 2.6 — primaryGoal is required.
  if (professional === undefined || isBlank(professional.primaryGoal)) {
    errors.push({
      field: "professional.primaryGoal",
      message: "Primary goal wajib diisi",
    });
  }

  // Req 2.5, 2.6 — coreMessage is required.
  if (professional === undefined || isBlank(professional.coreMessage)) {
    errors.push({
      field: "professional.coreMessage",
      message: "Core message wajib diisi",
    });
  } else if (countWords(professional.coreMessage) > CORE_MESSAGE_MAX_WORDS) {
    // Req 2.3, 2.4 — core message exceeds the 7-word limit.
    errors.push({
      field: "professional.coreMessage",
      message: `Core message maksimum ${CORE_MESSAGE_MAX_WORDS} kata`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    // Req 2.4, 2.6 — preserve every field value exactly as provided, unchanged.
    preservedValues: brief,
  };
}

// ---------------------------------------------------------------------------
// validateReferenceUploads — delegate to existing upload rules (Req 2.7)
// ---------------------------------------------------------------------------

/**
 * Validate optional reference-asset uploads for the professional brief by
 * delegating to the existing {@link validateUpload} (PNG/JPG/JPEG, ≤10 MB per
 * file, ≤10 files per session). Re-exposed here so the professional brief layer
 * has a single, named entry point while keeping one source of truth for the
 * upload rules. Req 2.7
 */
export function validateReferenceUploads(
  files: UploadedFile[],
): UploadValidationResult {
  return validateUpload(files);
}
