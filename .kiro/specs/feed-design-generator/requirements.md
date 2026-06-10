# Requirements Document

## Introduction

Feed Design Generator adalah aplikasi web (MVP) berbasis AI yang menghasilkan desain feed media sosial berkualitas profesional (Instagram Feed, Carousel, Story/Reel, Square Post, Landscape) dari sebuah design brief. Tujuan utama sistem adalah memproduksi output selengkap dan seprofesional referensi AI image generator: memuat teks/copywriting, elemen visual, foto, tipografi, dan kualitas seorang desainer profesional, dengan konsistensi brand yang kuat di seluruh rangkaian (series) konten.

Pembeda utama sistem ini adalah pipeline generasi terstruktur ("Content Design System"). Sistem TIDAK langsung melompat ke image prompt, melainkan menjalankan rantai prompt 6-langkah: Brand DNA Extraction → Design System Selection → Copy Generation → Layout Composition → Image Prompt Build → Render & Compose. Pendekatan ini menjamin identitas visual yang konsisten lintas variasi, bukan sekadar satu desain yang bagus.

Dokumen ini mendefinisikan kebutuhan untuk: intake brief pengguna, pipeline AI 6-langkah, preview & editing canvas, ekspor & publikasi, riwayat & feedback loop, batasan paket/kredit, serta jaminan konsistensi brand. Aspek tata letak (3 panel: Brief/Configurator, Canvas Output & Preview, Properties/Prompt Chain/History) didasarkan pada dua mockup HTML yang disediakan pengguna.

## Glossary

- **System**: Aplikasi web Feed Design Generator secara keseluruhan.
- **Brief_Intake**: Komponen yang menerima dan memvalidasi input design brief dari pengguna (Layer 1).
- **Pipeline_Engine**: Komponen yang menjalankan rantai prompt 6-langkah secara berurutan (Layer 2).
- **AI_Service_Connector**: Komponen yang memanggil layanan AI eksternal (Layer 3).
- **Canvas_Renderer**: Komponen yang menyusun dan merender desain pada canvas serta menampilkan preview (Layer 4).
- **Export_Manager**: Komponen yang menangani ekspor dan publikasi output (Layer 5).
- **History_Manager**: Komponen yang menyimpan dan menampilkan riwayat generasi serta feedback (Layer 6).
- **Credit_Manager**: Komponen yang mengelola kuota/kredit/token sesuai paket pengguna.
- **Brand_DNA**: Objek data berisi atribut identitas brand (nama, tagline, palet warna aksen, tone, gaya visual) hasil ekstraksi pada langkah 1 pipeline.
- **Design_System**: Objek data berisi aturan desain (font headline/body, skala tipografi, radius, densitas layout, posisi elemen brand) yang dipilih pada langkah 2 pipeline.
- **Layout_Template**: Struktur komposisi/penempatan elemen pada kanvas yang dipilih pada langkah 4 pipeline.
- **Copy_Content**: Teks hasil generasi (headline, sub-headline, body, CTA) pada langkah 3 pipeline.
- **Image_Prompt**: Prompt final untuk image generator yang dibangun pada langkah 5 pipeline.
- **Design_Variation**: Satu hasil desain individual dalam suatu batch generasi.
- **Generation_Batch**: Sekumpulan Design_Variation yang dihasilkan dari satu brief (3, 6, atau 9 variasi).
- **Plan**: Paket langganan pengguna; nilai yang valid adalah "Free" atau "Pro".
- **Credit**: Satuan kuota yang dikonsumsi pengguna untuk melakukan generasi.
- **Output_Format**: Format dimensi output; nilai valid: Instagram Feed (1080x1350), Carousel (1080x1080), Story/Reel (1080x1920), Square (1080x1080), Landscape (1200x628).

## Requirements

### Requirement 1: Pengisian dan Validasi Design Brief

**User Story:** Sebagai pengguna, saya ingin mengisi design brief melalui form konfigurator, sehingga sistem memiliki konteks yang cukup untuk menghasilkan desain yang relevan.

#### Acceptance Criteria

