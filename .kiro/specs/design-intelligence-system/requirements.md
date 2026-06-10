# Requirements Document

## Introduction

Design Intelligence System adalah lapisan kecerdasan desain yang dibangun **di atas** sistem Feed Design Generator yang sudah ada (lihat `.kiro/specs/feed-design-generator/`). Tujuannya adalah membuat sistem berpikir seperti **senior art director** — yang merancang dengan tujuan (purpose-driven), menalar secara eksplisit sebelum membuat, mengevaluasi hasilnya secara kritis, lalu belajar dari umpan balik — bukan sekadar "menghias" sebuah brief menjadi gambar.

Sistem yang sudah ada adalah aplikasi web Next.js + TypeScript yang dideploy di Vercel, menjalankan pipeline generasi **6-langkah berurutan dan ketat** (Brand DNA Extraction → Design System Selection → Copy Generation → Layout Composition → Image Prompt Build → Render & Compose) dengan komponen `Brief_Intake`, `Pipeline_Engine`, `AI_Service_Connector`, `Canvas_Renderer`, `Export_Manager`, `History_Manager`, dan `Credit_Manager`. Layanan AI eksternal diakses melalui adapter yang *pluggable* dan *mockable*. Model eksekusinya asinkron berbasis job: `POST /api/generate` mengembalikan `jobId`, worker background menjalankan pipeline, dan frontend melakukan polling ke `GET /api/jobs/{jobId}`.

Dokumen ini mendefinisikan kebutuhan untuk sepuluh kapabilitas baru: (1) System Prompt berlapis, (2) Visual Thinking / Design Brief Analysis, (3) Quality Gates / scoring, (4) Quality Evaluator sebagai langkah kritik terpisah, (5) bobot keputusan berbasis tujuan (purpose-driven weights), (6) Refinement Loop interaktif, (7) Intelligence Memory (pembelajaran berkelanjutan), (8) Enhanced Brief Intake, (9) Professional Mode toggle, dan (10) penghindaran pola negatif (negative-pattern avoidance). Seluruh kapabilitas harus terintegrasi dengan pipeline 6-langkah dan model job asinkron yang ada tanpa merusaknya, dengan tetap menghormati batasan serverless Vercel, akuntansi kredit, autentikasi endpoint, dan prinsip adapter yang *mockable*.

### Asumsi yang Perlu Dikonfirmasi (Default Pragmatis)

Nilai-nilai berikut dikodekan sebagai default yang masuk akal di dalam requirement, namun perlu dikonfirmasi pengguna sebelum desain final:

- **A1 — Skala skor**: Setiap kriteria kualitas dinilai pada skala bilangan bulat **1–10**. *(Perlu konfirmasi.)*
- **A2 — Kriteria kualitas default**: Hierarchy, Readability, Composition, Branding Consistency, Originality, Premium Perception, Whitespace (7 kriteria). *(Perlu konfirmasi daftar dan jumlahnya.)*
- **A3 — Ambang per-kriteria default**: Readability ≥ 8, Branding Consistency ≥ 8, Hierarchy ≥ 7, Composition ≥ 7, Whitespace ≥ 7, Originality ≥ 7, Premium Perception ≥ 7. *(Perlu konfirmasi angka pasti per kriteria.)*
- **A4 — Ambang total default**: Skor rata-rata berbobot ≥ **7.5** dari 10 agar sebuah desain DITERIMA. *(Perlu konfirmasi.)*
- **A5 — Maksimum percobaan regenerasi akibat Quality Gate**: **3** percobaan per Design_Variation (di luar percobaan retry kegagalan layanan AI yang sudah ada). *(Perlu konfirmasi.)*
- **A6 — Kebijakan kredit untuk regenerasi akibat Quality Gate**: regenerasi internal akibat penolakan Quality Gate **tidak** menambah konsumsi kredit pengguna (ditanggung sebagai biaya kualitas sistem); hanya 1 kredit per variasi final yang diterima. *(Perlu konfirmasi kebijakan.)*
- **A7 — Skala rating Refinement Loop**: pengguna menilai hasil pada skala bilangan bulat **1–10**. Catatan: sistem yang ada memakai rating riwayat 1–5; rating refinement 1–10 adalah saluran terpisah. *(Perlu konfirmasi keselarasan dua skala ini.)*
- **A8 — Retensi Intelligence Memory**: entri memori disimpan tanpa PII brief mentah, hanya menyimpan Design_DNA + konteks teragregasi (industri, tujuan, audiens) + hasil; retensi default **365 hari** dan dapat dihapus atas permintaan pengguna. *(Perlu konfirmasi periode retensi & cakupan data.)*
- **A9 — Default Professional_Mode**: Professional_Mode **nonaktif** secara default sehingga generator dasar tetap menjadi perilaku bawaan. *(Perlu konfirmasi default.)*
- **A10 — Anggaran waktu**: total tambahan latensi akibat analisis + evaluasi + regenerasi per variasi harus tetap berada dalam `maxDuration` worker (mis. 300 detik pada Vercel Pro); jumlah percobaan dibatasi (A5) agar tidak melampaui batas. *(Perlu konfirmasi `maxDuration` plan.)*

