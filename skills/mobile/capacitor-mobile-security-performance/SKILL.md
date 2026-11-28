---
name: capacitor-mobile-security-performance
description: "Hybrid mobile engineering guidance for user apps built with Capacitor: typed native plugin bridges, WebView security hardening, secure storage, and 60fps mobile UI."
category: mobile
version: 1.0.0
tags: [capacitor, mobile, webview, hybrid-app, mobile-security]
frameworks: [capacitor, react, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, build_project]
permissions: [READ, WRITE, EXECUTE]
triggers: ["capacitor", "webview", "mobile bridge", "mobile security", "hybrid mobile"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["Native plugin calls wrapped with safe web fallbacks.", "WebView navigation allowlist and HTTPS-only policy enforced.", "No secrets stored in plaintext local storage."]
examples: ["Wrap Capacitor Share and Storage plugins with typed web fallbacks", "Audit Capacitor config for WebView security and deep-link validation"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Guide clean architecture, WebView security, and smooth 60fps rendering when users build standalone hybrid mobile projects with Capacitor.

## When to use
Use when a user explicitly asks to build or optimize a Capacitor-based mobile app inside their workspace project.

## Required context
Inspect `capacitor.config.*`, `package.json`, frontend build output directory, and native plugin wrappers.

## Workflow
1. Abstract Capacitor plugin calls behind thin platform-guarded TypeScript adapters (`Capacitor.isNativePlatform()`) with graceful web fallbacks.
2. Harden WebView configuration: disallow cleartext HTTP in production, lock `allowNavigation` to trusted HTTPS origins, and disable remote debugging in release builds.
3. Store sensitive tokens only in OS-backed Keychain/Keystore plugins — never in plaintext `localStorage` or unencrypted preferences.
4. Optimize mobile UI performance: animate `transform`/`opacity` only, avoid heavy box-shadows on scrolling lists, and virtualize long feeds.
5. Verify web bundle build and TypeScript contracts cleanly.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Handle hardware back button and deep-link app URL events cleanly in one central lifecycle hook.
- Gracefully degrade native haptics/camera/share calls when previewed in desktop browsers.
- Keep offline state synced cleanly with conflict-safe retries.

## Anti-Patterns
- Calling native Capacitor plugins unconditionally without web fallback checks.
- Allowing arbitrary external URLs inside the privileged app WebView.
- Storing API keys or auth refresh tokens in plaintext preferences.

## Security Considerations
Restrict WebView navigation allowlists, enforce HTTPS/TLS, and validate deep-link parameters strictly before routing.

## Performance Considerations
Minimize main-thread layout thrashing and keep bundle parse time low on mid-range mobile CPUs.

## Testing Strategy
Unit-test plugin adapter wrappers with web fallback mocks and verify responsive WebView layout in mobile Chromium.

## Verification
- Native plugin calls wrapped with safe web fallbacks.
- WebView navigation allowlist and HTTPS-only policy enforced.
- No secrets stored in plaintext local storage.

## Checklist
- [ ] Native plugin calls wrapped with safe web fallbacks.
- [ ] WebView navigation allowlist and HTTPS-only policy enforced.
- [ ] No secrets stored in plaintext local storage.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Wrap Capacitor Share and Storage plugins with typed web fallbacks
- Audit Capacitor config for WebView security and deep-link validation

```ts
export async function copyToClipboardSafe(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  return false;
}
```
