/**
 * `POST /api/variations/[id]` — regenerate or fine-tune a design variation
 * (task 11.4).
 *
 * Backs the UI's per-variation "regenerate" / "fine-tune" controls (Req 4.6,
 * 7.6) by invoking the pure derivation operations in `lib/pipeline/derive.ts`
 * with the AI connector taken from the shared server container/worker provider.
 *
 * Request body (JSON):
 *   { "action": "regenerate" }                       — re-render with a fresh seed
 *   { "action": "fine-tune", "feedback": "<text>" }  — feedback-guided derivation
 *
 * The `[id]` path segment is the source variation's id.
 *
 * Authentication & authorization (design "Architecture → Keamanan"):
 *   - The authenticated user id is read from the trusted middleware-injected
 *     header (`x-fdg-user-id`, via `getAuthenticatedUserId`). Absent → 401.
 *   - Per-user ownership of the variation (its batch's owning user) is enforced
 *     with `authorizeOwnership`. Consistent with the jobs route's convention,
 *     BOTH an unknown variation and one owned by another user return **404** so
 *     the API never leaks the existence of another user's variation.
 *
 * Outcome (Req 4.7 / 7.9 — source preserved on failure):
 *   - On `DeriveResult.ok === true`  → 200 with the new `variation`.
 *   - On `DeriveResult.ok === false` → 502 with the UNCHANGED source variation
 *     plus `{ source: "regenerate" | "fine-tune", message }`, so the client
 *     keeps showing the original variation and can surface the error.
 *
 * Runtime: Node.js (consistent with the rest of the pipeline — canvas/PDF libs
 * are unavailable on the Edge runtime). `maxDuration` allows for the AI image
 * call (timeout 30s, ≤3 attempts) plus re-composition.
 *
 * Requirements: 4.6, 4.7, 7.6, 7.9
 */

import { NextResponse } from "next/server";

import { authorizeOwnership, getAuthenticatedUserId } from "@/lib/auth";
import {
  fineTuneVariation,
  regenerateVariation,
  type DeriveResult,
} from "@/lib/pipeline/derive";
import { getPipelineWorker } from "@/lib/server/container";
import { getVariationStore } from "@/lib/server/variation-store";

export const runtime = "nodejs";
/** Allow time for one AI image call (≤30s × up to 3 attempts) + re-compose. */
export const maxDuration = 120;
// The result depends on live AI output; never cache this mutation.
export const dynamic = "force-dynamic";

/** The action requested for the variation. */
type VariationAction = "regenerate" | "fine-tune";

/** Source label echoed in error responses (matches DeriveResult semantics). */
const ACTION_SOURCE: Record<VariationAction, "regenerate" | "fine-tune"> = {
  regenerate: "regenerate",
  "fine-tune": "fine-tune",
};

export async function POST(
  request: Request,
  context: { params: { id: string } },
): Promise<NextResponse> {
  const { id } = context.params;

  // 1. Authentication — trust only the middleware-injected header (fail closed).
  const userId = getAuthenticatedUserId(request.headers);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "Permintaan tidak terautentikasi." },
      { status: 401 },
    );
  }

  if (!id) {
    return NextResponse.json(
      { error: "not_found", message: "Variasi tidak ditemukan." },
      { status: 404 },
    );
  }

  // 2. Parse the JSON body defensively.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "invalid_json",
        message: "Body permintaan bukan JSON yang valid.",
      },
      { status: 400 },
    );
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const action = b.action;
  if (action !== "regenerate" && action !== "fine-tune") {
    return NextResponse.json(
      {
        error: "invalid_action",
        message: 'Field "action" harus "regenerate" atau "fine-tune".',
      },
      { status: 400 },
    );
  }

  // Fine-tune requires a non-empty feedback string (Req 7.6).
  let feedback = "";
  if (action === "fine-tune") {
    if (typeof b.feedback !== "string" || b.feedback.trim().length === 0) {
      return NextResponse.json(
        {
          error: "missing_feedback",
          message:
            'Aksi "fine-tune" membutuhkan field "feedback" berupa teks masukan.',
        },
        { status: 400 },
      );
    }
    feedback = b.feedback;
  }

  // 3. Resolve the source variation + its owner. Unknown OR not-owned → 404
  //    (no existence leak), matching the jobs route convention.
  const store = getVariationStore();
  const owned = await store.getVariation(id);
  if (!owned) {
    return NextResponse.json(
      { error: "not_found", message: "Variasi tidak ditemukan." },
      { status: 404 },
    );
  }
  if (!authorizeOwnership(userId, owned.ownerUserId)) {
    return NextResponse.json(
      { error: "not_found", message: "Variasi tidak ditemukan." },
      { status: 404 },
    );
  }

  // 4. Derive a new variation using the AI connector from the shared worker.
  const connector = getPipelineWorker().getConnector();

  let result: DeriveResult;
  try {
    result =
      action === "regenerate"
        ? await regenerateVariation(owned.variation, { connector })
        : await fineTuneVariation(owned.variation, feedback, { connector });
  } catch (error) {
    // Defensive: the derive ops already catch connector errors and return an
    // ok:false result, so reaching here is unexpected. Preserve the source
    // (Req 4.7/7.9) and report a failure without losing the original.
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: "derive_failed",
        source: ACTION_SOURCE[action],
        message,
        variation: owned.variation,
      },
      { status: 502 },
    );
  }

  if (!result.ok) {
    // Failure: the original variation is preserved unchanged (Req 4.7/7.9).
    return NextResponse.json(
      {
        error: "derive_failed",
        source: ACTION_SOURCE[action],
        message: result.message,
        variation: result.source,
      },
      { status: 502 },
    );
  }

  // 5. Success: persist and return the new variation (Req 4.6/7.6).
  await store.saveVariation(result.variation, owned.ownerUserId);

  return NextResponse.json({ variation: result.variation }, { status: 200 });
}
