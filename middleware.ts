/**
 * Next.js middleware — authentication gate for all network-exposed endpoints
 * (task 8.1).
 *
 * Per design "Architecture → Keamanan", every `/api/*` endpoint
 * (`/api/generate`, `/api/jobs/*`, `/api/variations/*`, `/api/export/*`,
 * `/api/publish/*`, `/api/history/*`, `/api/credits`, `/api/uploads`) MUST pass
 * through authentication before reaching its route handler.
 *
 * This middleware:
 *   1. Rejects unauthenticated requests with `401` (Req: tolak permintaan tak
 *      terautentikasi pada seluruh endpoint `/api/*`).
 *   2. On success, forwards the request with trusted `x-fdg-user-id` /
 *      `x-fdg-user-plan` headers so route handlers can enforce per-user
 *      resource-ownership authorization (403 for cross-user access) via
 *      `authorizeOwnership` from `lib/auth.ts`.
 *   3. Strips any client-supplied copy of those trusted headers so they cannot
 *      be spoofed.
 *
 * NOTE: Next.js only executes middleware defined at the project root
 * (`middleware.ts`). The design lists `app/middleware.ts` "atau /middleware.ts
 * root"; the root location is used so the gate actually runs on Vercel.
 *
 * Requirements: keamanan endpoint (Architecture → Keamanan).
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  USER_ID_HEADER,
  USER_PLAN_HEADER,
  authenticateRequest,
} from "@/lib/auth";

/**
 * Only run on API routes. All `/api/*` endpoints are protected EXCEPT
 * `/api/session` (the login/session-issuing endpoint) — you cannot obtain a
 * session if you must already be authenticated to reach it. The negative
 * lookahead `(?!session)` excludes that single path while still gating every
 * other `/api/*` endpoint. Everything else (static assets, pages) is untouched.
 */
export const config = {
  matcher: ["/api/((?!session).*)"],
};

function unauthorized(message: string): NextResponse {
  return NextResponse.json(
    { error: "unauthorized", message },
    {
      status: 401,
      headers: {
        // Standard challenge header for token-based auth.
        "WWW-Authenticate": 'Bearer realm="api", error="invalid_token"',
      },
    },
  );
}

function misconfigured(message: string): NextResponse {
  // Fail closed: if the server has no signing secret, deny access (500) rather
  // than allow unauthenticated traffic through.
  return NextResponse.json({ error: "server_error", message }, { status: 500 });
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const result = await authenticateRequest(request.headers);

  if (!result.authenticated) {
    if (result.reason === "misconfigured") {
      return misconfigured(result.message);
    }
    return unauthorized(result.message);
  }

  // Authenticated: forward request, injecting trusted identity headers and
  // stripping any client-supplied spoof of the same headers.
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.delete(USER_ID_HEADER);
  forwardedHeaders.delete(USER_PLAN_HEADER);
  forwardedHeaders.set(USER_ID_HEADER, result.user.userId);
  if (result.user.plan) {
    forwardedHeaders.set(USER_PLAN_HEADER, result.user.plan);
  }

  return NextResponse.next({
    request: { headers: forwardedHeaders },
  });
}
