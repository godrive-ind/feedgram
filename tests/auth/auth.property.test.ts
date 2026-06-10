import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  authorizeOwnership,
  signSessionToken,
  verifySessionToken,
} from "@/lib/auth";

const NUM_RUNS = 100;
const SECRET = "prop-secret";

/**
 * Feature: feed-design-generator, Property (auth): token round-trip integrity.
 *
 * For every well-formed session payload, signing then verifying with the same
 * secret recovers the same subject; verifying with any different secret always
 * fails (rejects forged/wrong-key tokens).
 *
 * Validates: keamanan endpoint (Architecture → Keamanan) — authentication.
 */
describe("Property (auth): session token round-trip + wrong-secret rejection", () => {
  it("recovers the subject with the right secret and rejects wrong secrets", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.constantFrom("Free", "Pro"),
        fc.string({ minLength: 1, maxLength: 32 }),
        async (sub, plan, otherSecret) => {
          const token = await signSessionToken(
            { sub, plan: plan as "Free" | "Pro" },
            SECRET,
          );

          const ok = await verifySessionToken(token, SECRET);
          expect(ok).toBeDefined();
          expect(ok!.sub).toBe(sub);

          // A different secret must never verify the token.
          if (otherSecret !== SECRET) {
            expect(await verifySessionToken(token, otherSecret)).toBeUndefined();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

/**
 * Feature: feed-design-generator, Property (auth): ownership authorization.
 *
 * For every pair of user ids, access is granted if and only if the requesting
 * user id exactly equals the resource owner id — i.e. cross-user access is
 * always denied (403), and same-user access is always allowed.
 *
 * Validates: keamanan endpoint (Architecture → Keamanan) — authorization.
 */
describe("Property (auth): ownership authorization iff ids match", () => {
  it("grants access exactly when requester equals owner", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        (a, b) => {
          expect(authorizeOwnership(a, b)).toBe(a === b);
          // Reflexive: a user always owns their own resource.
          expect(authorizeOwnership(a, a)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
