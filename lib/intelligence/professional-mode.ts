/**
 * Professional_Mode threading (Design Intelligence layer) — pure gating logic.
 *
 * Professional_Mode is a boolean flag threaded from the brief → job → worker →
 * pipeline state. This module exposes the default value and a resolver that
 * reads the flag from a brief, falling back to the default when absent.
 *
 * Pure logic only — no I/O. See design "Components and Interfaces →
 * Professional_Mode threading".
 *
 * Requirements: 1.1, 1.4
 */

import type { DesignBriefInput } from "../types";

/** Default Professional_Mode is disabled (Assumption A9, Req 1.4). */
export const PROFESSIONAL_MODE_DEFAULT = false;

/**
 * Resolve the Professional_Mode flag from a brief.
 *
 * Returns the brief's explicit value when present, otherwise falls back to the
 * disabled default (Req 1.4).
 */
export function resolveProfessionalMode(brief: DesignBriefInput): boolean {
  return brief.professionalMode ?? PROFESSIONAL_MODE_DEFAULT;
}
