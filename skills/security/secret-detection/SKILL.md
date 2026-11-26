---
name: secret-detection
description: Mendeteksi kebocoran API key, token autentikasi, private key, atau password hardcoded di seluruh file workspace proyek.
category: security
version: 1.0.0
tags: [secrets, credentials, api-key, redaction, env]
tools: [list_files, search_files, read_file, edit_file, write_file, validate_project]
permissions: [READ, WRITE]
triggers: [secret, api key bocor, credential, token hardcoded, env example, leak]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project]
---

## Purpose
Menemukan kredensial plaintext yang tidak sengaja ditulis di kode sumber atau file konfigurasi proyek, memindahkannya ke konfigurasi environment yang aman, dan mengganti placeholder di `.env.example`.

## When to use
Gunakan sebelum berbagi/mengekspor proyek, saat `validate_project` mendeteksi pola key plaintext, atau ketika pengguna meminta pembersihan rahasia di kode.

## Required context
- Daftar file proyek (`list_files`) dan hasil pemeriksaan `validate_project`.

## Workflow
1. Jalankan `validate_project` untuk pemeriksaan pola token otomatis di seluruh file workspace.
2. Telusuri kata kunci sensitif (`API_KEY`, `SECRET`, `PASSWORD`, `PRIVATE KEY`, `Bearer`) memakai `search_files`.
3. Periksa temuan melalui `read_file` tanpa menyalin ulang nilai rahasianya dalam ringkasan.
4. Ganti nilai hardcoded dengan pembacaan environment server-side (`process.env.<NAME>`) via `edit_file` dan dokumentasikan nama variabel tanpa nilai di `.env.example`.
5. Jalankan ulang `validate_project` untuk memastikan tidak ada kebocoran tersisa.

## Tool mapping
- `validate_project`: Deteksi bawaan kebocoran pola key.
- `search_files` / `read_file`: Pemeriksaan manual konfigurasi berisiko.
- `edit_file`: Penghapusan secret hardcoded dan pemindahan ke environment variable.

## Verification
- `validate_project` lulus tanpa peringatan kebocoran API key.

## Failure handling
- Jika file biner/aset tidak dapat dipindai teksnya, catat secara eksplisit pada laporan.

## Safety constraints
- Jangan pernah mencetak atau mengulang isi token sensitif di output chat, log, atau catatan project memory.

## Examples
- "/secret-detection Pindai seluruh proyek dan pindahkan konfigurasi kunci API ke variabel lingkungan aman"