## Glossary

- **System**: Aplikasi web Feed Design Generator secara keseluruhan (termasuk lapisan Design Intelligence ini).
- **Design_Intelligence**: Lapisan kapabilitas yang membuat sistem menalar, mengevaluasi, dan belajar layaknya senior art director; aktif hanya ketika Professional_Mode menyala.
- **Professional_Mode**: Sakelar (toggle) yang mengaktifkan atau menonaktifkan seluruh lapisan Design_Intelligence untuk suatu permintaan generasi.
- **System_Prompt_Layer**: Satu lapisan penyusun prompt sistem berlapis. Empat lapisan didefinisikan: L1 Identity/Persona, L2 Thinking_Process (proses berpikir wajib), L3 Quality_Gate_Directive (gerbang kualitas non-negotiable), L4 Design_DNA_Weights (bobot pencampuran gaya).
- **Layered_System_Prompt**: Hasil komposisi keempat System_Prompt_Layer (L1–L4) menjadi satu prompt sistem final yang dipakai pada langkah penyusunan prompt pipeline.
- **Design_Brief_Analysis**: Artefak penalaran terstruktur yang dibuat sebelum generasi, memuat core message, target audience, primary goal, dan emotion target.
- **Visual_Strategy**: Artefak penalaran terstruktur berisi rencana visual: hierarchy plan, composition type, color psychology, typography system beserta alasan (reasoning), dan whitespace ratio.
- **Quality_Criterion**: Satu dimensi penilaian kualitas desain (mis. Hierarchy, Readability, Composition, Branding Consistency, Originality, Premium Perception, Whitespace).
- **Quality_Score**: Nilai bilangan bulat 1–10 (A1) yang diberikan untuk sebuah Quality_Criterion pada sebuah Design_Variation.
- **Quality_Gate**: Aturan keputusan terima/tolak yang membandingkan Quality_Score (per-kriteria dan total berbobot) terhadap ambang yang dikonfigurasi.
- **Quality_Threshold**: Nilai ambang minimum, baik per Quality_Criterion maupun ambang total berbobot, yang harus dipenuhi agar lolos Quality_Gate.
- **Quality_Evaluator**: Peran/adapter AI terpisah ("Creative Director" yang kritis) yang mengkritik sebuah Design_Variation dan mengembalikan Quality_Score per kriteria beserta critique yang dapat ditindaklanjuti.
- **Quality_Report**: Objek hasil evaluasi berisi seluruh Quality_Score per kriteria, skor total berbobot, keputusan terima/tolak, dan teks critique.
- **Design_Purpose**: Tujuan desain yang dinyatakan pengguna; nilai valid: Marketing_Conversion, Branding_Awareness, Education, Engagement.
- **Decision_Weights**: Himpunan bobot per Quality_Criterion dan urutan prioritas yang diturunkan dari Design_Purpose, dipakai pada scoring dan penyusunan Visual_Strategy.
- **Design_DNA**: Himpunan parameter gaya yang dapat disetel (mis. whitespace ratio, jumlah elemen, bobot/weight tipografi, tingkat restraint palet, tingkat dekorasi) yang mengarahkan generasi; merupakan perluasan konsep Brand_DNA/Design_System yang ada.
- **Refinement_Loop**: Alur interaktif di mana pengguna memberi rating dan/atau komentar bahasa natural, lalu sistem menyesuaikan Design_DNA dan melakukan regenerasi disertai penjelasan penyesuaian.
- **Intelligence_Memory**: Penyimpanan persisten yang merekam Design_DNA yang dipakai, umpan balik, dan konteks (industri, tujuan, audiens) per desain yang diterima/ditolak, untuk dipakai ulang pada konteks serupa di masa depan.
- **Negative_Pattern**: Pola keluaran yang harus dihindari (tampilan template generik, "AI-generated look", desain yang terlalu didekorasi/over-decorated).
- **Brief_Intake**: Komponen eksisting yang menerima dan memvalidasi design brief (diperluas oleh requirement Enhanced Brief Intake).
- **Pipeline_Engine**: Komponen eksisting yang menjalankan pipeline 6-langkah berurutan ketat.
- **AI_Service_Connector**: Komponen eksisting yang memanggil layanan AI eksternal melalui adapter pluggable & mockable.
- **Design_Variation**: Satu hasil desain individual dalam sebuah Generation_Batch (istilah eksisting).
- **Generation_Batch**: Sekumpulan Design_Variation dari satu brief (istilah eksisting).
- **Job**: Pekerjaan generasi asinkron eksisting; `POST /api/generate` mengembalikan `jobId` dan worker menjalankan pipeline.

