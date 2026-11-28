import type { DatabaseSync } from 'node:sqlite';

export interface DbMigration {
  version: string;
  name: string;
  upSql: string;
  downSql?: string;
}

export const SQLITE_MIGRATIONS: DbMigration[] = [
  {
    version: '001_deployments_table',
    name: 'Add persistent deployments history table for Vercel, Netlify, Cloudflare Pages, and Self-Hosted targets',
    upSql: `
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        deployment_url TEXT,
        external_id TEXT,
        project_name TEXT NOT NULL,
        logs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
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
        project_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
    `,
    downSql: `
      DROP TABLE IF EXISTS project_handoff;
    `,
  },
  {
    version: '004_hash_session_tokens',
    name: 'Invalidate legacy plaintext session tokens before enforcing SHA-256 hashed session token storage',
    upSql: `
      DELETE FROM sessions;
    `,
    downSql: `
      SELECT 1;
    `,
  },
  {
    version: '005_shared_key_usage_metering',
    name: 'Add tokens_used and estimated_cost_usd metering columns to shared_key_usage',
    upSql: `
      CREATE TABLE IF NOT EXISTS shared_key_usage (
        user_id TEXT NOT NULL,
        usage_date TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, usage_date),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      ALTER TABLE shared_key_usage ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE shared_key_usage ADD COLUMN estimated_cost_usd REAL NOT NULL DEFAULT 0;
    `,
    downSql: `
      ALTER TABLE shared_key_usage DROP COLUMN estimated_cost_usd;
      ALTER TABLE shared_key_usage DROP COLUMN tokens_used;
    `,
  },
  {
    version: '006_skills_system',
    name: 'Add CARMEN Skill Intelligence System tables (skills, skill_versions, project_skill_configs, user_skill_preferences, skill_executions)',
    upSql: `
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL DEFAULT 'system',
        owner_user_id TEXT,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'builtin',
        trust_level TEXT NOT NULL DEFAULT 'BUILTIN',
        enabled INTEGER NOT NULL DEFAULT 1,
        current_version TEXT NOT NULL DEFAULT '1.0.0',
        manifest_json TEXT NOT NULL DEFAULT '{}',
        skill_md TEXT NOT NULL,
        references_json TEXT NOT NULL DEFAULT '{}',
        scripts_json TEXT NOT NULL DEFAULT '{}',
        assets_json TEXT NOT NULL DEFAULT '{}',
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(scope_key, slug),
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        version TEXT NOT NULL,
        skill_md TEXT NOT NULL,
        manifest_json TEXT NOT NULL DEFAULT '{}',
        references_json TEXT NOT NULL DEFAULT '{}',
        scripts_json TEXT NOT NULL DEFAULT '{}',
        assets_json TEXT NOT NULL DEFAULT '{}',
        checksum TEXT NOT NULL,
        changelog TEXT NOT NULL DEFAULT '',
        created_by_user_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS project_skill_configs (
        project_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        approved_permissions_json TEXT NOT NULL DEFAULT '[]',
        approved_by_user_id TEXT,
        approved_at TEXT,
        pinned_version TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, skill_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_skill_preferences (
        user_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        approved_permissions_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, skill_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS skill_executions (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        user_id TEXT,
        skill_id TEXT,
        skill_name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'auto',
        status TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',
        fallback_used INTEGER NOT NULL DEFAULT 0,
        tools_invoked_json TEXT NOT NULL DEFAULT '[]',
        error_summary TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
  {
    version: '007_skill_install_history',
    name: 'Add skill_install_history table for transparent skill install/enable/disable/update/import audit history',
    upSql: `
      CREATE TABLE IF NOT EXISTS skill_install_history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_slug TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        action TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1.0.0',
        source TEXT NOT NULL DEFAULT 'builtin',
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_skill_install_history_user ON skill_install_history(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_install_history_skill ON skill_install_history(skill_id, created_at);
    `,
    downSql: `
      DROP INDEX IF EXISTS idx_skill_install_history_skill;
      DROP INDEX IF EXISTS idx_skill_install_history_user;
      DROP TABLE IF EXISTS skill_install_history;
    `,
  },
];

export interface MigrationRunResult {
  applied: string[];
  alreadyApplied: string[];
  integrityOk: boolean;
}

export function runSqliteMigrations(database: DatabaseSync, migrations: DbMigration[] = SQLITE_MIGRATIONS): MigrationRunResult {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedRows = database
    .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
    .all() as Array<{ version: string }>;
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  const newlyApplied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const mig of migrations) {
    if (appliedSet.has(mig.version)) {
      alreadyApplied.push(mig.version);
      continue;
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(mig.upSql);
      database
        .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(mig.version, mig.name);
      database.exec('COMMIT');
      newlyApplied.push(mig.version);
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Ignore secondary rollback error
      }
      throw err;
    }
  }

  const integrityRow = database.prepare('PRAGMA integrity_check(1)').get() as
    | { integrity_check?: string }
    | undefined;
  const integrityOk = integrityRow?.integrity_check === 'ok';

  return { applied: newlyApplied, alreadyApplied, integrityOk };
}

export function rollbackLastSqliteMigration(
  database: DatabaseSync,
  migrations: DbMigration[] = SQLITE_MIGRATIONS
): { rolledBack: string | null } {
  const latest = database
    .prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1')
    .get() as { version: string } | undefined;
  if (!latest) return { rolledBack: null };

  const mig = migrations.find((m) => m.version === latest.version);
  if (!mig || !mig.downSql) {
    throw new Error(`Migrasi ${latest.version} tidak memiliki definisi rollback (downSql).`);
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(mig.downSql);
    database.prepare('DELETE FROM schema_migrations WHERE version = ?').run(mig.version);
    database.exec('COMMIT');
    return { rolledBack: mig.version };
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Ignore rollback error
    }
    throw err;
  }
}

export function checkSqliteIntegrity(database: DatabaseSync): { ok: boolean; detail: string } {
  const row = database.prepare('PRAGMA integrity_check(1)').get() as
    | { integrity_check?: string }
    | undefined;
  const detail = row?.integrity_check || 'unknown';
  return { ok: detail === 'ok', detail };
}

export interface TenantDatabaseIsolationStatus {
  engine: 'sqlite-isolated-file' | 'postgres-tenant-schema';
  tenantSchema: string;
  isolated: boolean;
  coreTablesSeparated: boolean;
}

export function getSqliteTenantIsolationStatus(projectId: string): TenantDatabaseIsolationStatus {
  const safe = String(projectId || '').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'default';
  return {
    engine: 'sqlite-isolated-file',
    tenantSchema: `tenant_${safe}`,
    isolated: true,
    coreTablesSeparated: true,
  };
}
