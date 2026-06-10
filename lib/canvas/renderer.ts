/**
 * Canvas_Renderer (Layer 4) — composition & render core.
 *
 * This module holds the PURE, testable composition logic that turns a
 * `VariationSpec` (brandDna + designSystem + copy + layout + imageAsset) into a
 * `DesignVariation` with its layout/slots, included mandatory elements, and a
 * rendered-canvas descriptor. The actual Fabric.js drawing is abstracted behind
 * an injectable adapter (`VariationRenderAdapter`) so the composition logic can
 * be unit/property tested in Node (Vitest) without a DOM.
 *
 * For the MVP the design specifies CLIENT-SIDE Fabric.js rendering. A thin
 * Fabric-backed adapter (`createFabricRenderAdapter`) is provided but takes the
 * `fabric` module as an injected dependency, so this module never hard-depends
 * on the browser/Fabric runtime at import time (keeps Node typecheck/tests
 * clean). Callers in browser-only code paths supply `fabric` and an element
 * factory.
 *
 * Exposes:
 * - `composeVariation(spec)`            — Req 3.3
 * - `renderBatch(batch, adapter?)`      — Req 4.1 (<=20 variations)
 * - `ensureMandatoryElements(batch, elements)` — Req 5.4 (100% coverage)
 *
 * See design "Components and Interfaces → Canvas_Renderer".
 *
 * Requirements: 3.3, 4.1, 5.4
 */

