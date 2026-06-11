"use client";

/**
 * Left Panel — Brief/Configurator (Layer 1, task 11.1).
 *
 * Renders the design-brief form: required brand name + optional tagline/main
 * message (with the character limits from `validateBrief`), pickers for content
 * goal / visual style / tone / output format / mandatory elements / accent
 * palette / variation count, and an asset upload control that runs client-side
 * `validateUpload` feedback.
 *
 * Behaviour:
 *   - On submit, runs `validateBrief` client-side; on invalid it shows the
 *     field errors and preserves every entered value unchanged (Req 1.3), then
 *     POSTs to `/api/generate` (thin fetch; polling wiring lands in 11.2/11.3).
 *   - The 9-variations option is DISABLED and badged "Pro" for Free plans, and
 *     enabled for Pro (Req 8.4/8.5).
 *
 * Requirements: 1.1, 1.3, 8.4, 8.5, 1.4, 2.1, 2.5, 2.6, 2.8
 */

import { useState } from "react";

import { getOptions, validateBrief } from "@/lib/intake/brief-intake";
import {
  BRIEF_FIELD_LIMITS,
} from "@/lib/intake/brief-intake";
import {
  validateProfessionalBrief,
  DESIGN_PURPOSES,
} from "@/lib/intelligence/professional-brief";
import { validateUpload } from "@/lib/intake/upload-validation";
import {
  VARIATION_COUNTS,
  type FieldError,
  type Plan,
  type UploadedFile,
  type UploadValidationResult,
  type VariationCount,
} from "@/lib/types";
import {
  buildBriefInput,
  createEmptyBriefFormState,
  DESIGN_PURPOSE_LABELS,
  isVariationCountEnabled,
  MANDATORY_ELEMENT_LABELS,
  OUTPUT_FORMAT_LABELS,
  toggleMandatoryElement,
  type BriefFormState,
} from "./brief-form-helpers";

const options = getOptions();

export interface BriefPanelProps {
  /** Current user's plan; gates the 9-variations option. Default "Free". */
  plan?: Plan;
  /** Optional callback fired with the created jobId after a successful POST. */
  onJobCreated?: (jobId: string) => void;
  /** Optional callback fired with the resultBatchId when generation completes synchronously. */
  onGenerationComplete?: (resultBatchId: string) => void;
}

/** Find the error message for a given field, if any. */
function errorFor(errors: FieldError[], field: string): string | undefined {
  return errors.find((e) => e.field === field)?.message;
}

