# CARMEN Skill Security Model & Threat Controls

**Classification:** Security Architecture Baseline  
**Enforcement Scope:** Built-in Skills, Created Skills, Imported ZIP Skills, Marketplace Skills, Skill Scripts

---

## 1. Security Posture: Zero-Trust External Instructions

Skills are treated strictly as **untrusted advisory playbooks**, never as privileged system code or policy overrides.

### Non-Negotiable Security Rules
1. **No Policy / Auth Bypass:** A Skill cannot grant permissions beyond the user's session authorization, disable CSRF checks, override project ownership, or unlock `ADMIN` capability.
2. **Forbidden Privilege Level:** `ADMIN` permission is rejected during parsing, validation, and runtime permission checking for all skills (`BUILTIN` and user-created alike).
3. **No Direct Host Filesystem Access:** Skills only map actions onto `AGENT_TOOLS` (`toolRegistry.ts`), which scope every read/write/edit/delete strictly through `normalizeProjectPath()` and tenant workspace isolation.
4. **Scripts Are Isolated & Non-Auto-Executing:**
   - Scripts bundled inside imported ZIPs or user-created skills are NEVER executed automatically upon import, discovery, or activation.
   - Any explicit script execution must go through `server/runtime/sandbox.ts` + `server/runtime/isolation.ts` (`docker`/`podman`/`unshare` namespace, `--network=none`, masked host `DATA_DIR`/source, `RLIMIT_*`, stripped secrets).
   - Imported skills start as `trust_level = 'UNTRUSTED'` and require explicit owner approval before script/mutating permissions (`WRITE`, `EXECUTE`, `NETWORK`, `DATABASE`, `DEPLOY`) are granted.
5. **Strict Multi-Tenant Isolation:** User `A`'s custom/imported skills, versions, approved permissions, and analytics rows are scoped by `user_id` and `project_id`. Cross-tenant read, modify, delete, enable, or execute attempts return `403`/`404`.
6. **Secret Protection:**
   - Skill content, execution logs, analytics errors, and ZIP exports pass through `scrubSecrets()` and plaintext secret pattern detectors.
   - API keys, `CARMEN_MASTER_KEY`, `SESSION_SECRET`, `.env` files, and database files are stripped from skill exports and child runtime environments.

---

## 2. Threat Matrix & Automated Controls

| Threat Vector | Mitigation Control | Module / Enforcement |
| :--- | :--- | :--- |
| **ZIP Slip (`../../etc/passwd`, `C:\...`)** | Normalize every entry name; reject absolute paths, `..` traversal, drive prefixes, backslashes, and null bytes. | `server/skills/validator.ts`, `importExport.ts` |
| **Symlink Escape inside ZIP** | Inspect ZIP `unixPermissions` `(perm & 0o170000) === 0o120000`; reject any archive containing symlinks before DB/FS write. | `server/skills/importExport.ts` |
| **Decompression / File Bomb** | Enforce `MAX_SKILL_ARCHIVE_FILES <= 64`, `MAX_SKILL_FILE_BYTES <= 128 KB`, `MAX_SKILL_TOTAL_BYTES <= 1 MB` using streaming chunk counters during extraction. | `server/skills/validator.ts`, `importExport.ts` |
| **Arbitrary / Malicious File Types** | Enforce strict allowlist (`SKILL.md`, `references/*.md|txt|json`, `scripts/*.sh|mjs|js|ts|py`, `assets/*.json|md|txt|svg|css`); block `.exe`, `.dll`, `.so`, `.bin`, `.jks`, `.env`, `.db`. | `server/skills/validator.ts` |
| **Prompt Injection inside `SKILL.md` / `references/`** | Deterministic pattern scanner detecting system-override phrases (`ignore previous instructions`, `reveal CARMEN_MASTER_KEY`, `exfiltrate process.env`, `bypass sandbox`, `disable auth`, `<system>` tag spoofing, hidden script/eval payload injection). Critical hits fail validation and block activation. | `server/skills/validator.ts` |
| **Privilege Escalation (`ADMIN` / Unapproved `EXECUTE`)** | Reject `ADMIN` in YAML schema; enforce explicit owner approval records per project for high-impact permissions (`WRITE`, `EXECUTE`, `NETWORK`, `DATABASE`, `DEPLOY`). | `server/skills/permissions.ts` |
| **SSRF via Remote Skill Marketplace** | Any external HTTPS catalog URL uses `safeOutboundFetch()` with IP pinning and private/metadata IP blocking (`127.0.0.1`, `169.254.169.254`, RFC1918, IPv6 mapped/NAT64). | `server/skills/marketplace.ts`, `server/security.ts` |
| **Hardcoded API Keys in Created/Imported Skills** | Scan all files inside skill package for Anthropic, OpenAI, OpenRouter, Gemini, Groq, Coarena, AWS, and PEM key signatures; reject or flag before activation. | `server/skills/validator.ts`, `creator.ts` |
| **Tenant Cross-Access (IDOR) & CSRF** | Every `/api/skills*` and `/api/projects/:id/skills*` route enforces `requireAuth`, owner verification, and Origin/`Sec-Fetch-Site` CSRF validation on mutations. | `server.ts` |
| **Runaway Skill Loops / Parallel Exhaustion** | Cap selected skills per turn (`<= 3`), composition chain length (`<= 5`), and retry count (`<= 1`) with deterministic cycle detection in DAG composer. | `server/skills/composer.ts`, `executor.ts` |
