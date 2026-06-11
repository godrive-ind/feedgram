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

// ---------------------------------------------------------------------------
// Singleton management (globalThis to survive HMR / module re-evaluation)
// ---------------------------------------------------------------------------

const GLOBAL_KEY_CREDIT_MGR = "__fdg_credit_manager__" as const;
const GLOBAL_KEY_CREDIT_REPO = "__fdg_credit_repo__" as const;

const globalStore = globalThis as unknown as {
  [GLOBAL_KEY_CREDIT_MGR]?: CreditManager;
  [GLOBAL_KEY_CREDIT_REPO]?: CreditRepository;
};

/**
 * Resolve the credit manager — uses UnlimitedCreditRepository so credits are
 * effectively infinite. No generation will ever be rejected for insufficient
 * balance.
 */
export function getCreditManager(): CreditManager {
  if (!globalStore[GLOBAL_KEY_CREDIT_MGR]) {
    globalStore[GLOBAL_KEY_CREDIT_REPO] = new UnlimitedCreditRepository();
    globalStore[GLOBAL_KEY_CREDIT_MGR] = new CreditManager(globalStore[GLOBAL_KEY_CREDIT_REPO]);
  }
  return globalStore[GLOBAL_KEY_CREDIT_MGR];
}

/**
 * Resolve the shared {@link CreditRepository} underlying the credit manager,
 * building the default in-memory manager on first use. `container.ts` passes
 * this into `createInMemoryPipelineWorker({ creditRepo })` so the worker and the
 * credits route observe the same balances (single source of truth).
 */
export function getCreditRepository(): CreditRepository {
  if (!globalStore[GLOBAL_KEY_CREDIT_REPO]) {
    // Building the manager populates the shared repo.
    getCreditManager();
  }
  // `getCreditManager` guarantees the repo is set.
  return globalStore[GLOBAL_KEY_CREDIT_REPO] as CreditRepository;
}

/**
 * Override the credit manager (used by production wiring and tests). When a
 * custom manager is injected the shared in-memory repo no longer applies, so it
 * is cleared; `getCreditRepository` will rebuild a default repo on demand.
 */
export function setCreditManager(manager: CreditManager): void {
  globalStore[GLOBAL_KEY_CREDIT_MGR] = manager;
  globalStore[GLOBAL_KEY_CREDIT_REPO] = undefined;
}

/** Reset the seam (test helper) so the next access rebuilds the default. */
export function resetCreditManager(): void {
  globalStore[GLOBAL_KEY_CREDIT_MGR] = undefined;
  globalStore[GLOBAL_KEY_CREDIT_REPO] = undefined;
}
