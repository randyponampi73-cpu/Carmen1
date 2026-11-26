---
name: data-integrity-audit
description: Mengaudit konsistensi relasi data, constraint NOT NULL/UNIQUE/FOREIGN KEY, isolasi tenant, serta transaksi atomik database.
category: database
version: 1.0.0
tags: [integrity, constraints, foreign-key, transaction, audit, database]
tools: [list_files, search_files, read_file, validate_project, run_tests]
permissions: [READ, DATABASE]
triggers: [integritas data, data integrity, foreign key, orphan, constraint, transaksi]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: [validate_project]
---

## Purpose
Menemukan celah integritas data seperti operasi tulis multi-tabel tanpa transaksi atomik, ketiadaan foreign key, potensi orphan records, atau bocornya isolasi tenant di query database.

## When to use
Gunakan saat melakukan peninjauan keamanan/keandalan lapisan database atau menyelidiki data tidak konsisten antar tabel.

## Required context
- Skema database (`schema.sql`) dan seluruh modul repositori/akses database.

## Workflow
1. Baca skema tabel dan seluruh constraint menggunakan `read_file`.
2. Cari semua blok mutasi multi-langkah dengan `search_files` untuk memeriksa penggunaan transaksi (`BEGIN`/`COMMIT` atau `asyncDb.transaction`).
3. Verifikasi setiap query tenant memfilter `user_id` / `project_id` dengan benar.
4. Jalankan `validate_project` dan `run_tests` (jika ada) lalu laporkan temuan integritas beserta saran perbaikan skema.

## Tool mapping
- `read_file`: Memeriksa constraint dan relasi skema.
- `search_files`: Menemukan operasi `INSERT`/`UPDATE`/`DELETE` tanpa transaksi atau filter kepemilikan.
- `validate_project`: Memvalidasi skema terhadap SQLite.

## Verification
- Laporan memuat temuan berbasis file:baris dan rekomendasi transaksi atau constraint yang terukur.

## Failure handling
- Jika pengujian database eksternal tidak tersedia di lingkungan, tandai integrasi live tersebut sebagai NOT VERIFIED.

## Safety constraints
- Audit dilakukan secara read-only; jangan mengubah atau menghapus data pengguna.

## Examples
- "/data-integrity-audit Periksa transaksi transfer saldo dan foreign key di seluruh endpoint API"
