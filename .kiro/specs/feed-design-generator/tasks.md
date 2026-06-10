# Implementation Plan: Feed Design Generator

## Overview

Rencana ini mengubah desain menjadi serangkaian langkah implementasi berbasis kode yang inkremental dan dapat diuji, dengan target deploy **Vercel.com** (Next.js App Router + TypeScript). Urutan implementasi memprioritaskan **inti logika murni** (validasi brief, mesin status pipeline 6-langkah, aritmetika kredit, verifikasi konsistensi) yang divalidasi lewat **property-based test (fast-check, ≥100 iterasi)** sejak awal, kemudian **API route** (model job asinkron + polling dengan autentikasi), lalu **UI 3-panel**, dan terakhir **ekspor/publikasi & riwayat**.

Prinsip:
- Setiap tugas membangun di atas tugas sebelumnya dan diakhiri dengan menyambungkan (wiring) komponen, tanpa kode menggantung.
- Layanan AI/storage eksternal diakses lewat adapter pluggable dan **dapat di-mock** untuk pengujian.
- Setiap property test diberi tag: `Feature: feed-design-generator, Property {n}: {teks properti}`, dengan minimal 100 iterasi.
- Seluruh endpoint terekspos jaringan WAJIB melewati autentikasi + otorisasi kepemilikan per-pengguna.
- Hanya tugas yang dapat dijalankan/di-deploy di Vercel sebagai kode.

## Tasks

- [x] 1. Siapkan struktur proyek Next.js App Router siap-Vercel dan tipe inti
  - [x] 1.1 Inisialisasi proyek dan konfigurasi deploy Vercel
    - Buat struktur folder `app/`, `lib/`, `prisma/`, `tests/` sesuai bagian "Struktur proyek" pada desain
    - Setup `package.json` (Next.js, TypeScript), `tsconfig.json`, dependency `fast-check` untuk PBT, `prisma`
    - Buat `vercel.json` dengan konfigurasi `functions.maxDuration` untuk `app/api/generate/route.ts` dan `app/api/jobs/[jobId]/route.ts`
    - Setup test runner (mis. Vitest/Jest) untuk eksekusi sekali jalan (mode `--run`)
    - _Requirements: target deploy Vercel (Overview desain)_
  - [x] 1.2 Definisikan seluruh tipe & antarmuka data inti di `lib/types.ts`
    - Tulis interface/type: `DesignBriefInput`, `OutputFormat`, `MandatoryElement`, `BrandDNA`, `DesignSystem`, `CopyContent`, `LayoutTemplate`, `LayoutSlot`, `ImagePrompt`, `DesignVariation`, `GenerationBatch`, `Job`, `JobStatus`, `JobState`, `StepId`, `StepStatus`, `PipelineState`, `Plan`, `Credit`, `ImageAsset`, `FileRef`, `ConsistencyReport`, `RatingResult`
    - Definisikan konstanta enum untuk opsi brief (tujuan, gaya visual, tone, format, elemen wajib)
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.1_

- [x] 2. Implementasi Brief_Intake (validasi brief & unggahan — logika murni)
  - [x] 2.1 Implementasi `validateBrief` dan `getOptions` di `lib/intake/brief-intake.ts`
    - Validasi `brandName` wajib (tolak bila kosong/whitespace), batas karakter `brandName` ≤50, `tagline` ≤100, `mainMessage` ≤500
    - Kembalikan `ValidationResult` dengan `preservedValues` yang mempertahankan seluruh nilai field input apa adanya
    - Implementasi `getOptions()` mengembalikan daftar enum tujuan, gaya, tone, format, elemen wajib
    - _Requirements: 1.1, 1.2, 1.3, 1.13, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_
  - [x]* 2.2 Tulis property test validasi nama brand wajib
    - **Property 1: Validasi nama brand wajib**
    - **Validates: Requirements 1.2, 1.3**
  - [x]* 2.3 Tulis property test batas karakter field teks
    - **Property 2: Batas karakter field teks**
    - **Validates: Requirements 1.13**
  - [x]* 2.4 Tulis unit test daftar opsi enum `getOptions()`
    - Verifikasi daftar tujuan, gaya visual, tone, format, dan elemen wajib sesuai spesifikasi
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_
  - [x] 2.5 Implementasi `validateUpload` di `lib/intake/upload-validation.ts`
    - Terima hanya PNG/JPG/JPEG, ≤10 MB/berkas, ≤10 berkas/sesi; tolak per-berkas dengan alasan `format`/`size`/`count` tanpa membatalkan berkas valid lain
    - Tandai berkas valid untuk pemicuan penghapusan latar otomatis
    - _Requirements: 1.10, 1.11, 1.12_
  - [x]* 2.6 Tulis property test validasi berkas unggahan
    - **Property 3: Validasi berkas unggahan**
    - **Validates: Requirements 1.10, 1.11, 1.12**

