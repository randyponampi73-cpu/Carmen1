---
name: test-generation
description: Menulis unit test dan integration test nyata berbasis Node test runner atau framework uji proyek tanpa mock palsu untuk logika inti.
category: testing
version: 1.0.0
tags: [testing, unit-test, integration-test, assertions, node-test]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests, validate_project]
permissions: [READ, WRITE, EXECUTE]
triggers: [buat test, tulis test, unit test, tambah pengujian, test coverage]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [run_tests, validate_project]
---

## Purpose
Menghasilkan test suite yang menguji skenario sukses, batas validasi (edge cases), serta jalur kegagalan nyata atas modul aplikasi sehingga regresi cepat terdeteksi.

## When to use
Gunakan saat pengguna meminta penambahan pengujian otomatis untuk fungsi bisnis, parser, validasi, endpoint API, atau skrip utilitas.

## Required context
- File implementasi target, `package.json` (untuk mengecek skrip `test` yang ada), dan konvensi modul ESM/CommonJS/TS proyek.

## Workflow
1. Inspeksi `package.json` dan file target memakai `read_file` agar test sesuai runtime proyek (`node:test`, `vitest`, atau `tsx --test`).
2. Identifikasi skenario utama: jalur normal, input kosong/tidak valid, batas numerik, serta kondisi error.
3. Tulis file uji (`*.test.mjs` atau `*.test.ts`) lewat `write_file` dan pastikan skrip `"test"` di `package.json` terpasang benar.
4. Jalankan `run_tests` dan perbaiki jika ada kegagalan nyata tanpa melemahkan assertion.

## Tool mapping
- `read_file`: Memahami signature fungsi dan kontrak data aktual.
- `write_file` / `edit_file`: Menulis berkas uji dan mengaktifkan skrip `"test"`.
- `run_tests`: Menjalankan eksekusi test langsung di sandbox.
- `validate_project`: Memastikan struktur proyek tetap valid.

## Verification
- Seluruh kasus uji yang baru dibuat tereksekusi melalui `run_tests` dan lulus 100%.

## Failure handling
- Jika `run_tests` gagal karena modul test runner belum terpasang, sesuaikan memakai `node --test` bawaan Node atau instal dependensi uji dengan persetujuan proyek.

## Safety constraints
- Dilarang menulis test kosong, `assert(true)`, atau melewati assertion kegagalan nyata.

## Examples
- "/test-generation Buat unit test komprehensif untuk modul kalkulasi diskon di lib/pricing.mjs"
