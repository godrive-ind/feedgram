# Implementation Plan: Design Intelligence System

## Overview

Rencana ini mengubah desain Design Intelligence System menjadi serangkaian langkah implementasi berbasis kode yang inkremental dan dapat diuji, sebagai **lapisan aditif** di atas Feed Design Generator yang sudah ada (Next.js App Router + TypeScript, deploy Vercel). Urutan implementasi memprioritaskan **modul logika murni** di `lib/intelligence/*` (professional-mode gating, validasi brief profesional, decision weights, Design_DNA, layered prompt, quality-gate, intelligence-memory) yang divalidasi lewat **property-based test (fast-check, ≥100 iterasi)** sejak awal, kemudian **adapter AI baru** (Quality_Evaluator), lalu **integrasi worker** (FASE PRA + FASE PASCA + loop regenerasi + kebijakan kredit), kemudian **endpoint baru** (refinement, penayangan artefak, pengelolaan memori), dan terakhir **persistensi Prisma** serta **integration/smoke test**.

Prinsip:
- Setiap tugas membangun di atas tugas sebelumnya dan diakhiri dengan menyambungkan (wiring) komponen ke worker/endpoint, tanpa kode menggantung.
- Seluruh kapabilitas baru bersifat aditif & non-destruktif: field baru opsional, perilaku baru di-*gate* oleh `professionalMode`; urutan ketat 6-langkah pipeline tidak berubah di kedua mode.
- Layanan AI (LLM + Quality_Evaluator) diakses lewat adapter pluggable dan **dapat di-mock** untuk pengujian; modul scoring/DNA/memory bersifat murni & deterministik.
- Setiap property test diberi tag: `Feature: design-intelligence-system, Property {n}: {teks properti}`, dengan minimal 100 iterasi (`{ numRuns: 100 }`).
- Seluruh endpoint baru WAJIB melewati autentikasi + otorisasi kepemilikan per-pengguna.
- Hanya tugas yang dapat dijalankan/di-deploy di Vercel sebagai kode.

## Tasks

- [x] 1. Perluasan tipe inti & data model untuk lapisan intelligence
  - [x] 1.1 Tambahkan perluasan tipe aditif di `lib/types.ts`
    - Perluas `DesignBriefInput` dengan `professionalMode?: boolean` dan `professional?: ProfessionalBriefFields` (opsional, non-breaking)
    - Tambahkan tipe: `DesignPurpose`, `ProfessionalBriefFields`, `DesignBriefAnalysis`, `TypographyChoice`, `VisualStrategy`, `QualityCriterionName`, `QualityCriterion`, `QualityScore`, `QualityReport`, `DesignDNA`, `DecisionWeights`, `DnaAdjustment`, `MemoryContext`, `IntelligenceMemoryEntry`
    - Perluas `PipelineState` (opsional): `professionalMode`, `briefAnalysis`, `visualStrategy`, `designDna`, `decisionWeights`, `layeredPrompt`
    - Perluas `Job` dengan `professionalMode?`, `JobStatus` dengan `intelligence?` ({ briefAnalysisReady, acceptedCount, warnings }), dan `DesignVariation` dengan `qualityReport?`, `acceptedWithWarning?`, `refinementRating?`
    - _Requirements: 1.1, 1.4, 2.1, 2.2, 4.2, 4.3, 5.2, 8.1_

- [x] 2. Professional_Mode threading (gating dasar)
  - [x] 2.1 Implementasi resolusi flag di `lib/intelligence/professional-mode.ts`
    - Definisikan `PROFESSIONAL_MODE_DEFAULT = false` dan `resolveProfessionalMode(brief)` yang mengembalikan nilai brief atau default nonaktif bila absen
    - _Requirements: 1.1, 1.4_
  - [ ]* 2.2 Tulis property test default Professional_Mode nonaktif
    - **Property 1: Default Professional_Mode nonaktif**
    - **Validates: Requirements 1.4**

