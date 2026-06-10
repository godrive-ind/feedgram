/**
 * Publish adapter (Layer 5 support — task 12.8).
 *
 * `POST /api/publish/[id]` sends a {@link DesignVariation} to a social channel
 * (Instagram / Facebook / LinkedIn). Per design "Components and Interfaces →
 * Export_Manager", `publish` must:
 *   - deliver the variation to the chosen channel (Req 6.4),
 *   - retry up to 3 times per request on failure (Req 6.7),
 *   - preserve the variation unchanged regardless of outcome and surface the
 *     failure cause (Req 6.6 / 6.5).
 *
 * The actual channel integration is vendor-specific, so — mirroring the
 * pluggable-seam pattern used by `lib/storage/object-storage.ts` and the
 * AI_Service_Connector — this module exposes:
 *
 *   - a small {@link PublishAdapter} contract (a single `deliver` attempt),
 *   - a default in-memory implementation ({@link InMemoryPublishAdapter}) that
 *     records published items and is configurable for tests,
 *   - an injectable provider ({@link getPublishAdapter} / {@link setPublishAdapter}
 *     / {@link resetPublishAdapter}) so the route is testable and a real
 *     channel-backed adapter can be dropped in later WITHOUT touching the
 *     handler,
 *   - a {@link publishVariation} orchestrator that applies the ≤3-attempt retry
 *     policy (Req 6.7) and produces a {@link PublishResult}, mirroring the
 *     `callWithRetry` convention from `lib/ai/connector.ts`.
 *
 * NOTE: this module deliberately does NOT live in / touch
 * `lib/export/export-manager.ts` (owned by sibling export tasks). It only
 * implements the publish slice of the Export_Manager responsibility.
 *
 * Requirements: 6.4, 6.5, 6.6, 6.7
 */