import type {
  CanvasRef,
  DesignVariation,
  GenerationBatch,
  LayoutSlot,
  MandatoryElement,
  VariationSpec,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of variations a single batch preview may render at once.
 * Req 4.1 — display all variations up to the maximum batch size of 20.
 */
export const MAX_BATCH_VARIATIONS = 20;

/** Default output image format for rendered canvases. */
const DEFAULT_RENDER_FORMAT = "png";

// ---------------------------------------------------------------------------
// Adapter seam — injectable so composition is testable without a DOM/Fabric
// ---------------------------------------------------------------------------

/**
 * Renders a single composed variation into a concrete `CanvasRef` (e.g. a
 * Fabric.js-produced data URL). Implementations are injected so the pure
 * composition logic can run in Node without a browser.
 */
export interface VariationRenderAdapter {
  /** Produce a rendered canvas reference for the given variation. */
  renderVariation(variation: DesignVariation): CanvasRef;
}

/**
 * Default, dependency-free adapter used when no Fabric/browser runtime is
 * available (Node tests, server). It produces a deterministic descriptor-only
 * `CanvasRef` (correct dimensions, no pixel data) so composition + batch flow
 * can be exercised end-to-end without a DOM.
 */
export const descriptorRenderAdapter: VariationRenderAdapter = {
  renderVariation(variation: DesignVariation): CanvasRef {
    const { width, height } = variation.layout.format;
    return {
      url: descriptorDataUri(variation),
      width,
      height,
      format: DEFAULT_RENDER_FORMAT,
    };
  },
};

// ---------------------------------------------------------------------------
// composeVariation — Req 3.3
// ---------------------------------------------------------------------------

/** Options for `composeVariation`. */
export interface ComposeOptions {
  /**
   * Explicit variation id. When omitted a deterministic id is derived from the
   * spec contents so composition stays pure (no random/Date).
   */
  id?: string;
}

/**
 * Compose a single `DesignVariation` from a `VariationSpec`.
 *
 * Pure: builds the variation's layout/slots, the set of included mandatory
 * elements (taken from the chosen layout), and an initial rendered-canvas
 * descriptor sized to the layout's output format. No drawing happens here — the
 * concrete pixel render is produced later by an injected adapter in
 * `renderBatch`. (Req 3.3)
 */
export function composeVariation(
  spec: VariationSpec,
  options: ComposeOptions = {},
): DesignVariation {
  const { batchId, brandDna, designSystem, copy, layout, imageAsset } = spec;
  const { width, height } = layout.format;

  const id = options.id ?? deriveVariationId(spec);

  // Initial descriptor — dimensions match the output format; url is empty
  // until a render adapter fills it (renderBatch). Req 3.3
  const renderedCanvas: CanvasRef = {
    url: "",
    width,
    height,
    format: DEFAULT_RENDER_FORMAT,
  };

  return {
    id,
    batchId,
    brandDna,
    designSystem,
    copy,
    layout,
    imageAsset,
    renderedCanvas,
  };
}

// ---------------------------------------------------------------------------
// renderBatch — Req 4.1
// ---------------------------------------------------------------------------

/**
 * Render every variation in a batch, refreshing each variation's
 * `renderedCanvas` reference via the injected adapter.
 *
 * Handles up to `MAX_BATCH_VARIATIONS` (20) variations (Req 4.1); a batch with
 * more variations than that is rejected to protect the preview budget.
 *
 * Returns a new `GenerationBatch` with refreshed variations (non-mutating) so
 * the result can be diffed/asserted. Defaults to the dependency-free
 * descriptor adapter so it is safe to call in Node; supply
 * `createFabricRenderAdapter(...)` in the browser for real pixel output.
 */
export function renderBatch(
  batch: GenerationBatch,
  adapter: VariationRenderAdapter = descriptorRenderAdapter,
): GenerationBatch {
  if (batch.variations.length > MAX_BATCH_VARIATIONS) {
    throw new RangeError(
      `Batch berisi ${batch.variations.length} variasi; maksimum ${MAX_BATCH_VARIATIONS} variasi dapat dirender.`,
    );
  }

  const variations = batch.variations.map((variation) => ({
    ...variation,
    renderedCanvas: adapter.renderVariation(variation),
  }));

  return { ...batch, variations };
}

// ---------------------------------------------------------------------------
// ensureMandatoryElements — Req 5.4
// ---------------------------------------------------------------------------

/**
 * Return `true` only if EVERY variation in the batch includes EVERY selected
 * mandatory element (100% coverage). Used by the consistency checks. (Req 5.4)
 *
 * An empty `elements` list is trivially satisfied. A coverage check on an empty
 * batch returns `false` when elements are required, since "100% of variations"
 * cannot include an element if there are no variations.
 */
export function ensureMandatoryElements(
  batch: GenerationBatch,
  elements: MandatoryElement[],
): boolean {
  const required = unique(elements);
  if (required.length === 0) return true;
  if (batch.variations.length === 0) return false;

  return batch.variations.every((variation) => {
    const included = new Set<MandatoryElement>(
      variation.layout.includedElements,
    );
    return required.every((element) => included.has(element));
  });
}

// ---------------------------------------------------------------------------
// Fabric.js-backed adapter (browser only, dependency injected)
// ---------------------------------------------------------------------------

/**
 * Minimal structural subset of the Fabric.js canvas instance this module uses.
 * Declared structurally so we never import `fabric` at module load time.
 */
export interface FabricCanvasLike {
  add(...objects: unknown[]): unknown;
  renderAll(): unknown;
  toDataURL(options?: {
    format?: string;
    multiplier?: number;
    quality?: number;
  }): string;
  clear?(): unknown;
}

/**
 * Minimal structural subset of the `fabric` module this module uses. Browser
 * code injects the real `fabric` namespace; tests can inject a fake.
 */
export interface FabricLike {
  StaticCanvas: new (
    element: unknown,
    options?: { width?: number; height?: number },
  ) => FabricCanvasLike;
  Rect: new (options: Record<string, unknown>) => unknown;
  Textbox: new (text: string, options: Record<string, unknown>) => unknown;
}

/** Factory that supplies a drawing surface (a canvas element) for Fabric. */
export type CanvasElementFactory = (
  width: number,
  height: number,
) => unknown;

/** Options for {@link createFabricRenderAdapter}. */
export interface FabricAdapterOptions {
  /**
   * Supplies the backing canvas element. Defaults to creating a DOM
   * `<canvas>` element (browser only).
   */
  createElement?: CanvasElementFactory;
  /** Export multiplier (e.g. 2 for retina). Defaults to 1. */
  multiplier?: number;
}

/** Returns true when a DOM (and thus client-side Fabric) is available. */
export function isFabricRenderingAvailable(): boolean {
  return typeof document !== "undefined";
}

/**
 * Create a Fabric.js-backed render adapter.
 *
 * The `fabric` module is INJECTED rather than imported here, so this module
 * carries no hard dependency on Fabric/the browser at import time. Intended for
 * client-side use; pass the real `fabric` namespace and (optionally) an element
 * factory. In Node/tests, prefer {@link descriptorRenderAdapter}.
 */
export function createFabricRenderAdapter(
  fabric: FabricLike,
  options: FabricAdapterOptions = {},
): VariationRenderAdapter {
  const multiplier = options.multiplier ?? 1;
  const createElement =
    options.createElement ??
    ((width: number, height: number): unknown => {
      if (!isFabricRenderingAvailable()) {
        throw new Error(
          "createFabricRenderAdapter membutuhkan DOM. Sediakan createElement saat di luar browser.",
        );
      }
      const el = document.createElement("canvas");
      el.width = width;
      el.height = height;
      return el;
    });

  return {
    renderVariation(variation: DesignVariation): CanvasRef {
      const { width, height } = variation.layout.format;
      const element = createElement(width, height);
      const canvas = new fabric.StaticCanvas(element, { width, height });

      paintVariation(fabric, canvas, variation);
      canvas.renderAll();

      const url = canvas.toDataURL({
        format: DEFAULT_RENDER_FORMAT,
        multiplier,
      });

      return { url, width, height, format: DEFAULT_RENDER_FORMAT };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Paint a variation's background, layout slots, and mandatory elements onto a
 * Fabric canvas. Kept private; only used by the Fabric adapter in the browser.
 */
function paintVariation(
  fabric: FabricLike,
  canvas: FabricCanvasLike,
  variation: DesignVariation,
): void {
  const { brandDna, designSystem, copy, layout } = variation;
  const { width, height } = layout.format;
  const palette = brandDna.accentPalette;
  const background = palette[0] ?? "#ffffff";
  const accent = palette[1] ?? palette[0] ?? "#000000";

  // Background
  canvas.add(
    new fabric.Rect({
      left: 0,
      top: 0,
      width,
      height,
      fill: background,
      selectable: false,
    }),
  );

  // Layout slots
  for (const slot of layout.slots) {
    canvas.add(slotObject(fabric, slot, { copy, designSystem, accent }));
  }

  // Mandatory elements — one labeled marker per included element so that the
  // rendered output visibly contains every selected element (Req 5.4).
  layout.includedElements.forEach((element, index) => {
    canvas.add(
      new fabric.Rect({
        left: 16,
        top: 16 + index * (designSystem.radius + 32),
        width: 160,
        height: 28,
        rx: designSystem.radius,
        ry: designSystem.radius,
        fill: accent,
        selectable: false,
        data: { mandatoryElement: element },
      }),
    );
    canvas.add(
      new fabric.Textbox(elementLabel(element), {
        left: 24,
        top: 20 + index * (designSystem.radius + 32),
        fontFamily: designSystem.bodyFont,
        fontSize: 14,
        fill: background,
        selectable: false,
      }),
    );
  });
}

/** Build a Fabric object for a single layout slot. */
function slotObject(
  fabric: FabricLike,
  slot: LayoutSlot,
  ctx: {
    copy: DesignVariation["copy"];
    designSystem: DesignVariation["designSystem"];
    accent: string;
  },
): unknown {
  if (slot.type === "text") {
    return new fabric.Textbox(ctx.copy.headline, {
      left: slot.x,
      top: slot.y,
      width: slot.w,
      fontFamily: ctx.designSystem.headlineFont,
      fontSize: ctx.designSystem.typographyScale[0] ?? 32,
      selectable: false,
    });
  }
  // image + element slots → rectangle placeholder sized to the slot.
  return new fabric.Rect({
    left: slot.x,
    top: slot.y,
    width: slot.w,
    height: slot.h,
    rx: ctx.designSystem.radius,
    ry: ctx.designSystem.radius,
    fill: slot.type === "image" ? "#cccccc" : ctx.accent,
    selectable: false,
  });
}

/** Human-readable label for a mandatory element marker. */
function elementLabel(element: MandatoryElement): string {
  return element;
}

/**
 * Derive a deterministic variation id from spec contents so `composeVariation`
 * stays pure (no random/time). Combines batch id, layout id, and a stable hash
 * of the composed content.
 */
function deriveVariationId(spec: VariationSpec): string {
  const seed = [
    spec.batchId,
    spec.layout.id,
    spec.brandDna.brandName,
    spec.copy.headline,
    spec.copy.cta,
    spec.imageAsset.id,
  ].join("|");
  return `${spec.batchId}-${spec.layout.id}-${hash(seed)}`;
}

/** Compact deterministic descriptor data URI for the descriptor adapter. */
function descriptorDataUri(variation: DesignVariation): string {
  const descriptor = {
    id: variation.id,
    format: variation.layout.format.name,
    width: variation.layout.format.width,
    height: variation.layout.format.height,
    elements: variation.layout.includedElements,
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(descriptor))}`;
}

/** Stable, non-cryptographic 32-bit string hash (FNV-1a) as base36. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Return the input array with duplicates removed, order preserved. */
function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

// ---------------------------------------------------------------------------
// CanvasRenderer aggregate (convenience object for API/UI imports)
// ---------------------------------------------------------------------------

/** Convenience object grouping the Canvas_Renderer composition functions. */
export const CanvasRenderer = {
  composeVariation,
  renderBatch,
  ensureMandatoryElements,
  createFabricRenderAdapter,
  descriptorRenderAdapter,
  isFabricRenderingAvailable,
  MAX_BATCH_VARIATIONS,
} as const;
