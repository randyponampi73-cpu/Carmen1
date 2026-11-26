---
name: environment-configuration
description: Mengelola definisi variabel lingkungan (.env.example), pemisahan rahasia client vs server, dan validasi konfigurasi saat startup.
category: devops
version: 1.0.0
tags: [env, configuration, secrets, env-example, config]
tools: [list_files, search_files, read_file, write_file, edit_file, validate_project]
permissions: [READ, WRITE]
triggers: [env, environment, variabel lingkungan, env.example, konfigurasi, config]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project]
---

## Purpose
Menyelaraskan seluruh pembacaan `process.env.*` / `import.meta.env.*` dengan template `.env.example`, mencegah eksposur rahasia server ke bundel browser, serta menerapkan perilaku fail-closed yang jelas jika variabel wajib kosong.

## When to use
Gunakan saat menambah variabel environment baru, memperbaiki kegagalan startup akibat env var hilang, atau membersihkan konfigurasi `.env.example`.

## Required context
- `.env.example`, berkas pembaca konfigurasi di server & client (`search_files` untuk `process.env` / `VITE_`).

## Workflow
1. Cari seluruh referensi environment variable di codebase dengan `search_files`.
2. Verifikasi tidak ada secret sensitif (API key privat, database URL, master key) yang memakai prefix publik client (`VITE_` / `NEXT_PUBLIC_`).
3. Perbarui `.env.example` melalui `write_file` / `edit_file` dengan nama variabel urut abjad dan nilai kosong atau contoh non-rahasia saja.
4. Jalankan `validate_project` untuk memastikan tidak ada secret nyata ikut tersimpan.

## Tool mapping
- `search_files`: Menginventarisasi seluruh pemakaian env var di frontend dan backend.
- `read_file`: Memeriksa nilai default dan logika fallback.
- `write_file` / `edit_file`: Menyinkronkan `.env.example` dan guard konfigurasi.
- `validate_project`: Memastikan tidak ada secret bocor.

## Verification
- Semua env var backend terdokumentasi di `.env.example` tanpa nilai rahasia dan `validate_project` lulus.

## Failure handling
- Jika file `.env` asli ditemukan di workspace kode proyek, jangan pernah membocorkan nilainya dan peringatkan pengguna untuk memindahkannya ke secret manager.

## Safety constraints
- Dilarang menulis nilai rahasia asli ke `.env.example`, kode sumber, maupun log.

## Examples
- "/environment-configuration Sinkronkan semua process.env server ke .env.example dan pastikan tidak ada secret berawalan VITE_"