1. THE Brief_Intake SHALL menampilkan field input untuk nama brand, tagline, topik/pesan utama, tujuan konten, gaya visual, palet warna aksen, tone konten, format output, jumlah variasi, dan elemen wajib.
2. THE Brief_Intake SHALL menandai field nama brand sebagai wajib diisi.
3. IF pengguna memicu generasi tanpa mengisi nama brand, THEN THE Brief_Intake SHALL menolak permintaan, menampilkan pesan yang menyatakan nama brand wajib diisi, dan mempertahankan seluruh nilai field yang sudah diisi tanpa perubahan.
4. THE Brief_Intake SHALL menyediakan pilihan tujuan konten berupa: Rekrutmen, Promosi, Branding, Edukasi, Engagement, dan Report.
5. THE Brief_Intake SHALL menyediakan pilihan gaya visual berupa: Bold Dark, Vibrant/Clean Modern, Corporate Blue, Minimalis, Warm Earth, Neon Cyber, Luxury, dan Gradient.
6. THE Brief_Intake SHALL menyediakan pilihan tone konten berupa: Profesional, Energik, Edukatif, Minimalis, Friendly, dan Formal.
7. THE Brief_Intake SHALL menyediakan pilihan Output_Format berupa: Instagram Feed (1080x1350), Carousel (1080x1080), Story/Reel (1080x1920), Square (1080x1080), dan Landscape (1200x628).
8. THE Brief_Intake SHALL menyediakan pilihan jumlah variasi berupa 3, 6, dan 9.
9. THE Brief_Intake SHALL menyediakan pemilih elemen wajib berupa: Logo Strip, CTA Button, Stat Cards, QR Code, Badge Floating, dan Progress Bar.
10. WHERE pengguna mengaktifkan unggah foto/aset, THE Brief_Intake SHALL menerima berkas berformat PNG, JPG, dan JPEG dengan ukuran maksimum 10 MB per berkas dan maksimum 10 berkas per sesi, lalu mengaktifkan proses penghapusan latar belakang otomatis bagi berkas yang diunggah pada sesi tersebut.
11. IF pengguna mengunggah berkas dengan format selain PNG, JPG, atau JPEG, THEN THE Brief_Intake SHALL menolak berkas dan menampilkan pesan kesalahan yang menyebutkan bahwa hanya format PNG, JPG, dan JPEG yang didukung.
12. IF pengguna mengunggah berkas berukuran lebih dari 10 MB atau melebihi 10 berkas dalam satu sesi, THEN THE Brief_Intake SHALL menolak berkas yang melampaui batas dan menampilkan pesan kesalahan yang menyebutkan batas ukuran 10 MB per berkas dan batas 10 berkas per sesi.
13. IF pengguna memasukkan nilai melebihi batas karakter pada field teks (nama brand maksimum 50 karakter, tagline maksimum 100 karakter, topik/pesan utama maksimum 500 karakter), THEN THE Brief_Intake SHALL menolak input yang melebihi batas dan menampilkan pesan kesalahan yang menyebutkan batas karakter field tersebut.

### Requirement 2: Pipeline Generasi Terstruktur 6-Langkah

**User Story:** Sebagai pengguna, saya ingin sistem menjalankan pipeline generasi terstruktur alih-alih langsung ke image prompt, sehingga desain yang dihasilkan memiliki identitas visual yang kuat dan konsisten.

#### Acceptance Criteria