## Requirements

### Requirement 1: Professional Mode Toggle

**User Story:** Sebagai pengguna, saya ingin dapat menyalakan atau mematikan lapisan kecerdasan desain melalui sebuah sakelar, sehingga generator dasar tetap dapat dipakai tanpa lapisan tambahan ketika tidak diperlukan.

#### Acceptance Criteria

1. THE Brief_Intake SHALL menyediakan kontrol Professional_Mode dengan dua nilai: aktif dan nonaktif.
2. WHERE Professional_Mode bernilai nonaktif, THE Pipeline_Engine SHALL menjalankan pipeline 6-langkah eksisting tanpa membangun Layered_System_Prompt, tanpa menghasilkan Design_Brief_Analysis, tanpa menjalankan Quality_Evaluator, dan tanpa menerapkan Quality_Gate.
3. WHERE Professional_Mode bernilai aktif, THE Pipeline_Engine SHALL mengaktifkan seluruh kapabilitas Design_Intelligence (Layered_System_Prompt, Design_Brief_Analysis, Visual_Strategy, Quality_Gate, Quality_Evaluator, Decision_Weights, dan Intelligence_Memory) di dalam pipeline 6-langkah yang sama.
4. WHEN sebuah permintaan generasi tidak menyertakan nilai Professional_Mode secara eksplisit, THE Brief_Intake SHALL menetapkan Professional_Mode bernilai nonaktif sebagai default (Asumsi A9).
5. THE Pipeline_Engine SHALL mempertahankan urutan ketat enam langkah (1 sampai 6) baik saat Professional_Mode aktif maupun nonaktif.

### Requirement 2: Enhanced Brief Intake (Brief Profesional)

**User Story:** Sebagai pengguna, saya ingin mengisi brief profesional yang lebih lengkap ketika Professional_Mode aktif, sehingga sistem memiliki konteks strategis yang cukup untuk menalar seperti art director.

#### Acceptance Criteria