- [x] 3. Enhanced Brief_Intake (validasi brief profesional — logika murni)
  - [x] 3.1 Implementasi validasi brief profesional di `lib/intelligence/professional-brief.ts`
    - Definisikan `CORE_MESSAGE_MAX_WORDS = 7`, `DESIGN_PURPOSES`, tipe `DesignPurpose`, `ProfessionalBriefFields`, dan `countWords(text)`
    - Implementasi `validateProfessionalBrief(brief)`: aktif hanya saat `professionalMode === true`; tolak core message > 7 kata dengan pesan menyebut batas 7 kata; tandai `designPurpose`/`primaryGoal`/`coreMessage` wajib dan tolak yang kosong dengan menyebut field yang kurang; kembalikan `preservedValues` mempertahankan seluruh nilai field lain
    - Delegasikan validasi unggahan referensi ke `validateUpload` yang ada (PNG/JPG/JPEG, ≤10 MB, ≤10 berkas)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
  - [ ]* 3.2 Tulis property test batas tujuh kata core message
    - **Property 4: Batas tujuh kata core message**
    - **Validates: Requirements 2.3, 2.4**
  - [ ]* 3.3 Tulis property test validasi field wajib dengan preservasi
    - **Property 5: Validasi field wajib profesional dengan preservasi**
    - **Validates: Requirements 2.4, 2.5, 2.6**
  - [ ]* 3.4 Tulis unit test enum Design_Purpose & delegasi unggahan
    - Verifikasi daftar `DESIGN_PURPOSES` (Marketing_Conversion, Branding_Awareness, Education, Engagement) dan delegasi ke `validateUpload`
    - _Requirements: 2.1, 2.2, 2.7_

- [x] 4. Decision_Weights — purpose-driven (logika murni)
  - [x] 4.1 Implementasi `deriveDecisionWeights` di `lib/intelligence/decision-weights.ts`
    - Definisikan `DecisionWeights` (weights ternormalisasi total 1.0, priority, purpose) dan aturan rule-based per Design_Purpose
    - Marketing_Conversion → Hierarchy & Readability tertinggi; Branding_Awareness → Branding Consistency & Premium Perception; Education → Readability & Hierarchy; Engagement → Originality & Composition; kriteria prioritas selalu berbobot > non-prioritas
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - [ ]* 4.2 Tulis property test aturan Decision_Weights berbasis tujuan
    - **Property 13: Aturan Decision_Weights berbasis tujuan**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**

- [x] 5. Design_DNA (parameter gaya — logika murni)
  - [x] 5.1 Implementasi modul Design_DNA di `lib/intelligence/design-dna.ts`
    - Definisikan `DesignDNA`, `DEFAULT_DESIGN_DNA`, `DnaAdjustment`, `clampDesignDna` (klamp ke rentang valid)
    - Implementasi `applyDnaAdjustments` monoton ("up" tidak menurunkan, "down" tidak menaikkan setelah clamp) yang mengembalikan DNA baru + daftar `changes` (parameter + arah)
    - Implementasi `initDesignDnaFromWeights(weights)` untuk inisialisasi default
    - _Requirements: 8.3, 8.7, 9.4_
  - [ ]* 5.2 Tulis property test monotonisitas penyesuaian Design_DNA
    - **Property 16: Monotonisitas penyesuaian Design_DNA**
    - **Validates: Requirements 8.3, 8.7**

- [x] 6. Layered System Prompt builder (logika murni)
  - [x] 6.1 Implementasi `buildLayeredSystemPrompt` & `applyLayeredPrompt` di `lib/intelligence/prompt-layers.ts`
    - Susun empat lapisan urutan tetap L1→L2→L3→L4: L1 persona senior art director, L2 proses berpikir (analysis & strategy), L3 daftar `QualityCriterion` + threshold, L4 bobot dari `Decision_Weights`
    - Hasilkan `composed` dengan urutan posisi tetap; `applyLayeredPrompt(base, layered)` menyisipkan `composed` ke depan base tanpa menghilangkan base
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  - [ ]* 6.2 Tulis property test komposisi dan urutan Layered_System_Prompt
    - **Property 6: Komposisi dan urutan Layered_System_Prompt**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

