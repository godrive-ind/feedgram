"use client";

/**
 * Center Panel — Canvas Output & Preview (Layer 4, task 11.2).
 *
 * Renders the variation grid (2–4 comparison columns), zoom/pan controls
 * (zoom clamped 25%–400%, pan bounded to the content area), variation
 * selection, and the per-variation edit/regenerate/duplicate entry points,
 * wired to `Canvas_Renderer` (`lib/canvas/renderer.ts` + `lib/canvas/controls.ts`).
 *
 * Self-contained for parallel execution (task 11.3 owns the right panel,
 * `app/page.tsx` is finalised in 14.1): all props are optional with sensible
 * defaults so the panel renders standalone. When a `batch` is supplied (a
 * completed `GenerationBatch`), all of its variations are shown (Req 4.1).
 *
 * Behaviour:
 *   - Grid columns via `setGridColumns`/clamp (2..4)            — Req 4.3
 *   - Zoom clamped to 25%–400%, pan bounded to content area      — Req 4.2
 *   - Selecting a variation surfaces edit/regenerate/duplicate    — Req 4.4
 *   - Regenerate / fine-tune POST to /api/variations/[id]         — (task 11.4)
 *   - Duplicate / edit are local/stub entry points
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */

import { useMemo, useRef, useState } from "react";

import {
  createViewportState,
  pan as panViewport,
  zoomViewport,
  type PanBounds,
  type ViewportState,
} from "@/lib/canvas/controls";
import type { DesignVariation, GenerationBatch, QualityReport } from "@/lib/types";
import {
  DEFAULT_GRID_COLUMNS,
  GRID_COLUMN_OPTIONS,
  ZOOM_STEP_PERCENT,
  duplicateVariation,
  editControlsFor,
  formatZoomLabel,
  gridTemplateColumns,
  hasVariations,
  isSelected,
  nextSelectedId,
  normalizeGridColumns,
  replaceVariation,
  stepZoom,
  variationsToDisplay,
  type GridColumns,
} from "./canvas-panel-helpers";

export interface CanvasPanelProps {
  /**
   * The completed generation batch whose variations to display. When omitted
   * (still generating / standalone render) the panel shows its empty state.
   * (Req 4.1)
   */
  batch?: GenerationBatch | null;
  /** Fired when the selected variation changes (id or null when cleared). */
  onSelectionChange?: (variationId: string | null) => void;
}

/** Viewport size used to bound panning of a single preview tile. */
const PREVIEW_VIEWPORT = { width: 280, height: 280 };

