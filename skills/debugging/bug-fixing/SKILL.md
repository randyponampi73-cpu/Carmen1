---
name: bug-fixing
description: Memperbaiki bug fungsional, syntax, dan kegagalan runtime dengan patch minimal serta verifikasi ulang hingga lulus.
category: debugging
version: 1.0.0
tags: [fix, bug, patch, repair, debug]
tools: [read_logs, read_file, search_files, edit_file, validate_project, run_tests, build_project, rollback_checkpoint]
permissions: [READ, WRITE, EXECUTE]
triggers: [fix, perbaiki, bug, tidak jalan, rusak, broken, repair]
dependencies: [error-diagnosis]
conflicts: []
execution_mode: sequential
verification: [validate_project, run_tests]
---

## Purpose
Menyelesaikan bug pada proyek dengan perubahan kode sekecil mungkin yang menyasar akar masalah, lalu membuktikan perbaikan melalui validasi, build, dan pengujian.

## When to use
Gunakan saat ada fitur rusak, error runtime, tombol tidak merespons, atau kegagalan test/build yang perlu diperbaiki segera.

## Required context
- Hasil diagnosis akar masalah, file target, serta status error terakhir.

## Workflow
1. Konfirmasi lokasi pasti bug dengan `read_logs`, `search_files`, dan `read_file`.
2. Terapkan patch terfokus memakai `edit_file` (hindari menulis ulang seluruh file jika tidak diperlukan).
3. Verifikasi perbaikan melalui `validate_project`, `build_project`, dan `run_tests`.
4. Jika muncul error baru selama maksimal 3 siklus perbaikan, evaluasi ulang penyebab atau pulihkan dengan `rollback_checkpoint` sebelum mencoba pendekatan bersih.

## Tool mapping
- `read_file`: Memastikan baris persis sebelum melakukan search-and-replace.
- `edit_file`: Menerapkan patch minimal pada file target.
- `validate_project` / `run_tests` / `build_project`: Membuktikan error benar-benar hilang.
- `rollback_checkpoint`: Pengaman jika patch justru memperburuk kondisi.

## Verification
- Error awal tidak muncul lagi pada `validate_project` maupun `run_tests` / `build_project`.

## Failure handling
- Hentikan percobaan berulang yang identik bila gagal; baca ulang file terkait atau kembalikan ke checkpoint aman.

## Safety constraints
- Jangan melewati pengujian yang gagal dengan menghapus assertion atau mematikan validasi keamanan.

## Examples
- "/bug-fixing Perbaiki error filter tanggal pada daftar transaksi yang menyebabkan halaman kosong"