- [x] 7. Quality_Gate — pure scoring & decision (logika murni)
  - [x] 7.1 Implementasi quality-gate di `lib/intelligence/quality-gate.ts`
    - Definisikan `QualityGateConfig`, `DEFAULT_QUALITY_GATE_CONFIG` (7 kriteria A2, threshold A3, total 7.5 A4, maxRegenerationAttempts 3 A5), `GateDecision`, `GateResult`
    - Implementasi `computeWeightedTotal(scores, weights)` (hasil dalam [1.0, 10.0]) dan `evaluateGate(report, config, weights)`: REJECTED jika ada kriteria < threshold ATAU total < totalThreshold, selain itu ACCEPTED
    - Implementasi `selectBestAttempt(attempts)` mengembalikan attempt skor tertinggi untuk accept-with-warning
    - Pastikan seluruh keputusan dan batas mengikuti config (tidak hardcode)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 6.8, 6.9, 7.6, 10.3_
  - [ ]* 7.2 Tulis property test keputusan Quality_Gate dan skor total berbobot
    - **Property 9: Keputusan Quality_Gate dan skor total berbobot**
    - **Validates: Requirements 5.2, 5.7, 6.1, 6.5, 6.8, 7.6, 10.3**
  - [ ]* 7.3 Tulis property test konfigurabilitas ambang dan batas regenerasi
    - **Property 12: Konfigurabilitas ambang dan batas regenerasi**
    - **Validates: Requirements 6.9**
  - [ ]* 7.4 Tulis property test pemilihan attempt terbaik untuk accept-with-warning
    - **Property 11: Pemilihan attempt terbaik untuk accept-with-warning**
    - **Validates: Requirements 6.7**
  - [ ]* 7.5 Tulis unit test konfigurasi default Quality_Gate
    - Verifikasi `DEFAULT_QUALITY_GATE_CONFIG`: daftar 7 kriteria, threshold per-kriteria (Readability/Branding ≥8, sisanya ≥7), ambang total 7.5
    - _Requirements: 6.2, 6.3, 6.4_

- [x] 8. Checkpoint - Pastikan seluruh tes lapisan logika murni lolos
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Quality_Evaluator adapter (perluasan AI_Service_Connector)
  - [x] 9.1 Tambahkan kontrak Quality_Evaluator ke `lib/ai/connector.ts`
    - Definisikan `QualityEvaluationRequest` dan `QualityEvaluatorAdapter`; perluas `AIServiceConnector` dengan `evaluateQuality(req, opts?)` yang dibungkus `callWithRetry` (timeout 30s, ≤3 percobaan) dengan step-label evaluasi terpisah
    - Pastikan adapter beroperasi sebagai peran AI terpisah dari LLM copy & image, dan memakai env var sisi-server saja
    - _Requirements: 5.1, 5.5, 5.6, 5.8_
  - [x] 9.2 Perluas `MockAIServiceConnector` dengan `evaluatorAdapter`
    - Tambahkan `evaluatorAdapter: MockAdapter<[QualityEvaluationRequest], QualityReport>` agar test deterministik; integrasikan dengan `createControllableScheduler` agar timeout 30s tidak menahan test
    - Adapter mengembalikan `QualityReport` dengan skor per kriteria (1–10), skor total berbobot, keputusan indikatif, critique non-kosong (≥1 kalimat per kriteria <7), dan `detectedNegativePatterns`
    - _Requirements: 5.2, 5.3, 5.7, 10.4_
  - [ ]* 9.3 Tulis integration test pemanggilan & retry Quality_Evaluator
    - Verifikasi `evaluateQuality` mengembalikan `Quality_Report` dalam batas waktu; kegagalan/timeout memicu retry ≤3 lalu menghentikan variasi (mock AI)
    - _Requirements: 5.1, 5.8_
  - [ ]* 9.4 Tulis smoke test arsitektur adapter Quality_Evaluator
    - Verifikasi adapter pluggable & mockable serta peran terpisah dari copy/image, diakses via `AI_Service_Connector`
    - _Requirements: 5.5, 5.6, 11.3_

