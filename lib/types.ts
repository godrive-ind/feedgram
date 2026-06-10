/**
 * Core data types & interfaces for the Feed Design Generator.
 *
 * Mirrors the "Data Models" and "Components and Interfaces" sections of the
 * design document. Types-only module: no runtime logic beyond the enum option
 * constants used by `getOptions()` and the UI.
 *
 * Requirements: 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.1
 */

// ---------------------------------------------------------------------------
// Brief option enums (runtime constants + derived literal union types)
// ---------------------------------------------------------------------------

/** Content goal options (tujuan konten). Req 1.4 */
export const CONTENT_GOALS = [
  "Rekrutmen",
  "Promosi",
  "Branding",
  "Edukasi",
  "Engagement",
  "Report",
] as const;
export type ContentGoal = (typeof CONTENT_GOALS)[number];

/** Visual style options (gaya visual). Req 1.5 */
export const VISUAL_STYLES = [
  "BoldDark",
  "VibrantCleanModern",
  "CorporateBlue",
  "Minimalis",
  "WarmEarth",
  "NeonCyber",
  "Luxury",
  "Gradient",
] as const;
export type VisualStyle = (typeof VISUAL_STYLES)[number];

/** Tone options (tone konten). Req 1.6 */
export const TONES = [
  "Profesional",
  "Energik",
  "Edukatif",
  "Minimalis",
  "Friendly",
  "Formal",
] as const;
export type Tone = (typeof TONES)[number];

/** Mandatory element options (elemen wajib). Req 1.9 */
export const MANDATORY_ELEMENTS = [
  "LogoStrip",
  "CTAButton",
  "StatCards",
  "QRCode",
  "BadgeFloating",
  "ProgressBar",
] as const;
export type MandatoryElement = (typeof MANDATORY_ELEMENTS)[number];

/** Variation count options (jumlah variasi). Req 1.8 */
export const VARIATION_COUNTS = [3, 6, 9] as const;
export type VariationCount = (typeof VARIATION_COUNTS)[number];

/**
 * Output format options (format output). Req 1.7
 * Runtime list of the discriminated-union members with fixed width/height.
 */
export const OUTPUT_FORMATS = [
  { name: "InstagramFeed", width: 1080, height: 1350 },
  { name: "Carousel", width: 1080, height: 1080 },
  { name: "StoryReel", width: 1080, height: 1920 },
  { name: "Square", width: 1080, height: 1080 },
  { name: "Landscape", width: 1200, height: 628 },
] as const;

/** Output format discriminated union. Req 1.7 */
export type OutputFormat =
  | { name: "InstagramFeed"; width: 1080; height: 1350 }
  | { name: "Carousel"; width: 1080; height: 1080 }
  | { name: "StoryReel"; width: 1080; height: 1920 }
  | { name: "Square"; width: 1080; height: 1080 }
  | { name: "Landscape"; width: 1200; height: 628 };

/** Subscription plans. Req 8.4, 8.5 */
export const PLANS = ["Free", "Pro"] as const;
export type Plan = (typeof PLANS)[number];

/** Publish channels. Req 6.4 */
export const PUBLISH_CHANNELS = ["instagram", "facebook", "linkedin"] as const;
export type PublishChannel = (typeof PUBLISH_CHANNELS)[number];

/**
 * Aggregated brief options consumed by `Brief_Intake.getOptions()` and the UI.
 * Req 1.4-1.9
 */
export interface BriefOptions {
  contentGoals: readonly ContentGoal[];
  visualStyles: readonly VisualStyle[];
  tones: readonly Tone[];
  outputFormats: readonly OutputFormat[];
  variationCounts: readonly VariationCount[];
  mandatoryElements: readonly MandatoryElement[];
}

// ---------------------------------------------------------------------------
// Layer 1 — Brief input & validation
// ---------------------------------------------------------------------------

