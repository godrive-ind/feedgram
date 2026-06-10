/**
 * `POST /api/refine/[id]` — interactive Refinement Loop for a Design_Variation
 * (task 17.3).
 *
 * Backs the UI's per-variation refinement controls (Req 8.1–8.9): the user
 * submits a Refinement_Loop rating (integer 1–10, A7) and/or a natural-language
 * comment (1–500 chars), the system interprets the comment into Design_DNA
 * adjustments, regenerates the variation, and explains the changes. All of the
 * adjustment + regeneration work happens inside the background job worker
 * ({@link PipelineWorker.runRefinement}) behind this authenticated endpoint
 * (Req 8.9).
 *
 * Request body (JSON): `{ "rating"?: number, "comment"?: string }`.
 *
 * The `[id]` path segment is the source variation's id.
 *
 * Authentication & authorization (design "Architecture → Keamanan"):
 *   - The authenticated user id is read from the trusted middleware-injected
 *     header (`x-fdg-user-id`, via `getAuthenticatedUserId`). Absent → 401.
 *   - Per-user ownership is enforced INSIDE `runRefinement` (resolves the
 *     variation + its owning user via the variation store). Both an unknown
 *     variation and one owned by another user surface as `reason: "not_found"`
 *     → 404, so the API never leaks the existence of another user's variation.
 *
 * Result mapping (`RefinementResult` discriminated union → HTTP):
 *   - ok:true                       → 200 { variation, refinementRating?, changes, explanation, message? }
 *   - ok:false "not_found"          → 404
 *   - ok:false "invalid_rating"     → 400 (preserves the previous rating, Req 8.2)
 *   - ok:false "invalid_comment"    → 400 (preserves the source variation, Req 8.4)
 *   - ok:false "regeneration_failed"→ 502 (preserves the source variation, Req 8.8)
 *
 * Runtime: Node.js (consistent with the rest of the pipeline — canvas/PDF libs
 * are unavailable on the Edge runtime). `maxDuration` allows for the AI image
 * call (timeout 30s, ≤3 attempts) plus re-composition.
 *
 * Requirements: 8.1, 8.2, 8.4, 8.9, 11.6
 */

import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "@/lib/auth";
import { getPipelineWorker } from "@/lib/server/container";
import type { RefinementResult } from "@/lib/pipeline/worker";

export const runtime = "nodejs";
/** Allow time for one AI image call (≤30s × up to 3 attempts) + re-compose. */
export const maxDuration = 120;
// The result depends on live AI output; never cache this mutation.
export const dynamic = "force-dynamic";

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

  // Pass through only the recognised optional fields; the worker performs the
  // authoritative validation (rating range A7 / Req 8.2, comment length Req 8.4)
  // and decides whether to reject and what to preserve.
  const rating = typeof b.rating === "number" ? b.rating : undefined;
  const comment = typeof b.comment === "string" ? b.comment : undefined;

  // 3. Run the refinement in the background job worker (Req 8.9). Ownership is
  //    enforced inside (unknown/not-owned → reason "not_found").
  let result: RefinementResult;
  try {
    result = await getPipelineWorker().runRefinement(
      id,
      { rating, comment },
      userId,
    );
  } catch (error) {
    // Defensive: runRefinement maps regeneration failures to an ok:false result,
    // so reaching here is unexpected. Report a failure without leaking details.
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "refinement_failed", message },
      { status: 502 },
    );
  }

  // 4. Success: return the (possibly regenerated) variation, the stored rating,
  //    the applied Design_DNA changes and their explanation (Req 8.1/8.7).
  if (result.ok) {
    return NextResponse.json(
      {
        variation: result.variation,
        refinementRating: result.refinementRating,
        changes: result.changes,
        explanation: result.explanation,
        message: result.message,
      },
      { status: 200 },
    );
  }

  // 5. Failure: map the discriminated reason to the appropriate HTTP status,
  //    preserving the previous rating / source variation as applicable.
  switch (result.reason) {
    case "not_found":
      return NextResponse.json(
        { error: "not_found", message: result.message },
        { status: 404 },
      );

    case "invalid_rating":
      // Reject the rating but keep the previously stored rating (Req 8.2).
      return NextResponse.json(
        {
          error: "invalid_rating",
          message: result.message,
          refinementRating: result.refinementRating,
          variation: result.source,
        },
        { status: 400 },
      );

    case "invalid_comment":
      // Reject the comment but keep the variation unchanged (Req 8.4).
      return NextResponse.json(
        {
          error: "invalid_comment",
          message: result.message,
          variation: result.source,
        },
        { status: 400 },
      );

    case "regeneration_failed":
      // Regeneration failed/timed out; preserve the source variation (Req 8.8).
      return NextResponse.json(
        {
          error: "regeneration_failed",
          message: result.message,
          refinementRating: result.refinementRating,
          variation: result.source,
        },
        { status: 502 },
      );

    default: {
      // Exhaustiveness guard — should be unreachable.
      const _exhaustive: never = result.reason;
      return NextResponse.json(
        { error: "refinement_failed", message: String(_exhaustive) },
        { status: 502 },
      );
    }
  }
}
