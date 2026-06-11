/**
 * Credit_Manager (Requirement 8) — pure credit arithmetic with the
 * reserve → commit/refund pattern.
 *
 * Storage access is abstracted behind {@link CreditRepository} so the manager
 * can be unit/property tested with an in-memory repository and later wired to a
 * Prisma-backed atomic-transaction repository (task 7.1) without changing this
 * logic.
 *
 * Invariants (Req 8.1, 8.6):
 * - A reported balance is ALWAYS a non-negative integer.
 * - Reserving credits holds funds atomically; it never drives the balance < 0.
 * - commit deducts exactly 1 credit per variation; refund returns held funds.
 *
 * See design "Components and Interfaces → Credit_Manager".
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

import {
  VARIATION_COUNTS,
  type Plan,
  type ReservationResult,
  type VariationCount,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Plan rules (Req 8.4, 8.5)
// ---------------------------------------------------------------------------

/**
 * Variation counts allowed per plan.
 * - "Free": only 3 or 6 variations (9 is a Pro feature). Req 8.4
 * - "Pro": 3, 6, or 9 variations. Req 8.5
 */
export const PLAN_VARIATION_RULES: Record<Plan, readonly VariationCount[]> = {
  Free: [3, 6],
  Pro: [3, 6, 9],
} as const;

// ---------------------------------------------------------------------------
// Repository abstraction (mockable; real Prisma impl wired in task 7.1)
// ---------------------------------------------------------------------------

/**
 * A held reservation: an amount of credits set aside for a user that has not
 * yet been committed (deducted) or refunded (released).
 */
export interface Reservation {
  id: string;
  userId: string;
  amount: number;
  /** "held" while pending; "committed"/"refunded" once finalized. */
  status: "held" | "committed" | "refunded";
}

/**
 * Storage abstraction for the Credit_Manager.
 *
 * Implementations MUST perform the reserve/commit/refund mutations atomically
 * (the real Prisma-backed implementation uses a DB transaction — task 7.1).
 * The in-memory implementation below is synchronous but exposes the same async
 * contract so callers are storage-agnostic.
 */
export interface CreditRepository {
  /** Current non-negative integer balance for a user (0 if unknown). Req 8.1 */
  getBalance(userId: string): Promise<number>;

  /**
   * Add `amount` credits to `userId`'s available balance (granting/seeding).
   *
   * `amount` is normalized to a non-negative integer; a non-positive or
   * non-finite amount is a no-op. The resulting balance always stays a
   * non-negative integer (Req 8.6). Used to seed new users with a starting
   * balance and to top-up credits.
   */
  addCredits(userId: string, amount: number): Promise<void>;

  /**
   * Atomically check-and-hold `amount` credits for `userId`.
   *
   * If the available balance is `< amount`, leaves the balance unchanged and
   * returns `undefined` (caller surfaces the upgrade prompt — Req 8.3).
   * On success, deducts the held amount from the available balance and returns
   * the created {@link Reservation}.
   */
  hold(userId: string, amount: number): Promise<Reservation | undefined>;

  /**
   * Finalize a held reservation as committed. The held funds were already
   * removed from the available balance by {@link hold}; commit simply marks the
   * reservation consumed (Req 8.2). No-op if already finalized.
   */
  commitReservation(reservationId: string): Promise<void>;

  /**
   * Partially finalize a held reservation: commit `commitAmount` credits and
   * refund the remainder (`reservation.amount - commitAmount`) back to the
   * user's available balance, atomically (Req 11.4). `commitAmount` is clamped
   * to `[0, reservation.amount]`, so `commitAmount === amount` behaves like
   * {@link commitReservation} (full commit) and `commitAmount === 0` behaves
   * like {@link refundReservation} (full refund). Idempotent: a non-"held"
   * reservation is a no-op. The available balance never goes below 0 and stays
   * an integer (Req 8.6).
   */
  commitPartialReservation(
    reservationId: string,
    commitAmount: number,
  ): Promise<void>;

