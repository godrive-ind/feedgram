"use client";

/**
 * Right Panel — Properties / Prompt Chain / History / Credit (task 11.3).
 *
 * Renders four sections mapped to the design's right-panel responsibilities:
 *   - Properties: a Design_System editor (headline/body font, radius, layout
 *     density, typography scale, logo position, watermark, CTA style) that emits
 *     `onDesignSystemChange` patches. The live preview update itself lives in the
 *     center canvas panel (task 11.2); here we only expose controls + emit
 *     changes (Req 4.5).
 *   - Prompt Chain: a 6-step progress indicator that polls
 *     `GET /api/jobs/{jobId}` (when `jobId` is set), showing the active step
 *     number + name + per-step status, stopping on done/failed (Req 2.9).
 *   - History: the most-recent batches (newest first, ≤20) with a 1–5 rating
 *     control per variation of the selected/active batch (Req 7.2).
 *   - Credit: the remaining credit balance (Req 8.1).
 *
 * The component is self-contained: every prop is optional with sensible
 * defaults so it renders standalone. Cross-panel wiring is finalized in task
 * 14.1; this task does not edit `app/page.tsx`.
 *
 * Data-shaping logic lives in the pure, unit-tested `progress-helpers.ts`.
 *
 * Requirements: 2.9, 4.5, 7.2, 8.1
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  DesignBriefAnalysis,
  DesignSystem,
  DesignSystemPatch,
  GenerationBatch,
  JobStatus,
  VisualStrategy,
} from "@/lib/types";
import {
  HISTORY_PAGE_SIZE,
  RATING_VALUES,
  describeProgress,
  isValidRating,
  normalizeBalance,
  resolveDisplayedRating,
  shapeHistory,
  shouldContinuePolling,
  toProgressRows,
  toRatingRows,
} from "./progress-helpers";

/** Default Design_System used when no value is provided (standalone render). */
const DEFAULT_DESIGN_SYSTEM: DesignSystem = {
  headlineFont: "Inter",
  bodyFont: "Inter",
  typographyScale: [12, 14, 18, 24, 32],
  radius: 8,
  layoutDensity: "regular",
  brandElementPosition: { logo: "top-left", watermark: "" },
  ctaStyle: "solid",
};

const FONT_OPTIONS = [
  "Inter",
  "Roboto",
  "Poppins",
  "Montserrat",
  "Playfair Display",
  "Lato",
] as const;

const LAYOUT_DENSITIES: DesignSystem["layoutDensity"][] = [
  "compact",
  "regular",
  "spacious",
];

const LOGO_POSITIONS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "center",
] as const;

const CTA_STYLES = ["solid", "outline", "ghost", "pill"] as const;

/** Default polling interval (ms) — within the ≤2s requirement (Req 2.9). */
const DEFAULT_POLL_INTERVAL_MS = 1500;

/**
 * Read-only Design_Intelligence artefacts for the selected/active batch, as
 * returned by `GET /api/batches/[id]/intelligence` (Req 4.4, 4.5). Supplied by
 * the page once a batch generated with Professional_Mode completes; the section
 * only renders when `professionalMode` is true and at least one artefact exists.
 */
export interface BatchIntelligence {
  professionalMode: boolean;
  briefAnalysis: DesignBriefAnalysis | null;
  visualStrategy: VisualStrategy | null;
}

export interface PropertiesPanelProps {
  /** Active generation job id; when set, the panel polls its status. */
  jobId?: string | null;
  /** Current Design_System values for the editor. Defaults applied if absent. */
  designSystem?: DesignSystem;
  /** Emitted whenever a Design_System control changes (Req 4.5). */
  onDesignSystemChange?: (patch: DesignSystemPatch) => void;
  /** History batches to display (newest-first/cap handled internally). Req 7.2 */
  history?: GenerationBatch[];
  /** The batch whose variations are shown in the rating control. */
  selectedBatch?: GenerationBatch | null;
  /** Rating callback. Defaults to a no-op stub when not wired (Req 7.2). */
  onRateVariation?: (variationId: string, rating: number) => void;
  /** Pre-supplied credit balance; if omitted the panel fetches /api/credits. */
  creditBalance?: number;
  /** Polling interval override (ms). */
  pollIntervalMs?: number;
  /**
   * Read-only Design_Intelligence artefacts for the active batch (Req 4.5).
   * When present and `professionalMode` is true, a read-only section renders the
   * Brief_Analysis + Visual_Strategy alongside the rest of the panel.
   */
  intelligence?: BatchIntelligence | null;
  /**
   * Fired once the polled job reaches a terminal state. `resultBatchId` is the
   * produced batch id on success (state "done"), or `null` on failure. The page
   * uses this to fetch the batch and populate the center canvas (task 14.1).
   */
  onJobComplete?: (resultBatchId: string | null) => void;
}