export default function CanvasPanel({
  batch = null,
  onSelectionChange,
}: CanvasPanelProps) {
  // Local working copy of the batch so local ops (duplicate / regenerate
  // result) can update the grid without touching the parent (wired in 14.1).
  const [workingBatch, setWorkingBatch] = useState<GenerationBatch | null>(
    batch,
  );
  // Keep the working copy in sync when the incoming batch prop identity changes
  // (the "derive state from props" pattern: set during render, guarded by a ref).
  const lastBatchRef = useRef<GenerationBatch | null>(batch);
  if (lastBatchRef.current !== batch) {
    lastBatchRef.current = batch;
    setWorkingBatch(batch);
  }

  const [columns, setColumns] = useState<GridColumns>(DEFAULT_GRID_COLUMNS);
  const [viewport, setViewport] = useState<ViewportState>(() =>
    createViewportState(),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const variations = variationsToDisplay(workingBatch);
  const editControls = useMemo(
    () => editControlsFor(selectedId),
    [selectedId],
  );

  // Pan bounds for a tile: content is the variation's intrinsic size scaled by
  // a fit factor isn't needed here — controls.ts handles scaling via zoom, so
  // we pass the unscaled content size and current viewport.
  const panBounds: PanBounds = {
    viewportWidth: PREVIEW_VIEWPORT.width,
    viewportHeight: PREVIEW_VIEWPORT.height,
    contentWidth: PREVIEW_VIEWPORT.width,
    contentHeight: PREVIEW_VIEWPORT.height,
  };

  function handleSelect(id: string): void {
    const next = nextSelectedId(selectedId, id);
    setSelectedId(next);
    onSelectionChange?.(next);
  }

  function handleColumns(cols: number): void {
    setColumns(normalizeGridColumns(cols));
  }

  function handleZoom(deltaPercent: number): void {
    setViewport((prev) => {
      const zoomed = zoomViewport(prev, stepZoom(prev.zoom, deltaPercent), panBounds);
      return zoomed;
    });
  }

  function handlePan(dx: number, dy: number): void {
    setViewport((prev) => panViewport(prev, dx, dy, panBounds));
  }

  function handleResetView(): void {
    setViewport(createViewportState());
  }

  function handleDuplicate(sourceId: string): void {
    if (!workingBatch) return;
    const newId = `${sourceId}-copy-${Date.now().toString(36)}`;
    setWorkingBatch(duplicateVariation(workingBatch, sourceId, newId));
    setActionMessage(`Variasi diduplikasi (lokal).`);
  }

  function handleEdit(id: string): void {
    // Local entry point — full edit UI is wired with the right panel (11.3/14.1).
    setActionMessage(`Mode edit untuk variasi ${id} (placeholder).`);
  }

  async function handleDerive(
    variation: DesignVariation,
    action: "regenerate" | "fine-tune",
  ): Promise<void> {
    setBusyId(variation.id);
    setActionMessage(null);
    try {
      const body =
        action === "fine-tune"
          ? { action, feedback: "Perhalus variasi ini." }
          : { action };
      const response = await fetch(`/api/variations/${variation.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as {
        variation?: DesignVariation;
        message?: string;
      };

      if (response.ok && data.variation) {
        if (workingBatch) {
          setWorkingBatch(replaceVariation(workingBatch, data.variation));
        }
        setActionMessage(
          action === "regenerate"
            ? "Variasi diregenerasi."
            : "Variasi disesuaikan.",
        );
      } else {
        // Failure: the source variation is preserved unchanged (Req 4.7/7.9).
        setActionMessage(
          data.message ??
            `Gagal ${action === "regenerate" ? "meregenerasi" : "menyesuaikan"} variasi.`,
        );
      }
    } catch {
      setActionMessage("Tidak dapat menghubungi server variasi.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleExport(
    variation: DesignVariation,
    format: "png" | "jpg" | "pdf",
  ): Promise<void> {
    setBusyId(variation.id);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/export/${variation.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        fileRef?: { url: string };
        message?: string;
      };
      if (response.ok && data.fileRef) {
        setActionMessage(
          `Ekspor ${format.toUpperCase()} siap: ${data.fileRef.url}`,
        );
      } else {
        // Export failures preserve the variation unchanged (Req 6.5/6.8).
        setActionMessage(
          data.message ?? `Gagal mengekspor variasi (${format}).`,
        );
      }
    } catch {
      setActionMessage("Tidak dapat menghubungi server ekspor.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleExportZip(): Promise<void> {
    if (!workingBatch) return;
    setActionMessage(null);
    try {
      const response = await fetch(`/api/export/${workingBatch.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "zip" }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        fileRef?: { url: string };
        message?: string;
      };
      if (response.ok && data.fileRef) {
        setActionMessage(`ZIP batch siap: ${data.fileRef.url}`);
      } else {
        setActionMessage(data.message ?? "Gagal mengekspor batch sebagai ZIP.");
      }
    } catch {
      setActionMessage("Tidak dapat menghubungi server ekspor.");
    }
  }

  async function handlePublish(
    variation: DesignVariation,
    channel: "instagram" | "facebook" | "linkedin",
  ): Promise<void> {
    setBusyId(variation.id);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/publish/${variation.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        result?: { channel: string };
        message?: string;
      };
      if (response.ok && data.result) {
        setActionMessage(`Dipublikasikan ke ${data.result.channel}.`);
      } else {
        // Publish failures preserve the variation unchanged (Req 6.5/6.6).
        setActionMessage(
          data.message ?? `Gagal mempublikasikan ke ${channel}.`,
        );
      }
    } catch {
      setActionMessage("Tidak dapat menghubungi server publikasi.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section
      className="panel panel-center"
      aria-label="Canvas Output dan Preview"
    >
      <div className="canvas-toolbar">
        <h2>Canvas Output & Preview</h2>

        {/* Grid column control (Req 4.3) */}
        <div className="toolbar-group" role="group" aria-label="Kolom grid">
          <span className="toolbar-label">Kolom</span>
          {GRID_COLUMN_OPTIONS.map((cols) => (
            <button
              key={cols}
              type="button"
              className={columns === cols ? "toolbar-btn is-active" : "toolbar-btn"}
              aria-pressed={columns === cols}
              onClick={() => handleColumns(cols)}
            >
              {cols}
            </button>
          ))}
        </div>

        {/* Zoom + pan controls (Req 4.2) */}
        <div className="toolbar-group" role="group" aria-label="Zoom dan Pan">
          <button
            type="button"
            className="toolbar-btn"
            aria-label="Perkecil"
            onClick={() => handleZoom(-ZOOM_STEP_PERCENT)}
          >
            −
          </button>
          <span className="toolbar-label" aria-live="polite">
            {formatZoomLabel(viewport.zoom)}
          </span>
          <button
            type="button"
            className="toolbar-btn"
            aria-label="Perbesar"
            onClick={() => handleZoom(ZOOM_STEP_PERCENT)}
          >
            +
          </button>
          <button
            type="button"
            className="toolbar-btn"
            aria-label="Geser kiri"
            onClick={() => handlePan(-40, 0)}
          >
            ◀
          </button>
          <button
            type="button"
            className="toolbar-btn"
            aria-label="Geser kanan"
            onClick={() => handlePan(40, 0)}
          >
            ▶
          </button>
          <button type="button" className="toolbar-btn" onClick={handleResetView}>
            Reset
          </button>
        </div>

        {/* Batch-level export (single ZIP of all variations, Req 6.3) */}
        {hasVariations(workingBatch) && (
          <div className="toolbar-group" role="group" aria-label="Ekspor batch">
            <button
              type="button"
              className="toolbar-btn"
              onClick={handleExportZip}
            >
              Ekspor ZIP Batch
            </button>
          </div>
        )}
      </div>

      {!hasVariations(workingBatch) ? (
        <div className="empty-state">
          <p>Belum ada variasi.</p>
          <p>Isi brief lalu klik Generate untuk menampilkan hasil di sini.</p>
        </div>
      ) : (
        <div
          className="variation-grid"
          style={{ gridTemplateColumns: gridTemplateColumns(columns) }}
        >
          {variations.map((variation) => {
            const selected = isSelected(selectedId, variation.id);
            const busy = busyId === variation.id;
            return (
              <article
                key={variation.id}
                className={selected ? "variation-cell is-selected" : "variation-cell"}
              >
                <button
                  type="button"
                  className="variation-preview"
                  aria-pressed={selected}
                  aria-label={`Pilih variasi ${variation.id}`}
                  onClick={() => handleSelect(variation.id)}
                >
                  <div className="preview-viewport">
                    {variation.renderedCanvas.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={variation.renderedCanvas.url}
                        alt={`Pratinjau variasi ${variation.copy.headline}`}
                        style={{
                          transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
                          transformOrigin: "top left",
                        }}
                      />
                    ) : (
                      <div className="preview-placeholder">
                        <span>{variation.copy.headline}</span>
                      </div>
                    )}
                  </div>
                </button>

                {/* Edit/regenerate/duplicate entry points (Req 4.4) */}
                {selected && editControls && (
                  <div className="variation-actions" role="group">
                    <button
                      type="button"
                      disabled={!editControls.canEdit || busy}
                      onClick={() => handleEdit(variation.id)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={!editControls.canRegenerate || busy}
                      onClick={() => handleDerive(variation, "regenerate")}
                    >
                      {busy ? "…" : "Regenerasi"}
                    </button>
                    <button
                      type="button"
                      disabled={!editControls.canRegenerate || busy}
                      onClick={() => handleDerive(variation, "fine-tune")}
                    >
                      Fine-tune
                    </button>
                    <button
                      type="button"
                      disabled={!editControls.canDuplicate || busy}
                      onClick={() => handleDuplicate(variation.id)}
                    >
                      Duplikat
                    </button>
                    {/* Export controls (Req 6.1) */}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleExport(variation, "png")}
                    >
                      Ekspor PNG
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleExport(variation, "jpg")}
                    >
                      Ekspor JPG
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleExport(variation, "pdf")}
                    >
                      Ekspor PDF
                    </button>
                    {/* Publish controls (Req 6.4) */}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handlePublish(variation, "instagram")}
                    >
                      Publikasi IG
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handlePublish(variation, "facebook")}
                    >
                      Publikasi FB
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handlePublish(variation, "linkedin")}
                    >
                      Publikasi LinkedIn
                    </button>
                  </div>
                )}
                {/* Read-only Quality_Report for the selected variation (Req 4.5,
                    5.2). Present only for Professional_Mode batches. */}
                {selected && variation.qualityReport && (
                  <QualityReportView report={variation.qualityReport} />
                )}
              </article>
            );
          })}
        </div>
      )}

      {actionMessage && (
        <p className="canvas-action-message" role="status">
          {actionMessage}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Read-only Quality_Report (Req 4.5, 5.2)
// ---------------------------------------------------------------------------

function QualityReportView({ report }: { report: QualityReport }) {
  return (
    <div className="quality-report" aria-label={`Quality Report ${report.variationId}`}>
      <h3>Quality Report</h3>
      <p className="quality-summary">
        <span className={`quality-decision decision-${report.decision.toLowerCase()}`}>
          {report.decision}
        </span>
        <span className="quality-total">
          Skor total: {report.weightedTotal.toFixed(1)}/10
        </span>
      </p>
      <ul className="quality-scores">
        {report.scores.map((s) => (
          <li key={s.criterion} className="quality-score-row">
            <span className="quality-criterion">{s.criterion}</span>
            <span className="quality-score">{s.score}/10</span>
          </li>
        ))}
      </ul>
      {report.critique && <p className="quality-critique">{report.critique}</p>}
      {report.detectedNegativePatterns.length > 0 && (
        <p className="quality-negative">
          Pola negatif: {report.detectedNegativePatterns.join(", ")}
        </p>
      )}
    </div>
  );
}
