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
