/**
 * AI_Service_Connector (Layer 3) — pluggable adapters + retry/timeout wrapper.
 *
 * Implements the `AIServiceConnector` contract from the design
 * ("Components and Interfaces → AI_Service_Connector"):
 *   - generateCopy        (Req 3.1) — calls the LLM adapter
 *   - generateImage       (Req 3.2) — calls the image-generation adapter
 *   - removeBackground    (Req 3.4) — calls the background-removal adapter
 *   - callWithRetry       (Req 3.5, 3.6) — timeout 30s, max 3 attempts per step
 *   - *Regenerable result (Req 3.7) — manual regenerate option after success
 *
 * Design goals honoured here:
 *   - Adapters are PLUGGABLE: the connector composes three injected adapters so
 *     vendors can be swapped without touching the Pipeline_Engine.
 *   - Adapters are MOCKABLE: `MockAIServiceConnector` / mock adapters let tests
 *     run with no real network calls (succeed / fail / timeout / fail-then-succeed).
 *   - API keys come from SERVER-SIDE env vars only (see `.env.example`); they are
 *     never hardcoded. `createAIServiceConnectorFromEnv()` reads them at runtime.
 *   - The 30s timeout is INJECTABLE via a `Scheduler` (and `timeoutMs` is
 *     overridable) so tests run fast without real 30s waits — but the DEFAULT is
 *     30000 ms exactly.
 *
 * Pure-ish logic module: the only real I/O lives in the env-backed HTTP adapters
 * (`HttpLLMAdapter`, etc.), which the connector receives by injection.
 *
 * Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.7
 */

