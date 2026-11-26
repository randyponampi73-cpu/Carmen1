---
name: sql-optimization
description: Mengoptimalkan query SQL lambat, menghilangkan pola N+1, menambahkan indeks tepat sasaran, dan memastikan parameterized query.
category: database
version: 1.0.0
tags: [sql, index, optimization, query, performance]
tools: [search_files, read_file, edit_file, validate_project, run_tests]
permissions: [READ, WRITE, DATABASE]
triggers: [query lambat, optimasi sql, indeks, index, n+1, sql optimization]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project, run_tests]
---

## Purpose
Mempercepat eksekusi query baca/tulis pada SQLite maupun PostgreSQL melalui penambahan indeks selektif, penggabungan query N+1, dan proyeksi kolom spesifik tanpa `SELECT *` berlebihan.

## When to use
Gunakan saat endpoint daftar/laporan lambat, ditemukan query di dalam loop, atau diperlukan indeks komposit pada skema SQL.

## Required context
- `schema.sql` beserta kode pemanggil SQL di server/aplikasi.

## Workflow
1. Cari seluruh pernyataan SQL di workspace dengan `search_files` dan baca konteks eksekusinya via `read_file`.
2. Identifikasi query di dalam iterasi (N+1), full-table scan pada kolom filter/order, serta penggabungan string tidak aman.
3. Perbarui query menggunakan JOIN/IN/agregasi terparameterisasi dan tambahkan indeks ke `schema.sql` memakai `edit_file`.
4. Validasi skema dan hasil uji menggunakan `validate_project` dan `run_tests`.

## Tool mapping
- `search_files`: Melacak semua pemanggilan `SELECT`, `INSERT`, `UPDATE`, `DELETE`.
- `read_file`: Mengaudit struktur tabel dan rencana query.
- `edit_file`: Menambahkan indeks ke `schema.sql` dan menyederhanakan query.
- `validate_project` / `run_tests`: Membuktikan query dan skema bekerja benar.

## Verification
- Semua query tetap terparameterisasi dan `validate_project` / `run_tests` lulus.

## Failure handling
- Jika indeks gagal dibuat karena kolom belum ada, periksa skema tabel dan sesuaikan nama kolom.

## Safety constraints
- Jangan pernah mengganti placeholder parameterisasi (`?` / `$1`) dengan interpolasi string literal saat merapikan query.

## Examples
- "/sql-optimization Hilangkan query N+1 pada endpoint riwayat pesanan dan tambahkan indeks komposit"
