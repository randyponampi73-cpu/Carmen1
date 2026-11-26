---
name: test-failure-analysis
description: Menganalisis test yang gagal, membedakan bug kode vs test usang, dan memperbaiki akar masalah tanpa memalsukan assertion.
category: testing
version: 1.0.0
tags: [test-failure, debugging, assertion, flaky, triage]
tools: [run_tests, read_logs, read_file, search_files, edit_file, validate_project]
permissions: [READ, WRITE, EXECUTE]
triggers: [test gagal, test failure, assertion error, flaky test, gagal uji]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [run_tests, validate_project]
---

## Purpose
Menemukan penyebab sebenarnya di balik kegagalan unit test atau integration test dan menyelesaikannya di akar implementasi dengan integritas pengujian terjaga.

## When to use
Gunakan ketika `npm test` atau perintah pengujian melaporkan kegagalan assertion, timeout, atau race condition.

## Required context
- Keluaran error test (`run_tests` / `read_logs`), file test terkait, serta file implementasi yang diuji.

## Workflow
1. Reproduksi kegagalan secara pasti dengan `run_tests` dan baca rincian stack trace lewat `read_logs`.
2. Baca file uji dan implementasi modul target menggunakan `read_file`.
3. Tentukan apakah kegagalan berasal dari bug kode, perubahan kontrak API yang disengaja, atau kondisi race/setup test.
4. Terapkan perbaikan di akar masalah via `edit_file` lalu jalankan ulang `run_tests` dan `validate_project`.

## Tool mapping
- `run_tests`: Mereproduksi kegagalan dan memverifikasi perbaikan.
- `read_file`: Membandingkan ekspektasi test dengan kode aktual.
- `edit_file`: Memperbaiki bug di implementasi atau setup isolasi test yang keliru.

## Verification
- Seluruh test suite kembali lulus pada eksekusi berulang (tidak flaky).

## Failure handling
- Jika test gagal karena dependensi eksternal (misal database PostgreSQL belum berjalan), laporkan sebagai keterbatasan lingkungan secara eksplisit.

## Safety constraints
- DILARANG menyembunyikan kegagalan test dengan `.skip()`, mock palsu untuk hasil produksi, atau melonggarkan assertion keamanan.

## Examples
- "/test-failure-analysis Cari tahu kenapa assertion migrasi di postgres.test.ts gagal lalu perbaiki"