- [x] 3. Implementasi Credit_Manager (aritmetika kredit — logika murni)
  - [x] 3.1 Implementasi logika kredit di `lib/credit/credit-manager.ts`
    - Implementasi `getBalance`, `canAfford`, `reserve`, `commit`, `refund`, `isVariationCountAllowed` dengan pola reserve→commit/refund
    - Pastikan saldo selalu bilangan bulat ≥0; tolak bila kredit < jumlah variasi (tanpa potong) dengan penanda ajakan upgrade Pro
    - Aturan plan: "Free" hanya 3/6 variasi, "Pro" mengizinkan 3/6/9; potong 1 credit/variasi saat commit
    - Abstraksikan akses penyimpanan via interface repository agar dapat di-mock (implementasi transaksi atomik DB disambung di task 7)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
  - [x]* 3.2 Tulis property test pengurangan kredit sesuai jumlah variasi
    - **Property 27: Pengurangan kredit sesuai jumlah variasi**
    - **Validates: Requirements 8.2**
  - [x]* 3.3 Tulis property test penolakan saat kredit tidak mencukupi
    - **Property 28: Penolakan saat kredit tidak mencukupi**
    - **Validates: Requirements 8.3**
  - [x]* 3.4 Tulis property test aturan kelayakan jumlah variasi berbasis plan
    - **Property 29: Aturan kelayakan jumlah variasi berbasis plan**
    - **Validates: Requirements 8.4, 8.5**
  - [x]* 3.5 Tulis property test invariant saldo kredit non-negatif
    - **Property 30: Invariant saldo kredit non-negatif**
    - **Validates: Requirements 8.1, 8.6**

