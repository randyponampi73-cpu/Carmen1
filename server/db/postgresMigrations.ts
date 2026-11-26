import fs from 'node:fs';
import path from 'node:path';
import type { AsyncDbClient } from './client';
import type { DbMigration, MigrationRunResult } from './migrations';

export const POSTGRES_MIGRATIONS: DbMigration[] = [
  {
    version: '001_deployments_table',
    name: 'Add persistent deployments history table for Vercel, Netlify, Cloudflare Pages, and Self-Hosted targets',
    upSql: `
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
      CREATE INDEX IF NOT EXISTS idx_deployments_project_id ON deployments(project_id);
    `,
    downSql: `
      DROP INDEX IF EXISTS idx_deployments_project_id;
      DROP TABLE IF EXISTS deployments;
    `,
  },
  {
    version: '002_messages_created_at_index',
    name: 'Add composite index on messages(project_id, created_at) for fast recent history queries',
    upSql: `
      CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project_id, created_at);
    `,
    downSql: `
      DROP INDEX IF EXISTS idx_messages_project_created;
    `,
  },
  {
    version: '003_project_handoff',
    name: 'Add deterministic project_handoff table for cross-provider and multi-turn continuity',
    upSql: `
      CREATE TABLE IF NOT EXISTS project_handoff (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
    downSql: `
      DROP TABLE IF EXISTS project_handoff;
    `,
  },
  {
    version: '004_tenant_schema_isolation',
    name: 'Provision strict per-project tenant_<id> PostgreSQL schema isolation separate from core platform tables',
    upSql: `
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
    `,
    downSql: `
      DROP FUNCTION IF EXISTS carmen_provision_tenant_schema(TEXT);
    `,
  },
  {
    version: '005_hash_session_tokens',
    name: 'Invalidate legacy plaintext session tokens and enforce SHA-256 digest in sessions.token',
    upSql: `
      DELETE FROM sessions;
    `,
    downSql: `
      SELECT 1;
    `,
  },
  {
    version: '006_shared_key_usage_metering',
    name: 'Add tokens_used and estimated_cost_usd metering columns to shared_key_usage',
    upSql: `
      ALTER TABLE shared_key_usage ADD COLUMN IF NOT EXISTS tokens_used BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE shared_key_usage ADD COLUMN IF NOT EXISTS estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0;
    `,
    downSql: `
      SELECT 1;
    `,
  },
  {
    version: '007_skills_system',
    name: 'Add CARMEN Skill Intelligence System tables (skills, skill_versions, project_skill_configs, user_skill_preferences, skill_executions)',
    upSql: `
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL DEFAULT 'system',
        owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'builtin',
        trust_level TEXT NOT NULL DEFAULT 'BUILTIN',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        current_version TEXT NOT NULL DEFAULT '1.0.0',
        manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        skill_md TEXT NOT NULL,
        references_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        scripts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        assets_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        checksum TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(scope_key, slug)
      );

      CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        skill_md TEXT NOT NULL,
        manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        references_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        scripts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        assets_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        checksum TEXT NOT NULL,
        changelog TEXT NOT NULL DEFAULT '',
        created_by_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS project_skill_configs (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        approved_permissions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        approved_by_user_id TEXT,
        approved_at TIMESTAMPTZ,
        pinned_version TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, skill_id)
      );

      CREATE TABLE IF NOT EXISTS user_skill_preferences (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        approved_permissions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, skill_id)
      );

      CREATE TABLE IF NOT EXISTS skill_executions (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        skill_id TEXT,
        skill_name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'auto',
        status TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',
        fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
        tools_invoked_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        error_summary TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_skills_owner ON skills(owner_user_id, category);
      CREATE INDEX IF NOT EXISTS idx_skills_slug ON skills(slug);
      CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_id ON skill_versions(skill_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_executions_project ON skill_executions(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_executions_user ON skill_executions(user_id, created_at);
    `,
    downSql: `
      DROP INDEX IF EXISTS idx_skill_executions_user;
      DROP INDEX IF EXISTS idx_skill_executions_project;
      DROP INDEX IF EXISTS idx_skill_versions_skill_id;
      DROP INDEX IF EXISTS idx_skills_slug;
      DROP INDEX IF EXISTS idx_skills_owner;
      DROP TABLE IF EXISTS skill_executions;
      DROP TABLE IF EXISTS user_skill_preferences;
      DROP TABLE IF EXISTS project_skill_configs;
      DROP TABLE IF EXISTS skill_versions;
      DROP TABLE IF EXISTS skills;
    `,
  },
];

export async function runPostgresMigrations(
  client: AsyncDbClient,
  migrations: DbMigration[] = POSTGRES_MIGRATIONS
): Promise<MigrationRunResult> {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const appliedRows = await client.all<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version ASC'
  );
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  const newlyApplied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const mig of migrations) {
    if (appliedSet.has(mig.version)) {
      alreadyApplied.push(mig.version);
      continue;
    }

    await client.transaction(async (tx) => {
      await tx.exec(mig.upSql);
      await tx.run('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', mig.version, mig.name);
    });
    newlyApplied.push(mig.version);
  }

  const health = await client.healthCheck();
  return {
    applied: newlyApplied,
    alreadyApplied,
    integrityOk: health.ok,
  };
}

export async function rollbackLastPostgresMigration(
  client: AsyncDbClient,
  migrations: DbMigration[] = POSTGRES_MIGRATIONS
): Promise<{ rolledBack: string | null }> {
  const latest = await client.get<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1'
  );
  if (!latest) return { rolledBack: null };

  const mig = migrations.find((m) => m.version === latest.version);
  if (!mig || !mig.downSql) {
    throw new Error(`Migrasi PostgreSQL ${latest.version} tidak memiliki definisi rollback (downSql).`);
  }

  await client.transaction(async (tx) => {
    await tx.exec(mig.downSql!);
    await tx.run('DELETE FROM schema_migrations WHERE version = $1', mig.version);
  });

  return { rolledBack: mig.version };
}

export async function bootstrapPostgresDatabase(
  client: AsyncDbClient,
  schemaFilePath = path.resolve(process.cwd(), 'server/db/postgres-schema.sql')
): Promise<MigrationRunResult> {
  if (!fs.existsSync(schemaFilePath)) {
    throw new Error(`File skema PostgreSQL tidak ditemukan: ${schemaFilePath}`);
  }
  const schemaSql = fs.readFileSync(schemaFilePath, 'utf8');
  await client.transaction(async (tx) => {
    await tx.exec(schemaSql);
  });
  return await runPostgresMigrations(client, POSTGRES_MIGRATIONS);
}