import type {
  CopyContent,
  CopyRequest,
  DecisionWeights,
  DesignBriefAnalysis,
  DesignVariation,
  ImageAsset,
  ImageRequest,
  QualityCriterion,
  QualityCriterionName,
  QualityReport,
  QualityScore,
  StepId,
  UploadedFile,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Defaults (Req 3.5, 3.6)
// ---------------------------------------------------------------------------

/** Default per-call timeout: 30 seconds (Req 3.5). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default maximum attempts per step: 3 (Req 3.6). */
export const DEFAULT_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Scheduler — injectable timer abstraction (keeps tests fast, Req 3.5)
// ---------------------------------------------------------------------------

/**
 * Timer abstraction used by `callWithRetry` for both the timeout race and the
 * inter-attempt backoff. Injecting a fake scheduler lets tests fire timeouts
 * and skip backoff delays instantly, so the real 30s default never blocks them.
 */
export interface Scheduler {
  /** Schedule `cb` to run after `ms` and return an opaque handle. */
  setTimer(cb: () => void, ms: number): unknown;
  /** Cancel a timer previously created with `setTimer`. */
  clearTimer(handle: unknown): void;
  /** Resolve after `ms` milliseconds (used for backoff between attempts). */
  delay(ms: number): Promise<void>;
}

/** Real scheduler backed by the host's `setTimeout`/`clearTimeout`. */
export const realScheduler: Scheduler = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why a step ultimately failed after exhausting retries. */
export type AIFailureReason = "timeout" | "error";

/**
 * Error thrown when a step exhausts its attempts. Identifies the failed step
 * (Req 3.5) and records how many attempts were made (never exceeds
 * `maxAttempts`, Req 3.6 / Property 13).
 */
export class AIServiceError extends Error {
  readonly step: StepId;
  readonly attempts: number;
  readonly reason: AIFailureReason;
  /** The last underlying error/timeout that caused the failure. */
  readonly lastCause?: unknown;

  constructor(params: {
    step: StepId;
    stepName?: string;
    attempts: number;
    reason: AIFailureReason;
    lastCause?: unknown;
  }) {
    const label = params.stepName
      ? `langkah ${params.step} (${params.stepName})`
      : `langkah ${params.step}`;
    const detail =
      params.reason === "timeout"
        ? `tidak menerima respons dalam batas waktu`
        : `pemanggilan layanan AI gagal`;
    super(
      `Kesalahan pada ${label}: ${detail} setelah ${params.attempts} percobaan`,
    );
    this.name = "AIServiceError";
    this.step = params.step;
    this.attempts = params.attempts;
    this.reason = params.reason;
    this.lastCause = params.lastCause;
  }
}

/** Internal marker for a timeout (so retry can classify the final failure). */
class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Pluggable adapter interfaces
// ---------------------------------------------------------------------------

/** Adapter to an external LLM provider (GPT-4o-class). Req 3.1 */
export interface LLMAdapter {
  generateCopy(req: CopyRequest): Promise<CopyContent>;
}

/** Adapter to an external image-generation provider (Flux Pro-class). Req 3.2 */
export interface ImageGenAdapter {
  generateImage(req: ImageRequest): Promise<ImageAsset>;
}

/** Adapter to an external background-removal provider (Remove.bg-class). Req 3.4 */
export interface BackgroundRemovalAdapter {
  removeBackground(asset: UploadedFile): Promise<ImageAsset>;
}

/**
 * Request payload for the Quality_Evaluator ("Creative Director" critique).
 * Bundles the rendered variation with the criteria + thresholds to assess, the
 * purpose-driven weights used for the weighted total, and the brief analysis as
 * judging context. Req 5.1, 5.2.
 */
export interface QualityEvaluationRequest {
  /** The rendered variation under evaluation. */
  variation: DesignVariation;
  /** Criteria + per-criterion thresholds being assessed (A2, A3). */
  criteria: QualityCriterion[];
  /** Purpose-driven weights for the weighted total (Req 5.2, 7.6). */
  decisionWeights: DecisionWeights;
  /** Brief analysis providing judging context (Req 4.2). */
  briefAnalysis: DesignBriefAnalysis;
}

/**
 * Adapter to an external Quality_Evaluator provider operating as a SEPARATE AI
 * role ("Creative Director") — distinct from the copy LLM and image generators
 * (Req 5.5, 5.6). Returns a {@link QualityReport} with per-criterion scores
 * (1–10), a weighted total, an indicative decision, and actionable critique.
 */
export interface QualityEvaluatorAdapter {
  evaluate(req: QualityEvaluationRequest): Promise<QualityReport>;
}

/** The three pluggable adapters the connector composes. */
export interface AIAdapters {
  llm: LLMAdapter;
  imageGen: ImageGenAdapter;
  backgroundRemoval: BackgroundRemovalAdapter;
  /**
   * Quality_Evaluator adapter — separate AI role (Req 5.5, 5.6). Optional so
   * existing connectors (and the mock, extended in task 9.2) remain
   * source-compatible; `evaluateQuality` throws a clear configuration error if
   * it is invoked without an evaluator adapter wired in.
   */
  evaluator?: QualityEvaluatorAdapter;
}

// ---------------------------------------------------------------------------
// callWithRetry options & result wrapper
// ---------------------------------------------------------------------------

/** Options for {@link callWithRetry}. Defaults: 30s timeout, 3 attempts. */
export interface CallWithRetryOptions {
  /** Per-attempt timeout. Defaults to 30000 ms (Req 3.5). */
  timeoutMs?: number;
  /** Maximum total attempts. Defaults to 3 (Req 3.6). */
  maxAttempts?: number;
  /** The pipeline step this call belongs to (named in failure errors, Req 3.5). */
  step: StepId;
  /** Optional human-readable step name included in the error message. */
  stepName?: string;
  /** Delay between attempts in ms (simple backoff). Defaults to 0. */
  backoffMs?: number;
  /** Injectable timer; defaults to {@link realScheduler}. */
  scheduler?: Scheduler;
}

/**
 * A successful step output bundled with a `regenerate` trigger (Req 3.7).
 * Calling `regenerate()` re-invokes the same underlying call (with the same
 * retry/timeout policy) and returns a fresh regenerable result.
 */
export interface RegenerableResult<T> {
  output: T;
  /** Manually regenerate this step's output. Req 3.7 */
  regenerate: () => Promise<RegenerableResult<T>>;
}

// ---------------------------------------------------------------------------
// callWithRetry — timeout + bounded retries (Req 3.5, 3.6)
// ---------------------------------------------------------------------------

/** Race a single attempt against the timeout. */
function attemptWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  scheduler: Scheduler,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const handle = scheduler.setTimer(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError());
    }, timeoutMs);

    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          scheduler.clearTimer(handle);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          scheduler.clearTimer(handle);
          reject(err);
        },
      );
  });
}