- [x] 4. Implementasi Pipeline_Engine (mesin status 6-langkah — logika murni)
  - [x] 4.1 Implementasi mesin status sekuensial di `lib/pipeline/engine.ts`
    - Implementasi `start` dan `advance` (hanya N→N+1; tidak melompat/mundur/mengulang), inisialisasi `statuses` per langkah
    - Implementasi kerangka `runStep` yang memanggil transform per-langkah dan memperbarui status
    - _Requirements: 2.1, 2.2_
  - [x]* 4.2 Tulis property test eksekusi pipeline berurutan ketat
    - **Property 4: Eksekusi pipeline berurutan ketat**
    - **Validates: Requirements 2.1, 2.2**
  - [x] 4.3 Implementasi transform tiap langkah di `lib/pipeline/steps.ts`
    - Langkah 1 Brand DNA dari brief; Langkah 2 Design System dari Brand DNA; Langkah 3 Copy selaras goal+tone; Langkah 4 Layout selaras format + superset elemen wajib; Langkah 5 Image Prompt gabungan 3 sumber; Langkah 6 Render & Compose menghasilkan batch berisi tepat `variationCount` variasi
    - Transform pemanggilan AI dilakukan via `AI_Service_Connector` yang di-inject (mockable)
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
  - [x]* 4.4 Tulis property test Brand DNA diturunkan dari brief
    - **Property 5: Brand DNA diturunkan dari brief**
    - **Validates: Requirements 2.3**
  - [x]* 4.5 Tulis property test copy selaras dengan tujuan dan tone
    - **Property 6: Copy selaras dengan tujuan dan tone**
    - **Validates: Requirements 2.5**
  - [x]* 4.6 Tulis property test layout selaras dengan format dan elemen wajib
    - **Property 7: Layout selaras dengan format dan elemen wajib**
    - **Validates: Requirements 2.6**
  - [x]* 4.7 Tulis property test image prompt menggabungkan tiga sumber
    - **Property 8: Image prompt menggabungkan tiga sumber**
    - **Validates: Requirements 2.7**
  - [x]* 4.8 Tulis property test jumlah variasi batch sesuai pilihan
    - **Property 9: Jumlah variasi batch sesuai pilihan**
    - **Validates: Requirements 2.8**
  - [x] 4.9 Implementasi penanganan kegagalan langkah + refund di `lib/pipeline/failure.ts`
    - Saat langkah K gagal: hentikan di K, susun pesan menyebut nomor+nama langkah, panggil `Credit_Manager.refund` untuk kredit belum terpakai, pertahankan brief tanpa perubahan
    - Pastikan hasil langkah 1..K-1 tetap utuh dan opsi retry tersedia
    - _Requirements: 2.10, 3.5_
  - [x]* 4.10 Tulis property test kegagalan langkah menghentikan proses, refund, dan mempertahankan brief
    - **Property 11: Kegagalan langkah menghentikan proses, refund, dan mempertahankan brief**
    - **Validates: Requirements 2.10**
  - [x]* 4.11 Tulis property test hasil langkah sebelumnya dipertahankan saat kegagalan AI
    - **Property 12: Hasil langkah sebelumnya dipertahankan saat kegagalan pemanggilan AI**
    - **Validates: Requirements 3.5**
  - [x] 4.12 Implementasi verifikasi konsistensi batch di `lib/pipeline/consistency.ts`
    - Implementasi `verifyConsistency`: cek Brand DNA, accentPalette, headlineFont, bodyFont identik + 100% elemen wajib hadir; tandai batch `inconsistent` dengan detail pelanggaran (variasi+atribut) dan pertahankan variasi sukses
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - [x]* 4.13 Tulis property test konsistensi brand lintas variasi dalam satu batch
    - **Property 17: Konsistensi brand lintas variasi dalam satu batch**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.6**
  - [x]* 4.14 Tulis property test deteksi dan pelaporan ketidakkonsistenan
    - **Property 18: Deteksi dan pelaporan ketidakkonsistenan**
    - **Validates: Requirements 5.5**
  - [x] 4.15 Implementasi `regenerateVariation` dan `fineTuneVariation` di `lib/pipeline/derive.ts`
    - Hasil regenerasi/fine-tune memakai Brand DNA & Design System identik dengan variasi sumber; saat gagal pertahankan variasi asal + indikasi error
    - _Requirements: 4.6, 4.7, 7.6, 7.9_
  - [x]* 4.16 Tulis property test operasi turunan variasi mempertahankan brand
    - **Property 15: Operasi turunan variasi mempertahankan brand**
    - **Validates: Requirements 4.6, 7.6**
  - [x]* 4.17 Tulis property test kegagalan operasi turunan mempertahankan variasi asal
    - **Property 16: Kegagalan operasi turunan mempertahankan variasi asal**
    - **Validates: Requirements 4.7, 7.9**

- [x] 5. Checkpoint - Pastikan seluruh test inti logika lulus
  - Pastikan semua test lulus, tanyakan ke pengguna bila ada pertanyaan.

- [x] 6. Implementasi AI_Service_Connector (adapter pluggable & mockable)
  - [x] 6.1 Implementasi connector + adapter + `callWithRetry` di `lib/ai/connector.ts`
    - Definisikan antarmuka `AIServiceConnector` dan adapter LLM/image-gen/background-removal pluggable; sediakan adapter mock untuk pengujian
    - Implementasi `callWithRetry` dengan timeout 30s dan maksimal 3 percobaan per langkah; sediakan opsi regenerasi manual pasca-sukses
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.7_
  - [x]* 6.2 Tulis property test batas maksimum percobaan ulang (AI & publikasi)
    - **Property 13: Batas maksimum percobaan ulang**
    - **Validates: Requirements 3.6, 6.7**
  - [x]* 6.3 Tulis integration test connector dengan adapter di-mock
    - Verifikasi `generateCopy`/`generateImage`/`removeBackground` dipanggil dengan argumen benar dan menangani respons; opsi regenerasi manual tersedia pada langkah sukses
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.7_

