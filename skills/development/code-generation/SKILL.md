---
name: code-generation
description: Menghasilkan kode aplikasi modular yang rapi, aman, dan tervalidasi sesuai stack proyek CARMEN.
category: development
version: 1.0.0
tags: [codegen, scaffold, module, typescript, react, vanilla]
tools: [list_files, read_file, create_directory, write_file, validate_project, build_project]
permissions: [READ, WRITE, EXECUTE]
triggers: [buatkan, generate, scaffold, modul baru, buat aplikasi]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project, build_project]
---

## Purpose
Membantu agen membangun komponen, layanan, dan halaman aplikasi secara terstruktur dari nol atau menambahkan modul baru ke proyek CARMEN yang sudah berjalan tanpa meninggalkan placeholder atau dead controls.

## When to use
Gunakan ketika pengguna meminta pembuatan aplikasi baru, penambahan fitur baru dari awal, atau generasi modul yang membutuhkan struktur file bersih.

## Required context
- Daftar file workspace (`list_files`) dan konfigurasi stack (`package.json`, `index.html`, atau `schema.sql`).
- Aturan proyek pengguna dan target runtime (Web Fullstack atau Android Capacitor).

## Workflow
1. Inspeksi struktur direktori dan dependensi proyek menggunakan `list_files` dan `inspect_dependencies`.
2. Tentukan batas pemisahan antara antarmuka (`index.html` / `src/`), skema data (`schema.sql`), dan utilitas logika.
3. Buat direktori yang diperlukan dengan `create_directory` lalu tulis implementasi lengkap melalui `write_file`.
4. Pastikan setiap formulir tervalidasi, elemen interaktif terhubung handler nyata, dan data persisten memakai endpoint `./api/<tabel>`.
5. Jalankan `validate_project` dan `build_project` (jika terdapat skrip build) untuk membuktikan hasil bebas error.

## Tool mapping
- `list_files`: Menginventarisasi file eksisting agar tidak menimpa komponen penting.
- `read_file`: Memeriksa konvensi gaya kode dan konfigurasi proyek.
- `create_directory`: Menyiapkan folder fitur baru.
- `write_file`: Menulis kode lengkap dan siap dijalankan.
- `validate_project`: Memastikan integritas `index.html`, `package.json`, dan `schema.sql`.
- `build_project`: Memverifikasi kompilasi aset/TypeScript.

## Verification
- `validate_project` lulus tanpa error dan tanpa placeholder starter.
- Jika proyek memiliki skrip build di `package.json`, `build_project` keluar dengan kode 0.

## Failure handling
- Jika `build_project` gagal karena dependensi atau kesalahan tipe, periksa detail error lalu perbaiki dengan `edit_file` dan ulangi verifikasi.
- Jika terdapat konflik besar yang tidak pulih, gunakan `rollback_checkpoint` dan laporkan penyebabnya.

## Safety constraints
- Dilarang menyematkan API key, token, atau kredensial hardcoded di file mana pun.
- Seluruh path harus relatif terhadap root workspace proyek.

## Examples
- "/code-generation Buat modul manajemen inventaris barang lengkap dengan schema.sql dan filter kategori"
