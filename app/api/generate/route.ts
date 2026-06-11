/**
 * POST /api/generate (task 8.2).
 *
 * Entry point of the async job model (design "Alur Permintaan Generasi"):
 *   1. Read the authenticated user id from the trusted middleware-injected
 *      header (`x-fdg-user-id` via `getAuthenticatedUser`); reject 401 if absent.
 *   2. Server-side validate the brief with `Brief_Intake.validateBrief`. On
 *      invalid input return 400 with `errors` + `preservedValues` (Req 1.3).
 *   3. Enforce the plan rule for the variation count (9 is Pro-only, Req 8.4/8.5).
 *   4. Create the job via `PipelineWorker.createJob` — this atomically reserves
 *      1 credit per variation (Req 8.2). On `InsufficientCreditError` return 402
 *      with the Pro upgrade prompt WITHOUT deducting (Req 8.3).
 *   5. Reply `202 { jobId }` immediately and run `worker.runJob(jobId)` in the
 *      background via `waitUntil` (the pipeline must not block the response).
 *
 * Runtime config (design "Deployment di Vercel"): Node.js runtime (canvas/PDF
 * need Node, not edge) and a high `maxDuration` so the background pipeline has
 * time to finish within the invocation.
 *
 * Requirements: 2.1, 8.2, 8.3, 1.3, 1.1, 1.4, 2.5, 2.6, 2.8
 */

import { NextResponse, type NextRequest } from "next/server";

import { getAuthenticatedUser } from "@/lib/auth";
import { validateBrief } from "@/lib/intake/brief-intake";
import { validateProfessionalBrief } from "@/lib/intelligence/professional-brief";
import { isVariationCount } from "@/lib/credit/credit-manager";
import { PLAN_VARIATION_RULES } from "@/lib/credit/credit-manager";
import { InsufficientCreditError } from "@/lib/pipeline/worker";
import { getPipelineWorker } from "@/lib/server/container";
import type {
  DesignBriefInput,
  Plan,
  ProfessionalBriefFields,
} from "@/lib/types";

// --- Vercel route segment config (design "Deployment di Vercel") -------------
/** Node.js runtime — canvas/PDF need Node, not the edge runtime. */
export const runtime = "nodejs";
/** High duration so the background pipeline (≤6 AI calls) can complete (Pro: 300s). */
export const maxDuration = 300;

/**
 * Coerce an unknown JSON body into a {@link DesignBriefInput}-shaped object.
 * We do NOT trust the client: `validateBrief` enforces the field rules, and the
 * variation-count / plan checks below reject anything out of range. Optional
 * fields are passed through as-is so `preservedValues` echoes the input (Req 1.3).
 *
 * Professional_Mode is additive and OFF by default: `professionalMode` is only
 * `true` when the client explicitly sends `true`, otherwise it is absent and the
 * base (non-professional) flow is unchanged (Req 1.1, 1.4). When present, the
 * professional brief fields are coerced and passed through so the conditional
 * `validateProfessionalBrief` (Req 2.x) and the worker (FASE PRA) can read them.
 */
function asBriefInput(body: unknown): DesignBriefInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const brief: DesignBriefInput = {
    brandName: typeof b.brandName === "string" ? b.brandName : "",
    tagline: typeof b.tagline === "string" ? b.tagline : undefined,
    mainMessage: typeof b.mainMessage === "string" ? b.mainMessage : undefined,
    contentGoal: b.contentGoal as DesignBriefInput["contentGoal"],
    visualStyle: b.visualStyle as DesignBriefInput["visualStyle"],
    tone: b.tone as DesignBriefInput["tone"],
    outputFormat: b.outputFormat as DesignBriefInput["outputFormat"],
    variationCount: b.variationCount as DesignBriefInput["variationCount"],
    accentPalette: Array.isArray(b.accentPalette)
      ? (b.accentPalette as string[])
      : [],
    mandatoryElements: Array.isArray(b.mandatoryElements)
      ? (b.mandatoryElements as DesignBriefInput["mandatoryElements"])
      : [],
    uploadedAssets: Array.isArray(b.uploadedAssets)
      ? (b.uploadedAssets as DesignBriefInput["uploadedAssets"])
      : [],
  };

  // Req 1.1, 1.4 — Professional_Mode defaults to OFF; only ON when explicit true.
  if (b.professionalMode === true) {
    brief.professionalMode = true;
    brief.professional = asProfessionalFields(b.professional);
  }

  return brief;
}

/**
 * Coerce an unknown value into a {@link ProfessionalBriefFields}-shaped object.
 * Field rules (required / 7-word limit / valid Design_Purpose) are enforced by
 * `validateProfessionalBrief`; this only normalises the shape so values are
 * preserved unchanged for the validator and the worker (Req 2.1, 2.8).
 */