/**
 * Run `fn`, racing each attempt against a timeout and retrying on
 * failure/timeout up to `maxAttempts` total attempts (Req 3.5, 3.6).
 *
 * The number of attempts NEVER exceeds `maxAttempts` (default 3) — this is the
 * invariant Property 13 checks. After exhausting attempts it throws an
 * {@link AIServiceError} that identifies the failed step.
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: CallWithRetryOptions,
): Promise<T> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    step,
    stepName,
    backoffMs = 0,
    scheduler = realScheduler,
  } = opts;

  // Guard against nonsensical configuration; always allow at least one attempt.
  const attemptsAllowed = Math.max(1, Math.floor(maxAttempts));

  let lastCause: unknown;
  let lastReason: AIFailureReason = "error";

  for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
    try {
      return await attemptWithTimeout(fn, timeoutMs, scheduler);
    } catch (err) {
      lastCause = err;
      lastReason = err instanceof TimeoutError ? "timeout" : "error";
      if (attempt < attemptsAllowed && backoffMs > 0) {
        await scheduler.delay(backoffMs);
      }
    }
  }

  throw new AIServiceError({
    step,
    stepName,
    attempts: attemptsAllowed,
    reason: lastReason,
    lastCause,
  });
}

// ---------------------------------------------------------------------------
// AIServiceConnector interface (design contract)
// ---------------------------------------------------------------------------

/**
 * Per-call retry/timeout overrides. Each public method accepts these so the
 * Pipeline_Engine can label the step and tests can inject a fast scheduler.
 * Defaults remain 30s timeout / 3 attempts when omitted.
 */
export interface ConnectorCallOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  stepName?: string;
  backoffMs?: number;
  scheduler?: Scheduler;
}

/**
 * AI_Service_Connector contract (Layer 3). Each generation method wraps its
 * adapter call in {@link callWithRetry} (timeout 30s, ≤3 attempts) and exposes
 * a `*WithRegenerate` variant that returns a {@link RegenerableResult} so a
 * successful step can be manually regenerated (Req 3.7).
 */
export interface AIServiceConnector {
  generateCopy(req: CopyRequest, opts?: ConnectorCallOptions): Promise<CopyContent>; // Req 3.1
  generateImage(req: ImageRequest, opts?: ConnectorCallOptions): Promise<ImageAsset>; // Req 3.2
  removeBackground(asset: UploadedFile, opts?: ConnectorCallOptions): Promise<ImageAsset>; // Req 3.4

  /** Generate copy and expose a manual-regenerate trigger. Req 3.1, 3.7 */
  generateCopyWithRegenerate(
    req: CopyRequest,
    opts?: ConnectorCallOptions,
  ): Promise<RegenerableResult<CopyContent>>;
  /** Generate an image and expose a manual-regenerate trigger. Req 3.2, 3.7 */
  generateImageWithRegenerate(
    req: ImageRequest,
    opts?: ConnectorCallOptions,
  ): Promise<RegenerableResult<ImageAsset>>;
  /** Remove a background and expose a manual-regenerate trigger. Req 3.4, 3.7 */
  removeBackgroundWithRegenerate(
    asset: UploadedFile,
    opts?: ConnectorCallOptions,
  ): Promise<RegenerableResult<ImageAsset>>;

  /**
   * Evaluate a rendered variation via the separate Quality_Evaluator role and
   * return a {@link QualityReport}. Wrapped in {@link callWithRetry} with a 30s
   * timeout and ≤3 attempts, under a distinct evaluation step label. Runs inside
   * the background worker, never on the initial request. Req 5.1, 5.5, 5.8.
   */
  evaluateQuality(
    req: QualityEvaluationRequest,
    opts?: ConnectorCallOptions,
  ): Promise<QualityReport>;

  /** Shared retry/timeout wrapper. Req 3.5, 3.6 */
  callWithRetry<T>(fn: () => Promise<T>, opts: CallWithRetryOptions): Promise<T>;
}

// Pipeline step ids per the 6-step chain (design state machine).
const STEP_COPY: StepId = 3; // Copy Generation
const STEP_IMAGE: StepId = 6; // Render & Compose (image generation)
const STEP_BACKGROUND: StepId = 1; // asset prep before Brand DNA extraction

/**
 * Step id used to LABEL Quality_Evaluator failures (Req 5.8). Evaluation is not
 * a 7th pipeline step — it runs as a loop around render (step 6) in the worker —
 * so it reuses the render step id but carries a distinct step NAME so error
 * messages clearly attribute the failure to evaluation, separate from the
 * render/generation steps. The distinct name is supplied via `stepName`.
 */
