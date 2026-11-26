---
name: regression-analysis
description: Membandingkan perubahan workspace terhadap versi sebelumnya untuk menemukan penyebab regresi fitur atau test yang tiba-tiba gagal.
category: debugging
version: 1.0.0
tags: [regression, diff, version, rollback, debug]
tools: [workspace_diff, read_file, search_files, read_logs, run_tests, rollback_checkpoint, validate_project]
permissions: [READ, WRITE, EXECUTE]
triggers: [regresi, regression, sebelumnya jalan, rusak setelah edit, diff]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: [validate_project, run_tests]
---

## Purpose
Menemukan bagian perubahan spesifik yang memecahkan perilaku yang sebelumnya berfungsi dengan membandingkan diff workspace, log, dan hasil pengujian.

## When to use
Gunakan ketika fitur yang sebelumnya berjalan mendadak rusak setelah serangkaian edit atau saat perubahan baru memicu kegagalan test.

## Required context
- Ringkasan `workspace_diff` dibandingkan snapshot versi terakhir.
- Output kegagalan `run_tests` dan `read_logs`.

## Workflow
1. Jalankan `workspace_diff` untuk melihat daftar seluruh file yang baru ditambah, dimodifikasi, atau dihapus.
2. Periksa log kegagalan dengan `read_logs` atau jalankan `run_tests` untuk mereproduksi regresi secara pasti.
3. Baca bagian file yang berubah dengan `read_file` dan identifikasi perubahan kontrak, penamaan, atau tipe data penyebab regresi.
4. Perbaiki bagian terkait atau gunakan `rollback_checkpoint` jika perlu memulihkan kondisi sebelum giliran berjalan.

## Tool mapping
- `workspace_diff`: Mengisolasi himpunan file yang berubah.
- `run_tests`: Mereproduksi test regresi.
- `read_file`: Memeriksa diff logika pada file terdampak.
- `rollback_checkpoint`: Mengembalikan kondisi aman bila dibutuhkan.

## Verification
- `validate_project` dan test regresi yang semula gagal kembali lulus.

## Failure handling
- Jika diff tidak menunjukkan penyebab di file yang diubah, periksa perubahan `package.json` atau `schema.sql`.

## Safety constraints
- Jangan mengedit file unrelated saat melakukan isolasi regresi.

## Examples
- "/regression-analysis Analisis perubahan terakhir yang membuat pengujian login gagal"