1. WHERE Professional_Mode aktif, THE Brief_Intake SHALL menampilkan field Design_Purpose, target audience (usia, profesi, pain point), primary goal, emotion target, dan core message.
2. WHERE Professional_Mode aktif, THE Brief_Intake SHALL menyediakan pilihan Design_Purpose berupa: Marketing_Conversion, Branding_Awareness, Education, dan Engagement.
3. WHERE Professional_Mode aktif, THE Brief_Intake SHALL membatasi field core message hingga maksimum 7 kata.
4. IF pengguna mengisi core message melebihi 7 kata saat Professional_Mode aktif, THEN THE Brief_Intake SHALL menolak input core message, menampilkan pesan kesalahan yang menyebutkan batas maksimum 7 kata, dan mempertahankan seluruh nilai field lain tanpa perubahan.
5. WHERE Professional_Mode aktif, THE Brief_Intake SHALL menandai field Design_Purpose, primary goal, dan core message sebagai wajib diisi.
6. IF pengguna memicu generasi saat Professional_Mode aktif tanpa mengisi salah satu field wajib (Design_Purpose, primary goal, atau core message), THEN THE Brief_Intake SHALL menolak permintaan, menampilkan pesan yang menyebutkan field wajib yang belum diisi, dan mempertahankan seluruh nilai field yang sudah diisi tanpa perubahan.
7. WHERE Professional_Mode aktif, THE Brief_Intake SHALL menyediakan unggah berkas referensi opsional dengan menerapkan aturan validasi unggahan eksisting (format PNG, JPG, JPEG; maksimum 10 MB per berkas; maksimum 10 berkas per sesi).
8. WHEN brief profesional yang valid dikirim, THE Brief_Intake SHALL meneruskan Design_Purpose, target audience, primary goal, emotion target, dan core message ke Pipeline_Engine sebagai masukan untuk Design_Brief_Analysis.

### Requirement 3: Multi-Layer System Prompt

**User Story:** Sebagai pengguna, saya ingin prompt sistem dibangun secara berlapis (identitas, proses berpikir, gerbang kualitas, dan bobot gaya), sehingga AI mengikuti standar seorang senior art director secara konsisten.

#### Acceptance Criteria

1. WHERE Professional_Mode aktif, WHEN langkah Copy Generation atau langkah Image Prompt Build dijalankan, THE Pipeline_Engine SHALL menyusun Layered_System_Prompt dari empat System_Prompt_Layer: L1 Identity/Persona, L2 Thinking_Process, L3 Quality_Gate_Directive, dan L4 Design_DNA_Weights.
2. THE Pipeline_Engine SHALL menyusun keempat System_Prompt_Layer dengan urutan tetap L1 → L2 → L3 → L4 di dalam Layered_System_Prompt.
3. WHEN menyusun System_Prompt_Layer L1, THE Pipeline_Engine SHALL menyertakan definisi persona senior art director.
4. WHEN menyusun System_Prompt_Layer L2, THE Pipeline_Engine SHALL menyertakan langkah-langkah proses berpikir wajib yang menghasilkan Design_Brief_Analysis dan Visual_Strategy.
5. WHEN menyusun System_Prompt_Layer L3, THE Pipeline_Engine SHALL menyertakan daftar Quality_Criterion beserta Quality_Threshold yang dikonfigurasi.
6. WHEN menyusun System_Prompt_Layer L4, THE Pipeline_Engine SHALL menyertakan Design_DNA_Weights yang diturunkan dari Decision_Weights untuk Design_Purpose yang dipilih.
7. WHERE Professional_Mode aktif, THE Pipeline_Engine SHALL menggabungkan Layered_System_Prompt ke dalam prompt langkah Copy Generation dan langkah Image Prompt Build tanpa mengubah urutan keenam langkah pipeline.

### Requirement 4: Visual Thinking / Design Brief Analysis

**User Story:** Sebagai pengguna, saya ingin sistem menghasilkan artefak penalaran eksplisit sebelum membuat desain, sehingga saya dapat melihat strategi visual yang mendasari setiap output.

#### Acceptance Criteria

