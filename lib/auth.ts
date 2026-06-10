/**
 * Authentication & authorization core (task 8.1).
 *
 * Provides the building blocks used by the Next.js middleware to protect every
 * network-exposed endpoint (`/api/*`), per design "Architecture → Keamanan":
 *
 *   - Authentication: verify a signed session token (HS256 JWT). Requests
 *     without a valid token are rejected with 401 by the middleware.
 *   - Authorization: per-user resource ownership — a user may only access
 *     jobs/batches/variations/credits they own. Cross-user access is rejected
 *     with 403 by route handlers via {@link authorizeOwnership}.
 *
 * Design constraints honoured here:
 *   - Edge-runtime compatible: uses the Web Crypto API (`crypto.subtle`) and
 *     `TextEncoder`/`atob`/`btoa` (all available in the Vercel Edge runtime and
 *     Node 18+). No Node-only `crypto` module, no `next/server` import — so the
 *     module is unit-testable in plain Node and runnable in middleware.
 *   - The signing secret comes from the server-only `AUTH_SECRET` env var
 *     (never `NEXT_PUBLIC_`), so it is never exposed to the client.
 *
 * Token format: a compact JWT `base64url(header).base64url(payload).base64url(sig)`
 * with `alg: "HS256"`. Payload claims: `sub` (userId), optional `plan`,
 * optional `exp`/`iat` (seconds since epoch).
 *
 * Requirements: keamanan endpoint (Architecture → Keamanan).
 */

import { type Plan } from "@/lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cookie name carrying the session token. */
export const SESSION_COOKIE = "fdg_session";

/**
 * Header the middleware injects with the authenticated user's id, for trusted
 * downstream consumption by route handlers. Any client-supplied value MUST be
 * stripped/overwritten by the middleware before handlers read it.
 */
export const USER_ID_HEADER = "x-fdg-user-id";

/** Header the middleware injects with the authenticated user's plan. */
export const USER_PLAN_HEADER = "x-fdg-user-plan";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Decoded, verified session payload (JWT claims). */
export interface SessionPayload {
  /** Subject — the user id. */
  sub: string;
  /** Optional subscription plan. */
  plan?: Plan;
  /** Expiry (seconds since epoch). */
  exp?: number;
  /** Issued-at (seconds since epoch). */
  iat?: number;
}

/** The authenticated principal derived from a verified token. */
export interface AuthenticatedUser {
  userId: string;
  plan?: Plan;
}

/** Result of attempting to authenticate a request. */
export type AuthResult =
  | { authenticated: true; user: AuthenticatedUser }
  | { authenticated: false; reason: "missing" | "invalid" | "expired" | "misconfigured"; message: string };

/** Minimal header accessor satisfied by `Headers` and `NextRequest.headers`. */
export interface HeadersLike {
  get(name: string): string | null;
}

// ---------------------------------------------------------------------------
// base64url helpers (Edge + Node compatible)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padLength = value.length % 4 === 0 ? 0 : 4 - (value.length % 4);
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLength);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function stringToBase64Url(value: string): string {
  return bytesToBase64Url(textEncoder.encode(value));
}

