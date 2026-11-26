---
name: database-design
description: Merancang skema relasional (schema.sql), tipe data, foreign key, constraint, dan indeks yang kompatibel untuk SQLite dan PostgreSQL.
category: database
version: 1.0.0
tags: [database, schema, sqlite, postgres, sql, modeling]
tools: [list_files, read_file, write_file, edit_file, validate_project, run_command]
permissions: [READ, WRITE, DATABASE]
triggers: [database, schema, schema.sql, desain tabel, relasi, rdbms, sqlite, postgres]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project]
---

## Purpose
Menghasilkan skema database (`schema.sql`) yang ternormalisasi, bebas tipe inkonsisten, memiliki primary key, foreign key, constraint unik, serta indeks untuk pola query utama aplikasi.

## When to use
Gunakan ketika memulai proyek berfitur data persisten, menambah tabel baru, atau menata ulang relasi antar-entitas database.

## Required context
- File `schema.sql` jika sudah ada, serta daftar fitur CRUD dan laporan yang dibutuhkan aplikasi.

## Workflow
1. Periksa `schema.sql` dan file backend/frontend yang memanggil `./api/<tabel>` lewat `read_file` dan `search_files`.
2. Definisikan tabel dengan `CREATE TABLE IF NOT EXISTS`, tipe kolom standar, `PRIMARY KEY`, `FOREIGN KEY ... ON DELETE CASCADE/RESTRICT`, `NOT NULL`, serta `CHECK` seperlunya.
3. Tambahkan `CREATE INDEX IF NOT EXISTS` pada kolom filter, join, dan pengurutan utama.
4. Tulis pembaruan `schema.sql` via `write_file` atau `edit_file`, lalu jalankan `validate_project` agar CARMEN menyinkronkan database sandbox SQLite.

## Tool mapping
- `read_file`: Mengaudit struktur tabel yang sudah ada.
- `write_file` / `edit_file`: Memperbarui `schema.sql`.
- `validate_project`: Otomatis menyinkronkan dan memvalidasi `schema.sql` pada SQLite proyek.

## Verification
- `validate_project` menyatakan `schema.sql sinkron dengan SQLite` tanpa error sintaks atau directive terlarang.

## Failure handling
- Jika sinkronisasi SQLite gagal, baca pesan error SQL dan perbaiki urutan tabel (induk sebelum anak) atau tipe kolom.

## Safety constraints
- Dilarang menyertakan perintah `ATTACH`, `DETACH`, `PRAGMA`, atau `load_extension` di dalam `schema.sql`.

## Examples
- "/database-design Rancang schema.sql untuk sistem peminjaman buku dengan tabel members, books, dan loans"
