---
name: architecture-review
description: Mengevaluasi arsitektur aplikasi secara menyeluruh (modularitas, batas tanggung jawab, skalabilitas, dan ketahanan kegagalan).
category: architecture
version: 1.0.0
tags: [architecture, review, modularity, scalability, trade-offs]
tools: [list_files, read_file, search_files, inspect_dependencies, validate_project, update_project_memory]
permissions: [READ, WRITE]
triggers: [architecture review, tinjau arsitektur, evaluasi arsitektur, struktur proyek]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: [validate_project]
---

## Purpose
Menyajikan penilaian arsitektur berbasis kode nyata: memetakan komponen, alur data, dependensi tersembunyi, risiko single-point-of-failure, serta rekomendasi perbaikan bertahap tanpa membangun ulang sistem yang sudah baik.

## When to use
Gunakan pada mode Diskusi atau sebelum perubahan besar untuk memahami dampak lintas modul dan menyelaraskan keputusan teknis.

## Required context
- Daftar file (`list_files`), dependensi (`inspect_dependencies`), dan entry point utama aplikasi.

## Workflow
1. Petakan modul UI, API, database, dan runtime memakai `list_files` dan `inspect_dependencies`.
2. Baca entry point dan lapisan abstraksi inti menggunakan `read_file` dan `search_files`.
3. Identifikasi coupling ketat, akses sinkron yang menghalangi skalabilitas, dan batas otorisasi antar lapisan.
4. Simpan ringkasan keputusan arsitektur (tanpa secret) via `update_project_memory` bila relevan untuk kelanjutan proyek.

## Tool mapping
- `list_files` / `search_files`: Memetakan topologi modul proyek.
- `read_file`: Memverifikasi kontrak antar lapisan secara langsung.
- `inspect_dependencies`: Meninjau dependensi eksternal.
- `update_project_memory`: Mencatat keputusan arsitektur penting lintas giliran.

## Verification
- Setiap klaim tentang arsitektur merujuk path file aktual yang telah dibaca.

## Failure handling
- Bedakan secara tegas antara fakta yang dibaca langsung di kode dan asumsi atau komponen yang tidak tersedia di lingkungan.

## Safety constraints
- Dalam mode diskusi atau tinjauan, jangan memodifikasi kode sumber aplikasi maupun menyimpan rahasia ke project memory.

## Examples
- "/architecture-review Evaluasi pemisahan lapisan database dan runtime pratinjau proyek ini"