import {
  PUBLISH_CHANNELS,
  type DesignVariation,
  type PublishChannel,
  type PublishResult,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Maximum delivery attempts per publish request (Req 6.7). */
export const MAX_PUBLISH_ATTEMPTS = 3;

/** Type guard: whether an arbitrary value is a supported publish channel. */
export function isPublishChannel(value: unknown): value is PublishChannel {
  return (
    typeof value === "string" &&
    (PUBLISH_CHANNELS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

/** Outcome of a single delivery attempt to a channel. */
export interface PublishDelivery {
  /** Whether this single attempt succeeded. */
  ok: boolean;
  /** Channel-side reference/post id returned on success (optional). */
  reference?: string;
  /** Human-readable cause message when `ok` is false (Req 6.6). */
  message?: string;
}

/**
 * Pluggable boundary to a social channel. A single `deliver` call represents
 * ONE delivery attempt; the ≤3-attempt retry policy is applied by
 * {@link publishVariation}, not the adapter.
 *
 * An implementation may either return `{ ok: false, message }` or throw — both
 * are treated as a failed attempt by the orchestrator.
 */
export interface PublishAdapter {
  deliver(
    variation: DesignVariation,
    channel: PublishChannel,
  ): Promise<PublishDelivery>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + local wiring; not for production)
// ---------------------------------------------------------------------------

/** Behaviour the in-memory adapter can be configured to exhibit. */
export type PublishBehavior = "succeed" | "fail" | "fail-then-succeed";

/** A record of a successfully delivered variation. */
export interface PublishedRecord {
  variationId: string;
  channel: PublishChannel;
  reference: string;
}

/** Configuration for {@link InMemoryPublishAdapter}. */
export interface InMemoryPublishAdapterConfig {
  /** How the adapter behaves on each attempt. Defaults to `"succeed"`. */
  behavior?: PublishBehavior;
  /** Leading failures before success for `fail-then-succeed`. Defaults to 1. */
  failuresBeforeSuccess?: number;
  /** Cause message returned on a failed attempt. */
  failureMessage?: string;
  /** If set, `deliver` throws this instead of returning `{ ok: false }`. */
  throwOnFail?: unknown;
}

/**
 * In-memory {@link PublishAdapter}. Records every successful delivery so tests
 * (and local wiring) can assert what was published, and exposes a call counter
 * so the ≤3-attempt retry bound can be verified. Production substitutes a real
 * channel-backed adapter behind the same contract.
 */
export class InMemoryPublishAdapter implements PublishAdapter {
  /** Number of `deliver` invocations (across all variations/channels). */
  calls = 0;
  /** Successful deliveries, in order. */
  readonly published: PublishedRecord[] = [];

  constructor(private readonly config: InMemoryPublishAdapterConfig = {}) {}

  async deliver(
    variation: DesignVariation,
    channel: PublishChannel,
  ): Promise<PublishDelivery> {
    this.calls += 1;
    const behavior = this.config.behavior ?? "succeed";
    const failureMessage =
      this.config.failureMessage ?? `Gagal mengirim ke kanal ${channel}.`;

    const fail = (): PublishDelivery => {
      if (this.config.throwOnFail !== undefined) {
        throw this.config.throwOnFail;
      }
      return { ok: false, message: failureMessage };
    };

    const succeed = (): PublishDelivery => {
      const reference = `${channel}:${variation.id}:${this.calls}`;
      this.published.push({ variationId: variation.id, channel, reference });
      return { ok: true, reference };
    };

    switch (behavior) {
      case "succeed":
        return succeed();
      case "fail":
        return fail();
      case "fail-then-succeed": {
        const threshold = this.config.failuresBeforeSuccess ?? 1;
        return this.calls <= threshold ? fail() : succeed();
      }
      default:
        return succeed();
    }
  }
}

// ---------------------------------------------------------------------------
// Injectable provider (mockable seam)
// ---------------------------------------------------------------------------

let publishAdapterSingleton: PublishAdapter | undefined;

/**
 * Resolve the process-wide {@link PublishAdapter}, lazily building an in-memory
 * adapter on first use. Production wiring (a real channel-backed adapter)
 * substitutes its own via {@link setPublishAdapter} without changing the route.
 */
export function getPublishAdapter(): PublishAdapter {
  if (!publishAdapterSingleton) {
    publishAdapterSingleton = new InMemoryPublishAdapter();
  }
  return publishAdapterSingleton;
}

/** Inject a specific publish adapter (tests and alternative wirings). */
export function setPublishAdapter(adapter: PublishAdapter): void {
  publishAdapterSingleton = adapter;
}

/** Reset the seam (test helper) so the next access rebuilds the default. */
export function resetPublishAdapter(): void {
  publishAdapterSingleton = undefined;
}

// ---------------------------------------------------------------------------
// publishVariation — bounded retry orchestrator (Req 6.4, 6.6, 6.7)
// ---------------------------------------------------------------------------

/** Options for {@link publishVariation}. */
export interface PublishVariationOptions {
  /** Adapter to use; defaults to {@link getPublishAdapter}. */
  adapter?: PublishAdapter;
  /** Maximum attempts per request; defaults to {@link MAX_PUBLISH_ATTEMPTS}. */
  maxAttempts?: number;
}

/**
 * Send `variation` to `channel`, retrying on failure up to `maxAttempts` total
 * attempts (default 3, Req 6.7). Each failed attempt — whether the adapter
 * returns `{ ok: false }` or throws — is retried until an attempt succeeds or
 * attempts are exhausted.
 *
 * Returns a {@link PublishResult}:
 *   - success → `{ success: true, channel, attempts: <attempt that worked> }`
 *   - failure → `{ success: false, channel, attempts: <maxAttempts>, message }`
 *     where `message` explains the cause of the last failure (Req 6.6).
 *
 * This function NEVER mutates `variation`, so the caller can keep it
 * re-publishable regardless of outcome (Req 6.5).
 */
export async function publishVariation(
  variation: DesignVariation,
  channel: PublishChannel,
  opts: PublishVariationOptions = {},
): Promise<PublishResult> {
  const adapter = opts.adapter ?? getPublishAdapter();
  const maxAttempts = Math.max(
    1,
    Math.floor(opts.maxAttempts ?? MAX_PUBLISH_ATTEMPTS),
  );

  let lastMessage = `Publikasi ke kanal ${channel} gagal.`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let delivery: PublishDelivery;
    try {
      delivery = await adapter.deliver(variation, channel);
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      continue;
    }

    if (delivery.ok) {
      return {
        success: true,
        channel,
        attempts: attempt,
        message: `Berhasil dipublikasikan ke kanal ${channel}.`,
      };
    }

    lastMessage = delivery.message ?? lastMessage;
  }

  return {
    success: false,
    channel,
    attempts: maxAttempts,
    message: lastMessage,
  };
}