1. WHEN pengguna memicu generasi dengan brief yang valid, THE Pipeline_Engine SHALL menjalankan enam langkah secara berurutan: (1) Brand DNA Extraction, (2) Design System Selection, (3) Copy Generation, (4) Layout Composition, (5) Image Prompt Build, dan (6) Render & Compose.
2. THE Pipeline_Engine SHALL menerapkan urutan langkah yang ketat, di mana setiap langkah hanya dapat berlanjut ke langkah penerus dengan nomor urut tepat satu lebih besar (langkah N ke langkah N+1) dan tidak dapat melompat, mengulang, atau mundur ke langkah lain.
3. WHEN langkah Brand DNA Extraction dijalankan, THE Pipeline_Engine SHALL menghasilkan objek Brand_DNA dari isi design brief.
4. WHEN langkah Design System Selection dijalankan, THE Pipeline_Engine SHALL menghasilkan objek Design_System berdasarkan Brand_DNA.
5. WHEN langkah Copy Generation dijalankan, THE Pipeline_Engine SHALL menghasilkan Copy_Content yang sesuai dengan tujuan konten dan tone yang dipilih pengguna pada design brief.
6. WHEN langkah Layout Composition dijalankan, THE Pipeline_Engine SHALL memilih Layout_Template yang sesuai dengan Output_Format dan elemen wajib yang dipilih.
7. WHEN langkah Image Prompt Build dijalankan, THE Pipeline_Engine SHALL menghasilkan Image_Prompt yang menggabungkan Brand_DNA, Design_System, dan Layout_Template.
8. WHEN langkah Render & Compose dijalankan, THE Pipeline_Engine SHALL menghasilkan Generation_Batch berisi jumlah Design_Variation yang sama persis dengan jumlah variasi yang dipilih pengguna.
9. WHILE pipeline 6-langkah berjalan, THE Pipeline_Engine SHALL menampilkan indikator progres yang menunjukkan nomor langkah aktif (1 sampai 6), nama langkah aktif, dan status setiap langkah (belum dijalankan, sedang berjalan, atau selesai), serta memperbarui indikator dalam waktu paling lambat 2 detik setiap kali langkah berpindah.
10. IF salah satu langkah pipeline gagal, THEN THE Pipeline_Engine SHALL menghentikan seluruh proses pada langkah yang gagal, menampilkan pesan kesalahan yang menyebutkan nomor dan nama langkah yang gagal, mengembalikan seluruh Credit yang belum terpakai untuk batch tersebut, dan mempertahankan isi design brief pengguna tanpa perubahan.

### Requirement 3: Integrasi Layanan AI Eksternal

**User Story:** Sebagai pengguna, saya ingin sistem memanfaatkan layanan AI eksternal untuk copy, gambar, komposisi, dan penghapusan latar, sehingga output mencapai kualitas profesional.

#### Acceptance Criteria

1. WHEN langkah copy/analisis brief dijalankan, THE AI_Service_Connector SHALL memanggil layanan model bahasa untuk menghasilkan Copy_Content dan analisis brief.
2. WHEN langkah generasi gambar dijalankan, THE AI_Service_Connector SHALL memanggil layanan AI image generation untuk menghasilkan aset gambar.
3. WHEN langkah komposisi dan render dijalankan, THE Canvas_Renderer SHALL menyusun teks, elemen, dan gambar pada canvas menjadi Design_Variation final.
4. WHERE pengguna mengunggah foto/aset, THE AI_Service_Connector SHALL memanggil layanan penghapusan latar belakang untuk memproses gambar tersebut.
5. IF panggilan ke layanan AI eksternal gagal atau tidak menerima respons dalam waktu 30 detik, THEN THE AI_Service_Connector SHALL menampilkan pesan kesalahan yang menunjukkan langkah yang gagal kepada pengguna, mempertahankan input dan hasil langkah sebelumnya tanpa perubahan, dan menawarkan opsi untuk mencoba ulang.
6. WHILE opsi mencoba ulang ditawarkan setelah kegagalan, THE AI_Service_Connector SHALL mengizinkan pengguna memicu pemanggilan ulang ke layanan AI eksternal hingga maksimal 3 kali percobaan per langkah.
7. WHEN suatu langkah generasi AI berhasil menghasilkan output, THE AI_Service_Connector SHALL menyediakan opsi regenerasi manual yang dapat dipicu pengguna untuk menghasilkan ulang output langkah tersebut.

### Requirement 4: Preview dan Editing Canvas

**User Story:** Sebagai pengguna, saya ingin melihat, membandingkan, dan mengedit variasi desain pada canvas, sehingga saya dapat memilih dan menyempurnakan hasil sebelum ekspor.

#### Acceptance Criteria

1. WHEN Generation_Batch selesai dibuat, THE Canvas_Renderer SHALL menampilkan seluruh Design_Variation (hingga maksimum jumlah variasi dalam batch, yaitu 20 variasi) pada area preview dalam waktu maksimum 2 detik sejak batch selesai.
2. THE Canvas_Renderer SHALL menyediakan kontrol zoom dengan rentang 25% hingga 400% dan kontrol pan yang dibatasi pada batas area konten preview canvas.
3. THE Canvas_Renderer SHALL menyediakan tampilan grid yang menampilkan antara 2 hingga 4 Design_Variation secara bersisian untuk perbandingan.
4. WHEN pengguna memilih sebuah Design_Variation, THE Canvas_Renderer SHALL menampilkan kontrol untuk mengedit, melakukan regenerasi, dan menduplikasi variasi tersebut dalam waktu maksimum 500 milidetik sejak variasi dipilih.
5. WHEN pengguna mengubah properti Design_System (font headline, font body, radius, densitas layout, skala tipografi, posisi logo, watermark, gaya CTA), THE Canvas_Renderer SHALL memperbarui tampilan preview agar mencerminkan perubahan tersebut dalam waktu maksimum 1 detik sejak perubahan dikonfirmasi.
6. WHEN pengguna meminta regenerasi sebuah Design_Variation, THE Pipeline_Engine SHALL menghasilkan variasi baru menggunakan Brand_DNA dan Design_System yang sama.
7. IF proses regenerasi sebuah Design_Variation gagal, THEN THE Pipeline_Engine SHALL mempertahankan Design_Variation sebelumnya tanpa perubahan dan menampilkan indikasi kesalahan yang menyatakan kegagalan regenerasi kepada pengguna.

