import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import {
  PostgresAsyncDbClient,
  SqliteAsyncDbClient,
  testPostgresConnection,
  type PgPoolClientLike,
  type PgPoolLike,
} from './client';
import {
  isForeignKeyError,
  isUniqueConstraintError,
  parseJsonColumn,
  toBooleanFlag,
  toIsoTimestamp,
  translateSqliteToPostgres,
} from './dialect';
import { runSqliteMigrations } from './migrations';
import { buildTenantSchemaProvisionSql, getDatabaseDriverStatus, parsePostgresConfig } from './postgres';
import {
  POSTGRES_MIGRATIONS,
  rollbackLastPostgresMigration,
  runPostgresMigrations,
} from './postgresMigrations';
import { createRepositories } from './repositories';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-pg-compat-'));

function initSqliteTestDb(dbPath: string): DatabaseSync {
  const database = new DatabaseSync(dbPath);
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(`
    CREATE TABLE users (
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
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'web',
      stack TEXT NOT NULL,
      rules TEXT NOT NULL DEFAULT '',
      apk_config_json TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE project_files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, path)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  runSqliteMigrations(database);
  return database;
}

/**
 * In-memory stateful PostgreSQL pool double verifying real `$1..$n` parameter binding,
 * dedicated PoolClient checkout, BEGIN/COMMIT/ROLLBACK, JSONB objects, boolean columns,
 * `SET LOCAL search_path`, and PostgreSQL SQLSTATE error codes (23505 / 23503).
 */
function createStatefulMockPgPool() {
  const executedSql: string[] = [];
  const appliedMigrations = new Map<string, { version: string; name: string; applied_at: Date }>();
  const users = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const projects = new Map<string, Record<string, unknown>>();
  const projectFiles = new Map<string, Record<string, unknown>>();
  const handoffs = new Map<string, Record<string, unknown>>();
  const deployments = new Map<string, Record<string, unknown>>();
  const txLogs: string[] = [];

  async function runQuery(text: string, values: unknown[] = []) {
    const trimmed = text.trim();
    executedSql.push(trimmed);

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(trimmed)) {
      txLogs.push(trimmed.toUpperCase());
      return { rows: [], rowCount: 0 };
    }
    if (/^SELECT\s+1\s+AS\s+ok/i.test(trimmed)) {
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }
    if (/^CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS|^SET\s+LOCAL\s+search_path/i.test(trimmed)) {
      return { rows: [], rowCount: 0 };
    }
    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+schema_migrations/i.test(trimmed)) {
      return { rows: [], rowCount: 0 };
    }
    if (/^SELECT\s+version\s+FROM\s+schema_migrations\s+ORDER\s+BY\s+version\s+ASC/i.test(trimmed)) {
      const rows = Array.from(appliedMigrations.values())
        .sort((a, b) => a.version.localeCompare(b.version))
        .map((m) => ({ version: m.version }));
      return { rows, rowCount: rows.length };
    }
    if (/^SELECT\s+version\s+FROM\s+schema_migrations\s+ORDER\s+BY\s+applied_at\s+DESC/i.test(trimmed)) {
      const rows = Array.from(appliedMigrations.values()).sort((a, b) => b.version.localeCompare(a.version));
      return { rows: rows.length > 0 ? [{ version: rows[0].version }] : [], rowCount: rows.length > 0 ? 1 : 0 };
    }
    if (/^INSERT\s+INTO\s+schema_migrations/i.test(trimmed)) {
      const [version, name] = values as [string, string];
      appliedMigrations.set(version, { version, name, applied_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (/^DELETE\s+FROM\s+schema_migrations\s+WHERE\s+version\s*=\s*\$1/i.test(trimmed)) {
      const version = String(values[0]);
      const deleted = appliedMigrations.delete(version);
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }
    if (/^INSERT\s+INTO\s+users/i.test(trimmed)) {
      const [id, email, passwordHash, name] = values as [string, string, string, string];
      const normEmail = email.trim().toLowerCase();
      for (const u of users.values()) {
        if (String(u.email).toLowerCase() === normEmail) {
          const err = new Error('duplicate key value violates unique constraint "users_email_key"') as Error & {
            code?: string;
          };
          err.code = '23505';
          throw err;
        }
      }
      const row = {
        id,
        email: normEmail,
        password_hash: passwordHash,
        name,
        locale: 'id',
        theme: 'dark',
        default_provider_key_id: null,
        default_model_id: null,
        fallback_provider_key_id: null,
        fallback_model_id: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      };
      users.set(id, row);
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT\s+\*\s+FROM\s+users\s+WHERE\s+id\s*=\s*\$1/i.test(trimmed)) {
      const row = users.get(String(values[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/^SELECT\s+\*\s+FROM\s+users\s+WHERE\s+lower\(trim\(email\)\)\s*=\s*\$1/i.test(trimmed)) {
      const clean = String(values[0]).trim().toLowerCase();
      const row = Array.from(users.values()).find((u) => String(u.email).toLowerCase() === clean);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/^INSERT\s+INTO\s+sessions/i.test(trimmed)) {
      const [token, userId, expiresAt] = values as [string, string, string];
      if (!users.has(userId)) {
        const err = new Error('insert or update on table "sessions" violates foreign key constraint') as Error & {
          code?: string;
        };
        err.code = '23503';
        throw err;
      }
      sessions.set(token, { token, user_id: userId, expires_at: new Date(expiresAt), created_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT\s+user_id,\s*expires_at\s+FROM\s+sessions\s+WHERE\s+token\s*=\s*\$1/i.test(trimmed)) {
      const row = sessions.get(String(values[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/^DELETE\s+FROM\s+sessions\s+WHERE\s+token\s*=\s*\$1/i.test(trimmed)) {
      const deleted = sessions.delete(String(values[0]));
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }
    if (/^INSERT\s+INTO\s+projects/i.test(trimmed)) {
      const [id, userId, name, type, stack, rules, apkJson] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      projects.set(id, {
        id,
        user_id: userId,
        name,
        type,
        stack,
        rules,
        apk_config_json: JSON.parse(apkJson), // simulate native PG JSONB object return
        archived: false, // simulate native PG BOOLEAN
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT\s+\*\s+FROM\s+projects\s+WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i.test(trimmed)) {
      const row = projects.get(String(values[0]));
      if (row && row.user_id === values[1]) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/^SELECT\s+\*\s+FROM\s+projects\s+WHERE\s+id\s*=\s*\$1$/i.test(trimmed)) {
      const row = projects.get(String(values[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/^SELECT\s+\*\s+FROM\s+projects\s+WHERE\s+user_id\s*=\s*\$1/i.test(trimmed)) {
      const includeArchived = !/archived\s*=\s*FALSE/i.test(trimmed);
      const userId = String(values[0]);
      const limit = Number(values[1] ?? 50);
      const offset = Number(values[2] ?? 0);
      const filtered = Array.from(projects.values())
        .filter((p) => p.user_id === userId && (includeArchived || p.archived === false))
        .slice(offset, offset + limit);
      return { rows: filtered, rowCount: filtered.length };
    }
    if (/^UPDATE\s+projects\s+SET\s+archived\s*=\s*\$1/i.test(trimmed)) {
      const [archived, projectId, userId] = values as [boolean, string, string];
      const row = projects.get(projectId);
      if (row && row.user_id === userId) {
        row.archived = Boolean(archived);
        row.updated_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/^INSERT\s+INTO\s+project_files/i.test(trimmed)) {
      const [id, projectId, filePath, content, hash] = values as [string, string, string, string, string];
      const key = `${projectId}:${filePath}`;
      projectFiles.set(key, { id, project_id: projectId, path: filePath, content, hash, updated_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT\s+path\s+FROM\s+project_files\s+WHERE\s+project_id\s*=\s*\$1/i.test(trimmed)) {
      const projectId = String(values[0]);
      const rows = Array.from(projectFiles.values())
        .filter((f) => f.project_id === projectId)
        .sort((a, b) => String(a.path).localeCompare(String(b.path)))
        .map((f) => ({ path: f.path }));
      return { rows, rowCount: rows.length };
    }
    if (/^UPDATE\s+project_files|^UPDATE\s+projects\s+SET\s+updated_at\s*=\s*NOW\(\)/i.test(trimmed)) {
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT\s+INTO\s+project_handoff/i.test(trimmed)) {
      const [projectId, content] = values as [string, string];
      handoffs.set(projectId, { project_id: projectId, content, updated_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT\s+content\s+FROM\s+project_handoff/i.test(trimmed)) {
      const row = handoffs.get(String(values[0]));
      return { rows: row ? [{ content: row.content }] : [], rowCount: row ? 1 : 0 };
    }
    if (/^INSERT\s+INTO\s+deployments/i.test(trimmed)) {
      const [id, projectId, target, status, deploymentUrl, externalId, projectName, logsJson, createdAt] =
        values as [string, string, string, string, string | null, string | null, string, string, string];
      deployments.set(id, {
        id,
        project_id: projectId,
        target,
        status,
        deployment_url: deploymentUrl,
        external_id: externalId,
        project_name: projectName,
        logs_json: JSON.parse(logsJson), // native PG JSONB
        created_at: new Date(createdAt),
      });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT\s+id,\s*project_id,\s*target/i.test(trimmed)) {
      const projectId = String(values[0]);
      const rows = Array.from(deployments.values()).filter((d) => d.project_id === projectId);
      return { rows, rowCount: rows.length };
    }
    if (/^SELECT\s+\*\s+FROM\s+todos/i.test(trimmed)) {
      return { rows: [{ id: 1, title: 'Tenant row' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  let releasedCount = 0;
  const pool: PgPoolLike = {
    async query(text, values) {
      return (await runQuery(text, values)) as never;
    },
    async connect(): Promise<PgPoolClientLike> {
      return {
        async query(text, values) {
          return (await runQuery(text, values)) as never;
        },
        release() {
          releasedCount += 1;
        },
      };
    },
    async end() {
      // noop
    },
  };

  return { pool, executedSql, txLogs, getReleasedCount: () => releasedCount, appliedMigrations };
}

describe('PostgreSQL Compatibility Layer & Dual-Mode Repositories', () => {
  let sqliteDb: DatabaseSync;

  before(() => {
    sqliteDb = initSqliteTestDb(path.join(tempDir, 'compat.db'));
  });

  after(() => {
    try {
      sqliteDb.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('translates SQLite queries to PostgreSQL cleanly while preserving literals, identifiers, and comments', () => {
    const raw = `
      -- keep ? inside comment and datetime('now') in comment
      SELECT id, "col?name", '?' AS q
      FROM projects
      WHERE user_id = ? AND archived = 0 AND created_at > datetime('now', '-7 days')
      ORDER BY updated_at DESC, rowid DESC
      LIMIT ?
    `;
    const pgSql = translateSqliteToPostgres(raw);
    assert.match(pgSql, /\$1/);
    assert.match(pgSql, /\$2/);
    assert.doesNotMatch(pgSql, /WHERE user_id = \?/);
    assert.match(pgSql, /"-- keep \?|keep \? inside comment"/i.test(pgSql) ? /keep \? inside comment/ : /keep \? inside comment/);
    assert.match(pgSql, /"col\?name"/);
    assert.match(pgSql, /'\?' AS q/);
    assert.match(pgSql, /archived = FALSE/);
    assert.match(pgSql, /\(NOW\(\) - INTERVAL '7 days'\)/);
    assert.doesNotMatch(pgSql, /,\s*rowid\s+DESC/i);
    assert.match(pgSql, /ORDER BY updated_at DESC/);

    const rowidOnly = translateSqliteToPostgres('SELECT * FROM messages ORDER BY rowid ASC');
    assert.equal(rowidOnly, 'SELECT * FROM messages ORDER BY created_at ASC');
  });

  it('normalizes JSON/JSONB columns, boolean flags, timestamps, and unique/FK errors across dialects', () => {
    assert.deepEqual(parseJsonColumn('{"a":1}', {}), { a: 1 });
    assert.deepEqual(parseJsonColumn({ a: 2 }, {}), { a: 2 });
    assert.deepEqual(parseJsonColumn('not-json', { fallback: true }), { fallback: true });

    assert.equal(toBooleanFlag(1), true);
    assert.equal(toBooleanFlag(0), false);
    assert.equal(toBooleanFlag(true), true);
    assert.equal(toBooleanFlag('t'), true);

    assert.equal(toIsoTimestamp('2026-03-01 12:30:00'), '2026-03-01T12:30:00Z');
    assert.equal(toIsoTimestamp(new Date('2026-03-01T12:30:00.000Z')), '2026-03-01T12:30:00.000Z');

    assert.equal(isUniqueConstraintError({ code: '23505' }), true);
    assert.equal(isUniqueConstraintError({ code: 'ERR_SQLITE_CONSTRAINT_UNIQUE' }), true);
    assert.equal(isForeignKeyError({ code: '23503' }), true);
    assert.equal(isForeignKeyError({ code: 'ERR_SQLITE_CONSTRAINT_FOREIGNKEY' }), true);
  });

  it('runs migrations, rollback, tenant schema isolation, and transaction release on PostgresAsyncDbClient', async () => {
    const mock = createStatefulMockPgPool();
    const cfg = parsePostgresConfig({ DATABASE_URL: 'postgresql://carmen:pw@localhost:5432/carmen', PGSSLMODE: 'disable' })!;
    const pgClient = new PostgresAsyncDbClient(cfg, { poolFactory: () => mock.pool });

    const health = await pgClient.healthCheck();
    assert.equal(health.ok, true);
    assert.equal(health.dialect, 'postgres');

    const mig1 = await runPostgresMigrations(pgClient, POSTGRES_MIGRATIONS);
    assert.equal(mig1.integrityOk, true);
    assert.equal(mig1.applied.length, POSTGRES_MIGRATIONS.length);

    const mig2 = await runPostgresMigrations(pgClient, POSTGRES_MIGRATIONS);
    assert.deepEqual(mig2.applied, []);
    assert.equal(mig2.alreadyApplied.length, POSTGRES_MIGRATIONS.length);

    const rolled = await rollbackLastPostgresMigration(pgClient, POSTGRES_MIGRATIONS);
    assert.equal(rolled.rolledBack, '007_skills_system');

    const tenantSchema = await pgClient.ensureTenantSchema('prj_alpha-1');
    assert.equal(tenantSchema, 'tenant_prj_alpha_1');

    const tenantRes = await pgClient.queryTenant('prj_alpha-1', 'SELECT * FROM todos WHERE done = ?', [false]);
    assert.equal(tenantRes.tenantSchema, 'tenant_prj_alpha_1');
    assert.equal(tenantRes.rowCount, 1);
    assert.ok(mock.executedSql.some((s) => s.includes('SET LOCAL search_path TO "tenant_prj_alpha_1"')));

    await assert.rejects(
      () => pgClient.queryTenant('prj_alpha-1', 'SELECT * FROM users'),
      /isolasi multi-tenant/i
    );

    assert.ok(mock.txLogs.includes('BEGIN'));
    assert.ok(mock.txLogs.includes('COMMIT'));
    assert.ok(mock.getReleasedCount() >= 4);
    await pgClient.close();
  });

  it('delivers identical repository semantics across SQLite and PostgreSQL (JSONB, booleans, pagination, transactions, 23505)', async () => {
    const sqliteClient = new SqliteAsyncDbClient(sqliteDb);
    const mock = createStatefulMockPgPool();
    const cfg = parsePostgresConfig({ DATABASE_URL: 'postgresql://carmen:pw@localhost:5432/carmen', PGSSLMODE: 'disable' })!;
    const pgClient = new PostgresAsyncDbClient(cfg, { poolFactory: () => mock.pool });

    for (const client of [sqliteClient, pgClient]) {
      const repos = createRepositories(client);

      const u1 = await repos.users.create({
        id: 'usr_dual_1',
        email: 'Ada@Example.com',
        passwordHash: 'hash_123',
        name: 'Ada Lovelace',
      });
      assert.equal(u1.user?.email, 'ada@example.com');

      const dup = await repos.users.create({
        id: 'usr_dual_dup',
        email: 'ADA@example.com',
        passwordHash: 'hash_123',
        name: 'Dup',
      });
      assert.equal(dup.duplicate, true);

      const rawToken = await repos.sessions.createHashed('usr_dual_1', 7);
      const foundUser = await repos.sessions.findUserByRawToken(rawToken);
      assert.equal(foundUser?.id, 'usr_dual_1');
      assert.equal(await repos.sessions.deleteByRawToken(rawToken), 1);
      assert.equal(await repos.sessions.findUserByRawToken(rawToken), null);

      const p1 = await repos.projects.createWithFiles({
        id: 'prj_dual_1',
        userId: 'usr_dual_1',
        name: 'Fullstack App',
        type: 'web',
        stack: 'React + Express + SQLite',
        rules: '',
        apkConfig: {
          appName: 'Fullstack App',
          packageId: 'id.carmen.fullstack',
          versionName: '1.0.0',
          versionCode: 1,
          iconColor: '#C8324B',
          buildType: 'debug',
        },
        files: {
          'client/index.html': '<!doctype html><html><body><div id="root"></div></body></html>',
          'server/index.ts': 'export const ok = true;',
        },
      });
      assert.equal(p1.archived, false);
      assert.equal(p1.apkConfig.packageId, 'id.carmen.fullstack');

      await repos.projects.createWithFiles({
        id: 'prj_dual_2',
        userId: 'usr_dual_1',
        name: 'Archived App',
        type: 'web',
        stack: 'Static',
        rules: '',
        apkConfig: {
          appName: 'Archived App',
          packageId: 'id.carmen.arch',
          versionName: '1.0.0',
          versionCode: 1,
          iconColor: '#C8324B',
          buildType: 'debug',
        },
        files: { 'index.html': '<h1>Hi</h1>' },
      });
      assert.equal(await repos.projects.setArchived('prj_dual_2', 'usr_dual_1', true), true);

      const activeList = await repos.projects.listByUser('usr_dual_1', { limit: 10, offset: 0 });
      assert.equal(activeList.length, 1);
      assert.equal(activeList[0].id, 'prj_dual_1');

      const allPaged = await repos.projects.listByUser('usr_dual_1', { includeArchived: true, limit: 1, offset: 1 });
      assert.equal(allPaged.length, 1);

      await repos.projectFiles.upsert('prj_dual_1', 'schema.sql', 'CREATE TABLE notes (id INTEGER PRIMARY KEY);');
      const paths = await repos.projectFiles.listPaths('prj_dual_1');
      assert.deepEqual(paths, ['client/index.html', 'schema.sql', 'server/index.ts']);

      await repos.memory.setHandoff('prj_dual_1', 'Status: step 2 ok');
      assert.equal(await repos.memory.getHandoff('prj_dual_1'), 'Status: step 2 ok');

      await repos.deployments.create({
        id: 'dep_dual_1',
        projectId: 'prj_dual_1',
        target: 'self-hosted',
        status: 'ready',
        deploymentUrl: null,
        externalId: 'self-hosted:fullstack-app',
        projectName: 'fullstack-app',
        logs: [{ timestamp: '2026-01-01T00:00:00Z', level: 'success', message: 'Ready' }],
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const deps = await repos.deployments.listByProject('prj_dual_1');
      assert.equal(deps.length, 1);
      assert.equal(deps[0].logs[0].message, 'Ready');
    }

    await pgClient.close();
  });

  it('reports transaction rollback honestly and testPostgresConnection never fabricates PG connectivity', async () => {
    const sqliteClient = new SqliteAsyncDbClient(sqliteDb);
    await assert.rejects(
      () =>
        sqliteClient.transaction(async (tx) => {
          await tx.run(
            `INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)`,
            'usr_rollback_1',
            'rb@example.com',
            'h',
            'RB'
          );
          throw new Error('simulated failure');
        }),
      /simulated failure/
    );
    const rolledBackUser = await sqliteClient.get('SELECT id FROM users WHERE id = ?', 'usr_rollback_1');
    assert.equal(rolledBackUser, undefined);

    const status = getDatabaseDriverStatus({});
    assert.equal(status.compatibilityLayerReady, true);
    assert.equal(status.pgPackageInstalled, true);

    const unconfigured = await testPostgresConnection({});
    assert.equal(unconfigured.ok, false);
    assert.equal(unconfigured.configured, false);

    const unreachable = await testPostgresConnection({
      DATABASE_URL: 'postgresql://carmen:pw@127.0.0.1:1/carmen',
      PGSSLMODE: 'disable',
    });
    assert.equal(unreachable.ok, false);
    assert.equal(unreachable.configured, true);
  });

  it('verifies F-01..F-04 FASE 1 deliverables: lockfile sync, multi-stage Dockerfile, Android CI assembler, and explicit Postgres fail-fast', async () => {
    // F-01: package.json runtime deps & lockfile sync, no bun.lock
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const lock = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string }>;
    };
    assert.ok(pkg.dependencies?.esbuild, 'esbuild must be a runtime dependency');
    assert.ok(pkg.dependencies?.pg, 'pg must be a runtime dependency');
    assert.ok(lock.packages?.['node_modules/pg'], 'pg must be synced in package-lock.json');
    assert.ok(lock.packages?.['node_modules/esbuild'], 'esbuild must be synced in package-lock.json');
    assert.equal(fs.existsSync(path.resolve(process.cwd(), 'bun.lock')), false, 'bun.lock must be removed');

    // F-02: multi-stage Dockerfile builds client & runs compiled server as non-root user
    const dockerfile = fs.readFileSync(path.resolve(process.cwd(), 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /FROM\s+node:22-bookworm-slim\s+AS\s+builder/i);
    assert.match(dockerfile, /FROM\s+node:22-bookworm-slim\s+AS\s+prod-deps/i);
    assert.match(dockerfile, /npm\s+ci/i);
    assert.match(dockerfile, /USER\s+node/);
    assert.match(dockerfile, /VOLUME\s+\["\/app\/data"\]/);
    assert.match(dockerfile, /CMD\s+\["npm",\s*"start"\]/);

    // F-03: Android CI workflow & project assembler never false-green
    const ciYaml = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/android-build.yml'), 'utf8');
    assert.match(ciYaml, /prepare-android-ci\.ts/);
    assert.match(ciYaml, /if-no-files-found:\s*error/);
    const { assembleAndroidGradleProject } = await import('../../scripts/prepare-android-ci');
    const ciTmp = fs.mkdtempSync(path.join(tempDir, 'android-ci-'));
    const fakeDist = path.join(ciTmp, 'dist');
    const androidOut = path.join(ciTmp, 'android');
    fs.mkdirSync(fakeDist, { recursive: true });
    fs.writeFileSync(path.join(fakeDist, 'index.html'), '<!doctype html><html><body>OK</body></html>');
    const generated = assembleAndroidGradleProject({
      outDir: androidOut,
      webDistDir: fakeDist,
      appName: 'Carmen Audit App',
      packageId: 'id.carmen.audit',
      versionName: '1.2.3',
      versionCode: 4,
    });
    assert.equal(generated.packageId, 'id.carmen.audit');
    assert.ok(generated.assetFilesCopied >= 1);
    assert.ok(fs.existsSync(path.join(androidOut, 'app', 'src', 'main', 'AndroidManifest.xml')));
    assert.ok(fs.existsSync(path.join(androidOut, 'app', 'build.gradle')));
    assert.match(fs.readFileSync(path.join(androidOut, 'app', 'build.gradle'), 'utf8'), /id\.carmen\.audit/);

    // F-04: Explicit Postgres selection fails fast when DATABASE_URL is missing
    const { createAsyncDbClient, buildPgPoolConfig } = await import('./client');
    assert.throws(
      () => createAsyncDbClient({ env: { CARMEN_DB_DRIVER: 'postgres' } }),
      /DATABASE_URL/i
    );

    // P0 TLS Hardening: secure-by-default verify-full, production fail-fast on unverified TLS, custom CA, and DIRECT_URL
    const defaultCfg = parsePostgresConfig({
      DATABASE_URL: 'postgresql://postgres:pw@db.example.supabase.co:6543/postgres?pgbouncer=true',
      DIRECT_URL: 'postgresql://postgres:pw@db.example.supabase.co:5432/postgres',
    });
    assert.ok(defaultCfg);
    assert.equal(defaultCfg.sslMode, 'verify-full');
    assert.equal(defaultCfg.sslRejectUnauthorized, true);
    assert.equal(defaultCfg.directConnectionString, 'postgresql://postgres:pw@db.example.supabase.co:5432/postgres');
    const defaultPool = buildPgPoolConfig(defaultCfg);
    assert.deepEqual(defaultPool.ssl, { rejectUnauthorized: true });
    const directPool = buildPgPoolConfig(defaultCfg, { useDirectUrl: true });
    assert.equal(directPool.connectionString, 'postgresql://postgres:pw@db.example.supabase.co:5432/postgres');

    // Production MUST reject disable and unverified require unless explicitly opted in
    assert.throws(
      () =>
        parsePostgresConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app',
          PGSSLMODE: 'disable',
        }),
      /ditolak di produksi/i
    );
    assert.throws(
      () =>
        parsePostgresConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app',
          PGSSLMODE: 'require',
        }),
      /ditolak di produksi/i
    );

    // Custom CA PEM works cleanly with verify-ca and verify-full in production
    const samplePem = '-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END CERTIFICATE-----';
    const customCaPath = path.join(tempDir, 'supabase-ca.crt');
    fs.writeFileSync(customCaPath, samplePem, 'utf8');

    const caCfg = parsePostgresConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@db.example.supabase.co:5432/postgres',
      PGSSLMODE: 'verify-ca',
      PGSSLROOTCERT: customCaPath,
    });
    assert.ok(caCfg);
    assert.equal(caCfg.sslRejectUnauthorized, true);
    assert.equal(caCfg.sslRootCertPem, samplePem);
    const caPool = buildPgPoolConfig(caCfg);
    assert.ok(caPool.ssl && typeof caPool.ssl === 'object');
    assert.equal(caPool.ssl.rejectUnauthorized, true);
    assert.equal(caPool.ssl.ca, samplePem);
    assert.equal(typeof caPool.ssl.checkServerIdentity, 'function');

    // Inline PEM env var also supported
    const inlineCfg = parsePostgresConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@db.example.supabase.co:5432/postgres',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT_PEM: samplePem.replace(/\n/g, '\\n'),
    });
    assert.equal(inlineCfg?.sslRootCertPem, samplePem);
    const inlinePool = buildPgPoolConfig(inlineCfg!);
    assert.ok(inlinePool.ssl && typeof inlinePool.ssl === 'object');
    assert.equal(inlinePool.ssl.checkServerIdentity, undefined);
  });

  it('prevents pooled search_path leakage, avoids revoking public schema, strips qualified rowid, and preserves healthy pool clients on benign tx errors', async () => {
    // 1) Tenant schema SQL uses transaction-scoped SET LOCAL and never revokes public schema globally
    const provisionSql = buildTenantSchemaProvisionSql('prj_tenant_abc');
    assert.match(provisionSql, /SET LOCAL search_path TO "tenant_prj_tenant_abc"/);
    assert.equal(/REVOKE\s+ALL\s+ON\s+SCHEMA\s+public/i.test(provisionSql), false);

    // 2) Table-qualified SQLite rowid tie-breakers (used in /api/activity) are cleanly stripped for Postgres
    const activitySql = translateSqliteToPostgres(
      `SELECT v.id FROM project_versions v WHERE v.project_id = ? ORDER BY v.created_at DESC, v.rowid DESC LIMIT ?`
    );
    assert.equal(/\browid\b/i.test(activitySql), false, `Qualified rowid must be stripped: ${activitySql}`);
    assert.match(activitySql, /ORDER BY v\.created_at DESC\s+LIMIT \$2/);

    // 3) PostgresAsyncDbClient.transaction releases healthy connection (false) on normal SQL error,
    //    and only destroys connection (true) when ROLLBACK itself fails
    const releaseArgs: Array<boolean | Error | undefined> = [];
    let failRollback = false;
    const mockPool: PgPoolLike = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async connect(): Promise<PgPoolClientLike> {
        return {
          async query(text: string) {
            if (text.trim().toUpperCase() === 'ROLLBACK' && failRollback) {
              throw new Error('connection lost during rollback');
            }
            return { rows: [], rowCount: 0 };
          },
          release(err?: boolean | Error) {
            releaseArgs.push(err);
          },
        };
      },
      async end() {},
    };
    const pgCfg = parsePostgresConfig({
      DATABASE_URL: 'postgresql://carmen:pw@localhost:5432/carmen',
      PGSSLMODE: 'disable',
    })!;
    const pgClient = new PostgresAsyncDbClient(pgCfg, { poolFactory: () => mockPool });

    try {
      await assert.rejects(
        () =>
          pgClient.transaction(async () => {
            throw new Error('duplicate key constraint');
          }),
        /duplicate key constraint/
      );
      assert.equal(releaseArgs[0], false, 'Benign transaction rollback should return healthy client to pool');

      failRollback = true;
      await assert.rejects(
        () =>
          pgClient.transaction(async () => {
            throw new Error('query failed before broken rollback');
          }),
        /query failed before broken rollback/
      );
      assert.equal(releaseArgs[1], true, 'Failed ROLLBACK must destroy tainted connection');
    } finally {
      await pgClient.close();
    }
  });
});

