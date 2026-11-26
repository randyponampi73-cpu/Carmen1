# OWASP Audit Checklist (CARMEN Projects)

1. **Injection (SQL / Command)**:
   - Pastikan seluruh query memakai placeholder terparameterisasi (`?` atau `$1`), bukan interpolasi string.
   - Pastikan perintah runtime tidak menerima input pengguna mentah via shell.
2. **Broken Access Control (IDOR / Missing Auth)**:
   - Setiap endpoint private wajib memverifikasi identitas pengguna dan kepemilikan resource (`owner_id = user.id`).
3. **Cross-Site Scripting (XSS)**:
   - Hindari `innerHTML` / `dangerouslySetInnerHTML` untuk string pengguna; gunakan binding aman / `textContent`.
4. **SSRF & Path Traversal**:
   - Validasi URL tujuan agar tidak menuju localhost/IP privat dan normalisasi path relatif terhadap direktori proyek.
5. **Sensitive Data Exposure**:
   - Jangan simpan API key atau rahasia di file frontend atau repository; gunakan environment variables server-side.
