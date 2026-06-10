/**
 * `GET /api/history` — list a user's generation batches, or load a single batch
 * by id (task 13.1).
 *
 * Two behaviours on one route handler (kept consistent with sibling routes that
 * key off query params / path segments):
 *
 *   - `GET /api/history`            → list the authenticated user's batches,
 *                                     newest → oldest, ≤20 per page (Req 7.2).
 *                                     Optional `?page=N` (1-indexed) paginates.
 *   - `GET /api/history?batchId=ID` → load that batch together with its brief
 *                                     (Req 7.3), enforcing per-user ownership.
 *
 * Authentication & authorization (design "Architecture → Keamanan"):
 *   - The authenticated user id is read from the trusted middleware-injected
 *     header (`x-fdg-user-id`, via `getAuthenticatedUserId`). Absent → 401.
 *   - `listBatches` is inherently per-user (scoped by `userId`).
 *   - `loadBatch` is ownership-checked: a batch owned by another user (or an
 *     unknown id) returns **404** so the API never leaks the existence of
 *     another user's batch — matching the jobs/variations route convention.
 *
 * Dependency wiring: the history manager is obtained through the injectable
 * provider seam (`lib/server/history-provider.ts`) so tests can supply an
 * in-memory manager and production can drop in a Prisma-backed one without
 * changing this handler.
 *
 * Runtime: Node.js (consistent with the rest of the API).
 *
 * Requirements: 7.2, 7.3, 7.4, 7.5, 7.8, keamanan endpoint (Architecture → Keamanan).
 */

import { NextResponse } from "next/server";

import { authorizeOwnership, getAuthenticatedUserId } from "@/lib/auth";
import { getHistoryManager } from "@/lib/server/history-provider";
import { getVariationStore } from "@/lib/server/variation-store";

export const runtime = "nodejs";
export const maxDuration = 15;
// History changes as batches are saved/rated; never cache the response.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  // 1. Authentication — trust only the middleware-injected header (fail closed).
  const userId = getAuthenticatedUserId(request.headers);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "Permintaan tidak terautentikasi." },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const batchId = url.searchParams.get("batchId");
  const manager = getHistoryManager();

  // 2. Load-by-id behaviour (Req 7.3) when `batchId` is present.
  if (batchId) {
    const record = await manager.loadBatch(batchId);
    // Unknown OR not-owned → 404 (no existence leak), matching jobs/variations.
    if (!record || !authorizeOwnership(userId, record.batch.userId)) {
      return NextResponse.json(
        { error: "not_found", message: "Riwayat batch tidak ditemukan." },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { batch: record.batch, brief: record.brief },
      { status: 200 },
    );
  }

  // 3. List behaviour (Req 7.2) — newest → oldest, ≤20 per page.
  const page = parsePage(url.searchParams.get("page"));
  const batches = await manager.listBatches(userId, page);

  return NextResponse.json({ batches, page }, { status: 200 });
}

/** Parse a 1-indexed `page` query param, defaulting to 1 for absent/invalid. */
function parsePage(raw: string | null): number {
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * `POST /api/history` — rate a variation on the 1..5 integer scale (Req 7.4).
 *
 * Backs the right panel's per-variation rating control. Out-of-range / non-int
 * values are rejected while preserving the previous rating (Req 7.8); when
 * storage is unavailable the rating is still accepted at the UI level and
 * persistence is retried silently (Req 7.5) — all handled inside
 * `History_Manager.rateVariation`.
 *
 * Request body (JSON): `{ "variationId": string, "rating": number }`.
 *
 * Ownership: the variation's owning user (its batch's `userId`) is resolved via
 * the variation store and checked with `authorizeOwnership`. An unknown OR
 * not-owned variation returns 404 (no existence leak), matching the sibling
 * routes. When no variation-store record exists (e.g. a session before the
 * store is populated), the rating is still validated by the manager so the
 * range rules (Req 7.4/7.8) always apply.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const userId = getAuthenticatedUserId(request.headers);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "Permintaan tidak terautentikasi." },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Body permintaan bukan JSON yang valid." },
      { status: 400 },
    );
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const variationId = b.variationId;
  if (typeof variationId !== "string" || variationId.length === 0) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: 'Field "variationId" wajib berupa string.',
      },
      { status: 400 },
    );
  }
  if (typeof b.rating !== "number") {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: 'Field "rating" wajib berupa angka.',
      },
      { status: 400 },
    );
  }
  const rating = b.rating;

  // Ownership: when the variation is known, enforce the owner. Unknown/not-owned
  // → 404 (no existence leak), matching jobs/variations/export/publish.
  const owned = await getVariationStore().getVariation(variationId);
  if (!owned || !authorizeOwnership(userId, owned.ownerUserId)) {
    return NextResponse.json(
      { error: "not_found", message: "Variasi tidak ditemukan." },
      { status: 404 },
    );
  }

  const result = await getHistoryManager().rateVariation(variationId, rating);

  // Invalid rating (out of range / non-integer) → 400 with the preserved rating
  // (Req 7.8). Accepted ratings → 200 (Req 7.4/7.5).
  return NextResponse.json(result, { status: result.accepted ? 200 : 400 });
}