function asProfessionalFields(value: unknown): ProfessionalBriefFields {
  const p = (value ?? {}) as Record<string, unknown>;
  const audience = (p.audience ?? {}) as Record<string, unknown>;
  return {
    designPurpose: p.designPurpose as ProfessionalBriefFields["designPurpose"],
    audience: {
      age: typeof audience.age === "string" ? audience.age : undefined,
      profession:
        typeof audience.profession === "string"
          ? audience.profession
          : undefined,
      painPoint:
        typeof audience.painPoint === "string"
          ? audience.painPoint
          : undefined,
    },
    primaryGoal: typeof p.primaryGoal === "string" ? p.primaryGoal : "",
    emotionTarget: typeof p.emotionTarget === "string" ? p.emotionTarget : "",
    coreMessage: typeof p.coreMessage === "string" ? p.coreMessage : "",
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Authentication — trust only the middleware-injected header.
  const user = getAuthenticatedUser(request.headers);
  if (!user) {
    return NextResponse.json(
      {
        error: "unauthorized",
        message: "Permintaan tidak terautentikasi.",
      },
      { status: 401 },
    );
  }

  // Parse the JSON body defensively.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Body permintaan bukan JSON yang valid." },
      { status: 400 },
    );
  }

  const brief = asBriefInput(body);

  // 2. Server-side brief validation (Req 1.3): preserve input values on reject.
  const validation = validateBrief(brief);
  if (!validation.valid) {
    return NextResponse.json(
      {
        error: "invalid_brief",
        errors: validation.errors,
        preservedValues: validation.preservedValues,
      },
      { status: 400 },
    );
  }

  // 2b. Professional brief validation — conditional on Professional_Mode (Req 2.1).
  //     When ON, enforce the enhanced rules (required Design_Purpose / primary
  //     goal / core message + 7-word limit) and preserve values on reject
  //     (Req 2.5, 2.6, 2.8). When OFF/absent this is a no-op (Req 1.4).
  const professionalValidation = validateProfessionalBrief(brief);
  if (!professionalValidation.valid) {
    return NextResponse.json(
      {
        error: "invalid_brief",
        errors: professionalValidation.errors,
        preservedValues: professionalValidation.preservedValues,
      },
      { status: 400 },
    );
  }

  // 3. Variation count must be one of 3/6/9 and allowed for the user's plan.
  if (!isVariationCount(brief.variationCount)) {
    return NextResponse.json(
      {
        error: "invalid_variation_count",
        message: "Jumlah variasi harus 3, 6, atau 9.",
      },
      { status: 400 },
    );
  }

  const plan: Plan = user.plan ?? "Free";
  if (!PLAN_VARIATION_RULES[plan].includes(brief.variationCount)) {
    // 9 variations is a Pro feature (Req 8.4/8.5) — surface the upgrade prompt.
    return NextResponse.json(
      {
        error: "plan_restriction",
        upgradePrompt: true,
        message:
          "Jumlah variasi 9 hanya tersedia pada paket Pro. Upgrade ke Pro untuk mengaktifkannya.",
      },
      { status: 403 },
    );
  }

  // 4. Create the job: atomic credit reserve (1/variation). Insufficient → 402.
  const worker = getPipelineWorker();
  let jobId: string;
  try {
    const job = await worker.createJob(brief, brief.variationCount, user.userId);
    jobId = job.id;
  } catch (error) {
    if (error instanceof InsufficientCreditError) {
      // Req 8.3 — reject without deducting; include the Pro upgrade prompt.
      return NextResponse.json(
        {
          error: "insufficient_credit",
          upgradePrompt: error.upgradePrompt,
          message: error.message,
        },
        { status: 402 },
      );
    }
    return NextResponse.json(
      {
        error: "job_creation_failed",
        message: "Gagal membuat job generasi. Silakan coba lagi.",
      },
      { status: 500 },
    );
  }

  // 5. Run the pipeline SYNCHRONOUSLY and return the result directly.
  //    This avoids the in-memory job polling problem on serverless (Vercel)
  //    where GET /api/jobs/[jobId] may hit a different instance.
  try {
    await worker.runJob(jobId);
  } catch (error) {
    console.error("[generate] pipeline error:", error);
  }

  // Read the final job status to determine the outcome.
  const status = await worker.getJobStatus(jobId, user.userId);

  if (status?.state === "done" && status.resultBatchId) {
    // Load the batch from history (persisted by onBatch sink in the same invocation).
    let batch: import("@/lib/types").GenerationBatch | undefined;
    try {
      const { getHistoryManager } = await import("@/lib/server/history-provider");
      const record = await getHistoryManager().loadBatch(status.resultBatchId);
      batch = record?.batch;
    } catch {
      // Non-fatal: batch not in history yet, but we still have the status.
    }

    return NextResponse.json(
      { jobId, resultBatchId: status.resultBatchId, status, batch: batch ?? null },
      { status: 200 },
    );
  }

  // Pipeline failed — return the failure info.
  return NextResponse.json(
    {
      jobId,
      status,
      error: "generation_failed",
      message: status?.message ?? "Pipeline generasi gagal.",
    },
    { status: 500 },
  );
}