const STEP_EVALUATE: StepId = 6;
/** Human-readable label for the separate evaluation step. */
const STEP_EVALUATE_NAME = "Quality Evaluation";

// ---------------------------------------------------------------------------
// DefaultAIServiceConnector — composes pluggable adapters
// ---------------------------------------------------------------------------

/**
 * Default connector composing three injected adapters. Holds no vendor logic
 * itself; each method delegates to its adapter through {@link callWithRetry}.
 *
 * Construct with real HTTP adapters in production (see
 * {@link createAIServiceConnectorFromEnv}) or mock adapters in tests.
 */
export class DefaultAIServiceConnector implements AIServiceConnector {
  private readonly adapters: AIAdapters;
  /** Connector-wide defaults (e.g. a shared scheduler for tests). */
  private readonly defaults: ConnectorCallOptions;

  constructor(adapters: AIAdapters, defaults: ConnectorCallOptions = {}) {
    this.adapters = adapters;
    this.defaults = defaults;
  }

  callWithRetry<T>(fn: () => Promise<T>, opts: CallWithRetryOptions): Promise<T> {
    return callWithRetry(fn, opts);
  }

  /** Merge per-call options over connector defaults into retry options. */
  private retryOpts(
    step: StepId,
    defaultStepName: string,
    opts?: ConnectorCallOptions,
  ): CallWithRetryOptions {
    return {
      step,
      stepName: opts?.stepName ?? defaultStepName,
      timeoutMs: opts?.timeoutMs ?? this.defaults.timeoutMs,
      maxAttempts: opts?.maxAttempts ?? this.defaults.maxAttempts,
      backoffMs: opts?.backoffMs ?? this.defaults.backoffMs,
      scheduler: opts?.scheduler ?? this.defaults.scheduler,
    };
  }

  generateCopy(req: CopyRequest, opts?: ConnectorCallOptions): Promise<CopyContent> {
    return this.callWithRetry(
      () => this.adapters.llm.generateCopy(req),
      this.retryOpts(STEP_COPY, "Copy Generation", opts),
    );
  }

  generateImage(req: ImageRequest, opts?: ConnectorCallOptions): Promise<ImageAsset> {
    return this.callWithRetry(
      () => this.adapters.imageGen.generateImage(req),
      this.retryOpts(STEP_IMAGE, "Render & Compose", opts),
    );
  }

  removeBackground(
    asset: UploadedFile,
    opts?: ConnectorCallOptions,
  ): Promise<ImageAsset> {
    return this.callWithRetry(
      () => this.adapters.backgroundRemoval.removeBackground(asset),
      this.retryOpts(STEP_BACKGROUND, "Background Removal", opts),
    );
  }

  evaluateQuality(
    req: QualityEvaluationRequest,
    opts?: ConnectorCallOptions,
  ): Promise<QualityReport> {
    return this.callWithRetry(() => {
      const evaluator = this.adapters.evaluator;
      if (!evaluator) {
        throw new Error(
          "Quality_Evaluator belum dikonfigurasi: tidak ada evaluator adapter pada AI_Service_Connector",
        );
      }
      return evaluator.evaluate(req);
    }, this.retryOpts(STEP_EVALUATE, STEP_EVALUATE_NAME, opts));
  }

  async generateCopyWithRegenerate(
    req: CopyRequest,
    opts?: ConnectorCallOptions,
  ): Promise<RegenerableResult<CopyContent>> {
    const output = await this.generateCopy(req, opts);
    return {
      output,
      regenerate: () => this.generateCopyWithRegenerate(req, opts),
    };
  }

  async generateImageWithRegenerate(
    req: ImageRequest,
    opts?: ConnectorCallOptions,
  ): Promise<RegenerableResult<ImageAsset>> {
    const output = await this.generateImage(req, opts);
    return {
      output,
      regenerate: () => this.generateImageWithRegenerate(req, opts),
    };
  }

  async removeBackgroundWithRegenerate(
    asset: UploadedFile,
    opts?: ConnectorCallOptions,
  ): Promise<RegenerableResult<ImageAsset>> {
    const output = await this.removeBackground(asset, opts);
    return {
      output,
      regenerate: () => this.removeBackgroundWithRegenerate(asset, opts),
    };
  }
}

