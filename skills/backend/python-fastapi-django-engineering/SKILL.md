---
name: python-fastapi-django-engineering
description: "Production Python backend engineering with FastAPI (async, Pydantic v2, SQLAlchemy) and Django (ORM, DRF, migrations, security middleware)."
category: backend
version: 1.0.0
tags: [python, fastapi, django, pydantic, sqlalchemy]
frameworks: [python, fastapi, django]
tools: [list_files, read_file, search_files, write_file, edit_file, run_command, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["python", "fastapi", "django", "pydantic", "sqlalchemy", "pytest", "uvicorn"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Response schemas explicitly whitelist exposed fields.", "No blocking network/DB calls inside async def handlers.", "Migrations and pytest suite pass cleanly."]
examples: ["Create async FastAPI CRUD router with Pydantic v2 validation", "Fix Django ORM N+1 query with prefetch_related"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Build strongly typed, async-safe Python web services using FastAPI or Django with clean dependency injection, safe ORM queries, and reproducible migrations.

## When to use
Use when implementing Python backend APIs, Pydantic schemas, SQLAlchemy/Django models, or pytest test suites.

## Required context
Read `pyproject.toml` or `requirements.txt`, app factory, settings module, and existing migrations.

## Workflow
1. Define explicit Pydantic v2 request/response models (or DRF serializers) separating input DTOs from database models.
2. Keep async FastAPI endpoints non-blocking: use async DB drivers (`asyncpg`/`aiosqlite`) or offload blocking I/O to threadpool (`def` routes).
3. Prevent N+1 queries with `selectinload`/`joinedload` (SQLAlchemy) or `select_related`/`prefetch_related` (Django).
4. Manage schema changes strictly through Alembic or Django migrations with reversible downgrades.
5. Run `pytest`, `ruff` / `mypy` where configured to verify typing and runtime behavior.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_command`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Use dependency injection (`Depends`) for DB sessions, auth principals, and config objects.
- Pin dependency ranges cleanly in `pyproject.toml` / lockfiles.
- Configure `pydantic-settings` to fail fast on missing critical environment variables.

## Anti-Patterns
- Calling synchronous `requests.get()` or blocking DB drivers inside `async def` FastAPI routes.
- Returning raw ORM instances without response models (risks leaking password hashes or internal columns).
- Using mutable default arguments (`def fn(items=[]):`) in Python functions.

## Security Considerations
Never use `eval`, `exec`, `pickle.loads`, or `yaml.load` (use `yaml.safe_load`) on untrusted input; use ORM parameterization and constant-time digest comparison (`hmac.compare_digest`).

## Performance Considerations
Configure connection pool sizes (`pool_size`, `max_overflow`, `pool_pre_ping=True`) and use bulk inserts for batch operations.

## Testing Strategy
Use `pytest` with transactional rollback fixtures and FastAPI `TestClient` / `httpx.AsyncClient`.

## Verification
- Response schemas explicitly whitelist exposed fields.
- No blocking network/DB calls inside `async def` handlers.
- Migrations and `pytest` suite pass cleanly.

## Checklist
- [ ] Response schemas explicitly whitelist exposed fields.
- [ ] No blocking network/DB calls inside `async def` handlers.
- [ ] Migrations and `pytest` suite pass cleanly.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Create async FastAPI CRUD router with Pydantic v2 validation
- Fix Django ORM N+1 query with prefetch_related

```python
from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException

class CreateTaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)

@router.post("/tasks", status_code=201)
async def create_task(payload: CreateTaskIn, user=Depends(get_current_user), db=Depends(get_db)):
    return await task_service.create(db, owner_id=user.id, title=payload.title.strip())
```
