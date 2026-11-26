---
name: deployment-management
description: Menyiapkan artefak deployment produksi, healthcheck, graceful shutdown, reverse proxy, dan kesiapan Cloud Run / self-hosted.
category: devops
version: 1.0.0
tags: [deploy, deployment, cloud-run, vercel, netlify, cloudflare, production]
tools: [list_files, read_file, write_file, edit_file, build_project, validate_project, run_tests]
permissions: [READ, WRITE, EXECUTE, DEPLOY]
triggers: [deploy, deployment, produksi, production, cloud run, vercel, netlify, healthcheck]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [build_project, validate_project]
---

## Purpose
Memastikan aplikasi siap rilis produksi: bundel frontend terkompilasi, endpoint `/api/health` tersedia, konfigurasi reverse proxy atau PaaS valid, dan tidak ada ketergantungan filesystem lokal kontainer yang rapuh.

## When to use
Gunakan ketika menyiapkan konfigurasi rilis ke Cloud Run, VPS (Caddy/Nginx + Docker), Vercel, Netlify, atau Cloudflare Pages.

## Required context
- `package.json`, entry point server (`server.ts`/`server.js`), konfigurasi PaaS/Docker, dan kebutuhan penyimpanan persisten.

## Workflow
1. Inspeksi target deployment, `package.json`, dan server startup dengan `list_files` dan `read_file`.
2. Pastikan aplikasi mendengarkan `PORT` dari environment variable, memiliki endpoint healthcheck ringan, dan menangani SIGTERM secara bersih.
3. Siapkan file konfigurasi deployment (`vercel.json`, `netlify.toml`, `Caddyfile`, atau `Dockerfile`) lewat `write_file` / `edit_file`.
4. Jalankan `build_project`, `validate_project`, dan `run_tests` (bila tersedia) sebagai bukti kesiapan rilis lokal.

## Tool mapping
- `read_file`: Memeriksa port, skrip `start`, dan dependensi runtime.
- `write_file` / `edit_file`: Menyusun atau memperbarui konfigurasi rilis.
- `build_project` / `validate_project`: Memastikan artefak build siap dideploy tanpa error maupun secret bocor.

## Verification
- `build_project` dan `validate_project` lulus.
- Kesiapan deployment live dilaporkan jujur sesuai ketersediaan target/token rilis (jangan mengklaim rilis berhasil tanpa bukti nyata).

## Failure handling
- Jika platform cloud tidak tersedia di lingkungan lokal, verifikasi artefak konfigurasinya lalu tandai deployment live sebagai NOT VERIFIED.

## Safety constraints
- Dilarang memaksa deployment tanpa persetujuan pengguna atau menyisipkan secret produksi ke file konfigurasi.

## Examples
- "/deployment-management Periksa kesiapan Cloud Run proyek ini dan siapkan endpoint healthcheck serta Dockerfile"
