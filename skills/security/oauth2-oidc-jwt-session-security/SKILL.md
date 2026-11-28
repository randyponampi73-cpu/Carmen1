---
name: oauth2-oidc-jwt-session-security
description: "Authentication and session hardening covering OAuth 2.1 + PKCE, OIDC ID token verification, HttpOnly cookie sessions, JWT pitfalls, and key rotation."
category: security
version: 1.0.0
tags: [oauth2, oidc, jwt, sessions, authentication, security]
frameworks: [nodejs, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["oauth", "oauth2", "oidc", "pkce", "jwt", "session cookie", "refresh token", "key rotation"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Session cookies use HttpOnly and appropriate SameSite/Secure flags.", "OAuth flows enforce PKCE + verified state + exact redirect URI.", "Passwords use scrypt/argon2id and tokens are stored hashed."]
examples: ["Audit OAuth2 PKCE state validation and redirect URI handling", "Harden session storage to SHA-256 hashed tokens"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Eliminate authentication bypasses, token theft, CSRF, and session fixation across OAuth2/OIDC, JWT, and cookie-based session flows.

## When to use
Use when implementing or auditing login, OAuth/OIDC flows, session cookies, JWT verification, or password hashing.

## Required context
Inspect auth routes, session middleware, cookie flags, token hashing/signing, and secret configuration.

## Workflow
1. Store opaque session tokens as SHA-256 digests in the database and issue them via `HttpOnly`, `SameSite=Lax` (or `None; Secure` for cross-site iframes), `Secure` cookies.
2. For OAuth2/OIDC: require PKCE (`S256`), cryptographically random `state` and `nonce` bound to the user session, and strict redirect URI exact-match validation.
3. For JWTs: pin allowed signing algorithms (`RS256`/`EdDSA`/`HS256`), reject `alg: none`, verify `iss`, `aud`, `exp`, and `nbf`, and keep access tokens short-lived.
4. Hash passwords with `scrypt`/`argon2id` + per-user random salt and compare digests in constant time.
5. Write negative security tests for invalid tokens, expired sessions, tampered JWTs, and CSRF attempts.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Rotate session IDs immediately upon login or privilege elevation to prevent session fixation.
- Rate-limit login, registration, and password-reset endpoints per IP and account.
- Use generic login failure messages to prevent account enumeration.

## Anti-Patterns
- Storing long-lived bearer JWTs in `localStorage` where XSS can exfiltrate them permanently.
- Accepting unverified `jwt.decode()` payloads without cryptographic signature verification.
- Falling back to hardcoded default signing secrets in production.

## Security Considerations
Never log bearer tokens, OAuth authorization codes, refresh tokens, or raw session cookies.

## Performance Considerations
Cache JWKS public keys with bounded TTL and refresh on unknown `kid` with rate limiting.

## Testing Strategy
Test expired session rejection, invalid signature rejection, and cookie security flags.

## Verification
- Session cookies use `HttpOnly` and appropriate `SameSite`/`Secure` flags.
- OAuth flows enforce PKCE + verified `state` + exact redirect URI.
- Passwords use scrypt/argon2id and tokens are stored hashed.

## Checklist
- [ ] Session cookies use `HttpOnly` and appropriate `SameSite`/`Secure` flags.
- [ ] OAuth flows enforce PKCE + verified `state` + exact redirect URI.
- [ ] Passwords use scrypt/argon2id and tokens are stored hashed.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Audit OAuth2 PKCE state validation and redirect URI handling
- Harden session storage to SHA-256 hashed tokens

```ts
const tokenDigest = crypto.createHash('sha256').update(rawSessionToken).digest('hex');
// Store only tokenDigest in DB; compare cookies by hashing incoming token first
const session = await db.get('SELECT user_id, expires_at FROM sessions WHERE token = ?', tokenDigest);
```
