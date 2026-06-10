"use client";

/**
 * Home page — 3-panel UI composition (tasks 11.1–11.3, finalized in 14.1).
 *
 * Lays out the three panel regions described in the design "Tata Letak UI
 * 3-Panel" and wires the cross-panel state so the end-to-end flow works:
 *   - Left  : Brief/Configurator   → `BriefPanel`. On a successful
 *             POST /api/generate it reports the new `jobId` (`onJobCreated`).
 *   - Right : Properties/Prompt/History/Credit → `PropertiesPanel`. It receives
 *             the active `jobId` and polls GET /api/jobs/{jobId}; when the job
 *             reaches a terminal state it reports the `resultBatchId`
 *             (`onJobComplete`).
 *   - Center: Canvas Output/Preview → `CanvasPanel`. When the job completes the
 *             page fetches the resulting batch (GET /api/history?batchId=…) and
 *             passes it down so export/publish/regenerate operate on the real
 *             variations.
 *
 * The right panel also loads the history list (GET /api/history) — refreshed
 * whenever a job completes — and forwards rating actions to POST /api/history.
 * Credit balance is fetched by the panel itself (GET /api/credits); after a
 * completed generation we bump a refresh key so the balance + history re-read.
 *
 * Plan defaults to "Free" for the MVP (real plan source is wired later); this
 * gates the 9-variations option in the brief panel (Req 8.4/8.5).
 *
 * Requirements: 7.1, 6.1, 6.3, 6.4 (wiring), plus 2.9 / 4.x / 8.1 via panels.
 */

import { useCallback, useEffect, useState } from "react";

import BriefPanel from "./components/BriefPanel";
import CanvasPanel from "./components/CanvasPanel";
import PropertiesPanel from "./components/PropertiesPanel";
import type { GenerationBatch, Plan } from "@/lib/types";

export default function HomePage() {
  // Placeholder plan source for the MVP. Real value comes from the session
  // later; "Free" keeps the 9-variations option gated by default.
  const [plan] = useState<Plan>("Free");

  // Cross-panel state.
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [batch, setBatch] = useState<GenerationBatch | null>(null);
  const [history, setHistory] = useState<GenerationBatch[]>([]);
  const [creditBalance, setCreditBalance] = useState<number | undefined>(
    undefined,
  );
  // Bumped after a job completes so the credit balance / history re-read.
  const [refreshKey, setRefreshKey] = useState(0);

  // Load the history list (newest-first, ≤20) for the right panel.
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/history");
      if (!res.ok) return;
      const data = (await res.json()) as { batches?: GenerationBatch[] };
      setHistory(data.batches ?? []);
    } catch {
      // Non-fatal: the panel shows an empty history.
    }
  }, []);

  // Load the credit balance (Req 8.1) for the right panel.
  const loadCredits = useCallback(async () => {
    try {
      const res = await fetch("/api/credits");
      if (!res.ok) return;
      const data = (await res.json()) as { balance?: number };
      if (typeof data.balance === "number") setCreditBalance(data.balance);
    } catch {
      // Non-fatal: the panel falls back to its own fetch / zero.
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    void loadCredits();
  }, [loadHistory, loadCredits, refreshKey]);

  // A fresh generation clears the previously-shown batch until it completes.
  const handleJobCreated = useCallback((jobId: string) => {
    setActiveJobId(jobId);
    setBatch(null);
  }, []);

  // When the polled job reaches a terminal state, load the produced batch and
  // refresh the history + credit balance.
  const handleJobComplete = useCallback(
    async (resultBatchId: string | null) => {
      setRefreshKey((k) => k + 1);
      if (!resultBatchId) return;
      try {
        const res = await fetch(
          `/api/history?batchId=${encodeURIComponent(resultBatchId)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { batch?: GenerationBatch };
        if (data.batch) setBatch(data.batch);
      } catch {
        // Non-fatal: the canvas keeps its empty state.
      }
    },
    [],
  );

  // Forward a rating to the history rating endpoint (Req 7.4).
  const handleRateVariation = useCallback(
    async (variationId: string, rating: number) => {
      try {
        await fetch("/api/history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variationId, rating }),
        });
      } catch {
        // Rating persistence is best-effort here; the panel keeps the UI value.
      }
    },
    [],
  );

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Feed Design Generator</h1>
      </header>
      <div className="panels">
        <BriefPanel plan={plan} onJobCreated={handleJobCreated} />
        <CanvasPanel batch={batch} />
        <PropertiesPanel
          jobId={activeJobId}
          history={history}
          selectedBatch={batch}
          creditBalance={creditBalance}
          onRateVariation={handleRateVariation}
          onJobComplete={handleJobComplete}
        />
      </div>
    </main>
  );
}
