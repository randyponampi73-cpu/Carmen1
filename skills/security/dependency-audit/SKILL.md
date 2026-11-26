---
name: dependency-audit
description: Memeriksa package.json, versi paket, skrip lifecycle install berisiko, dan risiko keamanan rantai pasok dependensi.
category: security
version: 1.0.0
tags: [dependencies, npm, supply-chain, package-json, audit]
tools: [inspect_dependencies, read_file, search_files, edit_file, validate_project]
permissions: [READ, WRITE]
triggers: [dependensi, dependency audit, npm audit, package.json, lifecycle script]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: [validate_project]
---

## Purpose
Mengidentifikasi risiko pada manifest dependensi proyek seperti skrip `preinstall`/`postinstall` berbahaya, paket tidak terpakai, pin versi tidak stabil, atau pola impor yang mencurigakan.

## When to use
Gunakan sebelum menjalankan instalasi paket baru, saat meninjau proyek impor pihak ketiga, atau ketika pengguna meminta audit dependensi.

## Required context
- File `package.json` dan daftar impor pada source proyek.

## Workflow
1. Jalankan `inspect_dependencies` untuk mengaudit daftar `dependencies`, `devDependencies`, dan skrip lifecycle (`preinstall`, `install`, `postinstall`, `prepare`).
2. Baca `package.json` lengkap lewat `read_file` dan verifikasi skrip `scripts` tidak mengeksekusi perintah unduhan eksternal atau shell obfuscated.
3. Cocokkan pemakaian paket aktual menggunakan `search_files`.
4. Bersihkan atau perbaiki entri `package.json` yang bermasalah melalui `edit_file`, lalu jalankan `validate_project`.

## Tool mapping
- `inspect_dependencies`: Audit otomatis manifest & lifecycle script di CARMEN.
- `read_file`: Verifikasi struktur lengkap `package.json`.
- `search_files`: Memeriksa apakah paket tertentu benar-benar digunakan.
- `edit_file`: Memperbarui versi atau menghapus paket mencurigakan.

## Verification
- `inspect_dependencies` melaporkan status audit lifecycle script aman dan `validate_project` lulus.

## Failure handling
- Jika proyek tidak memakai `package.json` (web statis murni), laporkan hasil apa adanya tanpa memaksakan file baru.

## Safety constraints
- Dilarang menjalankan instalasi paket yang mengandung lifecycle script eksekusi shell mencurigakan tanpa konfirmasi pengguna.

## Examples
- "/dependency-audit Audit package.json proyek ini untuk lifecycle script berbahaya dan dependensi usang"
