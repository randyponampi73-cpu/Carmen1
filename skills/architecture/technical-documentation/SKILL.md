---
name: technical-documentation
description: Menyusun dan memperbarui dokumentasi teknis (README, panduan API, arsitektur, dan runbook) berdasarkan implementasi kode aktual.
category: architecture
version: 1.0.0
tags: [docs, documentation, readme, markdown, runbook]
tools: [list_files, read_file, search_files, write_file, edit_file, inspect_dependencies, validate_project]
permissions: [READ, WRITE]
triggers: [dokumentasi, readme, docs, panduan, architecture doc, changelog]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: [validate_project]
---

## Purpose
Menghasilkan dokumentasi yang ringkas, akurat 100% terhadap kode sumber aktual, lengkap dengan prasyarat, variabel environment, skrip perintah nyata, serta batasan sistem yang jujur.

## When to use
Gunakan saat pengguna meminta pembuatan atau sinkronisasi `README.md`, catatan rilis, panduan developer, atau dokumentasi modul.

## Required context
- `package.json`, `.env.example`, dan file sumber utama yang akan didokumentasikan.

## Workflow
1. Baca `package.json` (`inspect_dependencies`), `.env.example`, serta modul utama menggunakan `list_files` dan `read_file`.
2. Pastikan setiap perintah CLI, endpoint API, dan variabel environment yang ditulis benar-benar ada di codebase.
3. Tulis atau perbarui file Markdown dengan `write_file` atau `edit_file`.
4. Jalankan `validate_project` untuk memastikan tidak ada secret contoh asli ikut tertulis.

## Tool mapping
- `inspect_dependencies` / `read_file`: Memverifikasi skrip, endpoint, dan env var nyata.
- `write_file` / `edit_file`: Menyimpan pembaruan dokumentasi.
- `validate_project`: Memeriksa kebersihan secret di dokumentasi.

## Verification
- Seluruh path file, perintah `npm run`, dan endpoint di dokumen sesuai dengan implementasi aktual.

## Failure handling
- Jangan mengarang langkah deployment atau fitur yang belum ada di kode; tulis secara jujur bila masih opsional atau belum tersedia.

## Safety constraints
- Dilarang mencantumkan kredensial asli, token, atau URL internal sensitif ke dalam dokumentasi.

## Examples
- "/technical-documentation Perbarui README.md agar sesuai dengan skrip npm dan endpoint API terbaru"