/** Design brief input (Layer 1). Req 1.1 */
export interface DesignBriefInput {
  brandName: string; // wajib, <=50
  tagline?: string; // <=100
  mainMessage?: string; // <=500
  contentGoal: ContentGoal; // Req 1.4
  visualStyle: VisualStyle; // Req 1.5
  tone: Tone; // Req 1.6
  outputFormat: OutputFormat; // Req 1.7
  variationCount: VariationCount; // Req 1.8
  accentPalette: string[]; // nilai warna hex
  mandatoryElements: MandatoryElement[]; // Req 1.9
  uploadedAssets: ImageAsset[];
  // --- Design Intelligence layer (additive, non-breaking) ---
  professionalMode?: boolean; // Req 1.1, 1.4 (default false)
  professional?: ProfessionalBriefFields; // hadir saat professionalMode ON (Req 2.1)
}

/** Field-level validation error. */
export interface FieldError {
  field: string;
  message: string;
}

/** Result of `validateBrief`. Req 1.3 */
export interface ValidationResult {
  valid: boolean;
  errors: FieldError[];
  preservedValues: DesignBriefInput; // nilai field dipertahankan apa adanya
}

/** A file submitted for upload (pre-validation). */
export interface UploadedFile {
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Marks a valid file to trigger automatic background removal. Req 1.10 */
  triggerBackgroundRemoval?: boolean;
}

/** Reason an uploaded file is rejected. Req 1.11, 1.12 */
export type UploadRejectionReason = "format" | "size" | "count";

/** Result of `validateUpload`. Req 1.10, 1.11, 1.12 */
export interface UploadValidationResult {
  accepted: UploadedFile[];
  rejected: { file: string; reason: UploadRejectionReason; message: string }[];
}

// ---------------------------------------------------------------------------
// Layer 2 — Pipeline state machine
// ---------------------------------------------------------------------------

/** Pipeline step identifiers (1..6). Req 2.1, 2.2 */
export type StepId = 1 | 2 | 3 | 4 | 5 | 6;

/** Status of an individual pipeline step. Req 2.9 */
export type StepStatus = "pending" | "running" | "done" | "failed";

/** In-memory pipeline state across the 6 steps. */
export interface PipelineState {
  current: StepId;
  statuses: Record<StepId, StepStatus>;
  brief: DesignBriefInput;
  brandDna?: BrandDNA;
  designSystem?: DesignSystem;
  copy?: CopyContent;
  layout?: LayoutTemplate;
  imagePrompt?: ImagePrompt;
  batch?: GenerationBatch;
  // --- Design Intelligence layer (additive, non-breaking) ---
  professionalMode?: boolean;
  briefAnalysis?: DesignBriefAnalysis; // diisi FASE PRA (Req 4.1)
  visualStrategy?: VisualStrategy; // diisi FASE PRA
  designDna?: DesignDNA;
  decisionWeights?: DecisionWeights;
  layeredPrompt?: LayeredSystemPrompt;
}

/** Result of running a single pipeline step. */
export interface StepResult {
  step: StepId;
  status: StepStatus;
  state: PipelineState;
  error?: string;
}

/** Brand consistency verification report. Req 5.5, 5.6 */
export interface ConsistencyReport {
  consistent: boolean;
  violations: {
    variationId: string;
    attribute:
      | "brandDna"
      | "accentPalette"
      | "headlineFont"
      | "bodyFont"
      | "mandatoryElement";
    detail: string;
  }[];
}

// ---------------------------------------------------------------------------
// Pipeline step outputs / data models
// ---------------------------------------------------------------------------

/** Step 1 output — Brand DNA. Req 2.3, 5.2 */
export interface BrandDNA {
  brandName: string;
  tagline?: string;
  accentPalette: string[]; // identik untuk seluruh variasi (Req 5.2)
  tone: string;
  visualStyle: string;
}

/** Step 2 output — Design System. Req 2.4, 5.3 */
export interface DesignSystem {
  headlineFont: string; // identik untuk seluruh variasi (Req 5.3)
  bodyFont: string; // identik untuk seluruh variasi (Req 5.3)
  typographyScale: number[];
  radius: number;
  layoutDensity: "compact" | "regular" | "spacious";
  brandElementPosition: { logo: string; watermark?: string };
  ctaStyle: string;
}

