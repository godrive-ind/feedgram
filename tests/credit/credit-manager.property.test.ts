import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  CreditManager,
  InMemoryCreditRepository,
  PLAN_VARIATION_RULES,
  createInMemoryCreditManager,
} from "@/lib/credit/credit-manager";
import { PLANS, VARIATION_COUNTS, type Plan, type VariationCount } from "@/lib/types";

const NUM_RUNS = 100;
const USER = "user-1";

/**
 * Property 27: Pengurangan kredit sesuai jumlah variasi
 * Feature: feed-design-generator, Property 27: Untuk setiap batch yang berhasil
 * dihasilkan dengan N variasi, saldo credit berkurang tepat N (1 credit per variasi).
 *
 * Validates: Requirements 8.2
 *
 * Models the success path reserve -> commit and asserts the committed deduction
 * equals exactly N.
 */
describe("Property 27: credit deduction equals variation count", () => {
  it("decreases balance by exactly N after reserve -> commit", async () => {
    await fc.assert(
      fc.asyncProperty(
        // N is a valid variation count (3, 6, or 9).
        fc.constantFrom<VariationCount>(...VARIATION_COUNTS),
        // Surplus credits beyond N (0 covers the exact-equal-balance edge case).
        fc.integer({ min: 0, max: 500 }),
        async (n, surplus) => {
          const startingBalance = n + surplus;
          const { manager } = createInMemoryCreditManager({
            [USER]: startingBalance,
          });

          const reservation = await manager.reserve(USER, n);

          // With enough credits, the reservation must succeed.
          expect(reservation.success).toBe(true);
          expect(reservation.reservationId).toBeTypeOf("string");
          expect(reservation.amount).toBe(n);

          await manager.commit(reservation.reservationId!);

          const finalBalance = await manager.getBalance(USER);
          // Balance decreased by exactly N (1 credit per variation). Req 8.2
          expect(finalBalance).toBe(startingBalance - n);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

/**
 * Property 28: Penolakan saat kredit tidak mencukupi
 * Feature: feed-design-generator, Property 28: Untuk setiap permintaan generasi
 * dengan saldo credit lebih kecil dari jumlah variasi yang diminta, permintaan
 * ditolak, saldo credit tidak berubah, dan ditampilkan ajakan upgrade ke Pro.
 *
 * Validates: Requirements 8.3
 */
describe("Property 28: reject when credit insufficient", () => {
  it("rejects, leaves balance unchanged, and signals an upgrade prompt", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<VariationCount>(...VARIATION_COUNTS),
        // Generate a balance strictly less than the requested count.
        fc.integer({ min: 0, max: 8 }),
        async (requested, balanceSeed) => {
          // Constrain the balance to [0, requested - 1] so it is always < requested.
          const balance = balanceSeed % requested; // 0..requested-1
          const { manager } = createInMemoryCreditManager({ [USER]: balance });

          const result = await manager.reserve(USER, requested);

          // Rejected without deduction. Req 8.3
          expect(result.success).toBe(false);
          expect(result.reservationId).toBeUndefined();
          // Upgrade prompt signaled.
          expect(result.upgradePrompt).toBe(true);

          // Balance untouched.
          const after = await manager.getBalance(USER);
          expect(after).toBe(balance);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

/**
 * Property 29: Aturan kelayakan jumlah variasi berbasis plan
 * Feature: feed-design-generator, Property 29: Untuk setiap plan: plan "Free"
 * tidak mengizinkan pilihan 9 variasi (hanya 3 dan 6), sedangkan plan "Pro"
 * mengizinkan 3, 6, dan 9 variasi.
 *
 * Validates: Requirements 8.4, 8.5
 */
describe("Property 29: plan-based variation count eligibility", () => {
  it("Free allows only 3 and 6 (not 9); Pro allows 3, 6, and 9", () => {
    const repo = new InMemoryCreditRepository();
    const manager = new CreditManager(repo);

    fc.assert(
      fc.property(
        fc.constantFrom<Plan>(...PLANS),
        fc.constantFrom<VariationCount>(...VARIATION_COUNTS),
        (plan, count) => {
          const allowed = manager.isVariationCountAllowed(plan, count);
          const expected = PLAN_VARIATION_RULES[plan].includes(count);

          // Matches the plan rules.
          expect(allowed).toBe(expected);

          // Explicit spec assertions (Req 8.4, 8.5).
          if (plan === "Free") {
            expect(manager.isVariationCountAllowed("Free", count)).toBe(count !== 9);
          } else {
            expect(manager.isVariationCountAllowed("Pro", count)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

/**
 * Property 30: Invariant saldo kredit non-negatif
 * Feature: feed-design-generator, Property 30: Untuk setiap barisan operasi
 * kredit (reserve, commit, refund) dengan urutan apa pun, saldo credit yang
 * dilaporkan selalu berupa bilangan bulat dan tidak pernah bernilai kurang dari 0.
 *
 * Validates: Requirements 8.1, 8.6
 */
type CreditOp =
  | { kind: "reserve"; amount: number }
  | { kind: "commit"; index: number }
  | { kind: "refund"; index: number };

const opArb: fc.Arbitrary<CreditOp> = fc.oneof(
  // Reserve with edge-case amounts: invalid (<=0), floats, large, zero.
  fc.record({
    kind: fc.constant("reserve" as const),
    amount: fc.oneof(
      fc.integer({ min: -10, max: 50 }), // includes zero & negatives
      fc.double({ min: -5, max: 50, noNaN: true }), // fractional amounts
    ),
  }),
  // Commit/refund target an index into the reservation-id list (incl. unknown).
  fc.record({ kind: fc.constant("commit" as const), index: fc.nat({ max: 30 }) }),
  fc.record({ kind: fc.constant("refund" as const), index: fc.nat({ max: 30 }) }),
);

describe("Property 30: balance is always a non-negative integer", () => {
  it("never reports a negative or non-integer balance for any operation sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Starting balance includes the zero-balance edge case.
        fc.integer({ min: 0, max: 100 }),
        fc.array(opArb, { minLength: 0, maxLength: 40 }),
        async (startingBalance, ops) => {
          const { manager } = createInMemoryCreditManager({
            [USER]: startingBalance,
          });

          // Track reservation ids produced so commit/refund can reference them;
          // unknown ids (out-of-range indexes) are also exercised.
          const reservationIds: string[] = [];

          const assertInvariant = async () => {
            const balance = await manager.getBalance(USER);
            expect(Number.isInteger(balance)).toBe(true);
            expect(balance).toBeGreaterThanOrEqual(0);
          };

          await assertInvariant();

          for (const op of ops) {
            switch (op.kind) {
              case "reserve": {
                const res = await manager.reserve(USER, op.amount);
                if (res.success && res.reservationId) {
                  reservationIds.push(res.reservationId);
                }
                break;
              }
              case "commit": {
                const id =
                  reservationIds.length > 0
                    ? reservationIds[op.index % reservationIds.length]
                    : `unknown_${op.index}`;
                await manager.commit(id);
                break;
              }
              case "refund": {
                const id =
                  reservationIds.length > 0
                    ? reservationIds[op.index % reservationIds.length]
                    : `unknown_${op.index}`;
                await manager.refund(id);
                break;
              }
            }

            // Invariant must hold after every single operation. Req 8.1, 8.6
            await assertInvariant();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
