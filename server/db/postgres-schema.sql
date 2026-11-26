-- CARMEN Reference PostgreSQL Schema (Equivalent to SQLite local schema + migrations 001..003)
-- Note: CARMEN runtime executes against SQLite unless a PostgreSQL runtime driver is wired.
-- Apply reference DDL with: psql "$DATABASE_URL" -f server/db/postgres-schema.sql

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'id',
  theme TEXT NOT NULL DEFAULT 'dark',
  default_provider_key_id TEXT,
  default_model_id TEXT,
  fallback_provider_key_id TEXT,
  fallback_model_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, -- SHA-256 hex digest of raw session token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  key_last4 TEXT NOT NULL,
  tier_declared TEXT NOT NULL DEFAULT 'unknown',
  base_url TEXT,
  auth_header TEXT,
  chat_path TEXT,
  custom_models_json TEXT,
  extra_headers_enc TEXT,
  supports_tools TEXT NOT NULL DEFAULT 'unknown',
  supports_vision TEXT NOT NULL DEFAULT 'unknown',
  is_server_env BOOLEAN NOT NULL DEFAULT FALSE,
  last_test_status TEXT,
  last_test_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'web',
  stack TEXT NOT NULL,
  rules TEXT NOT NULL DEFAULT '',
  apk_config_json JSONB NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, path)
);

CREATE TABLE IF NOT EXISTS project_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  message_id TEXT,
  label TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'build',
  plan TEXT,
  tool_events_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider TEXT,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  estimated_cost_usd DOUBLE PRECISION,
  version_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS env_vars (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, key)
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'apk',
  status TEXT NOT NULL DEFAULT 'queued',
  config_json JSONB NOT NULL,
  logs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  artifact_path TEXT,
  download_token TEXT,
  artifact_size_bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  deployment_url TEXT,
  external_id TEXT,
  project_name TEXT NOT NULL,
  logs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shared_key_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

CREATE TABLE IF NOT EXISTS project_memory (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_handoff (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_project_files_project_id ON project_files(project_id);
CREATE INDEX IF NOT EXISTS idx_project_versions_project_id ON project_versions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_project_id ON messages(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_builds_project_id ON builds(project_id);
CREATE INDEX IF NOT EXISTS idx_deployments_project_id ON deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

INSERT INTO schema_migrations (version, name)
VALUES
  ('001_deployments_table', 'Add persistent deployments history table'),
  ('002_messages_created_at_index', 'Add composite index on messages(project_id, created_at)'),
  ('003_project_handoff', 'Add deterministic project_handoff table for cross-provider and multi-turn continuity'),
  ('004_tenant_schema_isolation', 'Provision strict per-project tenant_<id> PostgreSQL schema isolation separate from core platform tables'),
  ('005_hash_session_tokens', 'Store SHA-256 digest in sessions.token instead of plaintext tokens'),
  ('006_shared_key_usage_metering', 'Add tokens_used and estimated_cost_usd metering columns to shared_key_usage')
ON CONFLICT (version) DO NOTHING;

-- Core platform tables remain strictly in the platform schema (`users`, `sessions`, `projects`, `provider_keys`).
-- Project-generated application databases are provisioned in isolated schemas named `tenant_<safe_project_id>`.
CREATE OR REPLACE FUNCTION carmen_provision_tenant_schema(p_project_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_safe TEXT;
  v_schema TEXT;
BEGIN
  v_safe := regexp_replace(lower(coalesce(p_project_id, '')), '[^a-z0-9_]', '_', 'g');
  v_safe := trim(both '_' from left(v_safe, 48));
  IF v_safe = '' THEN
    RAISE EXCEPTION 'Invalid project id for tenant schema';
  END IF;
  v_schema := 'tenant_' || v_safe;
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', v_schema);
  EXECUTE format('COMMENT ON SCHEMA %I IS %L', v_schema, 'Isolated tenant application schema for CARMEN project ' || p_project_id);
  RETURN v_schema;
END;
$$;