- [x] 10. Brief_Analysis & Visual_Strategy (FASE PRA — LLM-backed, mockable)
  - [x] 10.1 Implementasi `buildBriefAnalysis` di `lib/intelligence/brief-analysis.ts`
    - Bangun `DesignBriefAnalysis` (coreMessage, targetAudience, primaryGoal, emotionTarget) dari `ProfessionalBriefFields` via connector LLM; mockable dengan `ConnectorCallOptions`
    - _Requirements: 4.2, 2.8_
  - [x] 10.2 Implementasi `buildVisualStrategy` di `lib/intelligence/visual-strategy.ts`
    - Bangun `VisualStrategy` (hierarchyPlan, compositionType, colorPsychology, typography {system, reasoning}, whitespaceRatio dalam [0,1]) memakai urutan prioritas `Decision_Weights` untuk keputusan hierarchy/composition
    - _Requirements: 4.3, 7.7_
  - [ ]* 10.3 Tulis property test kelengkapan artefak penalaran
    - **Property 7: Kelengkapan artefak penalaran**
    - **Validates: Requirements 4.2, 4.3**
  - [ ]* 10.4 Tulis unit test pass-through field profesional & penerapan prioritas
    - Verifikasi field profesional diteruskan ke input Brief_Analysis (Req 2.8) dan urutan prioritas diterapkan pada Visual_Strategy (Req 7.7)
    - _Requirements: 2.8, 7.7_

- [x] 11. Intelligence_Memory — pluggable store (logika murni + seam)
  - [x] 11.1 Implementasi in-memory store di `lib/intelligence/intelligence-memory.ts`
    - Definisikan `MemoryContext`, `IntelligenceMemoryEntry`, `IntelligenceMemoryStore`; implementasi `InMemoryIntelligenceMemoryStore` dengan `save`, `retrieve` (cocok konteks per-user, terbaru dulu, hanya non-expired), `deleteByUser`, `purgeExpired` (>365 hari)
    - Pastikan store hanya menerima `DesignDNA` + `MemoryContext` teragregasi + outcome + feedback (tanpa PII brief mentah)
    - Implementasi `seedDesignDnaFromMemory(entries)`: prioritaskan DNA dari entri ACCEPTED, hindari REJECTED, kembalikan `undefined` bila tak ada yang cocok
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_
  - [x] 11.2 Tambahkan seam provider `lib/server/intelligence-memory-provider.ts`
    - Implementasi `getIntelligenceMemory`/`setIntelligenceMemory`/`resetIntelligenceMemory` mengikuti pola `history-provider.ts`
    - _Requirements: 9.1, 9.2_
  - [ ]* 11.3 Tulis property test pengambilan memori berbasis kecocokan konteks
    - **Property 18: Pengambilan memori berbasis kecocokan konteks**
    - **Validates: Requirements 9.2, 9.4**
  - [ ]* 11.4 Tulis property test seed Design_DNA (prioritas ACCEPTED, hindari REJECTED)
    - **Property 19: Seed Design_DNA memprioritaskan ACCEPTED dan menghindari REJECTED**
    - **Validates: Requirements 9.3, 9.4**
  - [ ]* 11.5 Tulis property test privasi entri memori (tanpa PII)
    - **Property 20: Privasi entri memori (tanpa PII)**
    - **Validates: Requirements 9.5**
  - [ ]* 11.6 Tulis property test penghapusan memori per pengguna
    - **Property 21: Penghapusan memori per pengguna**
    - **Validates: Requirements 9.6**
  - [ ]* 11.7 Tulis property test retensi 365 hari
    - **Property 22: Retensi 365 hari**
    - **Validates: Requirements 9.7**

- [x] 12. Negative-Pattern Avoidance (integrasi step 5)
  - [x] 12.1 Perluas `createStepTransforms` & `buildImagePrompt` di `lib/pipeline/steps.ts`
    - Tambahkan opsi `intelligence?: { layeredPrompt, negativePrompt }` pada `StepTransformsOptions`; saat hadir, step 3 menambahkan `composed` sebagai system prompt ke `CopyRequest` dan step 5 menambahkan `composed` + memperkuat `negativePrompt` ("generic template, AI-generated look, over-decorated"); saat absen pertahankan perilaku lama
    - _Requirements: 3.7, 10.2_
  - [ ]* 12.2 Tulis property test negative prompt menjauhi pola negatif
    - **Property 24: Negative prompt menjauhi pola negatif**
    - **Validates: Requirements 10.2**

