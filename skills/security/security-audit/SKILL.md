---
name: security-audit
description: Melakukan audit keamanan menyeluruh atas kode aplikasi (OWASP, autentikasi, otorisasi, SQLi, XSS, SSRF, path traversal, dan secret).
category: security
version: 1.0.0
tags: [security, audit, owasp, xss, sqli, auth, ssrf]
tools: [list_files, search_files, read_file, inspect_dependencies, validate_project, read_logs]
permissions: [READ]
triggers: [security audit, audit keamanan, periksa keamanan, owasp, celah keamanan]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: [validate_project]
---

## Purpose
Menemukan kelemahan keamanan nyata secara menyeluruh pada frontend, backend, database, dan konfigurasi proyek sebelum aplikasi digunakan atau dideploy.

## When to use
Gunakan ketika pengguna meminta audit keamanan aplikasi, pemeriksaan risiko OWASP Top 10, atau review kontrol akses dan privasi data.

## Required context
- Seluruh file proyek (`list_files`), dependensi (`inspect_dependencies`), dan konfigurasi skema (`schema.sql`).

## Workflow
1. Inventarisasi seluruh titik masuk data tidak tepercaya (route API, form input, query string, upload, rendering DOM) lewat `list_files` dan `search_files`.
2. Baca implementasi rute autentikasi, otorisasi kepemilikan data, query SQL/ORM, serta fungsi rendering HTML dengan `read_file`.
3. Periksa konfigurasi dependensi dan lifecycle script menggunakan `inspect_dependencies`.
4. Jalankan `validate_project` untuk mendeteksi secret plaintext serta error integritas dasar.
5. Susun laporan audit berdasarkan bukti file:baris nyata beserta prioritas mitigasi.

## Tool mapping
- `search_files`: Melacak sink berisiko (`innerHTML`, string concatenation SQL, `exec`, path join).
- `read_file`: Memverifikasi apakah input sudah divalidasi atau rentan di konteks pemanggilnya.
- `inspect_dependencies`: Mengaudit skrip `preinstall`/`postinstall` mencurigakan.
- `validate_project`: Memeriksa kebocoran pola key dan integritas `schema.sql`.

## Verification
- Laporan audit hanya memuat temuan terkonfirmasi dari pembacaan kode langsung lengkap dengan file dan baris.
- Tidak ada kredensial sensitif yang ikut tercetak dalam laporan.

## Failure handling
- Jika file tertentu gagal dibaca atau biner, catat keterbatasan cakupan audit secara jujur.

## Safety constraints
- Mode audit bersifat read-only; jangan menyisipkan payload destruktif ke sistem produksi atau membocorkan isi rahasia.

## Examples
- "/security-audit Audit seluruh endpoint API dan rendering HTML proyek terhadap XSS, SQLi, dan IDOR"
