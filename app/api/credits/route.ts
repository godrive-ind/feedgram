/**
 * `GET /api/credits` — return the authenticated user's remaining credit balance
 * (task 8.4).
 *
 * Behaviour (Req 8.1, 8.6):
 *   - Reads the trusted authenticated user id from the middleware-injected
 *     `x-fdg-user-id` header (see `lib/auth.ts` + root `middleware.ts`). The
 *     middleware already rejects unauthenticated `/api/*` traffic with 401, so
 *     a missing header here is treated defensively as 401.
 *   - Returns `200 { balance }` where `balance` is a non-negative integer read
 *     from `Credit_Manager.getBalance` (which normalizes to an int ≥ 0).
 *
 * Dependency wiring: the credit manager is obtained through a small injectable
 * provider seam (`setCreditManager`) so tests can supply an in-memory manager
 * with a seeded balance. By default it lazily builds an in-memory manager via
 * the established factory (`createInMemoryCreditManager`); production wiring
 * (Prisma-backed repository, task 7.1) substitutes a real manager through the
 * same seam without changing this handler.
 *
 * Runtime: Node.js (consistent with the rest of the API).
 *
 * Requirements: 8.1, 8.6, keamanan endpoint (Architecture → Keamanan).
 */

import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "@/lib/auth";
import { getCreditManager } from "@/lib/server/credit-provider";

export const runtime = "nodejs";
export const maxDuration = 15;
// Balance changes as credits are reserved/committed/refunded; never cache.
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<NextResponse> {
  const userId = getAuthenticatedUserId(request.headers);
  if (!userId) {
    return NextResponse.json(
      {
        error: "unauthorized",
        message: "Permintaan tidak terautentikasi.",
      },
      { status: 401 },
    );
  }

  const balance = await getCreditManager().getBalance(userId);

  // `getBalance` already guarantees a non-negative integer (Req 8.1, 8.6).
  return NextResponse.json({ balance }, { status: 200 });
}
