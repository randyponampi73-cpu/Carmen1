---
name: system-design
description: Merancang arsitektur sistem end-to-end mencakup komponen, model data, antrean, caching, serta pola degradasi aman (fail-closed).
category: architecture
version: 1.0.0
tags: [system-design, blueprint, scalability, fault-tolerance, components]
tools: [list_files, read_file, search_files, write_file, update_project_memory, validate_project]
permissions: [READ, WRITE]
triggers: [system design, desain sistem, rancang sistem, blueprint, arsitektur baru]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project]
---

## Purpose
Menyusun rancangan sistem yang pragmatis dan selaras dengan kemampuan infrastruktur aktual (lokal maupun cloud), menghindari over-engineering serta dependensi fiktif.

## When to use
Gunakan ketika merencanakan aplikasi kompleks baru, memecah layanan besar, atau mendokumentasikan spesifikasi arsitektur sebelum implementasi kode.

## Required context
- Kebutuhan fungsional pengguna, struktur proyek yang ada (`list_files`), serta batasan lingkungan deployment.

## Workflow
1. Inspeksi workspace dan file arsitektur yang sudah ada lewat `list_files` dan `read_file`.
2. Tentukan batas domain, skema data, kontrak API, strategi konkurensi/state, dan mekanisme fallback saat komponen opsional tidak tersedia.
3. Jika diminta menulis spesifikasi (`ARCHITECTURE.md` atau modul kerangka), simpan via `write_file` dan ringkas keputusan inti di `update_project_memory`.
4. Validasi kebersihan proyek lewat `validate_project` bila ada file baru.

## Tool mapping
- `list_files` / `read_file`: Menyelaraskan rancangan baru dengan aset yang sudah tersedia.
- `write_file`: Menulis dokumen desain atau kerangka antarmuka.
- `update_project_memory`: Menyimpan keputusan arsitektur untuk giliran implementasi berikutnya.

## Verification
- Rancangan mencantumkan batasan eksplisit dan tidak bergantung pada layanan eksternal yang tidak tersedia tanpa jalur fallback.

## Failure handling
- Jika mode Diskusi aktif, sajikan rancangan lengkap dalam teks respons tanpa memodifikasi file workspace.

## Safety constraints
- Jangan mendesain alur yang bergantung pada secret sisi klien atau melewati batas isolasi tenant.

## Examples
- "/system-design Rancang arsitektur sistem antrean job ekspor laporan dengan fallback lokal yang aman"