// ---------------------------------------------------------------------------
// Env-backed HTTP adapter config (server-side only — NEVER hardcode keys)
// ---------------------------------------------------------------------------

/**
 * Connection config for an env-backed HTTP adapter. Values originate from
 * server-side environment variables (see `.env.example`); they are read at
 * construction time and never hardcoded or shipped to the client.
 */
export interface AdapterEndpointConfig {
  apiKey: string;
  baseUrl: string;
}

/** Read the three adapter configs from `process.env`. Server-side only. */
export function readAdapterConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): {
  llm: AdapterEndpointConfig;
  imageGen: AdapterEndpointConfig;
  backgroundRemoval: AdapterEndpointConfig;
  evaluator: AdapterEndpointConfig;
} {
  return {
    llm: {
      apiKey: env.LLM_API_KEY ?? "",
      baseUrl: env.LLM_API_BASE_URL ?? "",
    },
    imageGen: {
      apiKey: env.IMAGE_GEN_API_KEY ?? "",
      baseUrl: env.IMAGE_GEN_API_BASE_URL ?? "",
    },
    backgroundRemoval: {
      apiKey: env.BACKGROUND_REMOVAL_API_KEY ?? "",
      baseUrl: env.BACKGROUND_REMOVAL_API_BASE_URL ?? "",
    },
    // Quality_Evaluator is a SEPARATE AI role with its own server-side creds
    // (never NEXT_PUBLIC_*) — distinct from copy/image providers (Req 5.5, 5.6).
    evaluator: {
      apiKey: env.QUALITY_EVALUATOR_API_KEY ?? "",
      baseUrl: env.QUALITY_EVALUATOR_API_BASE_URL ?? "",
    },
  };
}

/**
 * Build a production connector from server-side env vars. The adapters issue
 * the actual network calls; this connector only wires them with the retry
 * wrapper. Timeout/retry defaults (30s / 3) apply unless overridden per call.
 *
 * NOTE: The HTTP adapters below are thin placeholders for the MVP — they make
 * no assumptions about a specific vendor's payload shape. Real request/response
 * mapping is filled in when a concrete vendor is chosen; the connector and
 * Pipeline_Engine never change because the adapters are pluggable.
 */
export function createAIServiceConnectorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AIServiceConnector {
  const cfg = readAdapterConfigFromEnv(env);
  return new DefaultAIServiceConnector({
    llm: new HttpLLMAdapter(cfg.llm),
    imageGen: new HttpImageGenAdapter(cfg.imageGen),
    backgroundRemoval: new HttpBackgroundRemovalAdapter(cfg.backgroundRemoval),
    evaluator: new HttpQualityEvaluatorAdapter(cfg.evaluator),
  });
}

function assertConfigured(cfg: AdapterEndpointConfig, vendor: string): void {
  if (!cfg.apiKey || !cfg.baseUrl) {
    throw new Error(
      `${vendor} belum dikonfigurasi: set environment variable API key & base URL sisi server`,
    );
  }
}

/** HTTP-backed LLM adapter (vendor-agnostic placeholder). Req 3.1 */
export class HttpLLMAdapter implements LLMAdapter {
  constructor(private readonly cfg: AdapterEndpointConfig) {}

  async generateCopy(_req: CopyRequest): Promise<CopyContent> {
    assertConfigured(this.cfg, "LLM provider");
    // Concrete request/response mapping is added with the chosen vendor.
    throw new Error("HttpLLMAdapter.generateCopy belum diimplementasikan");
  }
}

/** HTTP-backed image-generation adapter (vendor-agnostic placeholder). Req 3.2 */
export class HttpImageGenAdapter implements ImageGenAdapter {
  constructor(private readonly cfg: AdapterEndpointConfig) {}

  async generateImage(_req: ImageRequest): Promise<ImageAsset> {
    assertConfigured(this.cfg, "Image generation provider");
    throw new Error("HttpImageGenAdapter.generateImage belum diimplementasikan");
  }
}

/** HTTP-backed background-removal adapter (vendor-agnostic placeholder). Req 3.4 */
export class HttpBackgroundRemovalAdapter implements BackgroundRemovalAdapter {
  constructor(private readonly cfg: AdapterEndpointConfig) {}

