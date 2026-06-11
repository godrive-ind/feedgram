/**
 * Variation store seam (task 11.4 support).
 *
 * `POST /api/variations/[id]` needs to (1) resolve a {@link DesignVariation} by
 * its id and (2) know which user owns it (the owning user of the variation's
 * batch) so per-user ownership can be enforced before regenerate/fine-tune.
 *
 * The shared worker/job store (`lib/server/container.ts`) does NOT expose a
 * direct variation lookup, and there is no production variation persistence yet
 * (the Prisma `DesignVariation` model is defined but the client is not
 * generated/connected in this environment). So, consistent with the
 * injectable-seam pattern used by sibling routes (e.g. the credits route's
 * `setCreditManager`), this module provides:
 *
 *   - a small {@link VariationStore} interface (lookup + replace),
 *   - a default in-memory implementation ({@link InMemoryVariationStore}),
 *   - an injectable provider ({@link getVariationStore} / {@link setVariationStore}
 *     / {@link resetVariationStore}) so the route is testable and a
 *     Prisma-backed store can be dropped in later WITHOUT touching the handler.
 *
 * Ownership model: a variation belongs to a `GenerationBatch`, and a batch has a
 * `userId`. The store therefore records the owning user id alongside each
 * variation and returns it from {@link VariationStore.getVariation} so the route
 * can call `authorizeOwnership(authUserId, ownerUserId)`.
 *
 * Requirements: 4.6, 4.7, 7.6, 7.9 (route support).
 */

import type { DesignVariation } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A variation paired with the id of the user that owns its batch. */
export interface OwnedVariation {
  variation: DesignVariation;
  /** The owning user (the `userId` of the variation's `GenerationBatch`). */
  ownerUserId: string;
}

/**
 * Persistence boundary for design variations used by the variations route.
 *
 * Kept intentionally small: the route only needs to look a variation up (to
 * authorize + derive from it) and to persist the new variation produced by a
 * successful regenerate/fine-tune.
 */
export interface VariationStore {
  /**
   * Resolve a variation and its owning user by id, or `undefined` when no such
   * variation exists. The route collapses "unknown" and "not owned" into a
   * single 404 so it never leaks the existence of another user's variation.
   */
  getVariation(variationId: string): Promise<OwnedVariation | undefined>;
  /**
   * Persist a (new) variation under the given owner. Used to store the result
   * of a successful regenerate/fine-tune so it can later be looked up too.
   */
  saveVariation(variation: DesignVariation, ownerUserId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + local wiring)
// ---------------------------------------------------------------------------

/** Deep-ish clone so callers cannot mutate the stored variation in place. */
function cloneVariation(variation: DesignVariation): DesignVariation {
  return {
    ...variation,
    brandDna: {
      ...variation.brandDna,
      accentPalette: [...variation.brandDna.accentPalette],
    },
    designSystem: {
      ...variation.designSystem,
      typographyScale: [...variation.designSystem.typographyScale],
      brandElementPosition: { ...variation.designSystem.brandElementPosition },
    },
    copy: { ...variation.copy },
    layout: {
      ...variation.layout,
      format: { ...variation.layout.format },
      slots: variation.layout.slots.map((s) => ({ ...s })),
      includedElements: [...variation.layout.includedElements],
    },
    imageAsset: { ...variation.imageAsset },
    renderedCanvas: { ...variation.renderedCanvas },
  };
}

/** In-memory {@link VariationStore} backed by a `Map`. */
export class InMemoryVariationStore implements VariationStore {
  private readonly byId = new Map<string, OwnedVariation>();

  constructor(seed: readonly OwnedVariation[] = []) {
    for (const owned of seed) {
      this.byId.set(owned.variation.id, {
        variation: cloneVariation(owned.variation),
        ownerUserId: owned.ownerUserId,
      });
    }
  }

  async getVariation(variationId: string): Promise<OwnedVariation | undefined> {
    const owned = this.byId.get(variationId);
    if (!owned) return undefined;
    return {
      variation: cloneVariation(owned.variation),
      ownerUserId: owned.ownerUserId,
    };
  }

  async saveVariation(
    variation: DesignVariation,
    ownerUserId: string,
  ): Promise<void> {
    this.byId.set(variation.id, {
      variation: cloneVariation(variation),
      ownerUserId,
    });
  }
}

// ---------------------------------------------------------------------------
// Injectable provider (mockable seam — globalThis for HMR survival)
// ---------------------------------------------------------------------------

const GLOBAL_KEY = "__fdg_variation_store__" as const;
const globalStore = globalThis as unknown as { [GLOBAL_KEY]?: VariationStore };

/**
 * Resolve the process-wide {@link VariationStore}, lazily building an empty
 * in-memory store on first use. Production wiring (Prisma-backed) substitutes a
 * real store via {@link setVariationStore} without changing route handlers.
 */
export function getVariationStore(): VariationStore {
  if (!globalStore[GLOBAL_KEY]) {
    globalStore[GLOBAL_KEY] = new InMemoryVariationStore();
  }
  return globalStore[GLOBAL_KEY];
}

/** Inject a specific variation store (tests and alternative wirings). */
export function setVariationStore(store: VariationStore): void {
  globalStore[GLOBAL_KEY] = store;
}

/** Reset the store seam (test helper) so the next access rebuilds the default. */
export function resetVariationStore(): void {
  globalStore[GLOBAL_KEY] = undefined;
}
