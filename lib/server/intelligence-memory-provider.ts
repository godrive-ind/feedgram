/**
 * Server-side Intelligence_Memory provider (mockable seam) — task 11.2 support.
 *
 * The Design_DNA initialisation step seeds future generations from prior
 * learning (`seedDesignDnaFromMemory`, Req 9.2) and the pipeline records design
 * outcomes back into memory (Req 9.1). Both need a shared
 * {@link IntelligenceMemoryStore} so that — within a single serverless
 * instance — entries persisted by one request are visible to later requests in
 * the SAME context. Consistent with the injectable-seam pattern used by sibling
 * providers (`history-provider.ts`'s `setHistoryManager`, the variations
 * route's `setVariationStore`), this module exposes an injectable provider over
 * a process-wide singleton.
 *
 * Production wiring note:
 *   The design targets a Prisma-backed store (`PrismaIntelligenceMemoryStore`
 *   in `lib/intelligence/prisma-intelligence-memory.ts`, task 18.2) that is a
 *   structural drop-in. Because the Prisma client is not generated / connected
 *   in this environment, the DEFAULT store here uses the established in-memory
 *   implementation ({@link InMemoryIntelligenceMemoryStore}) so callers run and
 *   are testable. Swapping to the Prisma-backed store is a one-line change here
 *   that does NOT touch any caller, e.g.:
 *     import { PrismaIntelligenceMemoryStore } from "@/lib/intelligence/prisma-intelligence-memory";
 *     setIntelligenceMemory(new PrismaIntelligenceMemoryStore(db));
 *
 * The store is a module-level singleton so that learned outcomes survive across
 * requests within an instance (Req 9.1, 9.2).
 */

import {
  IntelligenceMemoryStore,
  InMemoryIntelligenceMemoryStore,
} from "@/lib/intelligence/intelligence-memory";

let intelligenceMemorySingleton: IntelligenceMemoryStore | undefined;

/**
 * Resolve the process-wide {@link IntelligenceMemoryStore}, lazily building an
 * in-memory default on first use. Production wiring (Prisma-backed) substitutes
 * a real store via {@link setIntelligenceMemory} without changing callers.
 */
export function getIntelligenceMemory(): IntelligenceMemoryStore {
  if (!intelligenceMemorySingleton) {
    intelligenceMemorySingleton = new InMemoryIntelligenceMemoryStore();
  }
  return intelligenceMemorySingleton;
}

/** Inject a specific memory store (tests and alternative wirings). */
export function setIntelligenceMemory(store: IntelligenceMemoryStore): void {
  intelligenceMemorySingleton = store;
}

/** Reset the seam (test helper) so the next access rebuilds the default. */
export function resetIntelligenceMemory(): void {
  intelligenceMemorySingleton = undefined;
}