1. WHERE Professional_Mode aktif, WHEN generasi dipicu dengan brief valid, THE Pipeline_Engine SHALL menghasilkan Design_Brief_Analysis sebelum langkah Image Prompt Build dijalankan.
2. THE Design_Brief_Analysis SHALL memuat core message, target audience, primary goal, dan emotion target.
3. WHERE Professional_Mode aktif, THE Pipeline_Engine SHALL menghasilkan Visual_Strategy yang memuat hierarchy plan, composition type, color psychology, typography system beserta reasoning, dan whitespace ratio.
4. WHEN Design_Brief_Analysis dan Visual_Strategy selesai dibuat, THE Pipeline_Engine SHALL menyimpan kedua artefak tersebut bersama Generation_Batch terkait.
5. WHEN pengguna membuka sebuah Generation_Batch yang dihasilkan dengan Professional_Mode aktif, THE System SHALL menampilkan Design_Brief_Analysis dan Visual_Strategy terkait.
6. IF pembuatan Design_Brief_Analysis atau Visual_Strategy gagal, THEN THE Pipeline_Engine SHALL menghentikan proses pada langkah tersebut, menampilkan pesan kesalahan yang menyebutkan artefak yang gagal dibuat, mengembalikan kredit yang belum terpakai untuk batch tersebut, dan mempertahankan isi brief tanpa perubahan.

### Requirement 5: Quality Evaluator (Langkah Kritik Terpisah)

**User Story:** Sebagai pengguna, saya ingin sebuah evaluator AI terpisah mengkritik setiap desain secara kritis, sehingga hanya desain berkualitas tinggi yang lolos.

#### Acceptance Criteria

1. WHERE Professional_Mode aktif, WHEN sebuah Design_Variation selesai dirender, THE Quality_Evaluator SHALL mengevaluasi variasi tersebut dan mengembalikan Quality_Report dalam waktu maksimum 30 detik.
2. WHEN Quality_Evaluator mengembalikan Quality_Report, THE Quality_Report SHALL memuat satu Quality_Score bilangan bulat dalam rentang 1 sampai 10 untuk setiap Quality_Criterion dan satu skor total berbobot dalam rentang 1.0 sampai 10.0.
3. WHEN Quality_Evaluator mengembalikan Quality_Report, THE Quality_Report SHALL memuat keputusan biner terima atau tolak dan teks critique non-kosong yang memuat sekurang-kurangnya satu kalimat spesifik untuk setiap Quality_Criterion yang mendapat Quality_Score di bawah 7.
4. IF skor total berbobot bernilai 7.0 atau lebih dari 10.0, THEN THE Quality_Evaluator SHALL menetapkan keputusan "terima", dan IF skor total berbobot bernilai kurang dari 7.0, THEN THE Quality_Evaluator SHALL menetapkan keputusan "tolak".
5. THE Quality_Evaluator SHALL diimplementasikan sebagai adapter yang pluggable dan mockable yang konsisten dengan antarmuka AI_Service_Connector eksisting.
6. THE Quality_Evaluator SHALL beroperasi sebagai peran AI yang terpisah dari peran yang menghasilkan Copy_Content dan aset gambar.
7. WHEN Quality_Evaluator memberikan Quality_Score, THE Quality_Evaluator SHALL membatasi setiap Quality_Score pada bilangan bulat dalam rentang 1 sampai 10 (Asumsi A1).
8. IF panggilan Quality_Evaluator gagal atau tidak menerima respons dalam waktu 30 detik, THEN THE AI_Service_Connector SHALL mencoba ulang hingga maksimum 3 percobaan, lalu jika tetap gagal menghentikan proses variasi tersebut dengan pesan kesalahan yang menyebutkan kegagalan evaluasi dan mempertahankan hasil langkah sebelumnya tanpa perubahan.
9. THE Quality_Evaluator SHALL berjalan di dalam worker job background, bukan pada request `POST /api/generate` awal.

### Requirement 6: Quality Gates dan Scoring

**User Story:** Sebagai pengguna, saya ingin setiap desain dinilai terhadap kriteria berskor dan ditolak bila di bawah ambang, sehingga sistem secara otomatis membuang hasil di bawah standar dan menggantinya.

#### Acceptance Criteria