export default function PropertiesPanel({
  jobId = null,
  designSystem = DEFAULT_DESIGN_SYSTEM,
  onDesignSystemChange,
  history = [],
  selectedBatch = null,
  onRateVariation,
  creditBalance,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  intelligence = null,
  onJobComplete,
}: PropertiesPanelProps) {
  return (
    <section
      className="panel panel-right"
      aria-label="Properties, Prompt Chain, dan History"
    >
      <CreditSection balance={creditBalance} />
      <PromptChainSection
        jobId={jobId}
        pollIntervalMs={pollIntervalMs}
        onJobComplete={onJobComplete}
      />
      <IntelligenceSection intelligence={intelligence} />
      <PropertiesSection
        designSystem={designSystem}
        onChange={onDesignSystemChange}
      />
      <HistorySection
        history={history}
        selectedBatch={selectedBatch}
        onRateVariation={onRateVariation}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Credit balance (Req 8.1)
// ---------------------------------------------------------------------------

function CreditSection({ balance }: { balance?: number }) {
  const [fetched, setFetched] = useState<number | null>(null);

  useEffect(() => {
    // Only fetch when the balance is not supplied via props.
    if (balance !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/credits");
        if (!res.ok) return;
        const data = (await res.json()) as { balance?: unknown };
        if (!cancelled) setFetched(normalizeBalance(data.balance));
      } catch {
        // Leave as null; the display falls back to 0.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [balance]);

  const display = normalizeBalance(balance ?? fetched ?? 0);

  return (
    <div className="prop-section" aria-label="Saldo Kredit">
      <h2>Saldo Kredit</h2>
      <p className="credit-balance" role="status">
        <span className="credit-value">{display}</span> kredit
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompt-chain progress (Req 2.9)
// ---------------------------------------------------------------------------

function PromptChainSection({
  jobId,
  pollIntervalMs,
  onJobComplete,
}: {
  jobId: string | null;
  pollIntervalMs: number;
  onJobComplete?: (resultBatchId: string | null) => void;
}) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Keep the latest status in a ref so the polling loop can decide to stop.
  const statusRef = useRef<JobStatus | null>(null);
  statusRef.current = status;
  // Guard so the terminal callback fires exactly once per job.
  const completedRef = useRef(false);

  const poll = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok) {
        // On serverless (Vercel), the job may have been completed synchronously
        // in the same generate request. A 404 here means the in-memory store
        // does not have the job (different instance). Silently ignore it.
        if (res.status === 404) {
          setError(null);
          return;
        }
        setError(`Gagal memuat status job (status ${res.status}).`);
        return;
      }
      const data = (await res.json()) as JobStatus;
      setError(null);
      setStatus(data);
    } catch {
      setError("Tidak dapat menghubungi server status job.");
    }
  }, []);

  useEffect(() => {
    setStatus(null);
    setError(null);
    completedRef.current = false;
    if (!jobId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (cancelled) return;
      await poll(jobId);
      if (cancelled) return;
      const latest = statusRef.current;
      // Stop polling once the job reaches a terminal state (Req 2.9), and
      // notify the parent exactly once so it can load the batch (task 14.1).
      if (shouldContinuePolling(latest)) {
        timer = setTimeout(tick, pollIntervalMs);
      } else if (latest && !completedRef.current) {
        completedRef.current = true;
        onJobComplete?.(
          latest.state === "done" ? latest.resultBatchId ?? null : null,
        );
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, pollIntervalMs, poll, onJobComplete]);

  return (
    <div className="prop-section" aria-label="Progres Prompt Chain">
      <h2>Prompt Chain (Langkah 1–6)</h2>

      {!jobId && (
        <p className="empty-state">
          Indikator progres akan tampil saat generasi dimulai.
        </p>
      )}

      {jobId && error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      {jobId && status && (
        <>
          <p className="progress-summary" role="status">
            {describeProgress(status)}
          </p>
          <ol className="progress-steps">
            {toProgressRows(status).map((row) => (
              <li
                key={row.step}
                className={`progress-step status-${row.status}${
                  row.isActive ? " is-active" : ""
                }`}
                aria-current={row.isActive ? "step" : undefined}
              >
                <span className="step-number">{row.step}</span>
                <span className="step-name">{row.name}</span>
                <span className="step-status">{row.statusLabel}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Design_Intelligence artefacts — read-only (Req 4.5)
// ---------------------------------------------------------------------------

function IntelligenceSection({
  intelligence,
}: {
  intelligence: BatchIntelligence | null;
}) {
  // Only shown for batches generated with Professional_Mode that carry at least
  // one reasoning artefact (Req 4.5). Non-professional batches render nothing.
  if (
    !intelligence ||
    !intelligence.professionalMode ||
    (!intelligence.briefAnalysis && !intelligence.visualStrategy)
  ) {
    return null;
  }

  const { briefAnalysis, visualStrategy } = intelligence;

  return (
    <div className="prop-section" aria-label="Design Intelligence">
      <h2>Design Intelligence</h2>

      {briefAnalysis && (
        <div className="intelligence-block" aria-label="Brief Analysis">
          <h3>Brief Analysis</h3>
          <dl className="intelligence-list">
            <dt>Core Message</dt>
            <dd>{briefAnalysis.coreMessage}</dd>
            <dt>Target Audience</dt>
            <dd>{briefAnalysis.targetAudience}</dd>
            <dt>Primary Goal</dt>
            <dd>{briefAnalysis.primaryGoal}</dd>
            <dt>Emotion Target</dt>
            <dd>{briefAnalysis.emotionTarget}</dd>
          </dl>
        </div>
      )}

      {visualStrategy && (
        <div className="intelligence-block" aria-label="Visual Strategy">
          <h3>Visual Strategy</h3>
          <dl className="intelligence-list">
            <dt>Hierarchy Plan</dt>
            <dd>{visualStrategy.hierarchyPlan}</dd>
            <dt>Composition Type</dt>
            <dd>{visualStrategy.compositionType}</dd>
            <dt>Color Psychology</dt>
            <dd>{visualStrategy.colorPsychology}</dd>
            <dt>Typography</dt>
            <dd>
              {visualStrategy.typography.system} —{" "}
              {visualStrategy.typography.reasoning}
            </dd>
            <dt>Whitespace Ratio</dt>
            <dd>{Math.round(visualStrategy.whitespaceRatio * 100)}%</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Design_System properties editor (Req 4.5)
// ---------------------------------------------------------------------------

function PropertiesSection({
  designSystem,
  onChange,
}: {
  designSystem: DesignSystem;
  onChange?: (patch: DesignSystemPatch) => void;
}) {
  // Emit only the changed field as a patch (Req 4.5).
  const emit = (patch: DesignSystemPatch) => onChange?.(patch);

  return (
    <div className="prop-section" aria-label="Properti Design System">
      <h2>Properties (Design System)</h2>

      <div className="field">
        <label htmlFor="headlineFont">Font Headline</label>
        <select
          id="headlineFont"
          value={designSystem.headlineFont}
          onChange={(e) => emit({ headlineFont: e.target.value })}
        >
          {fontOptionsWith(designSystem.headlineFont).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="bodyFont">Font Body</label>
        <select
          id="bodyFont"
          value={designSystem.bodyFont}
          onChange={(e) => emit({ bodyFont: e.target.value })}
        >
          {fontOptionsWith(designSystem.bodyFont).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="radius">Radius ({designSystem.radius}px)</label>
        <input
          id="radius"
          type="range"
          min={0}
          max={48}
          step={1}
          value={designSystem.radius}
          onChange={(e) => emit({ radius: Number(e.target.value) })}
        />
      </div>

      <div className="field">
        <label htmlFor="layoutDensity">Densitas Layout</label>
        <select
          id="layoutDensity"
          value={designSystem.layoutDensity}
          onChange={(e) =>
            emit({
              layoutDensity: e.target.value as DesignSystem["layoutDensity"],
            })
          }
        >
          {LAYOUT_DENSITIES.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="typographyScale">Skala Tipografi (mis. 12,14,18,24,32)</label>
        <input
          id="typographyScale"
          type="text"
          value={designSystem.typographyScale.join(",")}
          onChange={(e) => emit({ typographyScale: parseScale(e.target.value) })}
        />
      </div>

      <div className="field">
        <label htmlFor="logoPosition">Posisi Logo</label>
        <select
          id="logoPosition"
          value={designSystem.brandElementPosition.logo}
          onChange={(e) => emit({ logoPosition: e.target.value })}
        >
          {logoPositionsWith(designSystem.brandElementPosition.logo).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="watermark">Watermark</label>
        <input
          id="watermark"
          type="text"
          placeholder="Teks watermark (opsional)"
          value={designSystem.brandElementPosition.watermark ?? ""}
          onChange={(e) => emit({ watermark: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="ctaStyle">Gaya CTA</label>
        <select
          id="ctaStyle"
          value={designSystem.ctaStyle}
          onChange={(e) => emit({ ctaStyle: e.target.value })}
        >
          {ctaStylesWith(designSystem.ctaStyle).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History list + rating (Req 7.2)
// ---------------------------------------------------------------------------

function HistorySection({
  history,
  selectedBatch,
  onRateVariation,
}: {
  history: GenerationBatch[];
  selectedBatch: GenerationBatch | null;
  onRateVariation?: (variationId: string, rating: number) => void;
}) {
  const rows = shapeHistory(history);

  return (
    <div className="prop-section" aria-label="Riwayat dan Rating">
      <h2>History</h2>

      {rows.length === 0 ? (
        <p className="empty-state">Belum ada riwayat generasi.</p>
      ) : (
        <ul className="history-list">
          {rows.map((row) => (
            <li key={row.batchId} className="history-row">
              <span className="history-date">
                {formatDate(row.createdAt)}
              </span>
              <span className={`history-status status-${row.status}`}>
                {row.status}
              </span>
              <span className="history-count">{row.variationCount} variasi</span>
            </li>
          ))}
        </ul>
      )}
      {history.length > HISTORY_PAGE_SIZE && (
        <p className="history-note">
          Menampilkan {HISTORY_PAGE_SIZE} terbaru.
        </p>
      )}

      {selectedBatch && (
        <RatingControl
          batch={selectedBatch}
          onRateVariation={onRateVariation}
        />
      )}
    </div>
  );
}

function RatingControl({
  batch,
  onRateVariation,
}: {
  batch: GenerationBatch;
  onRateVariation?: (variationId: string, rating: number) => void;
}) {
  // Track locally-displayed ratings so an accepted rating reflects immediately
  // while an invalid value preserves the previous rating (Req 7.8).
  const [ratings, setRatings] = useState<Record<string, number | undefined>>(
    () =>
      Object.fromEntries(toRatingRows(batch.variations).map((r) => [r.variationId, r.rating])),
  );

  const handleRate = (variationId: string, value: number) => {
    setRatings((prev) => ({
      ...prev,
      [variationId]: resolveDisplayedRating(prev[variationId], value),
    }));
    // Only forward valid ratings to the persistence handler (Req 7.4/7.8).
    if (isValidRating(value)) onRateVariation?.(variationId, value);
  };

  return (
    <div className="rating-control" aria-label="Rating Variasi">
      <h3>Rating Variasi</h3>
      <ul className="rating-list">
        {toRatingRows(batch.variations).map((row) => {
          const current = ratings[row.variationId];
          return (
            <li key={row.variationId} className="rating-row">
              <span className="rating-variation">{row.variationId}</span>
              <span
                className="rating-stars"
                role="radiogroup"
                aria-label={`Rating untuk ${row.variationId}`}
              >
                {RATING_VALUES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`rating-star${
                      current && value <= current ? " is-selected" : ""
                    }`}
                    role="radio"
                    aria-checked={current === value}
                    aria-label={`${value} dari 5`}
                    onClick={() => handleRate(row.variationId, value)}
                  >
                    ★
                  </button>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/** Ensure the current value is present in the option list (avoid empty select). */
function fontOptionsWith(current: string): string[] {
  return FONT_OPTIONS.includes(current as (typeof FONT_OPTIONS)[number])
    ? [...FONT_OPTIONS]
    : [current, ...FONT_OPTIONS];
}

function logoPositionsWith(current: string): string[] {
  return LOGO_POSITIONS.includes(current as (typeof LOGO_POSITIONS)[number])
    ? [...LOGO_POSITIONS]
    : [current, ...LOGO_POSITIONS];
}

function ctaStylesWith(current: string): string[] {
  return CTA_STYLES.includes(current as (typeof CTA_STYLES)[number])
    ? [...CTA_STYLES]
    : [current, ...CTA_STYLES];
}

/** Parse a comma-separated typography scale into a numeric array. */
function parseScale(raw: string): number[] {
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

/** Format an ISO timestamp for display; falls back to the raw string. */
function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}