- [x] 13. Refinement_Loop module (validasi & interpretasi — logika murni + LLM)
  - [x] 13.1 Implementasi modul refinement di `lib/intelligence/refinement.ts`
    - Definisikan `REFINEMENT_RATING_MIN/MAX`, `COMMENT_MAX_LENGTH`; implementasi `isValidRefinementRating` (integer 1–10) dan `isValidComment` (1–500 char)
    - Implementasi `interpretComment(comment, dna, connector, opts?)` via LLM → `DnaAdjustment[]`; komentar kosong/tak tertafsir → `[]`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - [ ]* 13.2 Tulis property test validasi rentang rating refinement
    - **Property 14: Validasi rentang rating refinement**
    - **Validates: Requirements 8.1, 8.2**
  - [ ]* 13.3 Tulis property test validasi panjang komentar refinement
    - **Property 15: Validasi panjang komentar refinement**
    - **Validates: Requirements 8.4**
  - [ ]* 13.4 Tulis unit test komentar tak tertafsir → minta klarifikasi
    - Verifikasi interpretasi `[]` menyebabkan variasi dipertahankan dan pesan klarifikasi dikembalikan
    - _Requirements: 8.5_

- [x] 14. Checkpoint - Pastikan seluruh tes modul intelligence lolos
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Integrasi worker — FASE PRA, FASE PASCA, loop regenerasi, kebijakan kredit
  - [x] 15.1 Perluas `PipelineWorker.runJob` untuk FASE PRA & threading di `lib/pipeline/worker.ts`
    - Tambahkan `PipelineWorkerDeps` opsional: `intelligenceMemory?`, `qualityGateConfig?`
    - Saat `professionalMode` aktif: retrieve memori + seed DNA (fallback `initDesignDnaFromWeights`), `deriveDecisionWeights`, bangun Brief_Analysis + Visual_Strategy sebelum step 5, susun Layered_System_Prompt, dan suntik transform ke step 3 & 5; saat nonaktif jalankan jalur lama persis
    - Pertahankan urutan ketat 6-langkah `[1..6]` di kedua mode
    - Kegagalan pembuatan artefak → hentikan job, refund seluruh reservasi, pertahankan brief
    - _Requirements: 1.2, 1.3, 1.5, 3.7, 4.1, 4.4, 4.6, 9.2, 9.4, 11.1, 11.2_
  - [x] 15.2 Implementasi FASE PASCA: evaluasi + Quality_Gate + loop regenerasi terbatas
    - Untuk tiap variasi: panggil `evaluateQuality`, jalankan `evaluateGate`; saat REJECTED & attempt < max → regenerasi pakai critique (tanpa potong kredit); saat max tercapai & masih REJECTED → `selectBestAttempt` + tandai `acceptedWithWarning` + lampirkan `Quality_Report`; batasi total percobaan agar tetap dalam `maxDuration`
    - Simpan `qualityReport` per variasi dan ekspos `warnings`/`acceptedCount` via `JobStatus.intelligence`
    - _Requirements: 5.9, 6.6, 6.7, 6.10, 10.3, 11.2_
  - [x] 15.3 Implementasi penyimpanan Intelligence_Memory & persistensi artefak di worker
    - Saat variasi ACCEPTED/REJECTED → simpan entri memori (DNA, outcome, feedback, konteks teragregasi) dibungkus try/catch agar kegagalan non-fatal; simpan Brief_Analysis/Visual_Strategy bersama batch
    - _Requirements: 4.4, 9.1, 9.8_
  - [x] 15.4 Implementasi kebijakan kredit profesional (partial commit/refund) di worker
    - Pada mode profesional: commit `acceptedCount` (termasuk accept-with-warning), refund `N − acceptedCount`; regenerasi internal tidak menambah konsumsi; kegagalan job → refund seluruh reservasi belum terpakai; mode dasar pertahankan commit penuh
    - _Requirements: 11.4, 11.5_
  - [ ]* 15.5 Tulis property test gating kapabilitas oleh Professional_Mode
    - **Property 2: Gating kapabilitas oleh Professional_Mode**
    - **Validates: Requirements 1.2, 1.3**
  - [ ]* 15.6 Tulis property test urutan ketat enam langkah dipertahankan
    - **Property 3: Urutan ketat enam langkah dipertahankan di kedua mode**
    - **Validates: Requirements 1.5, 11.1**
  - [ ]* 15.7 Tulis property test regenerasi quality-gate terbatas
    - **Property 10: Regenerasi quality-gate terbatas**
    - **Validates: Requirements 6.6, 6.10**
  - [ ]* 15.8 Tulis property test kegagalan penyimpanan memori bersifat non-fatal
    - **Property 23: Kegagalan penyimpanan memori bersifat non-fatal**
    - **Validates: Requirements 9.8**
  - [ ]* 15.9 Tulis property test kebijakan kredit — hanya variasi diterima yang dikonsumsi
    - **Property 25: Kebijakan kredit — hanya variasi diterima yang dikonsumsi**
    - **Validates: Requirements 11.4**
  - [ ]* 15.10 Tulis property test refund penuh saat job gagal
    - **Property 26: Refund penuh saat job gagal**
    - **Validates: Requirements 4.6, 11.5**

