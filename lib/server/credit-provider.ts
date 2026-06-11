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
  InMemoryCreditRepository,
  type CreditRepository,
  type Reservation,
} from "@/lib/credit/credit-manager";

// ---------------------------------------------------------------------------
// Unlimited Credit Repository — always reports infinite balance, never rejects
// ---------------------------------------------------------------------------

class UnlimitedCreditRepository implements CreditRepository {
  private seq = 0;

  async getBalance(_userId: string): Promise<number> {
    return 999999;
  }

  async addCredits(_userId: string, _amount: number): Promise<void> {
    // no-op — balance is always unlimited
  }

  async hold(userId: string, amount: number): Promise<Reservation | undefined> {
    // Always succeed — unlimited credits
    return {
      id: `res_unlimited_${++this.seq}`,
      userId,
      amount: Math.max(1, Math.floor(amount)),
      status: "held",
    };
  }

  async commitReservation(_reservationId: string): Promise<void> {
    // no-op
  }

  async commitPartialReservation(
    _reservationId: string,
    _commitAmount: number,
  ): Promise<void> {
    // no-op
  }

  async refundReservation(_reservationId: string): Promise<void> {
    // no-op
  }
}

let creditManager: CreditManager | undefined;
let creditRepo: CreditRepository | undefined;

/**
 * Resolve the credit manager — uses UnlimitedCreditRepository so credits are
 * effectively infinite. No generation will ever be rejected for insufficient
 * balance.
 */
export function getCreditManager(): CreditManager {
  if (!creditManager) {
    creditRepo = new UnlimitedCreditRepository();
    creditManager = new CreditManager(creditRepo);
  }
  return creditManager;
}

/**
 * Resolve the shared {@link CreditRepository} underlying the credit manager,
 * building the default in-memory manager on first use. `container.ts` passes
 * this into `createInMemoryPipelineWorker({ creditRepo })` so the worker and the
 * credits route observe the same balances (single source of truth).
 */
export function getCreditRepository(): CreditRepository {
  if (!creditRepo) {
    // Building the manager populates the shared repo.
    getCreditManager();
  }
  // `getCreditManager` guarantees `creditRepo` is set.
  return creditRepo as CreditRepository;
}

/**
 * Override the credit manager (used by production wiring and tests). When a
 * custom manager is injected the shared in-memory repo no longer applies, so it
 * is cleared; `getCreditRepository` will rebuild a default repo on demand.
 */
export function setCreditManager(manager: CreditManager): void {
  creditManager = manager;
  creditRepo = undefined;
}

/** Reset the seam (test helper) so the next access rebuilds the default. */
export function resetCreditManager(): void {
  creditManager = undefined;
  creditRepo = undefined;
}
