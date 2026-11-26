---
name: frontend-design
description: Merancang antarmuka web responsif dengan hierarki tipografi kuat, kontras WCAG AA, tata letak presisi, dan bebas template generik.
category: development
version: 1.0.0
tags: [ui, ux, frontend, css, tailwind, responsive, design]
tools: [list_files, read_file, write_file, edit_file, validate_project, build_project]
permissions: [READ, WRITE, EXECUTE]
triggers: [ui, ux, desain, tampilan, layout, responsif, frontend, halaman]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project]
---

## Purpose
Menghasilkan antarmuka web yang bersih, responsif di desktop maupun ponsel, mudah dibaca dengan kontras tinggi, serta memetakan setiap kontrol UI ke perilaku nyata.

## When to use
Gunakan ketika pengguna membangun atau memperbarui halaman web, dashboard, formulir interaktif, komponen React/CSS, atau memperbaiki masalah tata letak dan keterbacaan.

## Required context
- File `index.html`, stylesheet global (`src/index.css` atau CSS inline/eksternal), dan daftar komponen UI eksisting.
- Jenis perangkat target (web responsif atau Android Capacitor viewport mobile).

## Workflow
1. Baca `index.html` dan file style/komponen UI yang ada menggunakan `read_file`.
2. Tetapkan palet warna konsisten (dominan netral, permukaan terstruktur, 1 warna aksen utama), skala tipografi jelas, serta target sentuh minimal 40px.
3. Implementasikan komponen dan tata letak responsif dengan `write_file` atau `edit_file`, termasuk state loading, empty state, error state, dan validasi form.
4. Pastikan angka penting memakai `tabular-nums`, tidak ada tombol mati, dan tidak ada overflow horizontal.
5. Jalankan `validate_project` (dan `build_project` untuk proyek Vite/React) untuk memverifikasi hasil render bebas error.

## Tool mapping
- `read_file`: Memeriksa token CSS dan komponen UI yang sudah ada agar konsisten.
- `write_file`: Membuat halaman atau komponen antarmuka lengkap.
- `edit_file`: Memperbaiki tata letak, spacing, atau responsivitas pada file yang sudah ada.
- `validate_project`: Memastikan `index.html` valid dan tidak menyisakan starter placeholder.
- `build_project`: Memverifikasi bundel frontend sukses dikompilasi.

## Verification
- `validate_project` dan `build_project` (jika ada) berstatus sukses.
- Seluruh tombol/tautan penting terpasang handler nyata dan tata letak mendukung layar sempit (375px) maupun lebar (1280px+).

## Failure handling
- Jika CSS/JSX gagal dikompilasi saat build, baca pesan error compiler, perbaiki tag/kelas dengan `edit_file`, dan bangun ulang.

## Safety constraints
- Gunakan binding framework yang aman atau `textContent` untuk data pengguna; hindari `innerHTML` dengan input mentah.

## Examples
- "/frontend-design Perbarui tampilan dashboard keuangan agar responsif dengan tabel tabular-nums dan dark/light contrast tinggi"