  /**
   * Release a held reservation, returning the held funds to the user's
   * available balance (Req 2.10). No-op if already finalized.
   */
  refundReservation(reservationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory repository (for tests + local wiring; not for production)
// ---------------------------------------------------------------------------

/**
 * In-memory {@link CreditRepository}. Keeps balances and reservations in maps.
 *
 * The stored balance represents *available* (unreserved) credits. Holding moves
 * credits out of the available balance into a reservation; refund moves them
 * back; commit discards them permanently. This guarantees the available balance
 * never goes below 0 (Req 8.6).
 */
export class InMemoryCreditRepository implements CreditRepository {
  private balances = new Map<string, number>();
  private reservations = new Map<string, Reservation>();
  private seq = 0;

  constructor(initial?: Record<string, number>) {
    if (initial) {
      for (const [userId, balance] of Object.entries(initial)) {
        this.balances.set(userId, normalizeBalance(balance));
      }
    }
  }

  /** Seed/overwrite a user's available balance (test helper). */
  setBalance(userId: string, balance: number): void {
    this.balances.set(userId, normalizeBalance(balance));
  }

  async getBalance(userId: string): Promise<number> {
    return this.balances.get(userId) ?? 0;
  }

  async addCredits(userId: string, amount: number): Promise<void> {
    const normalizedAmount = normalizeBalance(amount);
    if (normalizedAmount <= 0) return; // no-op for non-positive/invalid grants
    const current = this.balances.get(userId) ?? 0;
    this.balances.set(userId, normalizeBalance(current + normalizedAmount));
  }

  async hold(userId: string, amount: number): Promise<Reservation | undefined> {
    const normalizedAmount = Math.floor(amount);
    const available = this.balances.get(userId) ?? 0;

    // Req 8.3 / 8.6 — reject when insufficient; leave balance unchanged.
    if (normalizedAmount <= 0 || available < normalizedAmount) {
      return undefined;
    }

    this.balances.set(userId, available - normalizedAmount);
    const reservation: Reservation = {
      id: `res_${++this.seq}`,
      userId,
      amount: normalizedAmount,
      status: "held",
    };
    this.reservations.set(reservation.id, reservation);
    return { ...reservation };
  }

  async commitReservation(reservationId: string): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== "held") {
      return; // idempotent / unknown — no balance change
    }
    // Funds were already removed from the available balance by hold().
    reservation.status = "committed";
  }

  async commitPartialReservation(
    reservationId: string,
    commitAmount: number,
  ): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== "held") {
      return; // idempotent / unknown — no balance change
    }
    // Clamp the committed amount to [0, amount] (Req 8.6). The remainder is
    // returned to the available balance; hold() already removed the full
    // amount, so only the refunded portion is credited back.
    const commit = clampCommit(commitAmount, reservation.amount);
    const refundAmount = reservation.amount - commit;
    if (refundAmount > 0) {
      const current = this.balances.get(reservation.userId) ?? 0;
      this.balances.set(reservation.userId, current + refundAmount);
    }
    reservation.status = "committed";
  }

  async refundReservation(reservationId: string): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== "held") {
      return; // idempotent / unknown — no balance change
    }
    const current = this.balances.get(reservation.userId) ?? 0;
    this.balances.set(reservation.userId, current + reservation.amount);
    reservation.status = "refunded";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp a balance to a non-negative integer (Req 8.6). */
function normalizeBalance(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  return floored < 0 ? 0 : floored;
}

/**
 * Clamp a partial-commit amount to an integer in `[0, amount]` (Req 8.6).
 * Non-finite input is treated as 0 so the whole reservation is refunded.
 */
function clampCommit(commitAmount: number, amount: number): number {
  if (!Number.isFinite(commitAmount)) return 0;
  const floored = Math.floor(commitAmount);
  if (floored <= 0) return 0;
  return floored > amount ? amount : floored;
}

/** Type guard for a valid variation count (3, 6, or 9). */
export function isVariationCount(count: number): count is VariationCount {
  return (VARIATION_COUNTS as readonly number[]).includes(count);
}

// ---------------------------------------------------------------------------
// CreditManager
// ---------------------------------------------------------------------------

/**
 * Manages credit quota using the reserve → commit/refund pattern.
 *
 * Depends only on a {@link CreditRepository}, so it is storage-agnostic and
 * fully mockable. The real Prisma-backed atomic repository is wired in task 7.1.
 */