### Requirement 5: Konsistensi Brand Lintas Variasi

**User Story:** Sebagai pengguna, saya ingin seluruh variasi dalam satu batch konsisten secara brand, sehingga rangkaian konten saya tampak sebagai satu kesatuan identitas.

#### Acceptance Criteria

1. THE Pipeline_Engine SHALL menerapkan Brand_DNA dan Design_System yang identik pada seluruh Design_Variation (1 sampai 10 variasi) dalam satu Generation_Batch.
2. THE Pipeline_Engine SHALL menerapkan palet warna aksen yang dipilih pengguna dengan nilai warna yang sama persis pada seluruh Design_Variation dalam satu Generation_Batch.
3. THE Pipeline_Engine SHALL menerapkan font headline dan font body yang sama persis (nama keluarga font identik) pada seluruh Design_Variation dalam satu Generation_Batch.
4. WHERE pengguna memilih elemen wajib, THE Canvas_Renderer SHALL menyertakan setiap elemen tersebut pada 100% Design_Variation dalam satu Generation_Batch.
5. IF satu atau lebih Design_Variation gagal menerapkan Brand_DNA, palet warna aksen, atau font yang sama dengan variasi lain dalam satu Generation_Batch, THEN THE Pipeline_Engine SHALL menandai Generation_Batch sebagai tidak konsisten, menampilkan indikasi kesalahan yang menyebutkan variasi dan atribut brand yang tidak sesuai, serta mempertahankan variasi yang sudah berhasil dibuat tanpa mengubahnya.
6. WHEN seluruh Design_Variation dalam satu Generation_Batch selesai dibuat, THE Pipeline_Engine SHALL memverifikasi bahwa Brand_DNA, palet warna aksen, font headline, font body, dan seluruh elemen wajib identik di semua variasi sebelum menandai Generation_Batch sebagai selesai.

### Requirement 6: Ekspor dan Publikasi

**User Story:** Sebagai pengguna, saya ingin mengekspor dan mempublikasikan desain dalam berbagai format, sehingga saya dapat langsung menggunakannya di berbagai kanal.

#### Acceptance Criteria

1. WHEN pengguna meminta ekspor sebuah Design_Variation sebagai PNG atau JPG, THE Export_Manager SHALL menghasilkan berkas dengan resolusi minimal 1080 piksel pada sisi terpendek dalam waktu maksimal 30 detik.
2. WHEN pengguna meminta ekspor sebagai PDF print-ready, THE Export_Manager SHALL menghasilkan berkas PDF dengan ruang warna CMYK.
3. WHEN pengguna meminta ekspor seluruh Generation_Batch, THE Export_Manager SHALL menghasilkan satu berkas ZIP yang berisi seluruh Design_Variation pada batch tersebut.
4. WHERE pengguna memilih publikasi langsung, THE Export_Manager SHALL mengirim Design_Variation ke kanal yang dipilih (Instagram, Facebook, atau LinkedIn) dan menampilkan konfirmasi keberhasilan dalam waktu maksimal 60 detik.
5. THE Export_Manager SHALL mempertahankan Design_Variation agar dapat diekspor atau dipublikasikan ulang terlepas dari hasil publikasi.
6. IF publikasi langsung gagal, THEN THE Export_Manager SHALL mempertahankan Design_Variation tanpa perubahan dan menampilkan pesan kesalahan yang menjelaskan penyebab kegagalan.
7. WHEN pengguna memilih mencoba ulang setelah publikasi langsung gagal, THE Export_Manager SHALL mengirim ulang Design_Variation yang sama ke kanal yang dipilih hingga maksimal 3 kali percobaan per permintaan.
8. IF proses ekspor (PNG, JPG, PDF, atau ZIP) gagal, THEN THE Export_Manager SHALL mempertahankan Design_Variation tanpa perubahan dan menampilkan pesan kesalahan yang menjelaskan penyebab kegagalan.

