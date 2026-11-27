import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import JSZip from 'jszip';

const execFileAsync = promisify(execFile);
import { checkSqliteIntegrity, rollbackLastSqliteMigration, runSqliteMigrations } from '../db/migrations';
import {
  buildTenantSchemaProvisionSql,
  getDatabaseDriverStatus,
  getTenantSchemaName,
  parsePostgresConfig,
  validateTenantQuerySql,
} from '../db/postgres';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-deploy-test-'));
process.env.CARMEN_DB_PATH = path.join(tempDir, 'test.db');
process.env.CARMEN_SANDBOX_ROOT = path.join(tempDir, 'sandboxes');
process.env.CARMEN_MASTER_KEY = 'deploy-test-master-key-32-bytes-minimum!!';

let dbMod: typeof import('../db');
let deployMod: typeof import('./adapters');
let projectId = '';

describe('Database Migrations, Postgres Config & Real Deployment Adapters', () => {
  before(async () => {
    dbMod = await import('../db');
    dbMod.initDatabase();
    deployMod = await import('./adapters');

    const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
    projectId = `prj_${crypto.randomUUID().slice(0, 8)}`;
    dbMod.db
      .prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
      .run(userId, `${userId}@example.com`, 'Deploy User', 'hash');
    dbMod.db
      .prepare('INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, userId, 'My Store App', 'web', 'HTML + SQLite', '', '{}');
    dbMod.db
      .prepare('INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), projectId, 'index.html', '<!doctype html><html><body><h1>Store</h1></body></html>', 'h1');
    dbMod.db
      .prepare('INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), projectId, '.env', 'SECRET_KEY=must_be_excluded', 'h2');
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs idempotent SQLite migrations, supports rollback, and verifies PRAGMA integrity_check', () => {
    const first = runSqliteMigrations(dbMod.db);
    assert.equal(first.integrityOk, true);
    assert.ok(first.alreadyApplied.includes('001_deployments_table'));

    const integrity = checkSqliteIntegrity(dbMod.db);
    assert.equal(integrity.ok, true);

    const rolled = rollbackLastSqliteMigration(dbMod.db);
    assert.equal(rolled.rolledBack, '006_skills_system');

    const reapplied = runSqliteMigrations(dbMod.db);
    assert.deepEqual(reapplied.applied, ['006_skills_system']);
  });

  it('validates PostgreSQL pool configuration and schema readiness without fabricating active PG connection', () => {
    assert.equal(parsePostgresConfig({}), null);
    assert.throws(() => parsePostgresConfig({ DATABASE_URL: 'mysql://bad' }));

    const cfg = parsePostgresConfig({
      DATABASE_URL: 'postgresql://carmen:secret@pgbouncer:6432/carmen?pgbouncer=true',
      PG_POOL_MAX: '25',
      PG_IDLE_TIMEOUT_MS: '45000',
      PGSSLMODE: 'verify-full',
    });
    assert.ok(cfg);
    assert.equal(cfg.maxConnections, 25);
    assert.equal(cfg.idleTimeoutMs, 45000);
    assert.equal(cfg.pgBouncer, true);
    assert.equal(cfg.poolMode, 'transaction');
    assert.equal(cfg.statementCacheSize, 0);
    assert.equal(cfg.sslMode, 'verify-full');

    const status = getDatabaseDriverStatus({
      CARMEN_DB_DRIVER: 'postgres',
      DATABASE_URL: 'postgresql://carmen:secret@pgbouncer:6432/carmen',
      PG_POOL_MAX: '15',
      PG_IDLE_TIMEOUT_MS: '20000',
    });
    assert.equal(status.activeDriver, 'postgres');
    assert.equal(status.schemaReady, true);
    assert.equal(status.pgBouncerEnabled, true);
    assert.equal(status.poolMax, 15);
    assert.equal(status.idleTimeoutMs, 20000);
    assert.match(status.notes, /PostgreSQL aktif/i);

    const sqliteDefaultStatus = getDatabaseDriverStatus({
      DATABASE_URL: 'postgresql://carmen:secret@pgbouncer:6432/carmen',
    });
    assert.equal(sqliteDefaultStatus.activeDriver, 'sqlite');
    assert.match(sqliteDefaultStatus.notes, /SQLite/i);
  });

  it('enforces PostgreSQL tenant schema naming and blocks queries targeting core platform tables or foreign schemas', () => {
    const schema = getTenantSchemaName('prj_abc-123');
    assert.equal(schema, 'tenant_prj_abc_123');
    const ddl = buildTenantSchemaProvisionSql('prj_abc-123');
    assert.match(ddl, /CREATE SCHEMA IF NOT EXISTS "tenant_prj_abc_123"/);
    assert.match(ddl, /SET LOCAL search_path TO "tenant_prj_abc_123"/);
    assert.equal(/REVOKE\s+ALL\s+ON\s+SCHEMA\s+public/i.test(ddl), false);

    assert.equal(validateTenantQuerySql('SELECT * FROM todos ORDER BY id DESC;', 'prj_abc-123').safe, true);
    assert.equal(validateTenantQuerySql('SELECT * FROM users;', 'prj_abc-123').safe, false);
    assert.equal(validateTenantQuerySql('SELECT * FROM public.api_keys;', 'prj_abc-123').safe, false);
    assert.equal(validateTenantQuerySql('SELECT * FROM tenant_other.secrets;', 'prj_abc-123').safe, false);
    assert.equal(validateTenantQuerySql("ATTACH DATABASE '/tmp/host.db' AS h;", 'prj_abc-123').safe, false);
  });

  it('generates distinct 3-strategy Self-Hosted Dockerfile & docker-compose.yml artifacts without runtime npx', async () => {
    // Strategy A: Pure Static HTML
    const staticArtifacts = deployMod.generateSelfHostedArtifacts('My Store App', false);
    assert.match(staticArtifacts.Dockerfile, /nginxinc\/nginx-unprivileged/);
    assert.match(staticArtifacts.Dockerfile, /USER 101/);
    assert.equal(staticArtifacts.Dockerfile.includes('npx'), false);
    assert.ok(staticArtifacts['docker-compose.yml'].includes('my-store-app'));

    // Strategy B: React/Vite modular SPA (multi-stage build -> dist/ on unprivileged nginx)
    const viteArtifacts = deployMod.generateSelfHostedArtifacts('My Vite App', true, undefined, {
      packageJsonContent: JSON.stringify({
        name: 'my-vite-app',
        scripts: { build: 'vite build' },
      }),
    });
    assert.match(viteArtifacts.Dockerfile, /RUN npm run build/);
    assert.match(viteArtifacts.Dockerfile, /COPY --from=builder.*\/app\/dist \/usr\/share\/nginx\/html/);
    assert.match(viteArtifacts.Dockerfile, /nginxinc\/nginx-unprivileged/);
    assert.match(viteArtifacts.Dockerfile, /USER 101/);
    assert.equal(viteArtifacts.Dockerfile.includes('npx'), false);

    // Strategy C: Full-stack TS backend (compiled at build-time -> non-root node runtime, persistent volume, zero npx)
    const fullstackTsArtifacts = deployMod.generateSelfHostedArtifacts(
      'My Fullstack App',
      true,
      { hasCustomBackend: true, backendEntry: 'server/index.ts' },
      { packageJsonContent: JSON.stringify({ name: 'fullstack-ts', scripts: { build: 'vite build' } }) }
    );
    assert.match(fullstackTsArtifacts.Dockerfile, /USER node/);
    assert.match(fullstackTsArtifacts.Dockerfile, /dist-server\/server\.cjs/);
    assert.match(fullstackTsArtifacts.Dockerfile, /"node", "dist-server\/server\.cjs"/);
    assert.equal(fullstackTsArtifacts.Dockerfile.includes('npx'), false);
    assert.match(fullstackTsArtifacts['docker-compose.yml'], /PORT: 8080/);
    assert.match(fullstackTsArtifacts['docker-compose.yml'], /\/app\/data/);

    // Strategy C (JS entry)
    const fullstackJsArtifacts = deployMod.generateSelfHostedArtifacts(
      'My JS Backend',
      true,
      { hasCustomBackend: true, backendEntry: 'server/index.js' },
      { packageJsonContent: JSON.stringify({ name: 'fullstack-js' }) }
    );
    assert.match(fullstackJsArtifacts.Dockerfile, /"node", "server\/index\.js"/);
    assert.equal(fullstackJsArtifacts.Dockerfile.includes('npx'), false);

    const composeRaw = fs.readFileSync(path.resolve(process.cwd(), 'docker-compose.yml'), 'utf8');
    assert.match(composeRaw, /profiles:\s*\["apk-queue"\]/);

    const record = await deployMod.executeDeployment({
      projectId,
      target: 'self-hosted',
      projectName: 'My Store App',
    });

    assert.equal(record.status, 'ready');
    assert.equal(record.target, 'self-hosted');
    assert.equal(record.deploymentUrl, null); // Never fabricates a fake live URL for self-hosted!

    const listed = deployMod.listProjectDeployments(projectId);
    assert.ok(listed.some((d) => d.id === record.id));
    assert.equal(deployMod.getDeploymentById(record.id)?.id, record.id);
  });

  it('rejects missing tokens honestly for Vercel, Netlify, and Cloudflare Pages (never fakes success)', async () => {
    for (const target of ['vercel', 'netlify', 'cloudflare-pages'] as const) {
      const rec = await deployMod.executeDeployment({
        projectId,
        target,
        projectName: 'My Store App',
      });
      assert.equal(rec.status, 'failed');
      assert.equal(rec.deploymentUrl, null);
      assert.ok(rec.logs.some((l) => l.level === 'error'));
    }
  });

  it('sends real Vercel v13 payload excluding .env files and scrubs tokens from failure logs', async () => {
    let capturedUrl = '';
    let capturedPayload: { name?: string; files?: Array<{ file: string }> } = {};

    const okRecord = await deployMod.executeDeployment(
      {
        projectId,
        target: 'vercel',
        projectName: 'My Store App',
        apiToken: 'vercel_secret_tok_999',
        production: true,
      },
      async (url, init) => {
        capturedUrl = url;
        capturedPayload = JSON.parse(String(init.body || '{}'));
        return new Response(JSON.stringify({ id: 'dpl_123', url: 'my-store-app.vercel.app', readyState: 'READY' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    );

    assert.ok(capturedUrl.startsWith('https://api.vercel.com/v13/deployments'));
    assert.ok(capturedPayload.files?.some((f) => f.file === 'index.html'));
    assert.equal(capturedPayload.files?.some((f) => f.file === '.env'), false, '.env must never be deployed');
    assert.equal(okRecord.status, 'ready');
    assert.equal(okRecord.deploymentUrl, 'https://my-store-app.vercel.app');

    // Now test 401 failure scrubs secret token
    const failRecord = await deployMod.executeDeployment(
      {
        projectId,
        target: 'vercel',
        projectName: 'My Store App',
        apiToken: 'vercel_secret_tok_999',
      },
      async () => new Response('Unauthorized token vercel_secret_tok_999', { status: 401 })
    );
    assert.equal(failRecord.status, 'failed');
    assert.equal(failRecord.deploymentUrl, null);
    assert.equal(
      failRecord.logs.some((l) => l.message.includes('vercel_secret_tok_999')),
      false,
      'API token must be scrubbed from logs'
    );
  });

  it('scrubs inline API key patterns from uploaded project files across Vercel deployments', async () => {
    dbMod.db
      .prepare('INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)')
      .run(
        crypto.randomUUID(),
        projectId,
        'config.js',
        'export const LEAK = "coa_test_secret_token_1234567890"; export const SK = "sk-live-secret-key-1234567890";',
        'h3'
      );

    let uploadedPayload = '';
    const rec = await deployMod.executeDeployment(
      {
        projectId,
        target: 'vercel',
        projectName: 'My Store App',
        apiToken: 'vercel_tok_clean',
      },
      async (_url, init) => {
        uploadedPayload = String(init.body || '');
        return new Response(JSON.stringify({ id: 'dpl_scrub', url: 'scrubbed.vercel.app' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    );
    assert.equal(rec.status, 'ready');
    assert.equal(uploadedPayload.includes('coa_test_secret_token_1234567890'), false);
    assert.equal(uploadedPayload.includes('sk-live-secret-key-1234567890'), false);
    assert.ok(uploadedPayload.includes('[REDACTED_KEY]'));
  });

  it('preserves disk binary assets identically across ZIP export and Vercel/Netlify/Cloudflare deployments while skipping symlinks & secrets (F-11)', async () => {
    const zipMod = await import('../export/zipExporter');
    const wsDir = path.join(process.env.CARMEN_SANDBOX_ROOT!, projectId, 'workspace');
    fs.mkdirSync(path.join(wsDir, 'public', 'fonts'), { recursive: true });

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xaa, 0x7f]);
    const woff2Bytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    fs.writeFileSync(path.join(wsDir, 'public', 'logo.png'), pngBytes);
    fs.writeFileSync(path.join(wsDir, 'public', 'fonts', 'inter.woff2'), woff2Bytes);
    fs.writeFileSync(path.join(wsDir, '.env'), 'SECRET_DISK=blocked');
    const outsideTarget = path.join(tempDir, 'outside-secret.txt');
    fs.writeFileSync(outsideTarget, 'OUTSIDE_SECRET_DATA');
    try {
      fs.symlinkSync(outsideTarget, path.join(wsDir, 'public', 'escape.png'));
    } catch {
      // Symlinks may require privileges on some platforms
    }

    // 1. ZIP Export preserves exact binary bytes
    const exported = await zipMod.exportProjectZip(projectId);
    const loadedZip = await JSZip.loadAsync(exported.buffer);
    assert.deepEqual(await loadedZip.file('public/logo.png')?.async('nodebuffer'), pngBytes);
    assert.deepEqual(await loadedZip.file('public/fonts/inter.woff2')?.async('nodebuffer'), woff2Bytes);
    assert.equal(loadedZip.file('.env'), null);
    assert.equal(loadedZip.file('public/escape.png'), null);

    // 2. Vercel uses base64 encoding for binary assets
    let vercelFiles: Array<{ file: string; data: string; encoding: string }> = [];
    const vercelRes = await deployMod.executeDeployment(
      { projectId, target: 'vercel', projectName: 'My Store App', apiToken: 'vercel_bin_tok' },
      async (_url, init) => {
        const body = JSON.parse(String(init.body || '{}')) as { files: typeof vercelFiles };
        vercelFiles = body.files;
        return new Response(JSON.stringify({ id: 'dpl_bin', url: 'bin.vercel.app' }), { status: 200 });
      }
    );
    assert.equal(vercelRes.status, 'ready');
    const vercelPng = vercelFiles.find((f) => f.file === 'public/logo.png');
    assert.ok(vercelPng);
    assert.equal(vercelPng.encoding, 'base64');
    assert.deepEqual(Buffer.from(vercelPng.data, 'base64'), pngBytes);
    assert.equal(vercelFiles.some((f) => f.file === 'public/escape.png'), false);

    // 3. Netlify ZIP upload preserves raw binary buffers
    let netlifyZipBuf: Buffer | null = null;
    const netlifyRes = await deployMod.executeDeployment(
      { projectId, target: 'netlify', projectName: 'My Store App', apiToken: 'nf_tok', siteId: 'site_123' },
      async (_url, init) => {
        netlifyZipBuf = Buffer.from(init.body as Uint8Array);
        return new Response(JSON.stringify({ id: 'nf_1', ssl_url: 'https://my-store.netlify.app' }), { status: 200 });
      }
    );
    assert.equal(netlifyRes.status, 'ready');
    assert.ok(netlifyZipBuf);
    const nfZip = await JSZip.loadAsync(netlifyZipBuf);
    assert.deepEqual(await nfZip.file('public/fonts/inter.woff2')?.async('nodebuffer'), woff2Bytes);

    // 4. Cloudflare Pages FormData preserves binary SHA-256 & payload
    let cfManifest: Record<string, string> = {};
    let cfForm: FormData | null = null;
    const cfRes = await deployMod.executeDeployment(
      {
        projectId,
        target: 'cloudflare-pages',
        projectName: 'My Store App',
        apiToken: 'cf_tok',
        accountId: '0123456789abcdef0123456789abcdef',
      },
      async (url, init) => {
        if (init.method === 'GET') {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        assert.match(url, /\/deployments$/);
        cfForm = init.body as FormData;
        cfManifest = JSON.parse(String(cfForm.get('manifest') || '{}'));
        return new Response(JSON.stringify({ result: { id: 'cf_1', url: 'https://store.pages.dev' } }), { status: 200 });
      }
    );
    assert.equal(cfRes.status, 'ready');
    const expectedHash = crypto.createHash('sha256').update(pngBytes).digest('hex').slice(0, 32);
    assert.equal(cfManifest['/public/logo.png'], expectedHash);
    const cfBlob = cfForm!.get(expectedHash) as File;
    assert.deepEqual(Buffer.from(await cfBlob.arrayBuffer()), pngBytes);
  });

  it('verifies Android worker non-HTTP healthcheck checks live worker PID, fresh heartbeat, and Redis PING (F-12)', async () => {
    const dockerAndroid = fs.readFileSync(path.resolve(process.cwd(), 'Dockerfile.android'), 'utf8');
    assert.equal(dockerAndroid.includes('/api/health'), false, 'Dockerfile.android must not use web HTTP healthcheck');
    assert.match(dockerAndroid, /scripts\/apk-worker-healthcheck\.mjs/);
    assert.match(dockerAndroid, /worker:apk/);

    const composeRaw = fs.readFileSync(path.resolve(process.cwd(), 'docker-compose.yml'), 'utf8');
    assert.match(composeRaw, /apk-worker:[\s\S]*scripts\/apk-worker-healthcheck\.mjs/);

    const scriptPath = path.resolve(process.cwd(), 'scripts/apk-worker-healthcheck.mjs');
    const healthFile = path.join(tempDir, 'apk-worker-health.json');

    // Fails when heartbeat file is missing
    assert.throws(() =>
      execFileSync(process.execPath, [scriptPath], {
        env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:6399', CARMEN_APK_WORKER_HEALTH_FILE: healthFile },
        stdio: 'pipe',
      })
    );

    // Fails when heartbeat is stale
    fs.writeFileSync(
      healthFile,
      JSON.stringify({ pid: process.pid, running: true, updatedAt: new Date(Date.now() - 120_000).toISOString() })
    );
    assert.throws(() =>
      execFileSync(process.execPath, [scriptPath], {
        env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:6399', CARMEN_APK_WORKER_HEALTH_FILE: healthFile },
        stdio: 'pipe',
      })
    );

    // Passes ONLY when heartbeat is fresh, PID is alive, AND Redis responds +PONG
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('PING')) {
          socket.write('+PONG\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as net.AddressInfo;

    try {
      fs.writeFileSync(
        healthFile,
        JSON.stringify({ pid: process.pid, running: true, updatedAt: new Date().toISOString() })
      );
      await execFileAsync(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          REDIS_URL: `redis://127.0.0.1:${addr.port}`,
          CARMEN_APK_WORKER_HEALTH_FILE: healthFile,
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