1. WHERE Professional_Mode aktif, WHEN Quality_Report sebuah Design_Variation tersedia, THE Quality_Gate SHALL membandingkan setiap Quality_Score terhadap Quality_Threshold per-kriteria dan skor total berbobot terhadap ambang total.
2. THE Quality_Gate SHALL menerima daftar Quality_Criterion default berupa: Hierarchy, Readability, Composition, Branding Consistency, Originality, Premium Perception, dan Whitespace (Asumsi A2).
3. THE Quality_Gate SHALL menggunakan Quality_Threshold per-kriteria default: Readability ≥ 8, Branding Consistency ≥ 8, Hierarchy ≥ 7, Composition ≥ 7, Whitespace ≥ 7, Originality ≥ 7, dan Premium Perception ≥ 7 (Asumsi A3).
4. THE Quality_Gate SHALL menggunakan ambang total berbobot default sebesar 7.5 dari 10 (Asumsi A4).
5. IF satu atau lebih Quality_Score berada di bawah Quality_Threshold per-kriteria, atau skor total berbobot berada di bawah ambang total, THEN THE Quality_Gate SHALL menandai Design_Variation sebagai REJECTED.
6. WHEN sebuah Design_Variation ditandai REJECTED, THE Pipeline_Engine SHALL meregenerasi variasi tersebut menggunakan critique dari Quality_Report sebagai masukan, hingga maksimum 3 percobaan regenerasi per variasi (Asumsi A5).
7. IF sebuah Design_Variation tetap REJECTED setelah jumlah maksimum percobaan regenerasi tercapai, THEN THE Pipeline_Engine SHALL mengembalikan Design_Variation dengan skor total tertinggi di antara percobaan dan menandainya sebagai diterima-dengan-peringatan disertai Quality_Report terkait.
8. WHEN sebuah Design_Variation memenuhi seluruh Quality_Threshold per-kriteria dan ambang total, THE Quality_Gate SHALL menandai variasi tersebut sebagai ACCEPTED.
9. THE Quality_Gate SHALL membuat Quality_Threshold per-kriteria, ambang total, dan jumlah maksimum percobaan regenerasi dapat dikonfigurasi tanpa mengubah kode Pipeline_Engine.
10. THE Pipeline_Engine SHALL membatasi total percobaan regenerasi akibat Quality_Gate agar keseluruhan eksekusi job tetap berada dalam batas `maxDuration` worker yang dikonfigurasi (Asumsi A10).

### Requirement 7: Purpose-Driven Decision Weights

**User Story:** Sebagai pengguna, saya ingin tujuan desain yang saya nyatakan memengaruhi prioritas penilaian dan strategi, sehingga desain marketing dinilai berbeda dari desain branding atau edukasi.

#### Acceptance Criteria

1. WHERE Professional_Mode aktif, WHEN Design_Purpose dipilih, THE Pipeline_Engine SHALL menurunkan Decision_Weights berupa urutan prioritas dan bobot per Quality_Criterion dari Design_Purpose tersebut menggunakan aturan berbasis aturan (rule-based).
2. WHEN Design_Purpose bernilai Marketing_Conversion, THE Pipeline_Engine SHALL memberikan bobot prioritas lebih tinggi pada Quality_Criterion yang berkaitan dengan konversi (mis. Hierarchy dan Readability) dibanding Quality_Criterion lain.
3. WHEN Design_Purpose bernilai Branding_Awareness, THE Pipeline_Engine SHALL memberikan bobot prioritas lebih tinggi pada Quality_Criterion Branding Consistency dan Premium Perception dibanding Quality_Criterion lain.
4. WHEN Design_Purpose bernilai Education, THE Pipeline_Engine SHALL memberikan bobot prioritas lebih tinggi pada Quality_Criterion Readability dan Hierarchy dibanding Quality_Criterion lain.
5. WHEN Design_Purpose bernilai Engagement, THE Pipeline_Engine SHALL memberikan bobot prioritas lebih tinggi pada Quality_Criterion Originality dan Composition dibanding Quality_Criterion lain.
6. WHEN skor total berbobot dihitung, THE Quality_Gate SHALL menerapkan Decision_Weights yang diturunkan dari Design_Purpose pada agregasi Quality_Score.
7. WHEN Visual_Strategy disusun, THE Pipeline_Engine SHALL menerapkan urutan prioritas dari Decision_Weights pada keputusan hierarchy plan dan composition type.

