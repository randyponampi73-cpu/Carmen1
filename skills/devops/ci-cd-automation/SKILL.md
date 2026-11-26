---
name: ci-cd-automation
description: Merancang workflow CI/CD GitHub Actions untuk typecheck, lint, test, build, dan pengemasan artefak secara aman.
category: devops
version: 1.0.0
tags: [ci, cd, github-actions, pipeline, automation, workflow]
tools: [list_files, read_file, write_file, edit_file, inspect_dependencies, validate_project]
permissions: [READ, WRITE]
triggers: [ci, cd, github actions, pipeline, workflow yaml, otomasi build]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project]
---

## Purpose
Menyusun pipeline CI/CD berbasis `.github/workflows/*.yml` dengan pinned action version, izin token minimal (`permissions`), caching bersih, dan tahapan verifikasi lengkap.

## When to use
Gunakan saat menyiapkan otomatisasi pengujian, linting, build Docker/Web, atau build Android APK pada GitHub Actions.

## Required context
- `package.json`, file workflow `.github/workflows/*` jika ada, dan kebutuhan environment pipeline.

## Workflow
1. Baca `package.json` dan file workflow eksisting menggunakan `list_files` dan `read_file`.
2. Susun langkah CI berurutan: checkout, setup runtime, instalasi deterministik, typecheck/lint, test, dan build.
3. Terapkan prinsip least privilege (`permissions: contents: read`), hindari injeksi ekspresi `${{ github.event... }}` mentah ke `run:`, dan pisahkan rahasia lewat `${{ secrets.* }}`.
4. Simpan YAML melalui `write_file` / `edit_file` dan verifikasi struktur proyek dengan `validate_project`.

## Tool mapping
- `inspect_dependencies`: Memverifikasi versi Node dan skrip NPM yang akan dipanggil CI.
- `write_file` / `edit_file`: Menulis file `.github/workflows/*.yml`.
- `validate_project`: Memastikan tidak ada secret plaintext di workflow.

## Verification
- Seluruh skrip (`npm ci`, `npm test`, `npm run build`) di workflow cocok dengan `package.json`.

## Failure handling
- Jika skrip yang dibutuhkan belum ada di `package.json`, tambahkan atau sesuaikan perintah pipeline sebelum menyimpan.

## Safety constraints
- Jangan mencetak nilai `${{ secrets.* }}` ke log stdout maupun mengekspos token di pull request fork.

## Examples
- "/ci-cd-automation Buat workflow GitHub Actions untuk menjalankan typecheck, lint, unit test, dan Vite build"
