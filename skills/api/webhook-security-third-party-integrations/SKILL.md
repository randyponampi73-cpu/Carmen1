---
name: webhook-security-third-party-integrations
description: "Secure outbound and inbound third-party integrations: HMAC webhook signature verification, replay protection, timeouts, circuit breakers, and SSRF safety."
category: api
version: 1.0.0
tags: [webhooks, hmac, integrations, resilience, ssrf]
frameworks: [nodejs, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, NETWORK, EXECUTE]
triggers: ["webhook", "hmac", "stripe webhook", "third-party api", "circuit breaker", "replay attack"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Raw body preserved for constant-time HMAC verification.", "Replay timestamp tolerance and event-ID deduplication enforced.", "Outbound fetches enforce timeouts, size caps, and SSRF guards."]
examples: ["Implement HMAC-verified GitHub/Stripe webhook endpoint", "Add timeout, Retry-After handling, and SSRF guard to external API client"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Guarantee authenticity, replay safety, and fault isolation when consuming inbound webhooks or calling external third-party APIs.

## When to use
Use when implementing Stripe/GitHub/payment webhooks or integrating external SaaS REST APIs.

## Required context
Inspect raw body middleware, outbound fetch helpers (`safeOutboundFetch`), secret storage, and webhook routes.

## Workflow
1. Capture the exact raw request bytes before JSON parsing so HMAC-SHA256 signature verification matches the sender byte-for-byte.
2. Verify signatures using `crypto.timingSafeEqual` and reject timestamps older than a tight tolerance window (e.g. 5 minutes).
3. Persist processed webhook event IDs so retried deliveries are idempotent and return `200 OK` quickly.
4. For outbound calls: enforce strict connect/read timeouts, bounded response sizes, retry only on 429/5xx respecting `Retry-After`, and SSRF URL validation.
5. Scrub API tokens and Authorization headers from all logs and error responses.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Acknowledge verified webhooks rapidly and offload heavy processing to async workers when possible.
- Use separate signing secrets per environment (dev/staging/prod).
- Track outbound failure streaks with circuit breakers to avoid thread/socket exhaustion.

## Anti-Patterns
- Comparing webhook signatures with `===` instead of constant-time comparison.
- Parsing JSON first and re-stringifying to verify HMAC (breaks signature verification).
- Calling external APIs without `AbortSignal.timeout(...)`.

## Security Considerations
Never allow user-supplied outbound webhook URLs to target private/loopback/metadata IP ranges; validate DNS resolution before connecting.

## Performance Considerations
Keep webhook HTTP handlers under 2 seconds response time to prevent sender retry storms.

## Testing Strategy
Write tests for valid signature, tampered body, expired timestamp, and duplicate event replay.

## Verification
- Raw body preserved for constant-time HMAC verification.
- Replay timestamp tolerance and event-ID deduplication enforced.
- Outbound fetches enforce timeouts, size caps, and SSRF guards.

## Checklist
- [ ] Raw body preserved for constant-time HMAC verification.
- [ ] Replay timestamp tolerance and event-ID deduplication enforced.
- [ ] Outbound fetches enforce timeouts, size caps, and SSRF guards.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Implement HMAC-verified GitHub/Stripe webhook endpoint
- Add timeout, Retry-After handling, and SSRF guard to external API client

```ts
import crypto from 'node:crypto';
export function verifyHmacSignature(rawBody: Buffer, signatureHex: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signatureHex, 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
```
