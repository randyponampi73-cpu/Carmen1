---
name: serverless-edge-object-storage
description: "Serverless/edge runtime engineering (Cloudflare Workers, Vercel Edge, AWS Lambda) and secure object storage (S3, R2, GCS) with presigned URLs and CDN caching."
category: cloud
version: 1.0.0
tags: [serverless, edge, s3, r2, gcs, object-storage, cdn]
frameworks: [cloudflare, aws, gcp]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, NETWORK]
triggers: ["serverless", "edge runtime", "lambda", "cloudflare workers", "s3", "r2", "gcs", "presigned url", "object storage"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["Storage buckets are private by default with tenant-scoped UUID keys.", "Presigned URLs enforce short TTL, exact MIME type, and size bounds.", "Edge functions use Web-standard APIs with lean bundles."]
examples: ["Implement presigned R2/S3 upload endpoint with MIME and size validation", "Add CDN caching headers for hashed static assets"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Design fast serverless/edge handlers and direct-to-storage upload pipelines using short-lived presigned URLs, strict content policies, and immutable CDN caching.

## When to use
Use when building edge functions, serverless APIs, or S3/R2/GCS file storage integrations.

## Required context
Inspect runtime constraints (Web Fetch API vs Node.js APIs), storage bucket config, and upload routes.

## Workflow
1. Verify runtime compatibility: Edge runtimes support Web Standard APIs (`fetch`, `crypto.subtle`, `ReadableStream`), not native Node `fs` or `child_process`.
2. Use short-lived presigned PUT/POST URLs with strict `Content-Type` and `Content-Length` constraints for client uploads to S3/R2/GCS.
3. Store objects under non-guessable tenant-scoped keys (`tenants/{tenantId}/{uuid}.{ext}`) and keep buckets private by default.
4. Use immutable `Cache-Control: public, max-age=31536000, immutable` only for content-hashed assets.
5. Minimize cold-start latency by keeping edge bundles lean and avoiding heavy top-level SDK imports.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Validate uploaded object metadata server-side before marking attachments active in the database.
- Set bucket lifecycle rules to purge abandoned multipart uploads and temporary exports.
- Use connection poolers (PgBouncer / Hyperdrive / RDS Proxy) when connecting serverless functions to PostgreSQL.

## Anti-Patterns
- Making entire S3/R2/GCS buckets public-read for private user documents.
- Proxying multi-hundred-MB file uploads through memory-constrained serverless functions.
- Opening a fresh unpooled PostgreSQL TCP connection on every Lambda invocation.

## Security Considerations
Scope presigned URLs to a single object key, exact MIME type, max byte size, and short expiry (<= 5 minutes).

## Performance Considerations
Keep edge functions under 1 MB compressed and cache read-only public metadata at the CDN layer.

## Testing Strategy
Test presigned URL generation parameters, expiry enforcement, and invalid MIME rejection.

## Verification
- Storage buckets are private by default with tenant-scoped UUID keys.
- Presigned URLs enforce short TTL, exact MIME type, and size bounds.
- Edge functions use Web-standard APIs with lean bundles.

## Checklist
- [ ] Storage buckets are private by default with tenant-scoped UUID keys.
- [ ] Presigned URLs enforce short TTL, exact MIME type, and size bounds.
- [ ] Edge functions use Web-standard APIs with lean bundles.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Implement presigned R2/S3 upload endpoint with MIME and size validation
- Add CDN caching headers for hashed static assets

```ts
export function buildSafeObjectKey(tenantId: string, ext: 'png' | 'webp' | 'pdf'): string {
  const safeTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, '');
  return `tenants/${safeTenant}/${crypto.randomUUID()}.${ext}`;
}
```
