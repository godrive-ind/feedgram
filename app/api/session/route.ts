/**
 * `POST /api/session` — issue a session cookie for the single-user MVP login
 * flow (no external identity provider yet).
 *
 * This endpoint is the ONLY `/api/*` route excluded from the authentication
 * middleware (see root `middleware.ts` matcher `"/api/((?!session).*)"`):
 * you cannot obtain a session if you must already be authenticated to reach the
 * login endpoint. Every other endpoint stays gated.
 *
 * Behaviour:
 *   - Reads optional JSON `{ name?: string, plan?: "Free" | "Pro" }`. The
 *     `name` derives a stable, sanitized userId (`user_<slug>`, default
 *     "demo" → `user_demo`); `plan` defaults to "Free".
 *   - Resolves the signing secret via `getAuthSecret()` (server-only
 *     `AUTH_SECRET`). When unset, fails closed with 500 so we never issue an
 *     unsigned/forgeable cookie.
 *   - Signs an HS256 session JWT (`signSessionToken`) with `sub`/`plan`/`iat`
 *     and an `exp` ~30 days ahead, and sets it as an httpOnly, Secure,
 *     SameSite=Lax cookie (`fdg_session`, path "/").
 *   - Seeds a generous starting balance ONLY when the user's current balance is
 *     0 (so re-login does not keep stacking credits), via the SHARED
 *     Credit_Manager from the credit-provider — the same manager the credits
 *     route and the generate flow observe.
 *   - Returns `200 { userId, plan, balance }`.
 *
 * Runtime: Node.js. Never cached (issues a fresh cookie each call).
 */

import { NextResponse } from "next/server";

import {
  SESSION_COOKIE,
  getAuthSecret,
  signSessionToken,
} from "@/lib/auth";
import { getCreditManager } from "@/lib/server/credit-provider";
import type { Plan } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Session lifetime: ~30 days, in seconds. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Generous starting balance seeded for a brand-new user (balance === 0). */
const STARTING_CREDITS = 30;

/**
 * Derive a stable, URL-safe userId from a display name. Lowercases, replaces
 * disallowed characters with "-", trims separators, and prefixes `user_`.
 * Falls back to "demo" when the name yields nothing usable.
 */
function deriveUserId(name?: string): string {
  const base = (name ?? "demo")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = base.length > 0 ? base : "demo";
  return `user_${slug}`;
}

interface SessionRequestBody {
  name?: string;
  plan?: Plan;
}

export async function POST(request: Request): Promise<NextResponse> {
  // Read optional JSON body; tolerate an empty/malformed body (treat as {}).
  let body: SessionRequestBody = {};
  try {
    const parsed = (await request.json()) as unknown;
    if (parsed && typeof parsed === "object") {
      body = parsed as SessionRequestBody;
    }
  } catch {
    // No/invalid JSON — use defaults.
  }

  const userId = deriveUserId(body.name);
  const plan: Plan = body.plan === "Pro" ? "Pro" : "Free";

  // Fail closed when the signing secret is missing — never issue a forgeable
  // cookie (consistent with the middleware's misconfigured handling).
  const secret = getAuthSecret();
  if (!secret) {
    return NextResponse.json(
      { error: "server_error", message: "AUTH_SECRET belum dikonfigurasi" },
      { status: 500 },
    );
  }

  // Seed a starting balance only for a brand-new user (balance === 0) so a
  // re-login does not keep stacking credits. Uses the SHARED credit manager so
  // both the UI balance and the generate flow observe it.
  const creditManager = getCreditManager();
  const current = await creditManager.getBalance(userId);
  if (current === 0) {
    await creditManager.grant(userId, STARTING_CREDITS);
  }
  const balance = await creditManager.getBalance(userId);

  // Sign the session JWT (HS256) with a ~30-day expiry.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await signSessionToken(
    {
      sub: userId,
      plan,
      iat: nowSeconds,
      exp: nowSeconds + SESSION_TTL_SECONDS,
    },
    secret,
  );

  const response = NextResponse.json({ userId, plan, balance }, { status: 200 });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return response;
}
