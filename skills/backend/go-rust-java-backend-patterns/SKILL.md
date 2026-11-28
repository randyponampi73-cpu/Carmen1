---
name: go-rust-java-backend-patterns
description: "Compiled backend systems engineering patterns for Go (net/http, chi), Rust (Axum, Tokio, SQLx), and Java (Spring Boot 3) emphasizing concurrency safety and explicit error handling."
category: backend
version: 1.0.0
tags: [go, rust, java, spring-boot, axum, concurrency]
frameworks: [go, rust, java]
tools: [list_files, read_file, search_files, write_file, edit_file, run_command, run_tests, build_project]
permissions: [READ, WRITE, EXECUTE]
triggers: ["golang", "go backend", "rust", "axum", "tokio", "java", "spring boot"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["All I/O operations honor request context and explicit timeouts.", "No panics/unwraps or ignored errors on untrusted input paths.", "Native build and test suite pass cleanly."]
examples: ["Add graceful shutdown and context timeout to Go HTTP service", "Eliminate unwrap panics in Rust Axum API handler"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Engineer high-throughput, memory-safe, and cancellation-aware compiled backend services in Go, Rust, or Java Spring Boot.

## When to use
Use when building or debugging Go, Rust, or Java backend services, HTTP handlers, concurrency workers, or build pipelines.

## Required context
Read `go.mod`, `Cargo.toml`, or `pom.xml`/`build.gradle`, main server entrypoint, and existing handler/service packages.

## Workflow
1. Propagate cancellation contexts (`context.Context` in Go, `tokio::select!` / cancellation tokens in Rust, timeouts in Spring WebClient) across all I/O calls.
2. Return typed domain errors mapped centrally to HTTP status codes (never panic/unwrap on external input in Rust or swallow `err != nil` in Go).
3. Use parameterized queries (`database/sql` / `pgx`, `sqlx::query!`, Spring Data JPA / `JdbcTemplate`) with bounded connection pools.
4. Enforce explicit HTTP server read/write/idle timeouts and graceful shutdown hooks.
5. Compile and run native test suites (`go test -race ./...`, `cargo test`, `mvn test`).

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_command`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Run Go tests with `-race` to catch data races early.
- In Rust, prefer `thiserror`/`anyhow` and zero `.unwrap()` in production request handlers.
- In Spring Boot, use constructor injection and immutable Java `record` DTOs.

## Anti-Patterns
- Spawning unbounded goroutines or Tokio tasks without semaphore/worker-pool backpressure.
- Holding mutex locks across `.await` points or blocking network I/O.
- Exposing JPA entities directly in Spring `@RestController` responses.

## Security Considerations
Enforce strict TLS verification, constant-time token checks, explicit CORS allowlists, and non-root container execution.

## Performance Considerations
Pre-allocate slices/buffers on hot paths, reuse HTTP clients with keep-alive pools, and profile allocations before micro-optimizing.

## Testing Strategy
Include concurrency/race tests and table-driven unit tests for error and boundary cases.

## Verification
- All I/O operations honor request context and explicit timeouts.
- No panics/unwraps or ignored errors on untrusted input paths.
- Native build and test suite pass cleanly.

## Checklist
- [ ] All I/O operations honor request context and explicit timeouts.
- [ ] No panics/unwraps or ignored errors on untrusted input paths.
- [ ] Native build and test suite pass cleanly.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Add graceful shutdown and context timeout to Go HTTP service
- Eliminate unwrap panics in Rust Axum API handler

```go
func handleHealth(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
    defer cancel()
    if err := db.PingContext(ctx); err != nil {
        http.Error(w, "database unavailable", http.StatusServiceUnavailable)
        return
    }
    w.Header().Set("Content-Type", "application/json")
    _, _ = w.Write([]byte(`{"ok":true}`))
}
```
