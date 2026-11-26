import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PostgresAsyncDbClient } from './client';
import { parsePostgresConfig } from './postgres';
import { bootstrapPostgresDatabase, POSTGRES_MIGRATIONS, rollbackLastPostgresMigration, runPostgresMigrations } from './postgresMigrations';
import { createRepositories } from './repositories';

async function checkPostgresAvailability(): Promise<{
  available: boolean;
  reason?: string;
  client?: PostgresAsyncDbClient;
}> {
  const url = (process.env.TEST_POSTGRES_URL || process.env.DATABASE_URL || '').trim();
  if (!url) {
    return {
      available: false,
      reason: 'BLOCKED: TEST_POSTGRES_URL / DATABASE_URL belum dikonfigurasi dan host container tidak menyediakan server PostgreSQL.',
    };
  }

  let client: PostgresAsyncDbClient;
  try {
    const cfg = parsePostgresConfig({ ...process.env, DATABASE_URL: url, PGSSLMODE: process.env.PGSSLMODE || 'disable' });
    if (!cfg) {
      return { available: false, reason: 'BLOCKED: Konfigurasi PostgreSQL kosong.' };
    }
    cfg.connectionTimeoutMs = 1500;
    client = new PostgresAsyncDbClient(cfg);
    const health = await client.healthCheck();
    if (!health.ok) {
      await client.close().catch(() => {});
      return {
        available: false,
        reason: `BLOCKED: Server PostgreSQL tidak dapat dijangkau (${health.detail}).`,
      };
    }
    return { available: true, client };
  } catch (err) {
    return {
      available: false,
      reason: `BLOCKED: Gagal menghubungkan ke PostgreSQL (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
}

const probe = await checkPostgresAvailability();
const skipReason = probe.available ? false : probe.reason || 'BLOCKED: PostgreSQL tidak tersedia.';

describe('Live PostgreSQL Integration Verification (Requires Real PostgreSQL Server)', () => {
  after(async () => {
    if (probe.client) {
      await probe.client.close();
    }
  });

  it('bootstraps PostgreSQL DDL schema, runs idempotent migrations, and supports rollback', { skip: skipReason }, async () => {
    const client = probe.client!;
    const boot = await bootstrapPostgresDatabase(client);
    assert.equal(boot.integrityOk, true);

    const second = await runPostgresMigrations(client, POSTGRES_MIGRATIONS);
    assert.deepEqual(second.applied, []);

    const latestVersion = POSTGRES_MIGRATIONS[POSTGRES_MIGRATIONS.length - 1].version;
    const rolled = await rollbackLastPostgresMigration(client, POSTGRES_MIGRATIONS);
    assert.equal(rolled.rolledBack, latestVersion);

    const reapplied = await runPostgresMigrations(client, POSTGRES_MIGRATIONS);
    assert.deepEqual(reapplied.applied, [latestVersion]);
  });

  it('enforces real PostgreSQL CRUD, transactions, foreign keys, JSONB, booleans, and tenant schema isolation', { skip: skipReason }, async () => {
    const client = probe.client!;
    const repos = createRepositories(client);
    const suffix = crypto.randomUUID().slice(0, 8);
    const userId = `usr_pg_${suffix}`;
    const projectId = `prj_pg_${suffix}`;

    try {
      const created = await repos.users.create({
        id: userId,
        email: `pg-${suffix}@example.com`,
        passwordHash: 'hash_test',
        name: 'PG Live Tester',
      });
      assert.equal(created.user?.id, userId);

      const dup = await repos.users.create({
        id: `usr_pg_dup_${suffix}`,
        email: `pg-${suffix}@example.com`,
        passwordHash: 'hash_test',
        name: 'PG Dup',
      });
      assert.equal(dup.duplicate, true);

      const proj = await repos.projects.createWithFiles({
        id: projectId,
        userId,
        name: 'PG Live App',
        type: 'web',
        stack: 'React + Express + PostgreSQL',
        rules: '',
        apkConfig: {
          appName: 'PG Live App',
          packageId: 'id.carmen.pglive',
          versionName: '1.0.0',
          versionCode: 1,
          iconColor: '#C8324B',
          buildType: 'debug',
        },
        files: {
          'client/index.html': '<!doctype html><html><body><h1>Live PG</h1></body></html>',
          'server/index.ts': 'export const pg = true;',
        },
      });
      assert.equal(proj.archived, false);

      const tenantSchema = await client.ensureTenantSchema(projectId);
      await client.transaction(async (tx) => {
        await tx.exec(`SET LOCAL search_path TO "${tenantSchema}"`);
        await tx.exec('CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, title TEXT NOT NULL)');
        await tx.run('INSERT INTO items (title) VALUES (?)', 'First PG Item');
      });

      const queryOut = await client.queryTenant<{ title: string }>(
        projectId,
        'SELECT title FROM items ORDER BY id DESC'
      );
      assert.equal(queryOut.rowCount, 1);
      assert.equal(queryOut.rows[0].title, 'First PG Item');

      await assert.rejects(
        () => client.queryTenant(projectId, 'SELECT * FROM users'),
        /isolasi multi-tenant/i
      );
    } finally {
      await client.run('DELETE FROM users WHERE id = ?', userId).catch(() => {});
    }
  });
});