/** Step 3 output — Copy content. Req 2.5 */
export interface CopyContent {
  headline: string;
  subHeadline?: string;
  body?: string;
  cta: string;
  alignedGoal: string; // sesuai contentGoal
  alignedTone: string; // sesuai tone (Req 2.5)
}

/** A single placement slot on a layout template. */
export interface LayoutSlot {
  type: "text" | "image" | "element";
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Step 4 output — Layout template. Req 2.6 */
export interface LayoutTemplate {
  id: string;
  format: OutputFormat; // sesuai Output_Format (Req 2.6)
  slots: LayoutSlot[];
  includedElements: MandatoryElement[]; // mencakup seluruh elemen wajib
}

/** Step 5 output — Image prompt. Req 2.7 */
export interface ImagePrompt {
  prompt: string; // gabungan BrandDNA + DesignSystem + LayoutTemplate (Req 2.7)
  negativePrompt?: string;
  seed?: number;
}

/** Reference to a rendered Fabric.js canvas result. */
export interface CanvasRef {
  url: string;
  width: number;
  height: number;
  format?: string;
}

/** Step 6 / output — a single design variation. Req 2.8 */
export interface DesignVariation {
  id: string;
  batchId: string;
  brandDna: BrandDNA; // identik antarvariasi
  designSystem: DesignSystem; // identik antarvariasi
  copy: CopyContent;
  layout: LayoutTemplate;
  imageAsset: ImageAsset;
  renderedCanvas: CanvasRef; // hasil Fabric.js
  rating?: number; // 1..5
  // --- Design Intelligence layer (additive, non-breaking) ---
  qualityReport?: QualityReport; // hasil evaluasi final
  acceptedWithWarning?: boolean; // Req 6.7
  refinementRating?: number; // saluran 1..10 (A7), terpisah dari rating 1..5
}

/** A batch of design variations generated from one brief. Req 2.8 */
export interface GenerationBatch {
  id: string;
  userId: string;
  briefId: string;
  variations: DesignVariation[]; // jumlah == variationCount (Req 2.8)
  status: "running" | "done" | "failed" | "inconsistent";
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Async job model (Vercel serverless background execution)
// ---------------------------------------------------------------------------

/** Job lifecycle state. */
export type JobState = "queued" | "running" | "done" | "failed";

/** A pipeline job created by `POST /api/generate`. */
export interface Job {
  id: string; // jobId yang dikembalikan POST /api/generate
  userId: string; // otorisasi kepemilikan
  briefId: string;
  variationCount: VariationCount;
  reservationId: string; // kredit yang direservasi untuk batch ini
  createdAt: string;
  professionalMode?: boolean; // Design Intelligence (additive)
}

/** Polled job status. Req 2.9, 2.10 */
export interface JobStatus {
  jobId: string;
  state: JobState;
  currentStep: StepId; // langkah aktif (Req 2.9)
  statuses: Record<StepId, StepStatus>; // status tiap langkah 1..6
  resultBatchId?: string; // terisi saat state == "done"
  failedStep?: StepId; // terisi saat state == "failed"
  message?: string; // pesan menyebut nomor+nama langkah (Req 2.10)
  updatedAt: string; // diperbarui <=2s per transisi (Req 2.9)
  // --- Design Intelligence layer (additive, non-breaking) ---
  intelligence?: {
    briefAnalysisReady?: boolean;
    acceptedCount?: number; // variasi diterima (untuk kredit)
    warnings?: string[]; // mis. accept-with-warning (Req 6.7)
  };
}

// ---------------------------------------------------------------------------
// Monetisasi — Plan & Credit
// ---------------------------------------------------------------------------

/** Credit balance for a user. Req 8.6 */
export interface Credit {
  userId: string;
  balance: number; // integer >= 0 (Req 8.6)
}

/** Result of a credit reservation (reserve -> commit/refund). */
export interface ReservationResult {
  success: boolean;
  reservationId?: string;
  amount?: number;
  /** Indicates a Pro upgrade prompt when credit is insufficient. Req 8.3 */
  upgradePrompt?: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// Shared assets & file references
// ---------------------------------------------------------------------------

/** A generated or uploaded image asset. */
export interface ImageAsset {
  id: string;
  url: string;
  width: number;
  height: number;
}

/** Reference to a stored exported file (object storage). */
export interface FileRef {
  url: string;
  format: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Layer 4 — Canvas renderer support types
// ---------------------------------------------------------------------------

/** Edit controls surfaced when a variation is selected. Req 4.4 */
export interface EditControls {
  variationId: string;
  canEdit: boolean;
  canRegenerate: boolean;
  canDuplicate: boolean;
}

/** A partial change to a design system applied to the preview. Req 4.5 */
export interface DesignSystemPatch {
  headlineFont?: string;
  bodyFont?: string;
  radius?: number;
  layoutDensity?: DesignSystem["layoutDensity"];
  typographyScale?: number[];
  logoPosition?: string;
  watermark?: string;
  ctaStyle?: string;
}

/** Specification used by `composeVariation`. Req 3.3 */
export interface VariationSpec {
  batchId: string;
  brandDna: BrandDNA;
  designSystem: DesignSystem;
  copy: CopyContent;
  layout: LayoutTemplate;
  imageAsset: ImageAsset;
}

// ---------------------------------------------------------------------------
// Layer 5 — Export & publish support types
// ---------------------------------------------------------------------------

/** Result of a direct publish to a social channel. Req 6.4, 6.6, 6.7 */
export interface PublishResult {
  success: boolean;
  channel: PublishChannel;
  attempts: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// Layer 6 — History & feedback support types
// ---------------------------------------------------------------------------

/** Result of rating a variation. Req 7.4, 7.8 */
export interface RatingResult {
  accepted: boolean; // false jika di luar 1..5
  storedRating?: number; // rating sebelumnya dipertahankan jika ditolak
  message?: string;
}

// ---------------------------------------------------------------------------
// Layer 3 — AI service connector request types
// ---------------------------------------------------------------------------

/** Request payload for copy generation. Req 3.1 */
export interface CopyRequest {
  brief: DesignBriefInput;
  brandDna: BrandDNA;
  contentGoal: ContentGoal;
  tone: Tone;
  /**
   * Optional layered System_Prompt prepended to the copy generation prompt when
   * Professional_Mode is active (Req 3.7). Additive/non-breaking: absent in the
   * legacy/base flow, so existing adapters that ignore it keep working.
   */
  systemPrompt?: string;
}

/** Request payload for image generation. Req 3.2 */
export interface ImageRequest {
  imagePrompt: ImagePrompt;
  format: OutputFormat;
}

// ---------------------------------------------------------------------------
// Design Intelligence layer — additive, non-breaking types
//
// Mirrors the "Data Models" section of the Design Intelligence System design.
// All new fields on existing interfaces are optional; new behaviour is gated
// by `professionalMode`. Types-only: no runtime logic beyond enum constants.
// Requirements: 1.1, 1.4, 2.1, 2.2, 4.2, 4.3, 5.2, 8.1
// ---------------------------------------------------------------------------

/** Design purpose options (purpose-driven). Req 2.2 */
export const DESIGN_PURPOSES = [
  "Marketing_Conversion",
  "Branding_Awareness",
  "Education",
  "Engagement",
] as const;
export type DesignPurpose = (typeof DESIGN_PURPOSES)[number];

/** Enhanced professional brief fields (present when professionalMode ON). Req 2.1, 2.5 */
export interface ProfessionalBriefFields {
  designPurpose: DesignPurpose; // wajib (Req 2.5)
  audience: { age?: string; profession?: string; painPoint?: string }; // Req 2.1
  primaryGoal: string; // wajib (Req 2.5)
  emotionTarget: string; // Req 2.1
  coreMessage: string; // wajib, <= 7 kata (Req 2.3)
}

// --- Reasoning artefacts (Req 4) ---

/** Design brief analysis artefact (FASE PRA). Req 4.2 */
export interface DesignBriefAnalysis {
  coreMessage: string;
  targetAudience: string;
  primaryGoal: string;
  emotionTarget: string;
}

/** Typography choice with reasoning. Req 4.3 */
export interface TypographyChoice {
  system: string;
  reasoning: string;
}

/** Visual strategy artefact (FASE PRA). Req 4.3 */
export interface VisualStrategy {
  hierarchyPlan: string;
  compositionType: string;
  colorPsychology: string;
  typography: TypographyChoice; // system + reasoning
  whitespaceRatio: number; // 0..1
}

// --- Quality (Req 5, 6, 10) ---

/** Quality criterion identifiers (7 default criteria). A2, Req 6.2 */
export type QualityCriterionName =
  | "Hierarchy"
  | "Readability"
  | "Composition"
  | "BrandingConsistency"
  | "Originality"
  | "PremiumPerception"
  | "Whitespace";

/** Quality criterion configuration (name + per-criterion threshold). Req 6.2, 6.3, 6.9 */
export interface QualityCriterion {
  name: QualityCriterionName;
  threshold: number; // ambang per-kriteria (A3)
}

/** A single criterion score. Req 5.2, 5.7 */
export interface QualityScore {
  criterion: QualityCriterionName;
  score: number; // bilangan bulat 1..10 (A1)
}

/** Quality evaluation report produced by Quality_Evaluator. Req 5.2, 5.3, 5.4, 10.4 */
export interface QualityReport {
  variationId: string;
  scores: QualityScore[]; // satu per kriteria
  weightedTotal: number; // 1.0..10.0
  decision: "ACCEPTED" | "REJECTED"; // indikatif evaluator (Req 5.4)
  critique: string; // non-kosong; >=1 kalimat tiap kriteria <7
  detectedNegativePatterns: string[]; // Req 10.4
}

// --- Design_DNA, Decision_Weights, Memory (Req 7, 8, 9) ---

/** Tunable style parameters. Req 8.3 */
export interface DesignDNA {
  whitespaceRatio: number; // 0..1
  elementCount: number; // >=0
  typographyWeight: number; // 0..1 (ringan..tebal)
  paletteRestraint: number; // 0..1 (ekspresif..terbatas)
  decorationLevel: number; // 0..1 (minimal..dekoratif)
}

/** Purpose-driven decision weights. Req 7.1 */
export interface DecisionWeights {
  weights: Record<QualityCriterionName, number>; // ternormalisasi, total 1.0
  priority: QualityCriterionName[]; // urutan prioritas, tertinggi dulu
  purpose: DesignPurpose;
}

/** A single Design_DNA adjustment. Req 8.3, 8.7 */
export interface DnaAdjustment {
  parameter: keyof DesignDNA;
  direction: "up" | "down";
  delta: number; // > 0
}

/** Aggregated context for intelligence memory matching (no PII). Req 9.2, 9.5 */
export interface MemoryContext {
  industry: string;
  purpose: DesignPurpose;
  audience: string; // representasi audiens teragregasi (tanpa PII)
}

/** A persisted intelligence-memory learning entry. Req 9.1, 9.5 */
export interface IntelligenceMemoryEntry {
  id: string;
  userId: string;
  context: MemoryContext;
  designDna: DesignDNA;
  outcome: "ACCEPTED" | "REJECTED";
  feedback?: string; // umpan balik teragregasi (tanpa PII)
  createdAt: string; // ISO; dipakai retensi 365 hari (Req 9.7)
}

// --- Layered System Prompt (Req 3) ---

/** Four-layer system prompt composed in fixed order L1->L2->L3->L4. Req 3.1, 3.2 */
export interface LayeredSystemPrompt {
  l1Identity: string; // persona senior art director (Req 3.3)
  l2Thinking: string; // proses berpikir -> analysis & strategy (Req 3.4)
  l3QualityGate: string; // daftar kriteria + threshold (Req 3.5)
  l4DesignDnaWeights: string; // bobot dari Decision_Weights (Req 3.6)
  composed: string; // komposisi final L1\nL2\nL3\nL4 (Req 3.2)
}
