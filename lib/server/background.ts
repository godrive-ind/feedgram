/**
 * Background-execution helper (task 8.2 support).
 *
 * The async job model requires `POST /api/generate` to return `202 { jobId }`
 * immediately while the 6-step pipeline runs *after* the response, within the
 * same function invocation's lifetime (design "Deployment di Vercel →
 * Eksekusi background": Vercel `waitUntil` / fluid compute for the MVP).
 *
 * `runInBackground` schedules work without blocking the response:
 *   1. Prefer Vercel's `waitUntil` from `@vercel/functions` when available — it
 *      keeps the function alive until the promise settles. (Optional dependency:
 *      resolved dynamically so the project builds/tests without it installed.)
 *   2. Fall back to the `waitUntil` exposed on the request context, if provided
 *      by the caller (e.g. from `next/server`).
 *   3. Otherwise fire-and-forget: start the promise and swallow rejections so an
 *      unhandled rejection never crashes the runtime. (Pipeline failures are
 *      already recorded in `JobStatus` by the worker, so losing the in-flight
 *      promise only matters for local/non-Vercel environments.)
 *
 * The work promise must never reject in a way that matters to the HTTP response
 * — the worker records failures in `JobStatus` (Req 2.10), and the frontend
 * polls `GET /api/jobs/{jobId}` for the outcome (Req 2.9).
 */

/** A `waitUntil`-style function that extends the runtime lifetime. */
export type WaitUntil = (promise: Promise<unknown>) => void;

/** Attempt to resolve Vercel's `waitUntil` from the optional `@vercel/functions`. */
async function resolveVercelWaitUntil(): Promise<WaitUntil | undefined> {
  try {
    // Dynamic import keeps this an OPTIONAL dependency: the bundle/tests do not
    // require `@vercel/functions` to be installed. On Vercel it is available.
    // The specifier is built at runtime so the type-checker/bundler does not
    // attempt to statically resolve the (possibly absent) module.
    const moduleName = ["@vercel", "functions"].join("/");
    const dynamicImport = new Function(
      "m",
      "return import(m);",
    ) as (m: string) => Promise<{ waitUntil?: WaitUntil }>;
    const mod = await dynamicImport(moduleName).catch(
      () => ({}) as { waitUntil?: WaitUntil },
    );
    return typeof mod.waitUntil === "function" ? mod.waitUntil : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Schedule `work` to run in the background. Returns immediately; never throws.
 *
 * @param work    A factory that starts the background work and returns its promise.
 * @param explicitWaitUntil Optional `waitUntil` provided by the caller's runtime
 *                          context (takes precedence over the dynamic lookup).
 */
export function runInBackground(
  work: () => Promise<unknown>,
  explicitWaitUntil?: WaitUntil,
): void {
  // Start the work eagerly so it begins regardless of how it is awaited, and
  // guard against unhandled rejections in every path.
  const promise = Promise.resolve()
    .then(work)
    .catch((error) => {
      // Failures are persisted in JobStatus by the worker; log for diagnostics.
      console.error("[background] pipeline worker task failed:", error);
    });

  if (explicitWaitUntil) {
    explicitWaitUntil(promise);
    return;
  }

  // Best-effort: hand the promise to Vercel's waitUntil if present. We don't
  // await this resolution — the work has already started; this only extends the
  // function lifetime when running on Vercel.
  void resolveVercelWaitUntil().then((waitUntil) => {
    if (waitUntil) waitUntil(promise);
  });
}
