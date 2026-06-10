/**
 * `GET /api/batches/[id]/intelligence` — serve the Design_Intelligence artefacts
 * produced for a generation batch (task 17.2).
 *
 * Backs the read-only artefact view (Req 4.5): when a user opens a
 * Generation_Batch that was generated with Professional_Mode active, the System
 * displays its `Design_Brief_Analysis`, `Visual_Strategy`, and per-variation
 * `Quality_Report`s. Those artefacts are persisted alongside the batch by the
 * worker's `onBatch` sink (`lib/server/container.ts`) into the
 * {@link BatchIntelligenceStore} seam (Req 4.4). The handler is strictly
 * READ-ONLY and IDEMPOTENT — it never triggers generation.
 *
 * The `[id]` path segment is the batch id.
 *
 * Authentication & authorization (Req 11.6):
 *   - The authenticated user id is read from the trusted middleware-injected
 *     header (`x-fdg-user-id`, see `lib/auth.ts`). Absent ⇒ 401.
 *   - Ownership is exact-match (`authorizeOwnership`). To avoid leaking the
 *     existence of another user's batch, an UNKNOWN batch and a CROSS-USER batch
 *     are BOTH collapsed into a 404 — consistent with the jobs/variations routes
 *     and the design's stated convention ("akses lintas-pengguna → 404").
 *
 * Response on success (200): the artefacts for the batch. For a batch generated
 * WITHOUT Professional_Mode there are no reasoning artefacts, so the payload
 * reports `professionalMode: false` with `null`/empty artefact fields rather
 * than 404 — the batch exists and is owned by the caller (Req 4.5).
 *
 * Runtime: Node.js (consistent with the rest of the API). `maxDuration` is kept
 * short since this is a quick read.
 *
 * Requirements: 4.5, 11.6
 */

import { NextResponse } from "next/server";

import { authorizeOwnership, getAuthenticatedUserId } from "@/lib/auth";
import { getBatchIntelligenceStore } from "@/lib/server/batch-intelligence-store";
import type {
  DesignBriefAnalysis,
  QualityReport,
  VisualStrategy,
} from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 15;
// Reflects per-user, per-batch state; never cache the response.
export const dynamic = "force-dynamic";

/** Shape returned to the client for a batch's Design_Intelligence artefacts. */
interface BatchIntelligenceResponse {
  batchId: string;
  /** Whether the batch was generated with Professional_Mode active (Req 4.5). */
  professionalMode: boolean;
  /** Brief analysis artefact, or `null` for non-Professional_Mode batches. */
  briefAnalysis: DesignBriefAnalysis | null;
  /** Visual strategy artefact, or `null` for non-Professional_Mode batches. */
  visualStrategy: VisualStrategy | null;
  /** Per-variation quality reports (empty for non-Professional_Mode batches). */
  qualityReports: QualityReport[];
}

export async function GET(
  request: Request,
  context: { params: { id: string } },
): Promise<NextResponse> {
  const { id } = context.params;

  // Trusted identity injected by the auth middleware. Absent only if the
  // middleware did not run (should not happen for /api/*) — fail closed (401).
  const userId = getAuthenticatedUserId(request.headers);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "Permintaan tidak terautentikasi." },
      { status: 401 },
    );
  }

  if (!id) {
    return NextResponse.json(
      { error: "not_found", message: "Batch tidak ditemukan." },
      { status: 404 },
    );
  }

  // Idempotent, read-only lookup. The store records the owning user alongside
  // the artefacts so we can enforce ownership without leaking existence.
  const record = await getBatchIntelligenceStore().getBatchIntelligence(id);

  // Collapse "unknown" and "not owned" into a single 404 (Req 11.6): never
  // reveal that another user's batch exists.
  if (!record || !authorizeOwnership(userId, record.ownerUserId)) {
    return NextResponse.json(
      { error: "not_found", message: "Batch tidak ditemukan." },
      { status: 404 },
    );
  }

  const body: BatchIntelligenceResponse = {
    batchId: record.batchId,
    professionalMode: record.professionalMode,
    briefAnalysis: record.briefAnalysis ?? null,
    visualStrategy: record.visualStrategy ?? null,
    qualityReports: record.qualityReports ?? [],
  };

  return NextResponse.json(body, { status: 200 });
}
