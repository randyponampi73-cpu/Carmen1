---
name: backend-development
description: Membangun REST API, validasi input, abstraksi database SQLite/PostgreSQL, dan penanganan error backend yang kokoh.
category: development
version: 1.0.0
tags: [backend, api, express, rest, validation, server]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests, validate_project, read_logs]
permissions: [READ, WRITE, EXECUTE, DATABASE]
triggers: [backend, api, endpoint, route, express, server, rest, middleware]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project, run_tests]
---

## Purpose
Mengembangkan endpoint backend yang aman, terparameterisasi, memiliki kode status HTTP tepat, validasi skema ketat, serta terintegrasi bersih dengan lapisan database.

## When to use
Gunakan ketika membangun server Node/Express, endpoint CRUD API, autentikasi sesi, atau memperbaiki kontrak permintaan/respons server.

## Required context
- Entry point backend (`server.ts`, `server.js`, atau direktori `server/`), `schema.sql`, dan `package.json`.
- Log server runtime bila ada kegagalan API (`read_logs`).

## Workflow
1. Inspeksi entry point server, middleware keamanan, dan model data yang sudah ada dengan `list_files` dan `read_file`.
2. Definisikan validasi tipe & rentang untuk body, query, dan parameter route sebelum menyentuh database.
3. Implementasikan route dengan query SQL terparameterisasi (`?` / `$n`), penanganan error konsisten, serta pemeriksaan kepemilikan resource.
4. Sinkronkan `schema.sql` bila tabel baru dibutuhkan lalu verifikasi melalui `validate_project` dan `run_tests`.

## Tool mapping
- `read_file`: Membaca route eksisting dan skema SQL.
- `search_files`: Melacak middleware autentikasi dan konfigurasi router.
- `write_file` / `edit_file`: Menambah atau memperbarui endpoint server.
- `validate_project`: Memvalidasi integritas `schema.sql` dan tidak adanya secret bocor.
- `run_tests`: Menguji endpoint dan kasus gagal.

## Verification
- Endpoint memvalidasi input invalid (HTTP 400), menolak akses tidak sah (HTTP 401/403), dan memakai parameterized query.
- `validate_project` lulus tanpa error runtime.

## Failure handling
- Jika server gagal startup atau route melempar exception, periksa `read_logs`, identifikasi baris penyebabnya, dan perbaiki dengan `edit_file`.

## Safety constraints
- Dilarang menggabungkan input pengguna langsung ke string SQL atau perintah shell.
- Jangan pernah mengembalikan password hash atau secret dalam payload JSON.

## Examples
- "/backend-development Tambahkan endpoint CRUD /api/invoices dengan validasi status dan total terhitung di server"
