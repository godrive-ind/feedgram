/**
 * `GET /api/jobs/[jobId]` — poll the status of a generation job (task 8.3).
 *
 * Backs the frontend progress polling described in the design's async job model
 * ("Alur Permintaan Generasi"). The handler is strictly READ-ONLY and
 * IDEMPOTENT: it reads the persisted `JobStatus` and NEVER triggers pipeline
 * execution (`runJob`), so repeated polling has no side effects (Req 2.9).
 *
 * Response on success (200): the full {@link JobStatus} JSON — `state`,
 * `currentStep`, the active step's human-readable name, the per-step `statuses`
 * map, and (when present) `resultBatchId` / `failedStep` / `message`. This is
 * exactly what the progress indicator needs: active step number + name + status
 * of each step (Req 2.9).
 *
 * Authorization: the authenticated user id is read from the trusted
 * middleware-injected header (`x-fdg-user-id`, see `lib/auth.ts`). The worker's
 * `getJobStatus(jobId, ownerUserId)` enforces per-user ownership and returns
 * `undefined` for BOTH a non-owned and an unknown job — it deliberately
 * collapses the two cases so the API never leaks whether a job belonging to
 * another user exists.
 *
 * Ownership response code — deliberate choice (documented per task 8.3):
 *   The design lists "cross-user access => 403, unknown => 404". However the
 *   worker/job-store contract intentionally hides the existence of other users'
 *   jobs (returning `undefined` for non-owned), which is the more secure
 *   behaviour and is explicitly called out as acceptable. We therefore return
 *   **404 for both unknown and non-owned jobs** to avoid leaking existence,
 *   and reserve **401** for the (should-not-happen) case where the trusted
 *   user header is absent.
 *
 * Runtime: Node.js (consistent with the rest of the pipeline, which uses
 * canvas/PDF libraries unavailable on the Edge runtime). `maxDuration` is kept
 * short (15s) — matching `vercel.json` — since this is a quick status read.
 *
 * Requirements: 2.9
 */

import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "@/lib/auth";
import { getPipelineWorker } from "@/lib/server/worker-provider";
import type { JobStatus, StepId } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 15;
// Status changes per request; never cache the polling response.
export const dynamic = "force-dynamic";

/** Human-readable names of the 6 pipeline steps (Req 2.9 — "nama langkah"). */
const STEP_NAMES: Record<StepId, string> = {
  1: "Brand DNA Extraction",
  2: "Design System Selection",
  3: "Copy Generation",
  4: "Layout Composition",
  5: "Image Prompt Build",
  6: "Render & Compose",
};

/** Shape returned to the client: the JobStatus plus the active step's name. */
interface JobStatusResponse extends JobStatus {
  /** Name of the currently-active step (`currentStep`), for the progress UI. */
  currentStepName: string;
}

export async function GET(
  _request: Request,
  context: { params: { jobId: string } },
): Promise<NextResponse> {
  const { jobId } = context.params;

  // Trusted identity injected by the auth middleware. Absent only if the
  // middleware did not run (should not happen for /api/*) — fail closed.
  const userId = getAuthenticatedUserId(_request.headers);
  if (!userId) {
    return NextResponse.json(
      {
        error: "unauthorized",
        message: "Permintaan tidak terautentikasi.",
      },
      { status: 401 },
    );
  }

  if (!jobId) {
    return NextResponse.json(
      { error: "not_found", message: "Job tidak ditemukan." },
      { status: 404 },
    );
  }

  // Idempotent, read-only status read. Ownership enforced by the worker:
  // undefined => unknown OR not owned by this user (existence is not leaked).
  const worker = getPipelineWorker();
  const status = await worker.getJobStatus(jobId, userId);

  if (!status) {
    return NextResponse.json(
      { error: "not_found", message: "Job tidak ditemukan." },
      { status: 404 },
    );
  }

  const body: JobStatusResponse = {
    ...status,
    currentStepName: STEP_NAMES[status.currentStep],
  };

  return NextResponse.json(body, { status: 200 });
}
