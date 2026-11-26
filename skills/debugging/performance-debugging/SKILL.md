---
name: performance-debugging
description: Mengidentifikasi bottleneck performa, query lambat, loop mahal, memory leak, dan render berulang pada aplikasi web maupun backend.
category: debugging
version: 1.0.0
tags: [performance, latency, optimization, bottleneck, memory]
tools: [list_files, read_file, search_files, edit_file, read_logs, run_tests, build_project]
permissions: [READ, WRITE, EXECUTE]
triggers: [lambat, performa, performance, bottleneck, latency, berat, memory leak]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [build_project, run_tests]
---

## Purpose
Menemukan sumber kelambatan nyata (query N+1, pemrosesan sinkron berulang, listener bocor, bundel berlebih, atau re-render tidak perlu) dan menerapkan optimasi terukur tanpa mengorbankan kebenaran logika.

## When to use
Gunakan saat pengguna mengeluhkan UI terasa patah-patah, respons API lambat, pemakaian memori meningkat, atau waktu build membengkak.

## Required context
- Modul frontend/backend terdampak, log eksekusi (`read_logs`), dan skema SQL (`schema.sql`).

## Workflow
1. Inventarisasi titik panas pada komponen UI, loop pemrosesan, atau query database dengan `search_files` dan `read_file`.
2. Periksa pola N+1 query, missing `CREATE INDEX`, timer/subscription tanpa cleanup, serta bundel besar.
3. Terapkan optimasi spesifik (batching, indeks SQL, memoization seperlunya, cleanup listener) lewat `edit_file`.
4. Verifikasi tidak ada error kompilasi atau regresi fungsional dengan `build_project` dan `run_tests`.

## Tool mapping
- `search_files`: Menemukan pola loop query, `setInterval`, atau render mahal.
- `read_file`: Mengaudit kompleksitas algoritma dan siklus hidup komponen.
- `edit_file`: Menerapkan perbaikan performa terfokus.
- `run_tests` / `build_project`: Memastikan optimasi tidak merusak perilaku aplikasi.

## Verification
- Kompilasi dan pengujian lulus setelah optimasi diterapkan.
- Perubahan performa dijelaskan berdasarkan kompleksitas atau jumlah query sebelum vs sesudah.

## Failure handling
- Jika optimasi menimbulkan ketidakkonsistenan data atau error tipe, batalkan patch dan verifikasi kembali kontrak state.

## Safety constraints
- Jangan menonaktifkan validasi atau kontrol keamanan demi mempercepat eksekusi.

## Examples
- "/performance-debugging Optimalkan query laporan penjualan bulanan dan tambahkan indeks yang sesuai"
