/**
 * `POST /api/publish/[id]` — publish a design variation to a social channel
 * (task 12.8).
 *
 * Backs the Export_Manager `publish` responsibility (design "Components and
 * Interfaces → Export_Manager"): send a {@link DesignVariation} to the chosen
 * channel (Instagram / Facebook / LinkedIn), retrying up to 3 times per request
 * on failure (Req 6.7), and preserving the variation unchanged regardless of
 * outcome while reporting the failure cause (Req 6.5 / 6.6).
 *
 * Request body (JSON):
 *   { "channel": "instagram" | "facebook" | "linkedin" }
 *
 * The `[id]` path segment is the variation's id.
 *
 * Authentication & authorization (design "Architecture → Keamanan"):
 *   - The authenticated user id is read from the trusted middleware-injected
 *     header (`x-fdg-user-id`, via `getAuthenticatedUserId`). Absent → 401.
 *   - Per-user ownership of the variation (its batch's owning user) is enforced
 *     with `authorizeOwnership`. Consistent with the jobs/variations routes,
 *     BOTH an unknown variation and one owned by another user return **404** so
 *     the API never leaks the existence of another user's variation.
 *
 * Outcome:
 *   - On success → 200 with the {@link PublishResult} (success, channel,
 *     attempts) plus the UNCHANGED variation (still re-publishable, Req 6.5).
 *   - On failure after ≤3 attempts → 502 with the cause message (Req 6.6) and
 *     the UNCHANGED variation, so the client keeps showing it and can retry.
 *
 * Runtime: Node.js (consistent with the rest of the pipeline). `maxDuration`
 * accommodates up to 3 channel deliveries within the design's ≤60s budget
 * (Req 6.4).
 *
 * Requirements: 6.4, 6.5, 6.6, 6.7
 */

import { NextResponse } from "next/server";

import { authorizeOwnership, getAuthenticatedUserId } from "@/lib/auth";
import {
  getPublishAdapter,
  isPublishChannel,
  publishVariation,
} from "@/lib/publish/publish-adapter";
import { getVariationStore } from "@/lib/server/variation-store";
import { PUBLISH_CHANNELS } from "@/lib/types";

export const runtime = "nodejs";
/** Allow up to 3 channel deliveries within the design's ≤60s publish budget. */
export const maxDuration = 60;
// Publishing is a live side-effecting mutation; never cache.
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

  // 3. Validate the requested channel (Req 6.4 — only the supported channels).
  const channel = (body ?? {}) as Record<string, unknown>;
  if (!isPublishChannel(channel.channel)) {
    return NextResponse.json(
      {
        error: "invalid_channel",
        message: `Field "channel" harus salah satu dari: ${PUBLISH_CHANNELS.join(
          ", ",
        )}.`,
      },
      { status: 400 },
    );
  }
  const targetChannel = channel.channel;

  // 4. Resolve the variation + its owner. Unknown OR not-owned → 404 (no
  //    existence leak), matching the jobs/variations route convention.
  const store = getVariationStore();
  const owned = await store.getVariation(id);
  if (!owned || !authorizeOwnership(userId, owned.ownerUserId)) {
    return NextResponse.json(
      { error: "not_found", message: "Variasi tidak ditemukan." },
      { status: 404 },
    );
  }

  // 5. Publish with the bounded ≤3-attempt retry policy (Req 6.7). The variation
  //    is never mutated, so it stays re-publishable regardless of outcome
  //    (Req 6.5).
  const result = await publishVariation(owned.variation, targetChannel, {
    adapter: getPublishAdapter(),
  });

  if (!result.success) {
    // Failure after retries: preserve the variation unchanged and report the
    // cause message (Req 6.6).
    return NextResponse.json(
      {
        error: "publish_failed",
        channel: result.channel,
        attempts: result.attempts,
        message: result.message,
        variation: owned.variation,
      },
      { status: 502 },
    );
  }

  // 6. Success: confirmation + the unchanged, still-re-publishable variation.
  return NextResponse.json(
    {
      result,
      variation: owned.variation,
    },
    { status: 200 },
  );
}
