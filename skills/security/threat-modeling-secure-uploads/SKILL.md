---
name: threat-modeling-secure-uploads
description: "STRIDE threat modeling, secure file/archive upload handling (magic-byte MIME checks, ZIP Slip & decompression bomb limits), and secret vault hygiene."
category: security
version: 1.0.0
tags: [threat-modeling, stride, file-upload, zip-slip, secrets]
frameworks: [nodejs, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["threat model", "stride", "file upload", "zip slip", "zip bomb", "secret vault", "encryption"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Upload byte limits, extension allowlists, and safe filenames enforced.", "ZIP imports block traversal, symlinks, nested archives, and decompression bombs.", "Secrets encrypted with AES-256-GCM and scrubbed from logs."]
examples: ["Threat-model and harden skill ZIP importer against ZIP Slip and bombs", "Audit AES-GCM secret vault key handling and log scrubbing"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Systematically enumerate attack surfaces with STRIDE and harden file uploads, archive extraction, and encrypted secret storage against abuse.

## When to use
Use when adding file/ZIP import/export features, designing secret vaults, or conducting pre-release threat reviews.

## Required context
Inspect upload routes, ZIP extraction utilities, encryption helpers, and storage paths.

## Workflow
1. Map assets, trust boundaries, entrypoints, and STRIDE threats (Spoofing, Tampering, Repudiation, Info Disclosure, DoS, Elevation of Privilege).
2. For uploads: enforce max byte size, strict extension + magic-byte content validation, randomized storage filenames, and non-executable storage.
3. For ZIP/tar imports: reject absolute paths, `..` traversal (ZIP Slip), symlinks, nested archives, excessive file count, and high compression ratio (ZIP bombs).
4. For secrets: encrypt at rest with authenticated encryption (`AES-256-GCM`) with unique IVs, fail closed when master key is missing, and scrub secrets from logs/errors.
5. Verify every threat mitigation with negative test cases.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Serve user-uploaded files with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` (or on a separate sandboxed origin).
- Never include uploaded filenames unsanitized in shell commands or HTTP `Content-Disposition` headers.
- Rotate encryption keys with versioned ciphertext prefixes.

## Anti-Patterns
- Trusting client-supplied `Content-Type` header alone for upload validation.
- Extracting ZIP archives directly to disk with `unzip` before inspecting every entry header.
- Logging decrypted API keys or full environment dumps on error.

## Security Considerations
Enforce hard caps on both compressed upload size AND cumulative uncompressed bytes during archive parsing.

## Performance Considerations
Stream large uploads with byte-counter aborts so oversized payloads terminate early before exhausting RAM.

## Testing Strategy
Test ZIP Slip (`../../etc/passwd`), oversized archive, nested `.zip`, and invalid MIME payloads.

## Verification
- Upload byte limits, extension allowlists, and safe filenames enforced.
- ZIP imports block traversal, symlinks, nested archives, and decompression bombs.
- Secrets encrypted with AES-256-GCM and scrubbed from logs.

## Checklist
- [ ] Upload byte limits, extension allowlists, and safe filenames enforced.
- [ ] ZIP imports block traversal, symlinks, nested archives, and decompression bombs.
- [ ] Secrets encrypted with AES-256-GCM and scrubbed from logs.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Threat-model and harden skill ZIP importer against ZIP Slip and bombs
- Audit AES-GCM secret vault key handling and log scrubbing

```ts
if (entryName.startsWith('/') || entryName.includes('\\') || entryName.split('/').includes('..')) {
  throw new Error('Blocked unsafe archive entry path');
}
```