export class CreditManager {
  constructor(private readonly repo: CreditRepository) {}

  /**
   * Return the user's remaining credits as a non-negative integer (Req 8.1).
   * Defensively normalizes whatever the repository returns (Req 8.6).
   */
  async getBalance(userId: string): Promise<number> {
    const balance = await this.repo.getBalance(userId);
    return normalizeBalance(balance);
  }

  /**
   * Grant (add) `amount` credits to the user's available balance, e.g. seeding
   * a new user's starting balance or topping-up. Delegates to
   * {@link CreditRepository.addCredits}, which normalizes the amount to a
   * non-negative integer and keeps the balance a non-negative integer (Req 8.6).
   */
  async grant(userId: string, amount: number): Promise<void> {
    await this.repo.addCredits(userId, amount);
  }

  /**
   * Whether the user can afford `variationCount` credits right now (Req 8.3).
   * Costs exactly 1 credit per variation.
   */
  async canAfford(userId: string, variationCount: number): Promise<boolean> {
    const cost = Math.floor(variationCount);
    if (cost <= 0) return true;
    const balance = await this.getBalance(userId);
    return balance >= cost;
  }

  /**
   * Atomically check-and-hold `amount` credits.
   *
   * - If the balance is `< amount`, returns `{ success: false, upgradePrompt: true }`
   *   and leaves the balance unchanged (Req 8.3).
   * - On success, holds the amount and returns a `reservationId` (Req 8.6).
   */
  async reserve(userId: string, amount: number): Promise<ReservationResult> {
    const normalizedAmount = Math.floor(amount);

    if (normalizedAmount <= 0) {
      return {
        success: false,
        message: "Jumlah reservasi kredit harus lebih besar dari 0",
      };
    }

    const reservation = await this.repo.hold(userId, normalizedAmount);

    if (!reservation) {
      // Req 8.3 — insufficient credit: reject without deducting, prompt upgrade.
      return {
        success: false,
        upgradePrompt: true,
        message:
          "Kredit tidak mencukupi untuk jumlah variasi yang diminta. Upgrade ke paket Pro untuk menambah kredit.",
      };
    }

    return {
      success: true,
      reservationId: reservation.id,
      amount: reservation.amount,
    };
  }

  /**
   * Commit a held reservation, finalizing the deduction of exactly 1 credit per
   * variation (Req 8.2). The held funds were already removed at reserve time.
   */
  async commit(reservationId: string): Promise<void> {
    await this.repo.commitReservation(reservationId);
  }

  /**
   * Partially commit a held reservation (professional-mode credit policy,
   * Req 11.4): consume `commitAmount` credits for the variations actually
   * accepted (including accept-with-warning) and refund the remainder
   * (`reservation amount - commitAmount`) back to the user's balance, all
   * atomically. `commitAmount` is clamped to `[0, reservation amount]`, so
   * passing the full reservation amount behaves like {@link commit} and passing
   * `0` behaves like {@link refund}. Idempotent and never drives the balance
   * below 0 (Req 8.6).
   */
  async commitPartial(
    reservationId: string,
    commitAmount: number,
  ): Promise<void> {
    await this.repo.commitPartialReservation(
      reservationId,
      Math.floor(commitAmount),
    );
  }

  /**
   * Refund a held reservation, returning unconsumed credits to the user's
   * balance (Req 2.10). The balance never goes below 0 and stays integer.
   */
  async refund(reservationId: string): Promise<void> {
    await this.repo.refundReservation(reservationId);
  }

  /**
   * Whether `count` variations is allowed for the given plan.
   * - "Free": 3 or 6 only (Req 8.4).
   * - "Pro": 3, 6, or 9 (Req 8.5).
   */
  isVariationCountAllowed(plan: Plan, count: VariationCount): boolean {
    const allowed = PLAN_VARIATION_RULES[plan];
    if (!allowed) return false;
    return allowed.includes(count);
  }
}

/** Factory: create a CreditManager backed by an in-memory repository. */
export function createInMemoryCreditManager(
  initial?: Record<string, number>,
): { manager: CreditManager; repo: InMemoryCreditRepository } {
  const repo = new InMemoryCreditRepository(initial);
  return { manager: new CreditManager(repo), repo };
}