### Requirement 8: Interactive Refinement Loop

**User Story:** Sebagai pengguna, saya ingin memberi rating dan komentar bahasa natural atas sebuah hasil lalu sistem menyesuaikan dan meregenerasi, sehingga saya dapat menyempurnakan desain melalui percakapan.

#### Acceptance Criteria

1. WHEN pengguna mengirimkan rating Refinement_Loop pada sebuah Design_Variation menggunakan skala bilangan bulat 1 sampai 10, THE System SHALL menyimpan rating tersebut bersama variasi terkait (Asumsi A7).
2. IF pengguna mengirim rating Refinement_Loop di luar rentang bilangan bulat 1 sampai 10, THEN THE System SHALL menolak rating tersebut, mempertahankan rating sebelumnya jika ada, dan menampilkan pesan yang menyatakan nilai rating tidak valid.
3. WHEN pengguna mengirimkan komentar bahasa natural (panjang 1 sampai 500 karakter) pada sebuah Design_Variation, THE Pipeline_Engine SHALL menafsirkan komentar tersebut menjadi penyesuaian Design_DNA (mis. whitespace ratio, jumlah elemen, bobot tipografi, tingkat restraint palet).
4. IF komentar bahasa natural kosong atau melebihi 500 karakter, THEN THE System SHALL menolak komentar tersebut, mempertahankan Design_Variation tanpa perubahan, dan menampilkan pesan yang menyatakan komentar tidak valid.
5. IF komentar bahasa natural tidak dapat ditafsirkan menjadi penyesuaian Design_DNA, THEN THE Pipeline_Engine SHALL mempertahankan Design_Variation tanpa perubahan dan menampilkan pesan yang meminta pengguna memperjelas masukan.
6. WHEN penyesuaian Design_DNA diterapkan, THE Pipeline_Engine SHALL meregenerasi Design_Variation menggunakan Design_DNA yang telah disesuaikan dalam waktu maksimum 30 detik.
7. WHEN sebuah Design_Variation diregenerasi melalui Refinement_Loop, THE System SHALL menampilkan penjelasan penyesuaian yang menyebutkan parameter Design_DNA yang diubah beserta arah perubahannya (naik atau turun).
8. IF proses regenerasi Refinement_Loop gagal atau tidak selesai dalam waktu 30 detik, THEN THE Pipeline_Engine SHALL mempertahankan Design_Variation asal tanpa perubahan dan menampilkan pesan kesalahan yang menyatakan penyempurnaan gagal.
9. THE System SHALL melakukan seluruh penyesuaian dan regenerasi Refinement_Loop di dalam worker job background dan melalui endpoint yang terautentikasi.

### Requirement 9: Continuous Learning / Intelligence Memory

**User Story:** Sebagai pengguna, saya ingin sistem mengingat Design_DNA yang berhasil dan yang ditolak untuk konteks serupa, sehingga generasi berikutnya menjadi lebih baik seiring waktu.

#### Acceptance Criteria

1. WHEN sebuah Design_Variation diterima (ACCEPTED) atau ditolak (REJECTED), THE Intelligence_Memory SHALL menyimpan Design_DNA yang dipakai, hasil terima/tolak, umpan balik terkait, dan konteks berupa industri, Design_Purpose, dan target audience.
2. WHEN generasi baru dipicu dengan Professional_Mode aktif, THE Pipeline_Engine SHALL mengambil entri Intelligence_Memory yang konteksnya cocok (industri, Design_Purpose, dan target audience) untuk menginisialisasi Design_DNA.
3. WHEN entri Intelligence_Memory yang cocok ditemukan, THE Pipeline_Engine SHALL memprioritaskan Design_DNA dari entri yang sebelumnya ACCEPTED dan menghindari Design_DNA dari entri yang sebelumnya REJECTED.
4. IF tidak ada entri Intelligence_Memory yang cocok dengan konteks, THEN THE Pipeline_Engine SHALL menginisialisasi Design_DNA dari Decision_Weights default tanpa menampilkan kesalahan.
5. THE Intelligence_Memory SHALL menyimpan entri tanpa menyertakan data pengenal pribadi (PII) dari brief mentah, hanya menyimpan Design_DNA dan konteks teragregasi (Asumsi A8).
6. WHERE pengguna meminta penghapusan data pembelajaran, THE Intelligence_Memory SHALL menghapus seluruh entri milik pengguna tersebut.
7. THE Intelligence_Memory SHALL mempertahankan entri selama maksimum 365 hari, lalu menghapus entri yang melampaui periode retensi tersebut (Asumsi A8).
8. IF penyimpanan ke Intelligence_Memory gagal, THEN THE Pipeline_Engine SHALL melanjutkan penyelesaian Generation_Batch tanpa menggagalkannya dan mencatat kegagalan penyimpanan secara internal.

