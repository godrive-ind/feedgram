/**
 * Variation derivation operations (Layer 2) — `regenerateVariation` and
 * `fineTuneVariation`.
 *
 * These two operations take an existing `DesignVariation` and produce a NEW
 * variation derived from it:
 *
 *   - `regenerateVariation(source, opts)` — re-generates the image (with a fresh
 *     seed) and re-composes the variation while REUSING the source's Brand DNA,
 *     Design System, copy, and layout unchanged (Req 4.6). Only the rendered
 *     image differs.
 *   - `fineTuneVariation(source, feedback, opts)` — produces a new variation
 *     guided by user feedback. The feedback influences the IMAGE PROMPT only;
 *     the source's Brand DNA and Design System are carried over identically and
 *     are never altered by the feedback (Req 7.6).
 *
 * Brand preservation (Property 15): both operations keep `brandDna` and
 * `designSystem` identical to the source.
 *
 * Failure preservation (Property 16, Req 4.7/7.9): if the injected
 * `AIServiceConnector` throws, the operation does NOT mutate or lose the source.
 * Instead it returns a discriminated `DeriveResult` whose `ok: false` branch
 * carries the untouched source plus an error message, so callers can keep the
 * original variation and surface the failure. (These functions are pure and
 * never mutate their `source` argument, so the caller's object is also safe.)
 *
 * The `AIServiceConnector` is INJECTED so the operations are mockable and, given
 * a deterministic mock, fully deterministic — which the property tests (tasks
 * 4.16 and 4.17) rely on.
 *
 * See design "Components and Interfaces → Pipeline_Engine"
 * (`regenerateVariation` / `fineTuneVariation`) and Correctness Properties 15 & 16.
 *
 * Requirements: 4.6, 4.7, 7.6, 7.9
 */

import type {
  AIServiceConnector,
  ConnectorCallOptions,
} from "@/lib/ai/connector";
import { composeVariation } from "@/lib/canvas/renderer";
import { buildImagePrompt } from "@/lib/pipeline/steps";
import type { DesignVariation, ImagePrompt } from "@/lib/types";

// ---------------------------------------------------------------------------
// Result type — discriminated so brand/source preservation is explicit
// ---------------------------------------------------------------------------

/**
 * Outcome of a derive operation (`regenerateVariation` / `fineTuneVariation`).
 *
 * - `ok: true`  → the new derived `variation` (brand identical to source).
 * - `ok: false` → the operation failed; the UNCHANGED `source` is returned
 *   alongside a human-readable `message` so the caller keeps the original
 *   variation and can show the error (Property 16, Req 4.7/7.9).
 */
export type DeriveResult =
  | { ok: true; variation: DesignVariation }
  | { ok: false; source: DesignVariation; message: string };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Shared options for the derive operations. */
export interface DeriveOptions {
  /** Injected AI connector used to (re)generate the image. Mockable. */
  connector: AIServiceConnector;
  /**
   * Explicit id for the produced variation. When omitted a deterministic id is
   * derived from the source + seed/feedback so the operation stays pure.
   */
  id?: string;
  /**
   * Seed for the regenerated image. When omitted a deterministic seed is
   * derived from the source so regeneration differs from the source render but
   * is reproducible in tests.
   */
  seed?: number;
  /** Retry/timeout overrides forwarded to the connector call. */
  connectorOptions?: ConnectorCallOptions;
}

// ---------------------------------------------------------------------------
// regenerateVariation — Req 4.6, Property 15/16
// ---------------------------------------------------------------------------

/**
 * Regenerate a {@link DesignVariation}.
 *
 * Produces a NEW variation that reuses the source's `brandDna`, `designSystem`,
 * `copy`, and `layout` EXACTLY (Property 15) and keeps the same `batchId`; only
 * the image is regenerated (with a fresh seed) and the variation re-composed.
 *
 * On connector failure the source is preserved unchanged and an
 * `ok: false` result carrying the source is returned (Property 16, Req 4.7).
 */