export default function BriefPanel({
  plan = "Free",
  onJobCreated,
  onGenerationComplete,
}: BriefPanelProps) {
  const [form, setForm] = useState<BriefFormState>(createEmptyBriefFormState);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [uploadResult, setUploadResult] =
    useState<UploadValidationResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  function update<K extends keyof BriefFormState>(
    key: K,
    value: BriefFormState[K],
  ): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleFileChange(fileList: FileList | null): void {
    if (!fileList) {
      setUploadResult(null);
      return;
    }
    // Map the browser File objects into the pure-logic UploadedFile shape.
    const files: UploadedFile[] = Array.from(fileList).map((f) => ({
      name: f.name,
      mimeType: f.type,
      sizeBytes: f.size,
    }));
    setUploadResult(validateUpload(files));
  }

  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setSubmitMessage(null);

    const brief = buildBriefInput(form);
    const result = validateBrief(brief);

    if (!result.valid) {
      // Req 1.3 — show errors and preserve entered values unchanged.
      setErrors(result.errors);
      return;
    }

    // Req 2.1, 2.5, 2.6 — when Professional_Mode is ON, run the enhanced brief
    // validation (required Design_Purpose / primary goal / core message + the
    // 7-word limit). No-op when OFF (Req 1.4). Values are preserved unchanged.
    const professionalResult = validateProfessionalBrief(brief);
    if (!professionalResult.valid) {
      setErrors(professionalResult.errors);
      return;
    }
    setErrors([]);

    setSubmitting(true);
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(brief),
      });

      if (response.status === 200) {
        // Synchronous pipeline: result returned directly.
        const data = (await response.json()) as {
          jobId: string;
          resultBatchId?: string;
          status?: any;
        };
        setSubmitMessage(`Generasi selesai (job ${data.jobId}).`);
        onJobCreated?.(data.jobId);
        if (data.resultBatchId) {
          onGenerationComplete?.(data.resultBatchId);
        }
      } else if (response.status === 202) {
        // Legacy async mode (if ever used).
        const data = (await response.json()) as { jobId: string };
        setSubmitMessage(`Generasi dimulai (job ${data.jobId}).`);
        onJobCreated?.(data.jobId);
      } else {
        const data = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        setSubmitMessage(
          data.message ?? `Gagal memulai generasi (status ${response.status}).`,
        );
      }
    } catch {
      setSubmitMessage("Tidak dapat menghubungi server generasi.");
    } finally {
      setSubmitting(false);
    }
  }

  const brandNameError = errorFor(errors, "brandName");
  const taglineError = errorFor(errors, "tagline");
  const mainMessageError = errorFor(errors, "mainMessage");
  const designPurposeError = errorFor(errors, "professional.designPurpose");
  const primaryGoalError = errorFor(errors, "professional.primaryGoal");
  const coreMessageError = errorFor(errors, "professional.coreMessage");

  return (
    <section className="panel panel-left" aria-label="Brief dan Configurator">
      <h2>Brief & Configurator</h2>

      <form onSubmit={handleSubmit} noValidate>
        {/* Professional Mode toggle (Req 1.1, 1.4 — default OFF) */}
        <div className="field professional-toggle">
          <label htmlFor="professionalMode" className="checkbox-row">
            <input
              id="professionalMode"
              name="professionalMode"
              type="checkbox"
              checked={form.professionalMode}
              onChange={(e) => update("professionalMode", e.target.checked)}
            />
            Professional Mode
          </label>
          <p className="field-hint">
            Aktifkan untuk brief profesional yang lebih lengkap dan lapisan
            kecerdasan desain.
          </p>
        </div>

        {/* Professional brief fields — shown only when Professional_Mode is ON
            (Req 2.1). Design_Purpose / primary goal / core message wajib
            (Req 2.5); core message ≤ 7 kata (Req 2.3). */}
        {form.professionalMode && (
          <fieldset className="field professional-fields">
            <legend>Brief Profesional</legend>

            {/* Design Purpose (required) */}
            <div className="field">
              <label htmlFor="designPurpose">
                Design Purpose <span aria-hidden="true">*</span>
              </label>
              <select
                id="designPurpose"
                value={form.designPurpose}
                aria-required="true"
                aria-invalid={designPurposeError ? "true" : undefined}
                aria-describedby={
                  designPurposeError ? "designPurpose-error" : undefined
                }
                onChange={(e) =>
                  update(
                    "designPurpose",
                    e.target.value as BriefFormState["designPurpose"],
                  )
                }
              >
                {DESIGN_PURPOSES.map((purpose) => (
                  <option key={purpose} value={purpose}>
                    {DESIGN_PURPOSE_LABELS[purpose]}
                  </option>
                ))}
              </select>
              {designPurposeError && (
                <p id="designPurpose-error" className="field-error" role="alert">
                  {designPurposeError}
                </p>
              )}
            </div>

            {/* Target audience (usia, profesi, pain point) — Req 2.1 */}
            <div className="field">
              <label htmlFor="audienceAge">Audiens — Usia</label>
              <input
                id="audienceAge"
                type="text"
                value={form.audienceAge}
                onChange={(e) => update("audienceAge", e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="audienceProfession">Audiens — Profesi</label>
              <input
                id="audienceProfession"
                type="text"
                value={form.audienceProfession}
                onChange={(e) =>
                  update("audienceProfession", e.target.value)
                }
              />
            </div>
            <div className="field">
              <label htmlFor="audiencePainPoint">Audiens — Pain Point</label>
              <input
                id="audiencePainPoint"
                type="text"
                value={form.audiencePainPoint}
                onChange={(e) => update("audiencePainPoint", e.target.value)}
              />
            </div>

            {/* Primary goal (required) */}
            <div className="field">
              <label htmlFor="primaryGoal">
                Primary Goal <span aria-hidden="true">*</span>
              </label>
              <input
                id="primaryGoal"
                type="text"
                value={form.primaryGoal}
                aria-required="true"
                aria-invalid={primaryGoalError ? "true" : undefined}
                aria-describedby={
                  primaryGoalError ? "primaryGoal-error" : undefined
                }
                onChange={(e) => update("primaryGoal", e.target.value)}
              />
              {primaryGoalError && (
                <p id="primaryGoal-error" className="field-error" role="alert">
                  {primaryGoalError}
                </p>
              )}
            </div>

            {/* Emotion target (optional) — Req 2.1 */}
            <div className="field">
              <label htmlFor="emotionTarget">Emotion Target</label>
              <input
                id="emotionTarget"
                type="text"
                value={form.emotionTarget}
                onChange={(e) => update("emotionTarget", e.target.value)}
              />
            </div>

            {/* Core message (required, <= 7 kata) — Req 2.3, 2.5 */}
            <div className="field">
              <label htmlFor="coreMessage">
                Core Message <span aria-hidden="true">*</span>
              </label>
              <input
                id="coreMessage"
                type="text"
                value={form.coreMessage}
                aria-required="true"
                aria-invalid={coreMessageError ? "true" : undefined}
                aria-describedby={
                  coreMessageError ? "coreMessage-error" : undefined
                }
                onChange={(e) => update("coreMessage", e.target.value)}
              />
              <p className="field-hint">Maksimum 7 kata.</p>
              {coreMessageError && (
                <p id="coreMessage-error" className="field-error" role="alert">
                  {coreMessageError}
                </p>
              )}
            </div>
          </fieldset>
        )}

        {/* Brand name (required) */}
        <div className="field">
          <label htmlFor="brandName">
            Nama Brand <span aria-hidden="true">*</span>
          </label>
          <input
            id="brandName"
            name="brandName"
            type="text"
            required
            maxLength={BRIEF_FIELD_LIMITS.brandName}
            aria-required="true"
            aria-invalid={brandNameError ? "true" : undefined}
            aria-describedby={brandNameError ? "brandName-error" : undefined}
            value={form.brandName}
            onChange={(e) => update("brandName", e.target.value)}
          />
          {brandNameError && (
            <p id="brandName-error" className="field-error" role="alert">
              {brandNameError}
            </p>
          )}
        </div>

        {/* Tagline (optional, <=100) */}
        <div className="field">
          <label htmlFor="tagline">Tagline</label>
          <input
            id="tagline"
            name="tagline"
            type="text"
            maxLength={BRIEF_FIELD_LIMITS.tagline}
            aria-invalid={taglineError ? "true" : undefined}
            aria-describedby={taglineError ? "tagline-error" : undefined}
            value={form.tagline}
            onChange={(e) => update("tagline", e.target.value)}
          />
          {taglineError && (
            <p id="tagline-error" className="field-error" role="alert">
              {taglineError}
            </p>
          )}
        </div>

        {/* Main message (optional, <=500) */}
        <div className="field">
          <label htmlFor="mainMessage">Topik / Pesan Utama</label>
          <textarea
            id="mainMessage"
            name="mainMessage"
            rows={3}
            maxLength={BRIEF_FIELD_LIMITS.mainMessage}
            aria-invalid={mainMessageError ? "true" : undefined}
            aria-describedby={
              mainMessageError ? "mainMessage-error" : undefined
            }
            value={form.mainMessage}
            onChange={(e) => update("mainMessage", e.target.value)}
          />
          {mainMessageError && (
            <p id="mainMessage-error" className="field-error" role="alert">
              {mainMessageError}
            </p>
          )}
        </div>

        {/* Content goal */}
        <div className="field">
          <label htmlFor="contentGoal">Tujuan Konten</label>
          <select
            id="contentGoal"
            value={form.contentGoal}
            onChange={(e) =>
              update(
                "contentGoal",
                e.target.value as BriefFormState["contentGoal"],
              )
            }
          >
            {options.contentGoals.map((goal) => (
              <option key={goal} value={goal}>
                {goal}
              </option>
            ))}
          </select>
        </div>

        {/* Visual style */}
        <div className="field">
          <label htmlFor="visualStyle">Gaya Visual</label>
          <select
            id="visualStyle"
            value={form.visualStyle}
            onChange={(e) =>
              update(
                "visualStyle",
                e.target.value as BriefFormState["visualStyle"],
              )
            }
          >
            {options.visualStyles.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
        </div>

        {/* Tone */}
        <div className="field">
          <label htmlFor="tone">Tone Konten</label>
          <select
            id="tone"
            value={form.tone}
            onChange={(e) =>
              update("tone", e.target.value as BriefFormState["tone"])
            }
          >
            {options.tones.map((tone) => (
              <option key={tone} value={tone}>
                {tone}
              </option>
            ))}
          </select>
        </div>

        {/* Output format */}
        <div className="field">
          <label htmlFor="outputFormat">Format Output</label>
          <select
            id="outputFormat"
            value={form.outputFormatName}
            onChange={(e) =>
              update(
                "outputFormatName",
                e.target.value as BriefFormState["outputFormatName"],
              )
            }
          >
            {options.outputFormats.map((format) => (
              <option key={format.name} value={format.name}>
                {OUTPUT_FORMAT_LABELS[format.name]}
              </option>
            ))}
          </select>
        </div>

        {/* Accent palette (single accent color for the MVP) */}
        <div className="field">
          <label htmlFor="accent">Palet Warna Aksen</label>
          <input
            id="accent"
            type="color"
            value={form.accentPalette[0] ?? "#2563eb"}
            onChange={(e) => update("accentPalette", [e.target.value])}
          />
        </div>

        {/* Mandatory elements */}
        <fieldset className="field">
          <legend>Elemen Wajib</legend>
          {options.mandatoryElements.map((element) => (
            <label key={element} className="checkbox-row">
              <input
                type="checkbox"
                checked={form.mandatoryElements.includes(element)}
                onChange={() =>
                  update(
                    "mandatoryElements",
                    toggleMandatoryElement(form.mandatoryElements, element),
                  )
                }
              />
              {MANDATORY_ELEMENT_LABELS[element]}
            </label>
          ))}
        </fieldset>

        {/* Variation count — 9 gated to Pro (Req 8.4/8.5) */}
        <fieldset className="field">
          <legend>Jumlah Variasi</legend>
          <div className="variation-options">
            {VARIATION_COUNTS.map((count: VariationCount) => {
              const enabled = isVariationCountEnabled(plan, count);
              const isPro = !enabled;
              return (
                <label key={count} className="radio-row">
                  <input
                    type="radio"
                    name="variationCount"
                    value={count}
                    checked={form.variationCount === count}
                    disabled={!enabled}
                    onChange={() => update("variationCount", count)}
                  />
                  {count}
                  {isPro && (
                    <span className="pro-badge" aria-label="Fitur Pro">
                      Pro
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Asset upload */}
        <div className="field">
          <label htmlFor="assets">Unggah Aset (PNG/JPG/JPEG)</label>
          <input
            id="assets"
            type="file"
            multiple
            accept="image/png,image/jpeg,image/jpg"
            onChange={(e) => handleFileChange(e.target.files)}
          />
          {uploadResult && (
            <div className="upload-feedback">
              {uploadResult.accepted.length > 0 && (
                <p className="upload-accepted">
                  {uploadResult.accepted.length} berkas diterima.
                </p>
              )}
              {uploadResult.rejected.length > 0 && (
                <ul className="upload-rejected" role="alert">
                  {uploadResult.rejected.map((r, i) => (
                    <li key={`${r.file}-${i}`}>
                      {r.file}: {r.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <button type="submit" disabled={submitting}>
          {submitting ? "Memulai…" : "Generate"}
        </button>

        {submitMessage && (
          <p className="submit-message" role="status">
            {submitMessage}
          </p>
        )}
      </form>
    </section>
  );
}