  async removeBackground(_asset: UploadedFile): Promise<ImageAsset> {
    assertConfigured(this.cfg, "Background removal provider");
    throw new Error(
      "HttpBackgroundRemovalAdapter.removeBackground belum diimplementasikan",
    );
  }
}

/**
 * HTTP-backed Quality_Evaluator adapter (vendor-agnostic placeholder). Operates
 * as a SEPARATE AI role from copy/image and reads server-side env creds only
 * (Req 5.5, 5.6). Req 5.1
 */
export class HttpQualityEvaluatorAdapter implements QualityEvaluatorAdapter {
  constructor(private readonly cfg: AdapterEndpointConfig) {}

  async evaluate(_req: QualityEvaluationRequest): Promise<QualityReport> {
    assertConfigured(this.cfg, "Quality evaluator provider");
    throw new Error("HttpQualityEvaluatorAdapter.evaluate belum diimplementasikan");
  }
}

// ---------------------------------------------------------------------------
// Mock adapters & connector (for tests — no real network calls)
// ---------------------------------------------------------------------------

/** Behaviour a mock adapter can be configured to exhibit per call. */
export type MockBehavior = "succeed" | "fail" | "timeout" | "fail-then-succeed";

/**
 * Configuration for a {@link MockAdapter}. `failuresBeforeSuccess` controls the
 * `fail-then-succeed` mode: it fails that many times, then succeeds. This lets
 * tests exercise retry exhaustion and recovery without real network or timers.
 */
export interface MockAdapterConfig<T> {
  behavior?: MockBehavior;
  /** Value returned on success. Required unless `result` factory is given. */
  result?: T;
  /** Lazily build the success value (e.g. to echo the request). */
  resultFactory?: (...args: unknown[]) => T;
  /** Number of leading failures for `fail-then-succeed`. Defaults to 1. */
  failuresBeforeSuccess?: number;
  /** Error thrown on `fail` / leading failures. Defaults to a generic Error. */
  error?: unknown;
}

/**
 * A configurable mock for a single adapter operation. Tracks how many times it
 * was invoked so tests can assert the retry bound (≤ maxAttempts, Property 13).
 */
export class MockAdapter<TArgs extends unknown[], TResult> {
  /** Number of times this adapter operation was invoked. */
  calls = 0;
  /** Arguments captured from the most recent invocation. */
  lastArgs?: TArgs;

  constructor(private readonly cfg: MockAdapterConfig<TResult>) {}

  /**
   * Invoke the mock. With `timeout` it returns a never-resolving promise so a
   * test scheduler's timer wins the race in `callWithRetry`.
   */
  invoke(...args: TArgs): Promise<TResult> {
    this.calls += 1;
    this.lastArgs = args;
    const behavior = this.cfg.behavior ?? "succeed";
    const error = this.cfg.error ?? new Error("mock adapter failure");

    const buildResult = (): TResult => {
      if (this.cfg.resultFactory) {
        return this.cfg.resultFactory(...(args as unknown[]));
      }
      if (this.cfg.result !== undefined) return this.cfg.result;
      throw new Error("MockAdapter: no `result` or `resultFactory` configured");
    };

    switch (behavior) {
      case "succeed":
        return Promise.resolve(buildResult());
      case "fail":
        return Promise.reject(error);
      case "timeout":
        // Never settles — the callWithRetry timeout fires instead.
        return new Promise<TResult>(() => {});
      case "fail-then-succeed": {
        const threshold = this.cfg.failuresBeforeSuccess ?? 1;
        if (this.calls <= threshold) return Promise.reject(error);
        return Promise.resolve(buildResult());
      }
      default:
        return Promise.resolve(buildResult());
    }
  }
}

/** Factory for a {@link MockAIServiceConnector} with per-adapter behaviour. */
export interface MockConnectorConfig {
  copy?: MockAdapterConfig<CopyContent>;
  image?: MockAdapterConfig<ImageAsset>;
  background?: MockAdapterConfig<ImageAsset>;
  /**
   * Quality_Evaluator behaviour. Lets tests exercise evaluation success,
   * failure, timeout, and fail-then-succeed deterministically. The success
   * value defaults to {@link buildDefaultMockQualityReport} keyed off the
   * incoming {@link QualityEvaluationRequest} so the report is internally
   * consistent (per-criterion scores 1–10, weighted total, indicative decision,
   * non-empty critique, detected negative patterns). Req 5.2, 5.3, 5.7, 10.4.
   */
  evaluator?: MockAdapterConfig<QualityReport>;
  /**
   * Shared call defaults applied to every method — typically a fast test
   * `scheduler` and a small `timeoutMs` so timeouts fire instantly.
   */
  defaults?: ConnectorCallOptions;
}

