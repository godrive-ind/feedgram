/**
 * Pipeline_Engine — batch brand-consistency verification (Layer 2).
 *
 * After step 6 produces a `GenerationBatch`, every `DesignVariation` in the
 * batch MUST share the SAME brand identity before the batch can be marked
 * `done` (Req 5.6). This module verifies that contract and reports any
 * deviation so an inconsistent batch can be flagged while the variations that
 * were produced successfully are preserved untouched (Req 5.5).
 *
 * What "consistent" means (Req 5.1–5.4, 5.6):
 *   - Brand DNA core identical across variations (brandName, tagline, tone,
 *     visualStyle).
 *   - Accent palette identical across variations (same hex values, same order).
 *   - Headline font and body font identical across variations.
 *   - Every selected mandatory element appears in 100% of variations.
 *
 * The FIRST variation is taken as the reference brand (the brand the batch was
 * generated for); any later variation that deviates from it is recorded as a
 * violation naming the offending `variationId` and the specific `attribute`
 * (`brandDna` | `accentPalette` | `headlineFont` | `bodyFont` |
 * `mandatoryElement`). Brand DNA and accent palette are reported as distinct
 * attributes so a palette-only deviation never masquerades as a generic
 * brand-DNA violation.
 *
 * Pure: `verifyConsistency` derives a report from the batch and never mutates
 * it; `markBatchConsistency` returns a NEW batch with an updated `status`
 * (`done` when consistent, `inconsistent` otherwise) while reusing the original
 * variation objects unchanged (Req 5.5 — successful variations preserved).
 *
 * See design "Components and Interfaces → Pipeline_Engine" (`verifyConsistency`)
 * and Correctness Properties 17 & 18.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import { ensureMandatoryElements } from "@/lib/canvas/renderer";
import type {
  ConsistencyReport,
  DesignVariation,
  GenerationBatch,
  MandatoryElement,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link verifyConsistency} / {@link markBatchConsistency}. */
export interface VerifyConsistencyOptions {
  /**
   * The selected mandatory elements that MUST appear in 100% of variations
   * (Req 5.4). When omitted, the reference (first) variation's
   * `layout.includedElements` is used as the expected set.
   */
  mandatoryElements?: MandatoryElement[];
}

// ---------------------------------------------------------------------------
// verifyConsistency — Req 5.1, 5.2, 5.3, 5.4, 5.6
// ---------------------------------------------------------------------------

/**
 * Verify that every variation in `batch` shares the same Brand DNA, accent
 * palette, headline/body fonts, and includes every selected mandatory element.
 *
 * Returns a {@link ConsistencyReport}. `consistent` is `true` only when there
 * are zero violations. Each violation names the offending `variationId` and the
 * deviating `attribute` (Req 5.5). An empty batch is trivially consistent.
 *
 * Pure: never mutates `batch`.
 */
export function verifyConsistency(
  batch: GenerationBatch,
  options: VerifyConsistencyOptions = {},
): ConsistencyReport {
  const violations: ConsistencyReport["violations"] = [];
  const variations = batch.variations;

  // An empty batch (or a single variation) has nothing to deviate against the
  // brand attributes; only the mandatory-element coverage check applies.
  const reference = variations[0];

  // Required mandatory elements: caller-provided set, else the reference's.
  const requiredElements = unique(
    options.mandatoryElements ?? reference?.layout.includedElements ?? [],
  );

  if (reference) {
    const refBrandCore = brandCore(reference);
    const refPalette = serialize(reference.brandDna.accentPalette);
    const refHeadline = reference.designSystem.headlineFont;
    const refBody = reference.designSystem.bodyFont;

    for (const variation of variations) {
      // Brand DNA core (excluding palette, reported as its own attribute).
      if (serialize(brandCore(variation)) !== serialize(refBrandCore)) {
        violations.push({
          variationId: variation.id,
          attribute: "brandDna",
          detail: `Brand DNA variasi ${variation.id} berbeda dari brand referensi`,
        });
      }

      // Accent palette — same hex values in the same order (Req 5.2).
      if (serialize(variation.brandDna.accentPalette) !== refPalette) {
        violations.push({
          variationId: variation.id,
          attribute: "accentPalette",
          detail: `Palet warna aksen variasi ${variation.id} berbeda dari referensi`,
        });
      }

      // Headline font identical (Req 5.3).
      if (variation.designSystem.headlineFont !== refHeadline) {
        violations.push({
          variationId: variation.id,
          attribute: "headlineFont",
          detail: `Font headline variasi ${variation.id} (${variation.designSystem.headlineFont}) berbeda dari referensi (${refHeadline})`,
        });
      }

      // Body font identical (Req 5.3).
      if (variation.designSystem.bodyFont !== refBody) {
        violations.push({
          variationId: variation.id,
          attribute: "bodyFont",
          detail: `Font body variasi ${variation.id} (${variation.designSystem.bodyFont}) berbeda dari referensi (${refBody})`,
        });
      }

      // Mandatory-element coverage per variation (Req 5.4).
      const included = new Set<MandatoryElement>(
        variation.layout.includedElements,
      );
      for (const element of requiredElements) {
        if (!included.has(element)) {
          violations.push({
            variationId: variation.id,
            attribute: "mandatoryElement",
            detail: `Variasi ${variation.id} tidak memuat elemen wajib ${element}`,
          });
        }
      }
    }
  }

  return {
    consistent: violations.length === 0,
    violations,
  };
}

// ---------------------------------------------------------------------------
// markBatchConsistency — Req 5.5, 5.6
// ---------------------------------------------------------------------------

/**
 * Run {@link verifyConsistency} and produce the finalized batch status.
 *
 * - Consistent → returns a NEW batch with `status: "done"` (Req 5.6).
 * - Inconsistent → returns a NEW batch with `status: "inconsistent"` (Req 5.5).
 *
 * In BOTH cases the original variation objects are reused unchanged — the
 * successfully produced variations are preserved (Req 5.5). The input batch is
 * never mutated.
 */
export function markBatchConsistency(
  batch: GenerationBatch,
  options: VerifyConsistencyOptions = {},
): { batch: GenerationBatch; report: ConsistencyReport } {
  const report = verifyConsistency(batch, options);
  const status: GenerationBatch["status"] = report.consistent
    ? "done"
    : "inconsistent";

  return {
    // Preserve the variations untouched; only the status transitions.
    batch: { ...batch, status, variations: batch.variations },
    report,
  };
}

// ---------------------------------------------------------------------------
// Convenience re-export
// ---------------------------------------------------------------------------

/**
 * Re-export the 100%-coverage helper so callers can perform a quick boolean
 * mandatory-element check without building a full report (Req 5.4).
 */
export { ensureMandatoryElements };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The brand-identity fields compared as the "brandDna" attribute (no palette). */
function brandCore(variation: DesignVariation): {
  brandName: string;
  tagline: string | undefined;
  tone: string;
  visualStyle: string;
} {
  const { brandName, tagline, tone, visualStyle } = variation.brandDna;
  return { brandName, tagline, tone, visualStyle };
}

/** Stable structural serialization for deep-equality comparison of JSON data. */
function serialize(value: unknown): string {
  return JSON.stringify(value);
}

/** Return the input array with duplicates removed, order preserved. */
function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

// ---------------------------------------------------------------------------
// Convenience aggregate
// ---------------------------------------------------------------------------

/** Convenience object grouping the consistency-verification functions. */
export const PipelineConsistency = {
  verifyConsistency,
  markBatchConsistency,
  ensureMandatoryElements,
} as const;
