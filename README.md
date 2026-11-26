# CARMEN — Full-Stack AI App Builder (BYOK)

CARMEN adalah platform pembuat aplikasi web dan Android full-stack berbasis perintah bahasa alami (*prompt*) dengan arsitektur **BYOK (*Bring Your Own Key*)** multi-provider, isolasi eksekusi tingkat OS, pratinjau *opaque-origin*, dan alur kerja AI agent terstruktur (*plan → inspect → execute → verify → repair*).

---

## Arsitektur Singkat

- **Frontend**: React 19 + Vite + Tailwind CSS + Monaco Editor (`src/`).
- **Backend**: Express + TypeScript (`server.ts`, `server/`) + SQLite bawaan Node (`node:sqlite`, `data/carmen.db`).
- **Secret Vault**: Enkripsi AES-256-GCM (`server/security.ts`) dengan `CARMEN_MASTER_KEY` wajib untuk penyimpanan API key dan *environment variable* proyek di server. Tersedia juga mode `KEY-8` penyimpanan key hanya di perangkat (`localStorage`) yang dikirim secara *ephemeral* ke `POST /api/providers/models/ephemeral` dan chat tanpa pernah menulis kunci ke database server.
- **Isolasi Eksekusi (`server/runtime/isolation.ts` & `server/runtime/sandbox.ts`)**:
  - Prioritas 1: **Docker / Podman container** (`--network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit --memory --cpus`).
  - Prioritas 2: **Linux Namespaces** (`unshare -Urnm -pf --mount-proc --kill-child`) + **`prlimit`** (CPU, ukuran file, file descriptor, batas proses), menyembunyikan direktori host (`data/`, kode server) dengan `tmpfs` kosong *read-only*, memutus jaringan pada eksekusi kode, dan menghapus env rahasia host.
  - Fallback jujur: **Host Terbatas** (*restricted-host*) bila host tidak mendukung container maupun Linux namespaces (tidak pernah dilabeli sebagai container).
  - Manajemen siklus proses (`ProcessLifecycleRegistry`): menghentikan seluruh *process group* (`-pgid`) termasuk proses cucu saat pembatalan, *timeout*, atau *shutdown* server.
