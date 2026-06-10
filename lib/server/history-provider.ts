/**
 * Server-side History_Manager provider (mockable seam) — task 13.1 support.
 *
 * `app/api/history/route.ts` needs a shared {@link HistoryManager} so that, in
 * production, a batch persisted by the pipeline worker's `onBatch` sink (wired
 * in task 14.1) is visible to `GET /api/history`. Consistent with the
 * injectable-seam pattern used by sibling routes (the credits route's
 * `setCreditManager`, the variations route's `setVariationStore`), this module
 * provides an injectable provider over a process-wide singleton.
 *
 * Production wiring note:
 *   The design targets a Prisma-backed history repository (the
 *   `GenerationBatch` / `DesignBrief` / `DesignVariation` models already exist
 *   in `prisma/schema.prisma`). Because the Prisma client is not generated /
 *   connected in this environment, the DEFAULT manager here uses the
 *   established in-memory factory ({@link createInMemoryHistoryManager}) so the
 *   route runs and is testable. Swapping to a Prisma-backed repository is a
 *   drop-in change here that does NOT touch the route handler.
 *
 * The manager is a module-level singleton so that — within a single serverless
 * instance — session-retained batches (Req 7.7) and accepted-but-unpersisted
 * ratings (Req 7.5) survive across requests.
 */

import {
  HistoryManager,
  createInMemoryHistoryManager,
} from "@/lib/history/history-manager";

let historyManagerSingleton: HistoryManager | undefined;

/**
 * Resolve the process-wide {@link HistoryManager}, lazily building an in-memory
 * default on first use. Production wiring (Prisma-backed) substitutes a real
 * manager via {@link setHistoryManager} without changing route handlers.
 */
export function getHistoryManager(): HistoryManager {
  if (!historyManagerSingleton) {
    historyManagerSingleton = createInMemoryHistoryManager().manager;
  }
  return historyManagerSingleton;
}

/** Inject a specific history manager (tests and alternative wirings). */
export function setHistoryManager(manager: HistoryManager): void {
  historyManagerSingleton = manager;
}

/** Reset the seam (test helper) so the next access rebuilds the default. */
export function resetHistoryManager(): void {
  historyManagerSingleton = undefined;
}