### Requirement 10: Negative-Pattern Avoidance

**User Story:** Sebagai pengguna, saya ingin sistem menjauhi tampilan template generik dan kesan "buatan AI" yang berlebihan, sehingga hasilnya terasa orisinal dan premium.

#### Acceptance Criteria

1. WHERE Professional_Mode aktif, THE Quality_Evaluator SHALL menilai Quality_Criterion Originality yang mengukur seberapa jauh sebuah Design_Variation menyerupai Negative_Pattern.
2. WHEN Image_Prompt dibangun saat Professional_Mode aktif, THE Pipeline_Engine SHALL menyertakan instruksi negative prompt yang mengarahkan hasil menjauh dari tampilan template generik, kesan "AI-generated look", dan dekorasi berlebih.
3. IF Quality_Score Originality sebuah Design_Variation berada di bawah Quality_Threshold-nya, THEN THE Quality_Gate SHALL menandai variasi tersebut sebagai REJECTED dan memicu regenerasi sesuai Requirement 6.
4. THE Quality_Report SHALL menyertakan critique spesifik yang mengidentifikasi Negative_Pattern apa pun yang terdeteksi pada Design_Variation.

### Requirement 11: Integrasi dengan Pipeline, Job Asinkron, Kredit, dan Keamanan

**User Story:** Sebagai pemilik sistem, saya ingin lapisan Design_Intelligence terintegrasi dengan pipeline, model job, kredit, dan keamanan yang ada tanpa merusaknya, sehingga sistem tetap stabil dan aman di Vercel.

#### Acceptance Criteria

1. THE Pipeline_Engine SHALL menjalankan seluruh kapabilitas Design_Intelligence di dalam pipeline 6-langkah berurutan ketat eksisting tanpa menambah, menghapus, melompati, atau mengubah urutan keenam langkah.
2. THE System SHALL menjalankan analisis, evaluasi, dan regenerasi Design_Intelligence di dalam worker job background eksisting dan mengembalikan progres melalui mekanisme polling `GET /api/jobs/{jobId}` yang ada.
3. THE AI_Service_Connector SHALL mengakses Quality_Evaluator dan seluruh layanan AI Design_Intelligence lain melalui adapter yang pluggable dan mockable.
4. WHEN sebuah Generation_Batch selesai dengan Professional_Mode aktif, THE Credit_Manager SHALL mengurangi kredit sebanyak 1 kredit untuk setiap Design_Variation final yang diterima dan TIDAK mengurangi kredit untuk regenerasi internal akibat penolakan Quality_Gate (Asumsi A6).
5. IF sebuah job gagal saat menjalankan kapabilitas Design_Intelligence, THEN THE Credit_Manager SHALL mengembalikan seluruh kredit yang direservasi dan belum terpakai untuk batch tersebut.
6. THE System SHALL mewajibkan autentikasi dan otorisasi kepemilikan sumber daya pada seluruh endpoint baru yang dipakai untuk Refinement_Loop, penayangan Design_Brief_Analysis/Visual_Strategy/Quality_Report, dan pengelolaan Intelligence_Memory.
7. THE System SHALL membatasi total tambahan latensi dari Design_Intelligence (analisis, evaluasi, dan regenerasi) agar eksekusi job tetap berada dalam batas `maxDuration` worker yang dikonfigurasi pada Vercel (Asumsi A10).
