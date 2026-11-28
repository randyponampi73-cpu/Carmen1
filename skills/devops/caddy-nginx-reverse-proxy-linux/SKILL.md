---
name: caddy-nginx-reverse-proxy-linux
description: "Reverse proxy engineering for Caddy and Nginx (automatic TLS, SSE/WebSocket proxying, security headers, rate limits) and Linux systemd service hardening."
category: devops
version: 1.0.0
tags: [caddy, nginx, reverse-proxy, tls, linux, systemd]
frameworks: [caddy, nginx, linux]
tools: [list_files, read_file, search_files, write_file, edit_file, validate_project]
permissions: [READ, WRITE, DEPLOY]
triggers: ["caddy", "caddyfile", "nginx", "reverse proxy", "tls", "ssl", "systemd", "linux hardening"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["TLS and security headers enabled.", "SSE/WebSocket proxy buffering disabled cleanly.", "Express trust proxy matches actual proxy hop count."]
examples: ["Harden Caddyfile for SSE streaming and security headers", "Configure Nginx reverse proxy for WebSockets and static asset caching"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Configure secure, streaming-safe Caddy and Nginx reverse proxies and hardened Linux services for self-hosted production deployments.

## When to use
Use when editing `Caddyfile`, `nginx.conf`, TLS/HTTPS headers, SSE/WebSocket forwarding, or systemd unit files.

## Required context
Read `Caddyfile`, `docker-compose.yml`, server port/trust-proxy settings, and SSE/preview endpoints.

## Workflow
1. Configure automatic HTTPS/TLS 1.2+ with HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and appropriate CSP/frame headers.
2. Disable proxy response buffering (`flush_interval -1` in Caddy, `proxy_buffering off` in Nginx) for SSE streaming routes.
3. Forward accurate `X-Forwarded-For`, `X-Forwarded-Proto`, and `Host` headers and configure Express `trust proxy` explicitly to the trusted hop count.
4. Enforce upload body size caps (`request_body` / `client_max_body_size`) and compression for text/JSON/SVG assets.
5. Harden Linux systemd units with `NoNewPrivileges=true`, `ProtectSystem=strict`, and dedicated non-root service user.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `validate_project`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Separate static asset caching rules (`/assets/*`, `/logos/*`) from dynamic `/api/*` no-store routes.
- Set explicit upstream connect/read timeouts for long-running AI streams.
- Keep access logs structured without logging sensitive query strings.

## Anti-Patterns
- Enabling Nginx response buffering on `/api/*/chat` SSE routes (delays token streaming until completion).
- Setting Express `trust proxy` to `true` blindly on directly internet-exposed Node servers (allows IP spoofing).
- Exposing internal database or worker ports on `0.0.0.0`.

## Security Considerations
Terminate TLS at the reverse proxy, bind backend app ports to private bridge/loopback interfaces, and strip `Server` version banners.

## Performance Considerations
Enable HTTP/2 + HTTP/3 (Caddy), gzip/zstd compression for static bundles, and keep-alive upstream pools.

## Testing Strategy
Validate Caddyfile/Nginx syntax and verify SSE streaming flushes chunks immediately.

## Verification
- TLS and security headers enabled.
- SSE/WebSocket proxy buffering disabled cleanly.
- Express `trust proxy` matches actual proxy hop count.

## Checklist
- [ ] TLS and security headers enabled.
- [ ] SSE/WebSocket proxy buffering disabled cleanly.
- [ ] Express `trust proxy` matches actual proxy hop count.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Harden Caddyfile for SSE streaming and security headers
- Configure Nginx reverse proxy for WebSockets and static asset caching

```caddyfile
app.example.com {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    -Server
  }
  reverse_proxy app:3000 {
    flush_interval -1
  }
}
```
