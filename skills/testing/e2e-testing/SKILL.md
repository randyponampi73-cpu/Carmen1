---
name: e2e-testing
description: Merancang dan memverifikasi alur uji end-to-end berbasis browser (Playwright/HTTP E2E) untuk fitur UI dan API lengkap.
category: testing
version: 1.0.0
tags: [e2e, playwright, browser, integration, ui-flow]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests, run_command, read_logs, validate_project]
permissions: [READ, WRITE, EXECUTE]
triggers: [e2e, end-to-end, playwright, uji alur, browser test, ui test]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [run_tests, validate_project]
---

## Purpose
Menyusun dan menjalankan skenario pengujian end-to-end yang memvalidasi alur pengguna nyata dari UI hingga database/API tanpa bergantung pada selector rapuh.

## When to use
Gunakan saat memverifikasi alur login, pembuatan data, navigasi multi-layar, responsivitas seluler/desktop, atau saat menulis skrip uji Playwright.

## Required context
- `package.json`, struktur HTML/komponen frontend, serta ketersediaan browser/Playwright di sandbox.

## Workflow
1. Inspeksi `package.json`, `index.html`, dan elemen antarmuka (`data-testid`, `aria-label`, peran ARIA) dengan `read_file` dan `search_files`.
2. Tulis skrip uji E2E yang memeriksa aliran pengguna kritis termasuk empty state, input valid/invalid, dan persistensi data.
3. Eksekusi skrip uji memakai `run_command` atau `run_tests` jika runtime browser tersedia di lingkungan.
4. Periksa `read_logs` dan pastikan server uji ditutup bersih setelah selesai.

## Tool mapping
- `search_files`: Menemukan selector semantik stabil di komponen UI.
- `write_file` / `edit_file`: Membuat skenario pengujian E2E.
- `run_command` / `run_tests`: Menjalankan runner E2E.
- `read_logs`: Menginspeksi error konsol atau network 4xx/5xx.

## Verification
- Skenario E2E berjalan dengan hasil PASS atau status keterbatasan lingkungan (mis. browser belum terpasang) dilaporkan jujur sebagai NOT VERIFIED.

## Failure handling
- Jika browser headless tidak tersedia di sandbox, laporkan keterbatasan lingkungan secara eksplisit tanpa memalsukan status PASS.

## Safety constraints
- Jangan menggunakan kredensial produksi sungguhan di file uji E2E; gunakan data uji terisolasi.

## Examples
- "/e2e-testing Buat uji alur Playwright untuk registrasi pengguna, tambah item todo, dan muat ulang halaman"
