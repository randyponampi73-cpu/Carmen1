---
name: refactoring
description: Merapikan dan memodularisasi kode eksisting secara aman tanpa mengubah perilaku fungsional yang sudah berjalan.
category: development
version: 1.0.0
tags: [refactor, modular, cleanup, maintainable, edit]
tools: [list_files, read_file, search_files, edit_file, write_file, run_tests, build_project, validate_project, rollback_checkpoint]
permissions: [READ, WRITE, EXECUTE]
triggers: [refactor, rapikan, modularisasi, struktur ulang, bersihkan kode]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project, run_tests]
---

## Purpose
Menurunkan kompleksitas, memecah file monolitik, dan menghilangkan duplikasi kode sambil menjaga kompatibilitas antarmuka dan perilaku fungsional yang sudah terbukti bekerja.

## When to use
Gunakan saat pengguna meminta perapian struktur modul, ekstraksi komponen/utilitas, atau penyederhanaan kode yang sulit dipelihara.

## Required context
- File sumber yang akan direfaktor dan daftar pemanggilnya (`search_files`).
- Baseline pengujian (`run_tests` atau `build_project`) sebelum perubahan besar.

## Workflow
1. Identifikasi seluruh pemanggil dan ekspor modul target menggunakan `read_file` dan `search_files`.
2. Catat kontrak fungsi/komponen publik agar tetap kompatibel ke belakang.
3. Lakukan ekstraksi modul atau perapian bertahap memakai `edit_file` dan `write_file`.
4. Jalankan `validate_project`, `build_project`, dan `run_tests` setelah perubahan.
5. Gunakan `rollback_checkpoint` segera jika refactoring merusak kompilasi dan ulangi perbaikan yang lebih kecil.

## Tool mapping
- `search_files`: Memastikan tidak ada import atau pemanggil yang terputus.
- `edit_file`: Mengubah blok kode terarah secara aman.
- `write_file`: Menempatkan modul hasil ekstraksi.
- `run_tests`: Memverifikasi perilaku tetap identik.
- `rollback_checkpoint`: Mengembalikan kondisi pra-giliran bila terjadi kerusakan.

## Verification
- Semua referensi import cocok dan `validate_project` / `build_project` lulus.
- Jika proyek memiliki test, `run_tests` lulus tanpa penurunan cakupan.

## Failure handling
- Kembalikan checkpoint via `rollback_checkpoint` jika perubahan memicu kegagalan berantai, lalu lakukan perubahan per file kecil.

## Safety constraints
- Dilarang menghapus fitur eksisting yang sedang berfungsi dengan alasan penyederhanaan.

## Examples
- "/refactoring Pisahkan fungsi kalkulasi harga ke lib/pricing.mjs beserta ekspor yang kompatibel"
