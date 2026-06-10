import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  AIServiceError,
  MockAIServiceConnector,
  createControllableScheduler,
  type ConnectorCallOptions,
} from "@/lib/ai/connector";
import type {
  CopyRequest,
  ImageRequest,
  UploadedFile,
  BrandDNA,
  DesignBriefInput,
  ImagePrompt,
  OutputFormat,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Property 13: Batas maksimum percobaan ulang (AI & publikasi)
//
// Feature: feed-design-generator, Property 13: Untuk setiap operasi yang terus
// gagal, jumlah percobaan tidak pernah melebihi 3 — baik untuk pemanggilan
// layanan AI per langkah maupun untuk publikasi per permintaan. (Generalised
// here to any maxAttempts: the attempt count never exceeds the configured
// maxAttempts.)
//
// Validates: Requirements 3.6, 6.7
// ---------------------------------------------------------------------------

// Minimal fixtures for the three connector operations. Their contents are
// irrelevant — every adapter is configured to keep failing, so the call never
// produces a meaningful result; we only care about the attempt count.
const brief: DesignBriefInput = {
  brandName: "Acme",
  contentGoal: "Branding",
  visualStyle: "Minimalis",
  tone: "Profesional",
  outputFormat: { name: "Square", width: 1080, height: 1080 },
  variationCount: 3,
  accentPalette: ["#000000"],
  mandatoryElements: [],
  uploadedAssets: [],
};
const brandDna: BrandDNA = {
  brandName: "Acme",
  accentPalette: ["#000000"],
  tone: "Profesional",
  visualStyle: "Minimalis",
};
const copyReq: CopyRequest = {
  brief,
  brandDna,
  contentGoal: "Branding",
  tone: "Profesional",
};
const imagePrompt: ImagePrompt = { prompt: "x" };
const outputFormat: OutputFormat = { name: "Square", width: 1080, height: 1080 };
const imageReq: ImageRequest = { imagePrompt, format: outputFormat };
const upload: UploadedFile = {
  name: "a.png",
  mimeType: "image/png",
  sizeBytes: 1234,
};

type Op = "copy" | "image" | "background";

/**
 * Drive a connector call to completion using a controllable scheduler so that
 * `timeout` behaviour fires instantly (no real 30s wait). Repeatedly flushes
 * pending timers between microtasks until the promise settles.
 */
async function runToCompletion<T>(promise: Promise<T>, scheduler: ReturnType<typeof createControllableScheduler>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  promise.then(
    (value) => {
      result = { ok: true, value };
    },
    (error) => {
      result = { ok: false, error };
    },
  );
  // Spin the event loop, firing any scheduled timeouts instantly, until settled.
  // Guard with an iteration cap so a logic regression can't hang the suite.
  for (let i = 0; i < 1000 && result === undefined; i++) {
    if (scheduler.pending() > 0) scheduler.flush();
    await Promise.resolve();
  }
  if (result === undefined) {
    throw new Error("connector call did not settle (possible infinite retry)");
  }
  return result;
}

describe("Property 13: Batas maksimum percobaan ulang (AIServiceConnector)", () => {
  it("never exceeds maxAttempts for any continually-failing AI operation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }), // arbitrary maxAttempts in 1..5 (default is 3)
        fc.constantFrom<Op>("copy", "image", "background"),
        fc.constantFrom<"fail" | "timeout">("fail", "timeout"),
        async (maxAttempts, op, behavior) => {
          // Fresh controllable scheduler so timeouts fire instantly.
          const scheduler = createControllableScheduler();

          // Configure ALL adapters to keep failing (fail or never-resolving timeout).
          const failCfg = { behavior } as const;
          const connector = new MockAIServiceConnector({
            copy: failCfg,
            image: failCfg,
            background: failCfg,
          });

          const callOpts: ConnectorCallOptions = {
            maxAttempts,
            timeoutMs: 50, // small; the controllable scheduler fires it instantly anyway
            scheduler,
          };

          let promise: Promise<unknown>;
          let adapter:
            | typeof connector.copyAdapter
            | typeof connector.imageAdapter
            | typeof connector.backgroundAdapter;
          switch (op) {
            case "copy":
              promise = connector.generateCopy(copyReq, callOpts);
              adapter = connector.copyAdapter;
              break;
            case "image":
              promise = connector.generateImage(imageReq, callOpts);
              adapter = connector.imageAdapter;
              break;
            default:
              promise = connector.removeBackground(upload, callOpts);
              adapter = connector.backgroundAdapter;
              break;
          }

          const outcome = await runToCompletion(promise, scheduler);

          // The operation always fails after exhausting attempts...
          expect(outcome.ok).toBe(false);
          if (!outcome.ok) {
            expect(outcome.error).toBeInstanceOf(AIServiceError);
            // ...and reports exactly the configured number of attempts.
            expect((outcome.error as AIServiceError).attempts).toBe(maxAttempts);
          }

          // INVARIANT: the adapter was invoked exactly maxAttempts times and
          // never more — the retry count never exceeds the bound.
          expect(adapter.calls).toBe(maxAttempts);
          expect(adapter.calls).toBeLessThanOrEqual(maxAttempts);
        },
      ),
      { numRuns: 100 },
    );
  });
});
