---
name: graphql-websocket-sse-engineering
description: "Real-time and flexible API engineering covering GraphQL (DataLoader, depth/cost limits), Server-Sent Events (SSE), and WebSockets with heartbeats and backpressure."
category: api
version: 1.0.0
tags: [graphql, websocket, sse, streaming, realtime]
frameworks: [graphql, nodejs, typescript, react]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["graphql", "websocket", "sse", "server-sent events", "streaming api", "dataloader"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["SSE endpoints disable proxy buffering and abort upstream work on close.", "WebSockets enforce auth, origin checks, heartbeats, and payload size caps.", "GraphQL enforces depth/complexity caps and per-request DataLoaders."]
examples: ["Harden SSE chat streaming endpoint with heartbeat and abort cleanup", "Add GraphQL query depth limit and per-request DataLoader"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Build resilient GraphQL, SSE, and WebSocket interfaces with strict resource caps, clean disconnection handling, and zero memory leaks.

## When to use
Use when implementing AI token streaming (SSE), collaborative WebSockets, or GraphQL schemas/resolvers.

## Required context
Inspect streaming endpoints, reverse proxy config (`Caddyfile`/Nginx), client SSE/WS hooks, or GraphQL schema.

## Workflow
1. For SSE: set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, send periodic heartbeat comments (`: ping`), and abort upstream work on `req.on("close")`.
2. For WebSockets: authenticate during handshake, enforce per-message size limits, implement ping/pong heartbeat liveness, and reconnect with exponential backoff + jitter on the client.
3. For GraphQL: enforce query depth & complexity limits, batch nested resolvers via per-request `DataLoader`, and disable introspection in locked-down production if required.
4. Handle partial disconnects and client aborts gracefully without uncaught stream write errors.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Use SSE over WebSockets for unidirectional server-to-client streaming (simpler auth, HTTP/2 multiplexing, proxy compatibility).
- Flush headers immediately (`res.flushHeaders()`) before starting async stream producers.
- Validate every incoming WebSocket JSON frame against a strict schema.

## Anti-Patterns
- Allowing unrestricted recursive GraphQL queries (DoS vector).
- Creating global `DataLoader` instances shared across requests (leaks cross-user cached data!).
- Forgetting to clear heartbeat intervals when a socket/SSE stream closes.

## Security Considerations
Validate WebSocket `Origin` headers against allowlist, authenticate every connection/subscription, and bound concurrent streams per user.

## Performance Considerations
Check `res.write()` backpressure and avoid buffering unbounded event histories in RAM.

## Testing Strategy
Test client disconnect cancellation, malformed frames, and heartbeat cleanup.

## Verification
- SSE endpoints disable proxy buffering and abort upstream work on close.
- WebSockets enforce auth, origin checks, heartbeats, and payload size caps.
- GraphQL enforces depth/complexity caps and per-request DataLoaders.

## Checklist
- [ ] SSE endpoints disable proxy buffering and abort upstream work on close.
- [ ] WebSockets enforce auth, origin checks, heartbeats, and payload size caps.
- [ ] GraphQL enforces depth/complexity caps and per-request DataLoaders.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Harden SSE chat streaming endpoint with heartbeat and abort cleanup
- Add GraphQL query depth limit and per-request DataLoader

```ts
res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
res.setHeader('Cache-Control', 'no-cache, no-transform');
res.setHeader('X-Accel-Buffering', 'no');
res.flushHeaders();
const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
req.on('close', () => { clearInterval(heartbeat); abortController.abort(); });
```
