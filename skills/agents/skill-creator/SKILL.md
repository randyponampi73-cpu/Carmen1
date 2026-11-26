---
name: skill-creator
description: Membantu merancang dan menulis paket Skill CARMEN baru (SKILL.md + references) sesuai standar Agent Skills dengan pemetaan AGENT_TOOLS valid.
category: agents
version: 1.0.0
tags: [skill, skill-md, agent-skills, template, creator]
tools: [list_files, read_file, create_directory, write_file, validate_project]
permissions: [READ, WRITE]
triggers: [buat skill, create skill, skill.md baru, skill-creator, authoring skill]
dependencies: []
conflicts: []
execution_mode: sequential
verification: [validate_project]
---

## Purpose
Membimbing pembuatan paket Skill baru berformat kebab-case yang bersih, modular, tervalidasi frontmatter-nya, dan hanya memetakan tools resmi CARMEN (`AGENT_TOOLS`).

## When to use
Gunakan hanya ketika pengguna meminta membuat paket `SKILL.md` baru, merancang skill kustom tim, atau mengonversi SOP menjadi Skill CARMEN.

## Required context
- Tujuan skill baru, kategori target (dari 8 kategori resmi), daftar tools CARMEN yang relevan, dan batas keamanannya.

## Workflow
1. Tentukan nama folder kebab-case (maks 64 karakter) dan pilih kategori yang sesuai.
2. Petakan hanya tool nyata dari registri `AGENT_TOOLS` serta permission minimum yang dibutuhkan (selalu tolak `ADMIN`).
3. Tulis `SKILL.md` lengkap berisi YAML frontmatter plus seluruh 9 bagian wajib (`Purpose`, `When to use`, `Required context`, `Workflow`, `Tool mapping`, `Verification`, `Failure handling`, `Safety constraints`, `Examples`) menggunakan `write_file`.
4. Tambahkan file panduan pendek di `references/` jika dibutuhkan (tanpa menyematkan binary atau secret).
5. Verifikasi struktur melalui `/skill-validator` atau `validate_project`.

## Tool mapping
- `create_directory`: Membuat folder paket skill atau subdirektori `references/`.
- `write_file`: Menulis berkas `SKILL.md` dan referensi terstruktur.
- `validate_project`: Memastikan tidak ada secret bocor di proyek.

## Verification
- Nama folder dan `name` frontmatter cocok persis dalam format kebab-case, deskripsi <= 1024 karakter, dan seluruh 9 bagian wajib terisi.

## Failure handling
- Jika tool yang diinginkan belum ada di registri CARMEN, catat kekurangannya secara eksplisit dan gunakan alternatif resmi atau usulkan implementasi tool aman.

## Safety constraints
- Skill yang dibuat hanya boleh bersifat instruksi workflow; dilarang keras menyisipkan prompt override, akses `.env`, atau izin `ADMIN`.

## Examples
- "/skill-creator Buat skill baru bernama accessibility-audit di kategori security dengan referensi WCAG"
