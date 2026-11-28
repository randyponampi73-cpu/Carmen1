import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAsyncDbClient, type AsyncDbClient } from './db/client';
import { runSqliteMigrations } from './db/migrations';
import { getDatabaseDriverStatus, getRequestedDbDriver, type CarmenDbDriver } from './db/postgres';
import { bootstrapPostgresDatabase } from './db/postgresMigrations';
import { createRepositories } from './db/repositories';
import { hashPassword, sha256 } from './security';
import { PROJECT_TEMPLATES } from './templates/projectTemplates';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');
export const DB_PATH = process.env.CARMEN_DB_PATH || path.join(DEFAULT_DATA_DIR, 'carmen.db');
export const DATA_DIR = path.dirname(path.resolve(DB_PATH));
export const SANDBOX_DIR = path.join(DATA_DIR, 'sandboxes');
export const ARTIFACT_DIR = path.join(DATA_DIR, 'artifacts');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SANDBOX_DIR, { recursive: true });
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

export const ACTIVE_DB_DRIVER: CarmenDbDriver = getRequestedDbDriver(process.env);

function openLocalSqliteDb(): DatabaseSync {
  const sqlite = new DatabaseSync(DB_PATH);
  try {
    sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA synchronous = NORMAL;');
    sqlite.exec('PRAGMA temp_store = MEMORY;');
  } catch {
    // Fallback cleanly to default journal mode on filesystems that do not support WAL locking
  }
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');
  return sqlite;
}

const rawSqliteDb: DatabaseSync | null = ACTIVE_DB_DRIVER === 'sqlite' ? openLocalSqliteDb() : null;

export const db: DatabaseSync =
  rawSqliteDb ??
  (new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'close') {
          return () => {};
        }
        throw new Error(
          `Akses sinkron SQLite db.${String(prop)} dilarang saat CARMEN_DB_DRIVER=postgres; gunakan asyncDb atau repositories.`
        );
      },
    }
  ) as unknown as DatabaseSync);

export const asyncDb: AsyncDbClient = createAsyncDbClient({
  sqliteDb: rawSqliteDb ?? undefined,
  env: process.env,
});

export const repositories = createRepositories(asyncDb);

export function getDatabaseCapabilities() {
  return getDatabaseDriverStatus(process.env);
}

/**
 * Executes a multi-step database mutation atomically inside a synchronous SQLite transaction.
 */
export function runInTransaction<T>(fn: () => T): T {
  if (!rawSqliteDb) {
    throw new Error('runInTransaction() sinkron hanya tersedia untuk driver SQLite; gunakan asyncDb.transaction().');
  }
  rawSqliteDb.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    rawSqliteDb.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      rawSqliteDb.exec('ROLLBACK');
    } catch {
      // Ignore secondary rollback error
    }
    throw err;
  }
}

export function cleanupExpiredSessions(): number {
  if (!rawSqliteDb) return 0;
  const nowIso = new Date().toISOString();
  const info = rawSqliteDb.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso);
  rawSqliteDb.prepare('DELETE FROM magic_link_tokens WHERE expires_at < ?').run(nowIso);
  return Number(info.changes || 0);
}

export async function cleanupExpiredSessionsAsync(): Promise<number> {
  const nowIso = new Date().toISOString();
  const res = await asyncDb.run('DELETE FROM sessions WHERE expires_at < ?', nowIso);
  await asyncDb.run('DELETE FROM magic_link_tokens WHERE expires_at < ?', nowIso);
  return res.changes;
}

export function initDatabase(): void {
  if (!rawSqliteDb) {
    throw new Error('initDatabase() sinkron dipanggil saat CARMEN_DB_DRIVER=postgres; gunakan await initDatabaseAsync().');
  }
  rawSqliteDb.exec(`
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, -- SHA-256 hex digest of raw session token
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS magic_link_tokens (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS provider_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
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
      is_server_env INTEGER NOT NULL DEFAULT 0,
      last_test_status TEXT,
      last_test_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'web',
      stack TEXT NOT NULL,
      rules TEXT NOT NULL DEFAULT '',
      apk_config_json TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, path),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      message_id TEXT,
      label TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'build',
      plan TEXT,
      tool_events_json TEXT NOT NULL DEFAULT '[]',
      provider TEXT,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      estimated_cost_usd REAL,
      version_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS env_vars (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, key),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS builds (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'apk',
      status TEXT NOT NULL DEFAULT 'queued',
      config_json TEXT NOT NULL,
      logs_json TEXT NOT NULL DEFAULT '[]',
      artifact_path TEXT,
      download_token TEXT,
      artifact_size_bytes INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_memory (
      project_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shared_key_usage (
      user_id TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, usage_date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
    CREATE INDEX IF NOT EXISTS idx_project_files_project_id ON project_files(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_versions_project_id ON project_versions(project_id);
    CREATE INDEX IF NOT EXISTS idx_messages_project_id ON messages(project_id);
    CREATE INDEX IF NOT EXISTS idx_builds_project_id ON builds(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  `);

  runSqliteMigrations(rawSqliteDb);
  cleanupExpiredSessions();
  seedDemoWorkspace();
}