- [x] 7. Implementasi Job Store, Worker, dan persistensi Prisma
  - [x] 7.1 Definisikan skema Prisma & job store di `prisma/schema.prisma` dan `lib/jobs/job-store.ts`
    - Model: User, Credit, Plan, GenerationBatch, DesignVariation, DesignBrief, Job, JobStatus; gunakan endpoint Postgres pooled (Neon/Supabase) + serverless driver adapter
    - Implementasi persistensi Job/JobStatus dan transaksi atomik kredit (reserve/commit/refund) yang menyambung `Credit_Manager`
    - _Requirements: 8.6, 2.10, 7.1_
  - [x] 7.2 Implementasi pipeline worker di `lib/pipeline/worker.ts`
    - Implementasi `createJob`, `runJob` (jalankan langkah 1..6 di background), dan `getJobStatus`; perbarui `JobStatus` (currentStep, statuses, updatedAt) tiap transisi; saat gagal set `failed` + `failedStep` + refund; saat sukses set `done` + `resultBatchId`
    - _Requirements: 2.9, 2.10_
  - [x]* 7.3 Tulis property test indikator progres mencerminkan state pipeline
    - **Property 10: Indikator progres mencerminkan state pipeline**
    - **Validates: Requirements 2.9**

- [x] 8. Implementasi API route (autentikasi + model job asinkron + polling)
  - [x] 8.1 Implementasi middleware autentikasi & otorisasi di `app/middleware.ts` dan `lib/auth.ts`
    - Tolak permintaan tak terautentikasi (401) pada seluruh endpoint `/api/*`; tegakkan otorisasi kepemilikan sumber daya (403 untuk akses lintas-pengguna)
    - _Requirements: keamanan endpoint (Architecture → Keamanan)_
  - [x] 8.2 Implementasi `POST /api/generate` di `app/api/generate/route.ts`
    - Validasi brief server-side, reservasi kredit atomik, buat Job, balas `202 { jobId }` segera; jalankan worker via `waitUntil`; set `runtime="nodejs"` & `maxDuration`
    - _Requirements: 2.1, 8.2, 8.3, 1.3_
  - [x] 8.3 Implementasi `GET /api/jobs/[jobId]` di `app/api/jobs/[jobId]/route.ts`
    - Baca `JobStatus` (idempoten, tidak memicu eksekusi ulang); paparkan currentStep, nama langkah, dan status tiap langkah; tegakkan otorisasi pemilik job
    - _Requirements: 2.9_
  - [x] 8.4 Implementasi `GET /api/credits` dan `POST /api/uploads`
    - `/api/credits` kembalikan saldo bilangan bulat ≥0; `/api/uploads` validasi server-side berkas dan unggah ke object storage via adapter
    - _Requirements: 8.1, 1.10, 1.11, 1.12_
  - [x]* 8.5 Tulis integration test alur job asinkron + smoke test autentikasi
    - Verifikasi `POST /api/generate`→`jobId`, worker menjalankan langkah, `GET /api/jobs/{jobId}` melaporkan progres lalu `done`/`failed` (AI & storage di-mock); endpoint menolak tanpa kredensial dan akses lintas-pengguna
    - _Requirements: 2.9, 2.10, keamanan endpoint_

- [x] 9. Checkpoint - Pastikan inti server & API lulus
  - Pastikan semua test lulus, tanyakan ke pengguna bila ada pertanyaan.

- [x] 10. Implementasi Canvas_Renderer (render sisi klien untuk MVP)
  - [x] 10.1 Implementasi komposisi & render di `lib/canvas/renderer.ts`
    - Implementasi `composeVariation` (Fabric.js), `renderBatch` (≤20 variasi), dan `ensureMandatoryElements` (100% variasi memuat elemen wajib)
    - _Requirements: 3.3, 4.1, 5.4_
  - [x] 10.2 Implementasi kontrol zoom/pan/grid/seleksi/edit di `lib/canvas/controls.ts`
    - `setZoom` clamp 25%–400%, `pan` dibatasi area konten, `setGridColumns` 2–4, `selectVariation` mengembalikan kontrol edit, `applyDesignSystemChange` memperbarui preview
    - _Requirements: 4.2, 4.3, 4.4, 4.5_
  - [x]* 10.3 Tulis property test kontrol zoom dan pan terbatas
    - **Property 14: Kontrol zoom dan pan terbatas**
    - **Validates: Requirements 4.2**
  - [x]* 10.4 Tulis unit test grid kolom, kontrol seleksi, dan update preview
    - Verifikasi grid 2–4 kolom, kontrol edit muncul saat seleksi, preview ter-update saat properti Design System berubah
    - _Requirements: 4.3, 4.4, 4.5_