function base64UrlToString(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

/** Constant-time comparison of two strings to avoid timing leaks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 signing (Web Crypto)
// ---------------------------------------------------------------------------

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacSign(signingInput: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(signingInput),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

/**
 * Read the server-only signing secret from `AUTH_SECRET`. Returns `undefined`
 * when unset/empty so callers can surface a misconfiguration (fail closed).
 */
export function getAuthSecret(): string | undefined {
  const secret = process.env.AUTH_SECRET;
  return secret && secret.length > 0 ? secret : undefined;
}

// ---------------------------------------------------------------------------
// Token sign / verify
// ---------------------------------------------------------------------------

/**
 * Sign a session token (HS256 JWT) for the given user. Intended for the
 * login/session-issuing flow and for tests.
 */
export async function signSessionToken(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = stringToBase64Url(JSON.stringify(header));
  const encodedPayload = stringToBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await hmacSign(signingInput, secret);
  return `${signingInput}.${signature}`;
}

/**
 * Verify a session token and return its payload, or `undefined` if the token is
 * malformed, has an unsupported algorithm, fails signature verification, or is
 * expired. Fails closed in every error case.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionPayload | undefined> {
  if (!token || !secret) return undefined;

  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [encodedHeader, encodedPayload, signature] = parts;

  // Validate header / algorithm.
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlToString(encodedHeader));
  } catch {
    return undefined;
  }
  if (header.alg !== "HS256") return undefined;

  // Verify signature (constant-time).
  let expectedSignature: string;
  try {
    expectedSignature = await hmacSign(`${encodedHeader}.${encodedPayload}`, secret);
  } catch {
    return undefined;
  }
  if (!timingSafeEqual(signature, expectedSignature)) return undefined;

  // Parse payload.
  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64UrlToString(encodedPayload));
  } catch {
    return undefined;
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return undefined;
  }

  // Expiry check (seconds since epoch).
  if (typeof payload.exp === "number") {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds >= payload.exp) return undefined;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Extract a bearer/cookie session token from request headers. Prefers the
 * `Authorization: Bearer <token>` header, then falls back to the
 * `{@link SESSION_COOKIE}` cookie. Returns `undefined` when absent.
 */
export function extractToken(headers: HeadersLike): string | undefined {
  const authorization = headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }

  const cookieHeader = headers.get("cookie");
  if (cookieHeader) {
    const token = readCookie(cookieHeader, SESSION_COOKIE);
    if (token) return token;
  }

  return undefined;
}

/** Parse a single cookie value out of a `Cookie` header string. */
function readCookie(cookieHeader: string, name: string): string | undefined {
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    const key = pair.slice(0, index).trim();
    if (key === name) {
      return decodeURIComponent(pair.slice(index + 1).trim());
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

/**
 * Authenticate a request from its headers. Resolves the signing secret from the
 * environment (fails closed with `misconfigured` if unset), extracts the token,
 * and verifies it.
 */
export async function authenticateRequest(headers: HeadersLike): Promise<AuthResult> {
  const secret = getAuthSecret();
  if (!secret) {
    return {
      authenticated: false,
      reason: "misconfigured",
      message: "Server autentikasi belum dikonfigurasi (AUTH_SECRET tidak ada).",
    };
  }

  const token = extractToken(headers);
  if (!token) {
    return {
      authenticated: false,
      reason: "missing",
      message: "Permintaan tidak terautentikasi: token sesi tidak ditemukan.",
    };
  }

  const payload = await verifySessionToken(token, secret);
  if (!payload) {
    return {
      authenticated: false,
      reason: "invalid",
      message: "Token sesi tidak valid atau telah kedaluwarsa.",
    };
  }

  return {
    authenticated: true,
    user: { userId: payload.sub, plan: payload.plan },
  };
}

// ---------------------------------------------------------------------------
// Authorization (per-user resource ownership)
// ---------------------------------------------------------------------------

/**
 * Whether `authUserId` is allowed to access a resource owned by
 * `resourceOwnerId`. Ownership is exact-match only; there is no cross-user
 * access (Req: pengguna hanya boleh mengakses sumber daya miliknya). A 403
 * response should be returned by the caller when this is `false`.
 */
export function authorizeOwnership(
  authUserId: string,
  resourceOwnerId: string,
): boolean {
  if (!authUserId || !resourceOwnerId) return false;
  return authUserId === resourceOwnerId;
}

/**
 * Read the trusted authenticated user id injected by the middleware. Route
 * handlers use this instead of re-parsing the token. Returns `undefined` if the
 * header is absent (should not happen for `/api/*` once middleware runs).
 */
export function getAuthenticatedUserId(headers: HeadersLike): string | undefined {
  const value = headers.get(USER_ID_HEADER);
  return value && value.length > 0 ? value : undefined;
}

/** Read the trusted authenticated user (id + plan) injected by the middleware. */
export function getAuthenticatedUser(headers: HeadersLike): AuthenticatedUser | undefined {
  const userId = getAuthenticatedUserId(headers);
  if (!userId) return undefined;
  const planValue = headers.get(USER_PLAN_HEADER);
  const plan = planValue === "Free" || planValue === "Pro" ? planValue : undefined;
  return { userId, plan };
}