- [x] 16. Implementasi runRefinement di worker (regenerasi interaktif)
  - [x] 16.1 Tambahkan `runRefinement(variationId, { rating?, comment? }, userId)` ke `lib/pipeline/worker.ts`
    - Validasi rating/komentar via modul refinement; interpretasi komentar → `DnaAdjustment[]` → `applyDnaAdjustments`; regenerasi pakai DNA tersesuaikan (≤30s); gagal/timeout → pertahankan variasi asal + pesan kegagalan (pola `DeriveResult { ok: false, source }`)
    - Simpan `refinementRating` pada saluran 1–10 terpisah; kembalikan penjelasan perubahan DNA (parameter + arah)
    - _Requirements: 8.1, 8.6, 8.7, 8.8_
  - [ ]* 16.2 Tulis property test preservasi variasi asal saat refinement gagal
    - **Property 17: Preservasi variasi asal saat refinement gagal**
    - **Validates: Requirements 8.5, 8.8**

- [x] 17. Wiring endpoint & threading brief profesional
  - [x] 17.1 Threading professionalMode + validasi profesional di `app/api/generate/route.ts` & Brief_Intake
    - Verifikasi ulang `validateProfessionalBrief` di server saat `professionalMode` aktif; teruskan field profesional ke worker; default nonaktif bila absen
    - Sambungkan kontrol Professional_Mode + field brief profesional di komponen `BriefPanel.tsx`
    - _Requirements: 1.1, 1.4, 2.1, 2.5, 2.6, 2.8_
  - [x] 17.2 Implementasi endpoint penayangan artefak `app/api/batches/[id]/intelligence/route.ts`
    - Kembalikan Brief_Analysis/Visual_Strategy/Quality_Report untuk pemilik; autentikasi + otorisasi kepemilikan (401 tanpa kredensial, 404 lintas-pengguna)
    - Tampilkan artefak di UI (`PropertiesPanel.tsx`/`CanvasPanel.tsx`) saat batch dihasilkan dengan Professional_Mode aktif
    - _Requirements: 4.5, 11.6_
  - [x] 17.3 Implementasi endpoint refinement `app/api/refine/[id]/route.ts`
    - Body `{ rating?, comment? }`; jalankan `runRefinement` di worker background via endpoint terautentikasi + ownership; rating tidak valid → tolak pertahankan rating sebelumnya; komentar tidak valid → tolak pertahankan variasi
    - Mengikuti pola `app/api/variations/[id]/route.ts` + `getVariationStore()` + `derive.ts`
    - _Requirements: 8.1, 8.2, 8.4, 8.9, 11.6_
  - [x] 17.4 Implementasi endpoint pengelolaan `app/api/intelligence-memory/route.ts`
    - Operasi penghapusan data pembelajaran per pengguna (`deleteByUser`) via endpoint terautentikasi; 401 tanpa kredensial, 403 akses lintas-pengguna
    - _Requirements: 9.6, 11.6_
  - [ ]* 17.5 Tulis property test round-trip persistensi artefak dengan batch
    - **Property 8: Round-trip persistensi artefak dengan batch**
    - **Validates: Requirements 4.4**
  - [ ]* 17.6 Tulis smoke test autentikasi endpoint baru
    - Verifikasi tanpa kredensial → 401; akses lintas-pengguna → 404/403 untuk refine, batches/intelligence, dan intelligence-memory
    - _Requirements: 11.6_