- [x] 11. Implementasi UI 3-panel dan wiring operasi variasi
  - [x] 11.1 Implementasi Panel Kiri (Brief/Configurator) di `app/page.tsx` + komponen form
    - Render form brief + picker gaya/format/variasi + unggah aset; integrasikan `validateBrief`/`validateUpload`; nonaktifkan opsi 9 variasi untuk plan Free (tandai fitur Pro)
    - _Requirements: 1.1, 1.3, 8.4, 8.5_
  - [x] 11.2 Implementasi Panel Tengah (Canvas Output & Preview)
    - Render grid variasi, kontrol zoom/pan, seleksi & titik masuk edit; sambungkan ke `Canvas_Renderer`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [x] 11.3 Implementasi Panel Kanan (Properties/Prompt Chain/History/Credit)
    - Render panel properti Design System, indikator progres langkah 1–6 (polling `GET /api/jobs/{jobId}`), daftar riwayat + rating, saldo kredit
    - _Requirements: 2.9, 4.5, 7.2, 8.1_
  - [x] 11.4 Implementasi `app/api/variations/[id]/route.ts` (regenerate/fine-tune) dan wiring UI
    - Sambungkan tombol regenerasi/fine-tune UI ke route yang memanggil `regenerateVariation`/`fineTuneVariation` dengan otorisasi pemilik
    - _Requirements: 4.6, 4.7, 7.6, 7.9_

- [x] 12. Implementasi Export_Manager (ekspor & publikasi)
  - [x] 12.1 Implementasi ekspor gambar di `lib/export/export-manager.ts` + `app/api/export/[id]/route.ts`
    - `exportImage` PNG/JPG sisi terpendek ≥1080px, unggah ke object storage, kembalikan `FileRef`; pertahankan variasi terlepas hasil
    - _Requirements: 6.1, 6.5, 6.8_
  - [x]* 12.2 Tulis property test resolusi ekspor gambar
    - **Property 19: Resolusi ekspor gambar**
    - **Validates: Requirements 6.1**
  - [x]* 12.3 Tulis property test variasi dipertahankan terlepas dari hasil ekspor/publikasi
    - **Property 21: Variasi dipertahankan terlepas dari hasil ekspor/publikasi**
    - **Validates: Requirements 6.5, 6.6, 6.8**
  - [x] 12.4 Implementasi `exportPdf` (CMYK print-ready)
    - Hasilkan PDF ruang warna CMYK via library PDF server-side + profil ICC
    - _Requirements: 6.2_
  - [x]* 12.5 Tulis unit test ruang warna CMYK PDF
    - Verifikasi metadata PDF menunjukkan ruang warna CMYK
    - _Requirements: 6.2_
  - [x] 12.6 Implementasi `exportBatchZip`
    - Hasilkan satu ZIP berisi seluruh variasi pada batch
    - _Requirements: 6.3_
  - [x]* 12.7 Tulis property test kelengkapan isi ZIP batch
    - **Property 20: Kelengkapan isi ZIP batch**
    - **Validates: Requirements 6.3**
  - [x] 12.8 Implementasi `publish` + retry di `app/api/publish/[id]/route.ts`
    - Kirim variasi ke kanal (Instagram/Facebook/LinkedIn) via adapter; retry ≤3 per permintaan; pertahankan variasi saat gagal + pesan penyebab
    - _Requirements: 6.4, 6.6, 6.7_
  - [x]* 12.9 Tulis integration test publikasi ke kanal (adapter di-mock)
    - Verifikasi pengiriman ke kanal yang benar dan penanganan kegagalan
    - _Requirements: 6.4_

