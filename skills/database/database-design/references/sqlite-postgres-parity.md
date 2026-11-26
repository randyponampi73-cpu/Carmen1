# SQLite & PostgreSQL Schema Parity Guide

- Gunakan `TEXT` untuk ID string/UUID, `INTEGER` / `BIGINT` untuk angka bulat, dan `TEXT` ISO-8601 atau `TIMESTAMPTZ` untuk timestamp.
- Hindari ketergantungan pada perilaku implisit `rowid` pada query lintas-dialek; sediakan selalu kolom `PRIMARY KEY` eksplisit dan kolom `created_at`.
- Gunakan `CREATE INDEX IF NOT EXISTS` untuk mempercepat filter `WHERE` pada foreign key (`user_id`, `project_id`, `status`).
- Seluruh parameter query harus memakai placeholder (`?` pada klien abstraksi CARMEN yang otomatis ditranslasikan ke `$1..$n` untuk PostgreSQL).
