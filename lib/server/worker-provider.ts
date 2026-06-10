/**
 * Server-side PipelineWorker provider (compatibility shim over the container).
 *
 * The job-based API routes need a SHARED {@link PipelineWorker} instance so a
 * job created by `POST /api/generate` can be polled by `GET /api/jobs/[jobId]`.
 *
 * Single source of truth: the process-wide worker singleton lives in
 * `lib/server/container.ts`. This module used to own a SEPARATE singleton,
 * which meant the two routes referenced different in-memory workers — a job
 * created via `POST /api/generate` (container) was invisible to
 * `GET /api/jobs/[jobId]` (this provider). To fix that wiring bug this provider
 * now DELEGATES to the container, so every consumer shares one worker.
 *
 * The named exports are kept for backwards compatibility with `GET
 * /api/jobs/[jobId]` and its test, but they simply forward to the container:
 *   - {@link getPipelineWorker}          → `container.getPipelineWorker`
 *   - {@link setPipelineWorkerForTesting} → `container.setPipelineWorker` /
 *                                           `container.resetContainer`
 */

import {
  getPipelineWorker as getContainerWorker,
  resetContainer,
  setPipelineWorker,
} from "@/lib/server/container";
import type { PipelineWorker } from "@/lib/pipeline/worker";

/**
 * Return the shared {@link PipelineWorker} (delegates to the container). Routes
 * call this so jobs created by `POST /api/generate` are visible to
 * `GET /api/jobs/[jobId]` — both now resolve the SAME singleton.
 */
export function getPipelineWorker(): PipelineWorker {
  return getContainerWorker();
}

/**
 * Override the shared worker (tests only). Pass `undefined` to reset back to
 * the lazily-built default. Delegates to the container so an injected worker is
 * shared by every route/provider.
 */
export function setPipelineWorkerForTesting(
  worker: PipelineWorker | undefined,
): void {
  if (worker) {
    setPipelineWorker(worker);
  } else {
    resetContainer();
  }
}
