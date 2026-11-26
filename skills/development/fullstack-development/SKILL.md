---
name: fullstack-development
description: Mengorkestrasi pengembangan end-to-end antara frontend UI, backend API, skema SQLite/PostgreSQL, dan validasi runtime dalam CARMEN.
category: development
version: 1.0.0
tags: [fullstack, sqlite, schema, api, ui, end-to-end]
tools: [list_files, read_file, write_file, edit_file, inspect_dependencies, validate_project, build_project, run_tests, read_logs]
permissions: [READ, WRITE, EXECUTE, DATABASE]
triggers: [fullstack, full-stack, aplikasi lengkap, crud, schema dan ui]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project, build_project]
---

## Purpose
Memastikan integrasi sinkron antar-lapisan — tabel database (`schema.sql`), kontrak API (`./api/<tabel>` atau backend kustom), dan antarmuka pengguna — sehingga aplikasi langsung berfungsi di pratinjau CARMEN.

## When to use
Gunakan untuk membangun atau memperluas aplikasi bisnis penuh (POS, inventaris, CRM, reservasi, LMS, SaaS) yang memadukan UI interaktif dengan persistensi data.

## Required context
- Daftar file workspace (`list_files`), `schema.sql`, `package.json`, dan `index.html`.

## Workflow
1. Inspeksi struktur proyek dan dependensi dengan `list_files` dan `inspect_dependencies`.
2. Rancang dan tulis skema relasional beserta indeks pada `schema.sql` (menggunakan `write_file`) agar backend SQLite CARMEN otomatis menyinkronkannya.
3. Implementasikan backend API (jika memakai server kustom) dan antarmuka lengkap yang memanggil `./api/<nama_tabel>` dengan state loading, error, dan konfirmasi mutasi.
4. Uji skrip bisnis inti jika kompleks, lalu jalankan `validate_project`, `build_project`, dan `read_logs` untuk verifikasi menyeluruh.

## Tool mapping
- `inspect_dependencies`: Memastikan library yang direferensikan tersedia di `package.json`.
- `write_file` / `edit_file`: Menyelaraskan `schema.sql`, logika backend, dan komponen UI.
- `validate_project`: Memverifikasi sinkronisasi SQLite, `index.html`, dan kebersihan secret.
- `build_project` / `run_tests`: Memverifikasi kompilasi dan uji logika.
- `read_logs`: Memastikan preview backend bebas error runtime.

## Verification
- Nama tabel dan kolom di frontend/API identik 100% dengan `schema.sql`.
- `validate_project` lulus dan tidak ada error baru di `read_logs`.

## Failure handling
- Bila sinkronisasi skema atau fetch API gagal, periksa kesesuaian nama kolom SQLite serta status log melalui `read_logs` dan perbaiki secara terkoordinasi.

## Safety constraints
- Gunakan `schema.sql` tanpa perintah `ATTACH`/`PRAGMA` berbahaya dan lindungi setiap input yang dirender ke DOM.

## Examples
- "/fullstack-development Bangun aplikasi kasir & stok gudang dengan schema.sql tabel products dan transactions"