- **Proteksi SSRF & DNS Rebinding (`server/security.ts`)**:
  - `safeOutboundFetch()` melakukan resolusi DNS terlebih dahulu, menolak seluruh rentang IP privat/loopback/link-local/CGNAT/metadata IPv4 & IPv6 (termasuk IPv4-mapped IPv6, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001:0::/32`, dan zone ID), lalu **mengunci (pin) alamat IP tervalidasi langsung ke koneksi soket** (`http.request`/`https.request` custom `lookup`) untuk menghilangkan celah TOCTOU DNS rebinding.
  - Memvalidasi setiap *hop* redirect dan menghapus header kredensial (`Authorization`, `Cookie`, `x-api-key`, `x-goog-api-key`) pada redirect lintas-origin.
- **Pratinjau Terisolasi & Health Check**: Iframe `sandbox="allow-scripts allow-forms allow-downloads"` tanpa `allow-same-origin`, token preview HMAC berumur pendek khusus proyek, endpoint `GET /api/projects/:id/preview-health` untuk deteksi status pratinjau nyata (`empty` vs `running` vs `error`), dan pelaporan error runtime kembali ke agent.
- **Autonomous AI Agent, Routing & Multi-Model Fallback (`server/agent/planner.ts`, `router.ts`, `orchestrator.ts`)**:
  - Klasifikasi intent terstruktur (`new_app`, `fullstack_feature`, `bug_repair`, `simple_edit`, `architecture_discuss`), rencana eksekusi live (`event: plan`) yang otomatis melewati perencanaan berat untuk suntingan kecil, serta *pre-turn workspace checkpoint* untuk `rollback_checkpoint`.
  - Pemantauan kesehatan provider (`ProviderHealthMonitor` + `GET /api/system/provider-health`) dan fallback otomatis lintas model / lintas provider saat terjadi `QUOTA_EXCEEDED`, `RATE_LIMIT`, `PROVIDER_DOWN`, `MODEL_NOT_FOUND`, `CONTEXT_TOO_LONG`, atau `AUTH_INVALID` (dengan jaminan tidak pernah mengulang key yang tidak valid).
  - Isolasi siklus sesi berbasis `sessionId` untuk mencegah *race condition* antar sesi chat berurutan.
- **Database Migrations & PostgreSQL Readiness (`server/db/migrations.ts`, `server/db/postgres-schema.sql`, `server/db/postgres.ts`)**:
  - Runner migrasi SQLite berversi dengan dukungan rollback dan `PRAGMA integrity_check` saat startup serta pada `GET /api/health`.
  - Skema PostgreSQL produksi siap pakai (`server/db/postgres-schema.sql`) dan validator konfigurasi pool (`DATABASE_URL`, `PGPOOL_MAX`, `PGSSLMODE`).
- **Deployment Produksi Nyata (`server/deploy/adapters.ts`, `DeployModal.tsx`)**:
  - Mendukung **Vercel** (Deployments API v13), **Netlify** (Site ZIP API), **Cloudflare Pages** (Direct Upload API v4), dan **Self-Hosted** (`Dockerfile` + `docker-compose.yml` + arsip ZIP bersih), seluruhnya melalui `safeOutboundFetch()`, menyaring file rahasia (`.env`), mencatat riwayat di tabel `deployments`, dan tidak pernah memalsukan URL deployment saat kredensial kosong/ditolak.

---

## Matriks Kompatibilitas Provider (7 Provider)

| Provider | Adapter | Endpoint Default | Validasi Kunci | Penemuan Model | Streaming | Tool Calling | Vision | Usage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Coarena AI** | Dedicated (`server/providers/coarena.ts`) | `https://coarena.ai/api/v1` (dapat dikonfigurasi) | `GET /api/v1/limits` (Bearer `coa_...`) | Dinamis via `GET /api/v1/models` (termasuk `capabilities.tools`, `capabilities.vision`, `pricing`) | Ya (SSE) | Sesuai metadata model | Sesuai metadata model | Ya (`stream_options`) |
| **Gemini** | Native (`@google/genai`) | `generativelanguage.googleapis.com/v1beta` | `GET /v1beta/models?pageSize=1` (`x-goog-api-key`) | Dinamis via `GET /v1beta/models` | Ya | Ya (termasuk `thoughtSignature`) | Ya (`inlineData`) | Ya (`usageMetadata`) |
| **Anthropic** | Native (`server/providers/anthropic.ts`) | `https://api.anthropic.com/v1` | `GET /v1/models?limit=1` (`x-api-key`) | Dinamis via `GET /v1/models` | Ya (SSE) | Ya (`tool_use`) | Ya (`image` base64) | Ya (`message_start`/`delta`) |
| **OpenAI** | OpenAI-compatible | `https://api.openai.com/v1` | `GET /v1/models` (Bearer) | Dinamis via `GET /v1/models` | Ya (SSE) | Ya | Ya (`image_url`) | Ya (`stream_options`) |
| **OpenRouter** | OpenAI-compatible | `https://openrouter.ai/api/v1` | `GET /api/v1/key` (Bearer + `HTTP-Referer`, `X-Title`) | Dinamis + kalkulasi tier otomatis dari `pricing` | Ya (SSE) | Sesuai `supported_parameters` | Sesuai katalog | Ya (`stream_options`) |
| **Groq** | OpenAI-compatible | `https://api.groq.com/openai/v1` | `GET /openai/v1/models` (Bearer) | Dinamis via `GET /openai/v1/models` | Ya (SSE) | Ya | Sesuai model | Ya (`stream_options`) |
| **Custom Provider** | OpenAI-compatible | Wajib HTTPS publik (pengguna) | `GET /models` (fallback `POST <chatPath>`) | Dinamis + daftar model manual opsional | Ya (SSE) | Konfigurasi pengguna | Konfigurasi pengguna | Ya (bila dikembalikan server) |

---

## Variabel Environment

Salin `.env.example` menjadi `.env` atau atur melalui panel **Secrets**:

| Variabel | Status | Keterangan |
| --- | --- | --- |
| `CARMEN_MASTER_KEY` | **Wajib** (penyimpanan key di server) | Kunci rahasia (minimal 32 karakter acak) untuk enkripsi AES-256-GCM API key & env var proyek. |
| `PORT` | Opsional | Port server HTTP (default: `3000`). |
| `APP_URL` | Opsional | URL publik aplikasi (HTTPS) untuk header referer dan cookie `Secure`/`SameSite=None`. |
| `CARMEN_DB_PATH` | Opsional | Path file SQLite utama (default: `data/carmen.db`). |
| `CARMEN_DB_DRIVER`, `DATABASE_URL` | Opsional | Driver database (`sqlite` default atau `postgres` dengan skema `server/db/postgres-schema.sql`). |
| `CARMEN_SANDBOX_DRIVER` | Opsional | Override driver isolasi: `auto` (default), `docker`, `podman`, `linux-namespace`, atau `restricted-host`. |
| `CARMEN_SANDBOX_IMAGE` | Opsional | Image OCI untuk mode Docker/Podman (default: `node:22-alpine`). |
| `PREVIEW_ORIGIN` | Opsional | Origin terpisah untuk hosting preview produksi. |
| `CARMEN_ENABLE_DEMO` | Opsional | Setel `1` untuk mengaktifkan tombol akun demo (`POST /api/auth/demo`) dan `?autostart=1` (default: mati). |
| `CARMEN_DEMO_PASSWORD` | Opsional | Kata sandi akun demo saat inisialisasi database pertama kali (default: dibuat acak aman per instalasi). |
| `CARMEN_SHARED_KEY_MAX_REQUESTS_PER_DAY`, `CARMEN_SHARED_KEY_MAX_TOKENS_PER_DAY`, `CARMEN_SHARED_KEY_MAX_COST_USD_PER_DAY` | Opsional | Batas harian (*requests*, *tokens*, estimasi USD) per pengguna untuk delegasi `GEMINI_API_KEY` server bersama (`server/providers/sharedQuota.ts`). |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | Opsional | Path Android SDK untuk kompilasi APK native melalui Gradle. |

---

## Perintah Pengembangan, Uji & Build

```bash
# 1. Pasang dependensi
npm install

# 2. Jalankan server pengembangan (Express + Vite di port 3000)
CARMEN_MASTER_KEY="ganti-dengan-kunci-acak-minimal-32-karakter" npm run dev

# 3. Pemeriksaan tipe TypeScript
npm run typecheck
npm run lint

# 4. Uji unit (keamanan, DNS rebinding/SSRF, isolasi OS, 7 provider, parser, agent E2E)
npm run test:unit

# 5. Uji integrasi API lengkap (auth, IDOR, CSRF, preview isolation, Coarena CRUD, sandbox)
npm run test:integration

# 6. Jalankan seluruh suite pengujian
npm test

# 7. Build produksi & jalankan server produksi
npm run build
npm start
```

---

## Pipeline Build Android & Persyaratan Toolchain

Status toolchain host dideteksi secara nyata melalui `GET /api/system/android-toolchain` (`java`, `javac`, `gradle`, `ANDROID_HOME`/`ANDROID_SDK_ROOT`, `apksigner`, `jarsigner`, `keytool`):

- **Jika toolchain lengkap tersedia**: CARMEN menjalankan Gradle di dalam lingkungan sandbox terisolasi (`spawnIsolatedProcess`). Untuk mode `release`, file keystore (`.jks`/`.keystore`/`.p12`) dan kredensial (*store password*, *key alias*, *key password*) divalidasi format binernya, ditulis sementara dengan izin `0600`, diverifikasi tanda tangannya (`apksigner`/`jarsigner`), dan langsung dihapus secara aman setelah build selesai. Artifak diklasifikasikan secara tegas: `debug-apk`, `signed-release-apk`, atau `unsigned-release-apk`.
- **Jika toolchain tidak tersedia di host**: CARMEN tidak memalsukan file `.apk`; sistem secara jujur menghasilkan arsip **`capacitor-source-zip`** (`-source.zip`) berisi proyek Capacitor + `AndroidManifest.xml` yang siap dikompilasi pada mesin/worker yang memiliki JDK 17+, Android SDK, dan Gradle 8+.

---

## Batasan yang Diketahui

- Kompilasi `.apk`/`.aab` native membutuhkan host atau worker dengan **JDK 17+**, **Android SDK**, **Gradle**, dan **`apksigner`/`jarsigner`**; tanpa toolchain tersebut output dibatasi secara jujur ke bundel sumber Capacitor `.zip`.
- Pengujian panggilan API *live* berbayar ke Anthropic/OpenAI/Groq/OpenRouter/Gemini/Coarena memerlukan API key valid milik pengguna; pengujian otomatis dalam repositori memverifikasi seluruh adapter secara deterministik terhadap kontrak resmi tanpa mengirim kunci rahasia.
- Login *magic link* belum memiliki transport pengiriman email sehingga endpoint `/api/auth/magic-link` mengembalikan `501` dan tab *Magic Link* disembunyikan sampai pengiriman email diimplementasikan.
- Mode `KEY-8` ("Key hanya di perangkat") pada `localStorage` berjalan secara *ephemeral* per permintaan (daftar model melalui `/api/providers/models/ephemeral` dan chat melalui `localProviderConfig`), sehingga tidak tersinkronisasi lintas perangkat kecuali disimpan ke Secret Vault terenkripsi di server.