let dbInitPromise: Promise<void> | null = null;

export async function initDatabaseAsync(): Promise<void> {
  if (ACTIVE_DB_DRIVER === 'sqlite') {
    initDatabase();
    return;
  }
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const { PostgresAsyncDbClient } = await import('./db/client');
      const { parsePostgresConfig } = await import('./db/postgres');
      const pgCfg = parsePostgresConfig(process.env);
      if (pgCfg?.directConnectionString) {
        const directClient = new PostgresAsyncDbClient(pgCfg, { useDirectUrl: true });
        try {
          await bootstrapPostgresDatabase(directClient);
        } finally {
          await directClient.close().catch(() => {});
        }
      } else {
        await bootstrapPostgresDatabase(asyncDb);
      }
      await cleanupExpiredSessionsAsync();
      await seedDemoWorkspaceAsync();
    })();
  }
  return await dbInitPromise;
}

export async function closeDatabaseAsync(): Promise<void> {
  await asyncDb.close();
}

function buildDemoSeedData() {
  const userId = 'usr_demo_carmen';
  const demoPassword =
    process.env.CARMEN_DEMO_PASSWORD && process.env.CARMEN_DEMO_PASSWORD.trim().length >= 6
      ? process.env.CARMEN_DEMO_PASSWORD.trim()
      : crypto.randomBytes(24).toString('hex');
  return { userId, passwordHash: hashPassword(demoPassword) };
}

