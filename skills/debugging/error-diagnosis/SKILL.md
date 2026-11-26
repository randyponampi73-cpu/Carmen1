---
name: error-diagnosis
description: Mendiagnosis akar masalah error runtime, syntax, database, atau build secara sistematis berbasis log dan inspeksi kode.
category: debugging
version: 1.0.0
tags: [debug, diagnosis, stacktrace, logs, error]
tools: [read_logs, list_files, search_files, read_file, workspace_diff, validate_project]
permissions: [READ]
triggers: [error, gagal, crash, stacktrace, diagnosis, kenapa error, exception]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: [validate_project]
---

## Purpose
Menelusuri gejala error hingga ke penyebab teknis utamanya dengan menggabungkan log runtime, stack trace, diff terbaru, dan pembacaan kode aktual tanpa menebak-nebak.

## When to use
Gunakan ketika aplikasi preview error, build gagal, query SQL bermasalah, atau pengguna mengirim pesan kesalahan yang perlu ditelusuri.

## Required context
- Log terbaru (`read_logs`), pesan error preview/terminal, dan daftar file terkait.

## Workflow
1. Ambil log terminal dan preview terbaru melalui `read_logs` serta jalankan `validate_project` untuk melihat seluruh gejala awal.
2. Ekstrak nama file, baris, simbol, atau query yang gagal dari pesan error.
3. Cari lokasi definisi dan pemanggil simbol memakai `search_files`, lalu baca bagian terkait menggunakan `read_file`.
4. Bandingkan dengan perubahan terbaru lewat `workspace_diff` untuk mengisolasi pemicu regresi.
5. Simpulkan akar masalah yang terverifikasi lengkap dengan lokasi file:baris sebelum perubahan dilakukan.

## Tool mapping
- `read_logs`: Mengumpulkan log error proses dev, install, dan build.
- `search_files`: Melacak simbol atau pesan error di seluruh proyek.
- `read_file`: Memeriksa konteks baris kode penyebab error.
- `workspace_diff`: Mengidentifikasi perubahan terbaru yang berpotensi memicu bug.
- `validate_project`: Memeriksa status `schema.sql`, `package.json`, dan `index.html`.

## Verification
- Akar masalah didukung langsung oleh kutipan log atau kode aktual dari workspace.

## Failure handling
- Jika log kosong, jalankan ulang perintah reproduksi yang aman atau periksa file entri utama (`index.html`, `server.ts`, `schema.sql`).

## Safety constraints
- Jangan mengubah file saat masih dalam fase diagnosis murni kecuali diminta beralih ke perbaikan.

## Examples
- "/error-diagnosis Telusuri penyebab TypeError pada halaman checkout di log preview"