- [x] 18. Persistensi Prisma (drop-in store)
  - [x] 18.1 Tambahkan model & kolom Prisma di `prisma/schema.prisma`
    - Tambahkan model `IntelligenceMemory` (userId, industry, purpose, audience, designDna Json, outcome, feedback?, createdAt + index konteks/createdAt + relasi User cascade)
    - Tambahkan kolom nullable non-breaking: `GenerationBatch.briefAnalysis Json?`, `GenerationBatch.visualStrategy Json?`, `DesignVariation.qualityReport Json?`, `DesignVariation.refinementRating Int?`
    - _Requirements: 4.4, 9.1, 9.7_
  - [x] 18.2 Implementasi `PrismaIntelligenceMemoryStore` sebagai drop-in
    - Implementasikan `IntelligenceMemoryStore` Prisma-backed (struktural seperti `PrismaJobStore`); tegakkan retensi 365 hari pada `retrieve` (filter expired) dan `purgeExpired`; sambungkan ke provider
    - _Requirements: 9.1, 9.2, 9.6, 9.7_

- [ ] 19. Integrasi end-to-end & wiring akhir
  - [ ]* 19.1 Tulis integration test alur job mode profesional end-to-end
    - `POST /api/generate` (professionalMode=true) → worker FASE PRA + pipeline 1–6 + FASE PASCA → `GET /api/jobs/{jobId}` melaporkan progres lalu `done` dengan artefak + acceptedCount (AI/store di-mock)
    - _Requirements: 1.3, 4.1, 5.9, 11.2_
  - [ ]* 19.2 Tulis integration test penayangan artefak & refinement
    - `GET /api/batches/[id]/intelligence` mengembalikan artefak untuk pemilik; `POST /api/refine/[id]` menjalankan regenerasi di worker, menyimpan rating 1–10, mengembalikan penjelasan perubahan DNA
    - _Requirements: 4.5, 8.6, 8.7, 8.9_
  - [ ]* 19.3 Tulis integration test critique evaluator & negative pattern
    - Verifikasi critique memuat kalimat per kriteria <7 dan identifikasi Negative_Pattern terhadap adapter mock terkonfigurasi
    - _Requirements: 5.3, 10.1, 10.4_

- [x] 20. Checkpoint akhir - Pastikan seluruh tes lolos
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tugas yang ditandai `*` bersifat opsional (unit/property/integration/smoke test) dan dapat dilewati untuk MVP lebih cepat, namun direkomendasikan untuk menjaga korektness lapisan logika murni.
- Setiap tugas mereferensikan requirement spesifik untuk keterlacakan.
- Checkpoint memastikan validasi inkremental pada batas yang wajar.
- Property test memvalidasi 26 properti universal pada bagian Correctness Properties (tag `Feature: design-intelligence-system, Property {n}`, ≥100 iterasi).
- Unit/integration/smoke test memvalidasi konfigurasi statis, perilaku layanan AI yang di-mock, arsitektur adapter, autentikasi endpoint, dan timing.
- Seluruh layanan AI di-mock pada pengujian; tidak ada properti yang menguji keluaran vendor.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "5.1", "7.1", "11.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3", "3.4", "4.2", "5.2", "6.1", "7.2", "7.3", "7.4", "7.5", "9.1", "11.2", "11.3", "11.4", "11.5", "11.6", "11.7", "13.1"] },
    { "id": 3, "tasks": ["6.2", "9.2", "10.1", "10.2", "12.1", "13.2", "13.3", "13.4"] },
    { "id": 4, "tasks": ["9.3", "9.4", "10.3", "10.4", "12.2"] },
    { "id": 5, "tasks": ["15.1"] },
    { "id": 6, "tasks": ["15.2", "15.3", "15.4", "16.1"] },
    { "id": 7, "tasks": ["15.5", "15.6", "15.7", "15.8", "15.9", "15.10", "16.2", "17.1", "17.2", "17.3", "17.4"] },
    { "id": 8, "tasks": ["17.5", "17.6", "18.1"] },
    { "id": 9, "tasks": ["18.2", "19.1", "19.2", "19.3"] }
  ]
}
```
