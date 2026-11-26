---
name: test-execution
description: Menjalankan test suite proyek di lingkungan sandbox terisolasi, mengumpulkan metrik lulus/gagal, dan melaporkan bukti hasil uji.
category: testing
version: 1.0.0
tags: [test, run-tests, verification, sandbox, report]
tools: [list_files, read_file, run_tests, run_command, read_logs, validate_project]
permissions: [READ, EXECUTE]
triggers: [jalankan test, run test, uji proyek, cek test, test suite]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: [run_tests]
---

## Purpose
Menjalankan suite pengujian proyek secara jujur dan deterministik di sandbox, melaporkan jumlah lulus/gagal aktual serta penyebab bila ada skrip yang belum tersedia.

## When to use
Gunakan ketika pengguna meminta menjalankan pengujian, memverifikasi hasil perubahan kode, atau memeriksa kesehatan test suite saat ini.

## Required context
- `package.json` untuk melihat definisi skrip `"test"`, dan daftar file test di workspace.

## Workflow
1. Periksa `package.json` dan cari berkas uji (`list_files` / `read_file`) untuk memastikan suite uji tersedia.
2. Jalankan `run_tests` (atau `run_command` spesifik seperti `node --test ...` jika dibutuhkan).
3. Jika test gagal, kumpulkan rincian kegagalan dan log melalui `read_logs` tanpa menyembunyikan error.
4. Jalankan `validate_project` dan laporkan ringkasan jujur jumlah test lulus, gagal, atau tidak terverifikasi.

## Tool mapping
- `read_file`: Memeriksa skrip uji pada `package.json`.
- `run_tests`: Mengeksekusi `npm test` di sandbox terisolasi.
- `run_command`: Menjalankan berkas uji spesifik saat debugging.
- `read_logs`: Mengambil detail keluaran eksekusi.

## Verification
- Hasil status akhir didasarkan pada exit code dan output aktual dari `run_tests`.

## Failure handling
- Jika `package.json` tidak memiliki skrip `test`, laporkan status NOT VERIFIED dan rekomendasikan pembuatan test via `test-generation`.

## Safety constraints
- Jangan pernah mengeklaim pengujian lulus tanpa bukti eksekusi nyata.

## Examples
- "/test-execution Jalankan seluruh unit test proyek dan tampilkan ringkasan hasilnya"
