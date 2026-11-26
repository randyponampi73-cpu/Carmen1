---
name: docker-management
description: Mengelola Dockerfile, docker-compose.yml, .dockerignore, healthcheck, serta konfigurasi container non-root yang siap produksi.
category: devops
version: 1.0.0
tags: [docker, container, dockerfile, compose, non-root]
tools: [list_files, read_file, write_file, edit_file, inspect_dependencies, validate_project, run_command]
permissions: [READ, WRITE, EXECUTE]
triggers: [docker, dockerfile, docker-compose, container, image, dockerignore]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project]
---

## Purpose
Menyiapkan konfigurasi Docker multi-stage yang ringkas, menggunakan user non-root, mengecualikan file sensitif lewat `.dockerignore`, serta menjaga kesesuaian dependensi dan port dengan aplikasi.

## When to use
Gunakan ketika membuat atau memperbarui `Dockerfile`, `docker-compose.yml`, `.dockerignore`, atau menyiapkan kontainerisasi proyek.

## Required context
- `package.json`, `.env.example`, dan konfigurasi Docker eksisting.

## Workflow
1. Periksa `package.json` (`build`, `start`, dependensi runtime) dan file Docker eksisting dengan `read_file` dan `inspect_dependencies`.
2. Pastikan `Dockerfile` menyalin lockfile/manifest secara deterministik, menjalankan build, memakai user non-root, dan mendefinisikan `HEALTHCHECK`.
3. Pastikan `.dockerignore` mengecualikan `.env`, `node_modules`, `data/*.db`, dan artefak sementara.
4. Validasi hasil dengan `validate_project` (dan jalankan verifikasi build bila daemon Docker tersedia; jika tidak ada, laporkan NOT VERIFIED).

## Tool mapping
- `inspect_dependencies`: Memverifikasi kebutuhan paket build vs runtime.
- `write_file` / `edit_file`: Menyusun `Dockerfile`, `docker-compose.yml`, dan `.dockerignore`.
- `validate_project`: Memastikan tidak ada secret ikut tersimpan.

## Verification
- `Dockerfile` tidak memuat secret hardcoded dan selaras dengan skrip di `package.json`.
- Jika `docker` binary tidak terpasang di host, tandai build image live sebagai NOT VERIFIED.

## Failure handling
- Jangan mengklaim image container berhasil dibangun tanpa menjalankan `docker build` yang nyata.

## Safety constraints
- Container wajib berjalan sebagai non-root dan dilarang meng-COPY file `.env` atau kunci privat ke dalam image.

## Examples
- "/docker-management Buat Dockerfile multi-stage Node 22 non-root dan .dockerignore untuk proyek ini"