export async function regenerateVariation(
  source: DesignVariation,
  opts: DeriveOptions,
): Promise<DeriveResult> {
  const seed = opts.seed ?? deriveSeed(`${source.id}|regen`);
  const basePrompt = buildImagePrompt(
    source.brandDna,
    source.designSystem,
    source.layout,
  );
  const imagePrompt: ImagePrompt = { ...basePrompt, seed };

  return deriveFrom(source, imagePrompt, opts, {
    id: opts.id ?? `${source.id}-regen-${seed}`,
    failureMessage: "Regenerasi variasi gagal",
  });
}

// ---------------------------------------------------------------------------
// fineTuneVariation — Req 7.6, Property 15/16
// ---------------------------------------------------------------------------

/**
 * Fine-tune a {@link DesignVariation} using user `feedback`.
 *
 * Produces a NEW variation derived from the source and the feedback. The
 * feedback influences the IMAGE PROMPT only (appended as a labeled marker); the
 * source's `brandDna` and `designSystem` are carried over identically and are
 * NOT changed by the feedback (Property 15). `copy`, `layout`, and `batchId`
 * are also preserved from the source.
 *
 * On connector failure the source is preserved unchanged and an
 * `ok: false` result carrying the source is returned (Property 16, Req 7.9).
 */
export async function fineTuneVariation(
  source: DesignVariation,
  feedback: string,
  opts: DeriveOptions,
): Promise<DeriveResult> {
  const seed = opts.seed ?? deriveSeed(`${source.id}|finetune|${feedback}`);
  const basePrompt = buildImagePrompt(
    source.brandDna,
    source.designSystem,
    source.layout,
  );

  // Feedback adjusts the prompt only — never the Brand DNA / Design System.
  const imagePrompt: ImagePrompt = {
    ...basePrompt,
    prompt: `${basePrompt.prompt}\n[FEEDBACK] ${feedback}`,
    seed,
  };

  return deriveFrom(source, imagePrompt, opts, {
    id: opts.id ?? `${source.id}-finetune-${seed}`,
    failureMessage: "Penyempurnaan (fine-tune) variasi gagal",
  });
}

// ---------------------------------------------------------------------------
// Shared derivation core
// ---------------------------------------------------------------------------

/**
 * Generate a fresh image from `imagePrompt` and re-compose a new variation that
 * reuses the source's brand/design/copy/layout (brand identical, Property 15).
 * Any connector error is caught and surfaced as an `ok: false` result that
 * preserves the untouched source (Property 16).
 */
async function deriveFrom(
  source: DesignVariation,
  imagePrompt: ImagePrompt,
  opts: DeriveOptions,
  meta: { id: string; failureMessage: string },
): Promise<DeriveResult> {
  try {
    const imageAsset = await opts.connector.generateImage(
      { imagePrompt, format: source.layout.format },
      opts.connectorOptions,
    );

    // Reuse the source's brand/design/copy/layout EXACTLY; keep same batchId.
    const variation = composeVariation(
      {
        batchId: source.batchId,
        brandDna: source.brandDna,
        designSystem: source.designSystem,
        copy: source.copy,
        layout: source.layout,
        imageAsset,
      },
      { id: meta.id },
    );

    // Carry over the existing rating, if any — a derived render keeps metadata.
    if (source.rating !== undefined) {
      return { ok: true, variation: { ...variation, rating: source.rating } };
    }
    return { ok: true, variation };
  } catch (error) {
    // Failure: preserve the source unchanged and report the error (Property 16).
    return {
      ok: false,
      source,
      message: `${meta.failureMessage}: ${errorMessage(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Deterministic non-negative integer seed from a string (FNV-1a). */
function deriveSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Convenience aggregate
// ---------------------------------------------------------------------------

/** Convenience object grouping the derive operations. */
export const VariationDerive = {
  regenerateVariation,
  fineTuneVariation,
} as const;