/** Sensible default success payloads for the mock adapters. */
const DEFAULT_MOCK_COPY: CopyContent = {
  headline: "Mock headline",
  cta: "Mock CTA",
  alignedGoal: "Branding",
  alignedTone: "Profesional",
};

const DEFAULT_MOCK_IMAGE: ImageAsset = {
  id: "mock-image",
  url: "https://example.invalid/mock.png",
  width: 1080,
  height: 1080,
};

/** The 7 default quality criteria (A2, Req 6.2) used to synthesise a report. */
const ALL_CRITERIA: QualityCriterionName[] = [
  "Hierarchy",
  "Readability",
  "Composition",
  "BrandingConsistency",
  "Originality",
  "PremiumPerception",
  "Whitespace",
];

/** Clamp a value into the integer score range 1..10 (A1). */
function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(10, Math.max(1, Math.round(n)));
}

/**
 * Build a deterministic, internally-consistent {@link QualityReport} for the
 * mock Quality_Evaluator. Produces:
 *   - one integer Quality_Score in 1..10 for every one of the 7 criteria
 *     (defaulting to all criteria when the request lists none) — Req 5.2, 5.7;
 *   - a purpose-weighted total in 1.0..10.0 using the request's
 *     `decisionWeights` (falling back to a simple mean) — Req 5.2;
 *   - an INDICATIVE decision via the evaluator's simple ≥7.0 threshold
 *     (authoritative ACCEPT/REJECT belongs to Quality_Gate) — Req 5.4;
 *   - a non-empty critique containing at least one specific sentence for every
 *     criterion scoring below 7 — Req 5.3;
 *   - `detectedNegativePatterns` describing Negative_Patterns — Req 10.4.
 *
 * The default score is a high pass (9) so reports look "accepted" unless a test
 * overrides specific criteria via `scoreOverrides`, keeping the mock useful for
 * both ACCEPTED and REJECTED scenarios without bespoke wiring.
 */
export function buildDefaultMockQualityReport(
  req: QualityEvaluationRequest,
  scoreOverrides: Partial<Record<QualityCriterionName, number>> = {},
): QualityReport {
  const criteriaNames =
    req.criteria.length > 0
      ? req.criteria.map((c) => c.name)
      : ALL_CRITERIA;

  const scores: QualityScore[] = criteriaNames.map((criterion) => ({
    criterion,
    score: clampScore(scoreOverrides[criterion] ?? 9),
  }));

  // Weighted total using the purpose-driven weights when available; otherwise a
  // simple mean. Result is clamped to the 1.0..10.0 range (Req 5.2).
  const weights = req.decisionWeights?.weights;
  let weightedTotal: number;
  if (weights) {
    let sum = 0;
    let weightSum = 0;
    for (const { criterion, score } of scores) {
      const w = weights[criterion] ?? 0;
      sum += score * w;
      weightSum += w;
    }
    weightedTotal = weightSum > 0 ? sum / weightSum : meanScore(scores);
  } else {
    weightedTotal = meanScore(scores);
  }
  weightedTotal = Math.min(10, Math.max(1, weightedTotal));

  // Indicative evaluator decision: simple ≥7.0 threshold (Req 5.4). The
  // authoritative ACCEPT/REJECT is decided by the pure Quality_Gate (Req 6).
  const decision: QualityReport["decision"] =
    weightedTotal >= 7.0 ? "ACCEPTED" : "REJECTED";

  // Critique: at least one specific sentence per criterion scoring < 7 (Req 5.3).
  const lowScored = scores.filter((s) => s.score < 7);
  const detectedNegativePatterns: string[] = [];
  const sentences: string[] = [];
  for (const { criterion, score } of lowScored) {
    sentences.push(
      `${criterion} mendapat skor ${score} dari 10; tingkatkan aspek ${criterion} agar memenuhi ambang kualitas.`,
    );
    if (criterion === "Originality") {
      detectedNegativePatterns.push(
        "generic template look",
        "AI-generated look",
      );
    }
  }

  const critique =
    sentences.length > 0
      ? sentences.join(" ")
      : "Seluruh kriteria memenuhi ambang kualitas; tidak ada masalah signifikan yang terdeteksi.";

  return {
    variationId: req.variation.id,
    scores,
    weightedTotal,
    decision,
    critique,
    detectedNegativePatterns,
  };
}

