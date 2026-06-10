/**
 * Server-side Credit_Manager provider (mockable seam).
 *
 * Extracted out of `app/api/credits/route.ts` because Next.js App Router route
 * modules may ONLY export route handlers (`GET`/`POST`/…) and a small set of
 * route-segment config fields (`runtime`, `dynamic`, `maxDuration`, …) — any
 * other export (e.g. a `setCreditManager` seam) fails the production build with
 * "is not a valid Route export field". Hosting the injectable seam here keeps
 * the route file build-valid while preserving the same testable wiring used by
 * sibling providers (`history-provider.ts`, `variation-store.ts`).
 *
 * Default: lazily builds an in-memory manager via the established factory.
 * Production wiring (Prisma-backed repository) substitutes a real manager via
 * {@link setCreditManager} without changing the route handler.
 */

import {
  CreditManager,
  createInMemoryCreditManager,
} from "@/lib/credit/credit-manager";

let creditManager: CreditManager | undefined;

/** Resolve the credit manager, lazily building an in-memory default. */
export function getCreditManager(): CreditManager {
  if (!creditManager) {
    creditManager = createInMemoryCreditManager().manager;
  }
  return creditManager;
}

/** Override the credit manager (used by production wiring and tests). */
export function setCreditManager(manager: CreditManager): void {
  creditManager = manager;
}

/** Reset the seam (test helper) so the next access rebuilds the default. */
export function resetCreditManager(): void {
  creditManager = undefined;
}
