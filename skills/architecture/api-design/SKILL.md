---
name: api-design
description: Merancang kontrak REST API yang konsisten, tervalidasi, aman, backward-compatible, serta lengkap dengan skema request/response.
category: architecture
version: 1.0.0
tags: [api, rest, openapi, contract, endpoints, schema]
tools: [list_files, read_file, search_files, write_file, edit_file, validate_project]
permissions: [READ, WRITE]
triggers: [api design, desain api, kontrak api, endpoint baru, rest api, openapi]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project]
---

## Purpose
Menetapkan konvensi penamaan resource, status kode HTTP, paginasi, format error terstruktur, dan validasi payload agar integrasi frontend-backend bersih dan stabil.

## When to use
Gunakan saat mendesain endpoint API baru, menyelaraskan tipe TypeScript client-server, atau memperbaiki inkonsistensi respons API.

## Required context
- File definisi API dan tipe bersama (`src/types.ts`, `server.ts`, atau folder `routes/`).

## Workflow
1. Baca endpoint dan tipe data eksisting dengan `search_files` dan `read_file` untuk mempertahankan konvensi proyek.
2. Definisikan URI resource, metode HTTP idempoten (`GET`, `PUT`, `DELETE`) vs non-idempoten (`POST`), serta payload error konsisten.
3. Selaraskan tipe TypeScript/validasi atau spesifikasi API memakai `edit_file` / `write_file`.
4. Verifikasi proyek dengan `validate_project`.

## Tool mapping
- `search_files` / `read_file`: Memastikan kontrak baru konsisten dengan klien dan server yang ada.
- `write_file` / `edit_file`: Memperbarui file tipe atau spesifikasi kontrak API.
- `validate_project`: Memastikan validitas proyek.

## Verification
- Kontrak API baru tetap backward-compatible dengan endpoint dan pemanggil eksisting.

## Failure handling
- Jika perubahan kontrak mengharuskan breaking change, tandai secara eksplisit dan perbarui seluruh pemanggil di frontend.

## Safety constraints
- Setiap endpoint mutasi harus mengasumsikan autentikasi, pemeriksaan kepemilikan tenant, serta perlindungan CSRF.

## Examples
- "/api-design Rancang kontrak endpoint manajemen webhook termasuk paginasi, validasi, dan kode error"
