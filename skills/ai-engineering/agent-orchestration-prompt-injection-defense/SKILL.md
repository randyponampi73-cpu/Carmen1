---
name: agent-orchestration-prompt-injection-defense
description: "Autonomous coding agent orchestration (plan-act-verify-repair loops, tool sandboxing, step budgets) and layered defenses against direct and indirect prompt injection."
category: ai-engineering
version: 1.0.0
tags: [agent-orchestration, prompt-injection, sandboxing, evals, ai-safety]
frameworks: [typescript, nodejs]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["agent loop", "orchestrator", "prompt injection", "agent eval", "tool sandbox", "skill security"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Tool execution enforces sandbox, path, and permission boundaries in code.", "Verification gates reflect strictly real post-mutation tool outcomes.", "Adversarial prompt-injection and loop-breaker tests pass."]
examples: ["Harden agent orchestrator with evidence-backed verification stages", "Add indirect prompt-injection delimiter escaping to external skill loader"]
provenance_origin: community-inspired
source_repos: ["anthropics/skills", "agentskills/agentskills", "obra/superpowers"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Engineer reliable autonomous agents with explicit verification gates, bounded execution loops, least-privilege tool sandboxes, and strong prompt-injection boundaries.

## When to use
Use when designing or hardening AI agent orchestrators, tool registries, skill loaders, or agent safety evaluations.

## Required context
Read `server/agent/orchestrator.ts`, `server/agent/toolRegistry.ts`, `server/skills/validator.ts`, and `server/runtime/isolation.ts`.

## Workflow
1. Enforce explicit lifecycle stages: Inspect -> Plan -> Execute -> Verify -> Repair, with hard per-turn step limits and identical-failure loop breakers.
2. Separate trusted system instructions from untrusted external data (files, web content, imported skills) using escaped XML boundaries and explicit data-only notices.
3. Enforce least-privilege permissions and sandbox isolation at the tool-execution layer (never rely on prompt instructions alone for security!).
4. Require real post-mutation tool evidence (`build_project`, `run_tests`, `validate_project`) before reporting verification pass.
5. Maintain automated adversarial tests for prompt injection, privilege escalation, secret exfiltration, and tool abuse.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Execute consecutive pure read-only tools in parallel while serializing mutating and verification tools.
- Keep Agent Core fully operational even when optional skills fail or are disabled.
- Emit structured verification stage telemetry honestly reflecting real tool outcomes.

## Anti-Patterns
- Trusting LLM-generated paths or shell commands without sandbox and path-traversal enforcement.
- Granting unrestricted `ADMIN` permissions to dynamically loaded skills or plugins.
- Reporting task completion as verified when no build/test command actually passed after the final file edit.

## Security Considerations
Defense-in-depth is mandatory: prompt delimiters + static threat scanning + least-privilege permission gates + OS/filesystem sandboxing + secret scrubbing.

## Performance Considerations
Load skill metadata lazily (progressive disclosure) so idle skills consume zero prompt tokens.

## Testing Strategy
Run adversarial prompt-injection tests, loop-breaker tests, and skill-optional fallback tests.

## Verification
- Tool execution enforces sandbox, path, and permission boundaries in code.
- Verification gates reflect strictly real post-mutation tool outcomes.
- Adversarial prompt-injection and loop-breaker tests pass.

## Checklist
- [ ] Tool execution enforces sandbox, path, and permission boundaries in code.
- [ ] Verification gates reflect strictly real post-mutation tool outcomes.
- [ ] Adversarial prompt-injection and loop-breaker tests pass.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Harden agent orchestrator with evidence-backed verification stages
- Add indirect prompt-injection delimiter escaping to external skill loader

```ts
// Escape untrusted XML boundary tags before inserting external content into prompts
export function neutralizeBoundaryTags(raw: string): string {
  return raw.replace(/<\s*(\/?)\s*(system|developer|tool_call|skill_playbook)\b/gi, '&lt;$1$2');
}
```
