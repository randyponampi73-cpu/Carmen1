---
name: code-review
description: Meninjau kualitas kode, kebenaran logika, tepi kasus, dan kepatuhan standar arsitektur sebelum perubahan dirilis.
category: development
version: 1.0.0
tags: [review, quality, maintainability, bugs, typescript]
tools: [list_files, read_file, search_files, workspace_diff, validate_project, run_tests]
permissions: [READ, EXECUTE]
triggers: [review, tinjau, periksa kode, audit kode, code review]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: [validate_project]
---

## Purpose
Menyediakan tinjauan kode objektif berbasis pembacaan file aktual dan diff untuk menemukan bug logika, penanganan error yang hilang, regresi API, atau duplikasi kode.

## When to use
Gunakan ketika pengguna meminta peninjauan perubahan, inspeksi kualitas kode modul tertentu, atau pemeriksaan sebelum build/deploy.

## Required context
- Target file atau `workspace_diff` untuk melihat perubahan terbaru.
- Konteks test suite dan error runtime jika tersedia.

## Workflow
1. Periksa ringkasan perubahan dengan `workspace_diff` dan daftar file melalui `list_files`.
2. Baca file target secara menyeluruh dengan `read_file` dan telusuri referensi pemanggil via `search_files`.
3. Evaluasi kebenaran logika, validasi input, penanganan error async, tipe data, dan kepatuhan keamanan.
4. Jalankan `validate_project` dan `run_tests` bila tersedia untuk melengkapi temuan dengan bukti objektif.
5. Laporkan temuan terurut berdasarkan tingkat keparahan lengkap dengan file, baris, dan rekomendasi perbaikan konkret.

## Tool mapping
- `workspace_diff`: Mengidentifikasi file yang ditambah, diubah, atau dihapus.
- `read_file`: Membaca implementasi lengkap sebelum memberi komentar.
- `search_files`: Melacak seluruh pemanggil fungsi dan kontrak terkait.
- `validate_project`: Memverifikasi integritas umum proyek.
- `run_tests`: Memastikan regresi teruji.

## Verification
- Setiap temuan menyertakan referensi path file dan nomor baris atau blok kode aktual.
- Status `validate_project` dilaporkan akurat sesuai hasil tool.

## Failure handling
- Jika file target tidak ditemukan, tampilkan daftar file terdekat via `list_files` sebelum menyimpulkan.

## Safety constraints
- Mode tinjauan tidak boleh menghapus atau menimpa kode tanpa persetujuan pengguna.
- Jangan mengeklaim pengujian lulus jika `run_tests` tidak dijalankan.

## Examples
- "/code-review Tinjau seluruh perubahan API di server dan komponen form utama"