/** Mean of the given scores, clamped to 1..10 (used as a weighted-total fallback). */
function meanScore(scores: QualityScore[]): number {
  if (scores.length === 0) return 1;
  const total = scores.reduce((acc, s) => acc + s.score, 0);
  return total / scores.length;
}

/**
 * Test connector backed by configurable {@link MockAdapter}s. Performs no real
 * network calls. Each underlying mock is exposed (`copyAdapter`, etc.) so tests
 * can assert call counts (e.g. attempts never exceed `maxAttempts`).
 *
 * Composes the same {@link DefaultAIServiceConnector} so production retry/timeout
 * behaviour is exercised — only the adapters and scheduler are swapped.
 */
export class MockAIServiceConnector
  extends DefaultAIServiceConnector
  implements AIServiceConnector
{
  readonly copyAdapter: MockAdapter<[CopyRequest], CopyContent>;
  readonly imageAdapter: MockAdapter<[ImageRequest], ImageAsset>;
  readonly backgroundAdapter: MockAdapter<[UploadedFile], ImageAsset>;
  /**
   * Mock Quality_Evaluator. Exposed so tests can assert call counts (e.g. the
   * ≤3-attempt retry bound under failure/timeout) and inspect the captured
   * {@link QualityEvaluationRequest}. Defaults to returning a consistent
   * {@link buildDefaultMockQualityReport} for the incoming request.
   */
  readonly evaluatorAdapter: MockAdapter<[QualityEvaluationRequest], QualityReport>;

  constructor(config: MockConnectorConfig = {}) {
    const copyAdapter = new MockAdapter<[CopyRequest], CopyContent>({
      result: DEFAULT_MOCK_COPY,
      ...config.copy,
    });
    const imageAdapter = new MockAdapter<[ImageRequest], ImageAsset>({
      result: DEFAULT_MOCK_IMAGE,
      ...config.image,
    });
    const backgroundAdapter = new MockAdapter<[UploadedFile], ImageAsset>({
      result: DEFAULT_MOCK_IMAGE,
      ...config.background,
    });
    // Default success builds a report keyed off the actual request so the
    // returned QualityReport is internally consistent (Req 5.2, 5.3, 5.7, 10.4).
    const evaluatorAdapter = new MockAdapter<
      [QualityEvaluationRequest],
      QualityReport
    >({
      resultFactory: (...args: unknown[]) =>
        buildDefaultMockQualityReport(args[0] as QualityEvaluationRequest),
      ...config.evaluator,
    });

    super(
      {
        llm: { generateCopy: (req) => copyAdapter.invoke(req) },
        imageGen: { generateImage: (req) => imageAdapter.invoke(req) },
        backgroundRemoval: {
          removeBackground: (asset) => backgroundAdapter.invoke(asset),
        },
        evaluator: { evaluate: (req) => evaluatorAdapter.invoke(req) },
      },
      config.defaults,
    );

    this.copyAdapter = copyAdapter;
    this.imageAdapter = imageAdapter;
    this.backgroundAdapter = backgroundAdapter;
    this.evaluatorAdapter = evaluatorAdapter;
  }
}

/**
 * Build an in-memory {@link Scheduler} useful for tests. Timers are tracked and
 * can be fired synchronously via `flush()`, and `delay()` resolves immediately
 * so inter-attempt backoff never blocks. This keeps the default 30s timeout
 * from ever waiting in tests.
 */
export function createControllableScheduler(): Scheduler & {
  /** Immediately fire all pending timers (simulating elapsed time). */
  flush: () => void;
  /** Number of currently pending timers. */
  pending: () => number;
} {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimer(cb, _ms) {
      const id = nextId++;
      timers.set(id, cb);
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle as number);
    },
    delay() {
      return Promise.resolve();
    },
    flush() {
      for (const [id, cb] of [...timers.entries()]) {
        timers.delete(id);
        cb();
      }
    },
    pending() {
      return timers.size;
    },
  };
}