- [x] 13. Implementasi History_Manager (riwayat & feedback loop)
  - [x] 13.1 Implementasi simpan/daftar/muat di `lib/history/history-manager.ts` + `app/api/history/route.ts`
    - `saveBatch` (retry persist + pertahankan data sesi saat gagal), `listBatches` (urut terbaru→terlama, ≤20/halaman), `loadBatch`
    - _Requirements: 7.1, 7.2, 7.3, 7.7_
  - [x]* 13.2 Tulis property test round-trip simpan dan muat riwayat
    - **Property 22: Round-trip simpan dan muat riwayat**
    - **Validates: Requirements 7.1, 7.3**
  - [x]* 13.3 Tulis property test pengurutan dan paginasi riwayat
    - **Property 23: Pengurutan dan paginasi riwayat**
    - **Validates: Requirements 7.2**
  - [x]* 13.4 Tulis property test data batch dipertahankan saat penyimpanan riwayat gagal
    - **Property 26: Data batch dipertahankan saat penyimpanan riwayat gagal**
    - **Validates: Requirements 7.7**
  - [x] 13.5 Implementasi `rateVariation` (1..5 + retry diam-diam)
    - Terima rating integer 1..5 (simpan), tolak di luar rentang (pertahankan rating lama + indikasi error), retry persist diam-diam ≤3 kali tanpa pesan error saat penyimpanan tak tersedia
    - _Requirements: 7.4, 7.5, 7.8_
  - [x]* 13.6 Tulis property test validasi rentang rating
    - **Property 24: Validasi rentang rating**
    - **Validates: Requirements 7.4, 7.8**
  - [x]* 13.7 Tulis property test ketahanan rating saat penyimpanan tidak tersedia
    - **Property 25: Ketahanan rating saat penyimpanan tidak tersedia**
    - **Validates: Requirements 7.5**

- [x] 14. Integrasi akhir & wiring end-to-end
  - [x] 14.1 Sambungkan seluruh route ekspor/publikasi/riwayat ke UI dan worker
    - Wiring `History_Manager.saveBatch` pada worker saat batch `done`; sambungkan tombol ekspor/publikasi/riwayat panel ke route terkait; verifikasi konfigurasi Vercel (runtime nodejs, maxDuration, secret tanpa `NEXT_PUBLIC_`, DB pooled)
    - _Requirements: 7.1, 6.1, 6.3, 6.4_
  - [x]* 14.2 Tulis integration test alur end-to-end happy-path
    - Brief → job → batch → ekspor sebagai satu jalur (AI & storage di-mock)
    - _Requirements: 2.1, 2.8, 6.1, 7.1_

- [x] 15. Checkpoint akhir - Pastikan seluruh test lulus
  - Pastikan semua test lulus, tanyakan ke pengguna bila ada pertanyaan.

## Notes

- Tugas bertanda `*` bersifat opsional (test) dan dapat dilewati untuk MVP lebih cepat; tugas inti tidak pernah opsional.
- Setiap tugas merujuk klausa requirement dan/atau properti spesifik untuk keterlacakan.
- Property test memakai fast-check, minimal 100 iterasi, dengan tag `Feature: feed-design-generator, Property {n}: ...`; layanan AI/storage eksternal di-mock.
- Inti logika murni (validasi, mesin status pipeline, aritmetika kredit, verifikasi konsistensi) diimplementasikan dan diuji lebih dulu sebelum API, UI, dan ekspor/publikasi.
- Checkpoint memastikan validasi inkremental di tiap fase.
- Aspek timing/perf dan integrasi vendor diverifikasi via integration/smoke test, bukan PBT (lihat Testing Strategy desain).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "3.1", "4.1", "6.1", "10.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.2", "3.3", "3.4", "3.5", "4.2", "6.2", "6.3", "10.2"] },
    { "id": 4, "tasks": ["2.6", "4.3", "7.1", "10.3", "10.4"] },
    { "id": 5, "tasks": ["4.4", "4.5", "4.6", "4.7", "4.8", "4.9", "4.12", "4.15", "7.2"] },
    { "id": 6, "tasks": ["4.10", "4.11", "4.13", "4.14", "4.16", "4.17", "7.3", "8.1"] },
    { "id": 7, "tasks": ["8.2", "8.3", "8.4"] },
    { "id": 8, "tasks": ["8.5", "11.1", "11.2", "11.3", "11.4"] },
    { "id": 9, "tasks": ["12.1", "12.4", "12.6", "12.8", "13.1", "13.5"] },
    { "id": 10, "tasks": ["12.2", "12.3", "12.5", "12.7", "12.9", "13.2", "13.3", "13.4", "13.6", "13.7"] },
    { "id": 11, "tasks": ["14.1"] },
    { "id": 12, "tasks": ["14.2"] }
  ]
}
```