### Requirement 7: Riwayat dan Feedback Loop

**User Story:** Sebagai pengguna, saya ingin menyimpan riwayat generasi serta memberi rating dan menyempurnakan hasil, sehingga saya dapat meninjau ulang dan meningkatkan kualitas output.

#### Acceptance Criteria

1. WHEN Generation_Batch selesai dibuat, THE History_Manager SHALL menyimpan batch tersebut beserta brief terkait ke dalam riwayat pengguna dalam waktu maksimal 2 detik.
2. WHEN pengguna membuka halaman riwayat, THE History_Manager SHALL menampilkan daftar Generation_Batch sebelumnya yang diurutkan dari yang terbaru ke yang terlama, dengan maksimal 20 entri per halaman.
3. WHEN pengguna memilih sebuah entri riwayat, THE History_Manager SHALL memuat kembali Generation_Batch beserta brief terkait dalam waktu maksimal 3 detik.
4. WHEN pengguna memberi rating pada sebuah Design_Variation menggunakan skala bilangan bulat 1 sampai 5, THE History_Manager SHALL menyimpan rating tersebut bersama variasi terkait.
5. IF sistem penyimpanan tidak tersedia saat pengguna memberi rating, THEN THE History_Manager SHALL tetap menerima dan menampilkan rating pada antarmuka pengguna serta mencoba menyimpan ulang hingga maksimal 3 kali tanpa menampilkan pesan kesalahan kepada pengguna.
6. WHEN pengguna meminta penyempurnaan (fine-tune) sebuah Design_Variation, THE Pipeline_Engine SHALL menghasilkan variasi baru berdasarkan variasi asal dan masukan penyempurnaan pengguna.
7. IF proses penyimpanan Generation_Batch ke riwayat gagal, THEN THE History_Manager SHALL mempertahankan data batch pada sesi aktif dan menampilkan indikasi kesalahan yang menyatakan bahwa penyimpanan riwayat gagal.
8. IF pengguna memberi rating di luar rentang bilangan bulat 1 sampai 5, THEN THE History_Manager SHALL menolak rating tersebut, mempertahankan rating sebelumnya jika ada, dan menampilkan indikasi kesalahan yang menyatakan bahwa nilai rating tidak valid.
9. IF proses penyempurnaan (fine-tune) Design_Variation gagal, THEN THE Pipeline_Engine SHALL mempertahankan variasi asal tanpa perubahan dan menampilkan indikasi kesalahan yang menyatakan bahwa penyempurnaan gagal.

### Requirement 8: Manajemen Paket dan Kredit

**User Story:** Sebagai pengguna, saya ingin sistem mengelola kuota kredit sesuai paket saya, sehingga konsumsi penggunaan transparan dan mendorong upgrade.

#### Acceptance Criteria

1. WHEN pengguna membuka halaman utama atau saldo Credit berubah, THE Credit_Manager SHALL menampilkan jumlah Credit yang tersisa sebagai bilangan bulat non-negatif dalam waktu paling lama 2 detik.
2. WHEN Generation_Batch berhasil dihasilkan, THE Credit_Manager SHALL mengurangi Credit sebanyak 1 Credit untuk setiap variasi yang dihasilkan.
3. IF jumlah Credit tersisa kurang dari jumlah variasi yang diminta, THEN THE Credit_Manager SHALL menolak permintaan generasi tanpa mengurangi Credit, mempertahankan saldo Credit sebelumnya, dan menampilkan pesan yang mengindikasikan Credit tidak mencukupi beserta ajakan untuk melakukan upgrade ke paket Pro.
4. WHERE Plan pengguna adalah "Free", THE Credit_Manager SHALL menonaktifkan pilihan 9 variasi dan menandainya sebagai fitur Pro.
5. WHERE Plan pengguna adalah "Pro", THE Credit_Manager SHALL mengaktifkan pilihan 9 variasi.
6. THE Credit_Manager SHALL memastikan jumlah Credit tersisa tidak pernah bernilai kurang dari 0.