export function seedDemoWorkspace(): void {
  if (!rawSqliteDb) return;
  const existing = rawSqliteDb.prepare('SELECT id FROM users WHERE email = ?').get('dev@carmen.app') as
    | { id: string }
    | undefined;
  if (existing) {
    ensureServerGeminiKey(existing.id);
    return;
  }

  const { userId, passwordHash } = buildDemoSeedData();

  runInTransaction(() => {
    rawSqliteDb
      .prepare(`INSERT INTO users (id, email, password_hash, name, locale, theme) VALUES (?, ?, ?, ?, 'id', 'dark')`)
      .run(userId, 'dev@carmen.app', passwordHash, 'Raka Pratama');

    ensureServerGeminiKey(userId);

    for (const tpl of PROJECT_TEMPLATES.slice(0, 1)) {
      const projectId = 'prj_todo_sqlite';
      rawSqliteDb
        .prepare(
          `INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(projectId, userId, tpl.name, tpl.type, tpl.stack, tpl.defaultRules, '{}');

      const snapshot: Record<string, string> = {};
      for (const [filePath, content] of Object.entries(tpl.files)) {
        rawSqliteDb
          .prepare(`INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`)
          .run(crypto.randomUUID(), projectId, filePath, content, sha256(content));
        snapshot[filePath] = content;
      }

      const versionId = `ver_${projectId}_1`;
      const msgId = `msg_${projectId}_1`;

      rawSqliteDb
        .prepare(`INSERT INTO project_versions (id, project_id, message_id, label, snapshot_json) VALUES (?, ?, ?, ?, ?)`)
        .run(versionId, projectId, msgId, 'Versi 1 — Inisialisasi proyek', JSON.stringify(snapshot));

      const userPrompt = 'Buat aplikasi todo dengan database SQLite dan filter prioritas.';

      rawSqliteDb
        .prepare(`INSERT INTO messages (id, project_id, role, content, mode) VALUES (?, ?, 'user', ?, 'build')`)
        .run(`msg_${projectId}_0`, projectId, userPrompt);

      const toolEvents = Object.keys(tpl.files).map((filePath, idx) => ({
        id: `act_${idx}`,
        tool: 'write_file',
        target: filePath,
        status: 'success',
        detail: `${tpl.files[filePath].length} karakter ditulis`,
      }));

      rawSqliteDb
        .prepare(
          `INSERT INTO messages (id, project_id, role, content, mode, plan, tool_events_json, provider, model, tokens_in, tokens_out, version_id)
           VALUES (?, ?, 'assistant', ?, 'build', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          msgId,
          projectId,
          'Proyek aplikasi Todo fullstack telah dibuat lengkap dengan frontend, API CRUD, dan skema tabel SQLite `todos`. Preview dan tab Database siap digunakan.',
          '1. Siapkan skema tabel SQLite todos\n2. Bangun antarmuka daftar tugas dengan filter prioritas\n3. Hubungkan operasi tambah, ubah status, dan hapus ke API',
          JSON.stringify(toolEvents),
          'gemini',
          'gemini-4-hydrogen',
          420,
          980,
          versionId
        );
    }
  });
}

export async function seedDemoWorkspaceAsync(): Promise<void> {
  const existing = await asyncDb.get<{ id: string }>('SELECT id FROM users WHERE email = ?', 'dev@carmen.app');
  if (existing) {
    ensureServerGeminiKey(existing.id);
    return;
  }

  const { userId, passwordHash } = buildDemoSeedData();

  await asyncDb.transaction(async (tx) => {
    const inside = await tx.get<{ id: string }>('SELECT id FROM users WHERE email = ?', 'dev@carmen.app');
    if (inside) return;

    await tx.run(
      `INSERT INTO users (id, email, password_hash, name, locale, theme) VALUES (?, ?, ?, ?, 'id', 'dark')`,
      userId,
      'dev@carmen.app',
      passwordHash,
      'Raka Pratama'
    );

    ensureServerGeminiKey(userId);

    for (const tpl of PROJECT_TEMPLATES.slice(0, 1)) {
      const projectId = 'prj_todo_sqlite';
      await tx.run(
        `INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        userId,
        tpl.name,
        tpl.type,
        tpl.stack,
        tpl.defaultRules,
        '{}'
      );

      const snapshot: Record<string, string> = {};
      for (const [filePath, content] of Object.entries(tpl.files)) {
        await tx.run(
          `INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          projectId,
          filePath,
          content,
          sha256(content)
        );
        snapshot[filePath] = content;
      }

      const versionId = `ver_${projectId}_1`;
      const msgId = `msg_${projectId}_1`;

      await tx.run(
        `INSERT INTO project_versions (id, project_id, message_id, label, snapshot_json) VALUES (?, ?, ?, ?, ?)`,
        versionId,
        projectId,
        msgId,
        'Versi 1 — Inisialisasi proyek',
        JSON.stringify(snapshot)
      );

      const userPrompt = 'Buat aplikasi todo dengan database SQLite dan filter prioritas.';

      await tx.run(
        `INSERT INTO messages (id, project_id, role, content, mode) VALUES (?, ?, 'user', ?, 'build')`,
        `msg_${projectId}_0`,
        projectId,
        userPrompt
      );

      const toolEvents = Object.keys(tpl.files).map((filePath, idx) => ({
        id: `act_${idx}`,
        tool: 'write_file',
        target: filePath,
        status: 'success',
        detail: `${tpl.files[filePath].length} karakter ditulis`,
      }));

      await tx.run(
        `INSERT INTO messages (id, project_id, role, content, mode, plan, tool_events_json, provider, model, tokens_in, tokens_out, version_id)
         VALUES (?, ?, 'assistant', ?, 'build', ?, ?, ?, ?, ?, ?, ?)`,
        msgId,
        projectId,
        'Proyek aplikasi Todo fullstack telah dibuat lengkap dengan frontend, API CRUD, dan skema tabel SQLite `todos`. Preview dan tab Database siap digunakan.',
        '1. Siapkan skema tabel SQLite todos\n2. Bangun antarmuka daftar tugas dengan filter prioritas\n3. Hubungkan operasi tambah, ubah status, dan hapus ke API',
        JSON.stringify(toolEvents),
        'gemini',
        'gemini-4-hydrogen',
        420,
        980,
        versionId
      );
    }
  });
}

export function isSharedGeminiEnabled(): boolean {
  const envKey = (process.env.GEMINI_API_KEY || '').trim();
  return Boolean(envKey && envKey !== 'MY_GEMINI_API_KEY');
}

export function ensureServerGeminiKey(_userId: string): void {
  // Platform .env keys (GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, COARENA_API_KEY)
  // are resolved dynamically by server/providers/index.ts with user BYOK keys always taking priority.
}
