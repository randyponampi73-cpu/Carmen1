---
name: migration-management
description: Mengelola evolusi skema database secara idempoten dengan skrip migrasi naik/turun yang aman untuk SQLite dan PostgreSQL.
category: database
version: 1.0.0
tags: [migration, schema, ddl, rollback, sqlite, postgres]
tools: [list_files, read_file, search_files, write_file, edit_file, validate_project, run_tests]
permissions: [READ, WRITE, DATABASE]
triggers: [migrasi, migration, alter table, tambah kolom, skema baru]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project, run_tests]
---

## Purpose
Menjamin setiap perubahan struktur tabel database dijalankan secara berurutan, idempoten, terdokumentasi di kedua dialek (SQLite dan PostgreSQL bila tersedia), serta dilengkapi jalur rollback yang jelas.

## When to use
Gunakan ketika menambah tabel, mengubah constraint, menambah kolom pada skema eksisting, atau menyelaraskan berkas migrasi dual-dialect.

## Required context
- File migrasi/skema eksisting (`schema.sql`, `migrations.ts`, `postgresMigrations.ts`, atau `postgres-schema.sql`).

## Workflow
1. Inspeksi versi migrasi terbaru dan struktur tabel saat ini menggunakan `list_files` dan `read_file`.
2. Susun definisi migrasi baru dengan nomor versi berurutan dan `IF NOT EXISTS` bila relevan agar aman dijalankan ulang.
3. Pastikan definisi `down` / rollback tersedia dan tipe kolom konsisten antar dialek (mis. `BOOLEAN`/`INTEGER`, `JSONB`/`TEXT`).
4. Jalankan `validate_project` dan `run_tests` untuk memastikan migrasi naik maupun rollback berjalan mulus.

## Tool mapping
- `read_file`: Memeriksa pola migrasi terbaru agar penomoran konsisten.
- `edit_file` / `write_file`: Menambahkan berkas atau entri migrasi baru.
- `run_tests`: Menguji penerapan migrasi dan integritas database.

## Verification
- Migrasi baru berjalan idempoten dan test database lulus.

## Failure handling
- Jika migrasi mengubah data atau menghapus kolom berisiko destruktif, minta persetujuan eksplisit sebelum menerapkan.

## Safety constraints
- Dilarang menulis migrasi destruktif (`DROP TABLE` produksi atau `TRUNCATE`) tanpa persetujuan pengguna.

## Examples
- "/migration-management Tambahkan kolom due_date dan status_priority ke tabel tasks dengan migrasi aman"
