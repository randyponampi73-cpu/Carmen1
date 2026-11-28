---
name: llm-multi-provider-tool-calling
description: "Multi-provider LLM adapter engineering (Anthropic, OpenAI, Gemini, OpenRouter, Groq, OpenAI-compatible) with streaming tool calls, structured outputs, and smart failover."
category: ai-engineering
version: 1.0.0
tags: [llm, tool-calling, streaming, multi-provider, failover, ai]
frameworks: [typescript, nodejs]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["llm", "tool calling", "function calling", "multi-provider", "model fallback", "structured output", "ai adapter"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Provider stream normalized with abort propagation and secret scrubbing.", "Tool arguments validated strictly before execution.", "Error codes distinguish auth, rate-limit, quota, context-length, and outage."]
examples: ["Add structured error normalization and Retry-After parsing to LLM adapter", "Implement model identity enrichment across OpenRouter and Groq discovery"]
provenance_origin: community-inspired
source_repos: ["anthropics/skills", "agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Design normalized, reliable multi-provider LLM adapters supporting streaming text, validated tool calls, error classification, and transparent provider/model fallback.

## When to use
Use when building or debugging LLM provider adapters, tool-calling schemas, token usage metering, or automatic fallback routing.

## Required context
Inspect `server/providers/*`, `shared/modelIdentity.ts`, model catalog, and `server/agent/router.ts`.

## Workflow
1. Normalize every provider stream into a single canonical event union (`text_delta`, `tool_call`, `usage`, `truncated`, `error`, `done`).
2. Classify upstream errors accurately (`AUTH_INVALID`, `RATE_LIMIT`, `QUOTA_EXCEEDED`, `MODEL_NOT_FOUND`, `CONTEXT_TOO_LONG`, `PROVIDER_DOWN`) and respect `Retry-After` headers.
3. Validate tool call JSON arguments strictly before execution; repair or return structured tool error messages when models emit malformed arguments.
4. Separate Provider Identity (API platform) from Model Creator Identity (model vendor) across metadata and UI.
5. Scrub all API keys and auth headers from error strings before logging or streaming to clients.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Always pass `AbortSignal` into upstream `fetch` requests so user cancellation terminates billing immediately.
- Handle provider-specific quirks (Anthropic alternating roles/tool_result blocks, Gemini thought signatures, OpenAI SSE `[DONE]` framing) cleanly inside each adapter.
- Track token usage and cost estimates server-side from actual provider usage events.

## Anti-Patterns
- Retrying `AUTH_INVALID` (401/403) errors endlessly.
- Assuming every model on OpenRouter/Groq belongs to the router brand instead of the underlying creator.
- Swallowing truncation (`max_tokens`/`length` finish reason) silently without notifying the user.

## Security Considerations
Keep all provider API keys encrypted server-side or ephemeral per-request; never log raw keys or expose them in client bundles.

## Performance Considerations
Cache discovered model lists per key with bounded TTL and stream deltas immediately without buffering whole completions.

## Testing Strategy
Test each adapter SSE parser, tool-call accumulation, error normalization, and fallback routing with deterministic stub streams.

## Verification
- Provider stream normalized with abort propagation and secret scrubbing.
- Tool arguments validated strictly before execution.
- Error codes distinguish auth, rate-limit, quota, context-length, and outage.

## Checklist
- [ ] Provider stream normalized with abort propagation and secret scrubbing.
- [ ] Tool arguments validated strictly before execution.
- [ ] Error codes distinguish auth, rate-limit, quota, context-length, and outage.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Add structured error normalization and Retry-After parsing to LLM adapter
- Implement model identity enrichment across OpenRouter and Groq discovery

```ts
// Canonical error classification drives safe retry vs fallback decisions
if (err.code === 'RATE_LIMIT' || err.code === 'QUOTA_EXCEEDED' || err.code === 'PROVIDER_DOWN') {
  return routeToFallbackProvider(ctx, err);
}
```
