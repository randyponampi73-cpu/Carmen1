import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-builds-test-'));
process.env.CARMEN_DB_PATH = path.join(tempDir, 'test.db');
process.env.CARMEN_ARTIFACT_DIR = path.join(tempDir, 'artifacts');
process.env.CARMEN_SANDBOX_ROOT = path.join(tempDir, 'sandboxes');
process.env.CARMEN_MASTER_KEY = 'builds-test-master-key-32-bytes-minimum!!';

let dbMod: typeof import('../db');
let apkMod: typeof import('./apkBuilder');

describe('APK/AAB Build Queue Recovery, Redis Validation & Artifact Lifecycle (F-17, F-20)', () => {
  before(async () => {
    dbMod = await import('../db');
    dbMod.initDatabase();
    apkMod = await import('./apkBuilder');
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates REDIS_URL protocol, hostname, port, DB index, and CARMEN_REQUIRE_REDIS_QUEUE', () => {
    assert.deepEqual(apkMod.validateRedisConfiguration({}), {
      configured: false,
      required: false,
      tls: false,
    });

    const missingRequired = apkMod.validateRedisConfiguration({ CARMEN_REQUIRE_REDIS_QUEUE: '1' });
    assert.equal(missingRequired.configured, false);
    assert.equal(missingRequired.required, true);
    assert.ok(missingRequired.error);

    assert.equal(apkMod.validateRedisConfiguration({ REDIS_URL: 'http://localhost:6379' }).configured, false);
    assert.equal(apkMod.validateRedisConfiguration({ REDIS_URL: 'redis://localhost:99999' }).configured, false);
    assert.equal(apkMod.validateRedisConfiguration({ REDIS_URL: 'redis://localhost:6379/notanint' }).configured, false);
    assert.equal(apkMod.validateRedisConfiguration({ REDIS_URL: 'not a url' }).configured, false);

    const validTcp = apkMod.validateRedisConfiguration({ REDIS_URL: 'redis://127.0.0.1:6379/0' });
    assert.equal(validTcp.configured, true);
    assert.equal(validTcp.tls, false);

    const validTls = apkMod.validateRedisConfiguration({
      REDIS_URL: 'rediss://:secret@redis.example.com:6380/2',
    });
    assert.equal(validTls.configured, true);
    assert.equal(validTls.tls, true);
  });

  it('enforces atomic build claim and recovers orphaned running/queued builds safely', async () => {
    const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
    const projectId = `prj_${crypto.randomUUID().slice(0, 8)}`;
    dbMod.db
      .prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
      .run(userId, `${userId}@example.com`, 'Build Recovery User', 'hash');
    dbMod.db
      .prepare(
        'INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(projectId, userId, 'Mobile Recovery App', 'android', 'Capacitor + HTML', '', '{}');
    dbMod.db
      .prepare('INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)')
      .run(
        crypto.randomUUID(),
        projectId,
        'index.html',
        '<!doctype html><html><body><h1>Recovery</h1></body></html>',
        'h0'
      );

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const runningId = `bld_run_${crypto.randomUUID().slice(0, 6)}`;
    const queuedReleaseId = `bld_rel_${crypto.randomUUID().slice(0, 6)}`;
    const queuedDebugId = `bld_dbg_${crypto.randomUUID().slice(0, 6)}`;

    const baseConfig = {
      appName: 'Recovery App',
      packageId: 'id.carmen.recovery',
      versionName: '1.0.0',
      versionCode: 1,
      iconColor: '#C8324B',
      buildType: 'debug' as const,
    };

    dbMod.db
      .prepare(
        `INSERT INTO builds (id, project_id, type, status, config_json, logs_json, expires_at) VALUES (?, ?, 'apk', 'running', ?, '[]', ?)`
      )
      .run(runningId, projectId, JSON.stringify(baseConfig), expiresAt);

    dbMod.db
      .prepare(
        `INSERT INTO builds (id, project_id, type, status, config_json, logs_json, expires_at) VALUES (?, ?, 'apk', 'queued', ?, '[]', ?)`
      )
      .run(
        queuedReleaseId,
        projectId,
        JSON.stringify({ ...baseConfig, buildType: 'release', hasKeystore: true }),
        expiresAt
      );

    dbMod.db
      .prepare(
        `INSERT INTO builds (id, project_id, type, status, config_json, logs_json, expires_at) VALUES (?, ?, 'apk', 'queued', ?, '[]', ?)`
      )
      .run(queuedDebugId, projectId, JSON.stringify(baseConfig), expiresAt);

    const recovery = await apkMod.recoverPendingApkBuildsAsync({ localAutoResume: false });
    assert.equal(recovery.recoveredRunningFailed, 1);
    assert.equal(recovery.failedMissingKeystore, 1);
    assert.equal(recovery.resumedLocalQueued, 0);

    const runRec = await apkMod.getBuildRecordAsync(runningId);
    assert.equal(runRec?.status, 'failed');
    assert.ok(runRec?.logs.some((l) => l.message.includes('terhenti')));

    const relRec = await apkMod.getBuildRecordAsync(queuedReleaseId);
    assert.equal(relRec?.status, 'failed');
    assert.ok(relRec?.logs.some((l) => l.message.includes('keystore')));

    // Running processApkBuild in parallel on the same queuedDebugId executes exactly once and verifies output artifact
    await Promise.all([
      apkMod.processApkBuild(queuedDebugId, projectId, baseConfig),
      apkMod.processApkBuild(queuedDebugId, projectId, baseConfig),
    ]);

    const dbgRec = await apkMod.getBuildRecordAsync(queuedDebugId);
    assert.equal(dbgRec?.status, 'success');
    assert.ok(dbgRec?.downloadToken);
    assert.ok((dbgRec?.artifactSizeBytes ?? 0) > 0);

    // Calling processApkBuild again on an already-completed buildId is a safe no-op
    await apkMod.processApkBuild(queuedDebugId, projectId, baseConfig);
    const dbgRecAfter = await apkMod.getBuildRecordAsync(queuedDebugId);
    assert.equal(dbgRecAfter?.status, 'success');
  });

  it('cleans up expired artifact files on disk and preserves unexpired ones', async () => {
    const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
    const projectId = `prj_${crypto.randomUUID().slice(0, 8)}`;
    dbMod.db
      .prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
      .run(userId, `${userId}@example.com`, 'Cleanup User', 'hash');
    dbMod.db
      .prepare(
        'INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(projectId, userId, 'Cleanup App', 'android', 'Capacitor', '', '{}');

    const expiredArtifact = path.join(dbMod.ARTIFACT_DIR, 'expired-sample.zip');
    const freshArtifact = path.join(dbMod.ARTIFACT_DIR, 'fresh-sample.zip');
    fs.writeFileSync(expiredArtifact, 'old-bytes');
    fs.writeFileSync(freshArtifact, 'fresh-bytes');

    const expiredId = `bld_exp_${crypto.randomUUID().slice(0, 6)}`;
    const freshId = `bld_ok_${crypto.randomUUID().slice(0, 6)}`;
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const futureIso = new Date(Date.now() + 600_000).toISOString();

    dbMod.db
      .prepare(
        `INSERT INTO builds (id, project_id, type, status, config_json, logs_json, artifact_path, download_token, expires_at) VALUES (?, ?, 'apk', 'success', '{}', '[]', ?, 'tok_exp', ?)`
      )
      .run(expiredId, projectId, expiredArtifact, pastIso);

    dbMod.db
      .prepare(
        `INSERT INTO builds (id, project_id, type, status, config_json, logs_json, artifact_path, download_token, expires_at) VALUES (?, ?, 'apk', 'success', '{}', '[]', ?, 'tok_fresh', ?)`
      )
      .run(freshId, projectId, freshArtifact, futureIso);

    const res = await apkMod.cleanupExpiredBuildArtifactsAsync();
    assert.equal(res.cleanedFiles, 1);
    assert.equal(fs.existsSync(expiredArtifact), false);
    assert.equal(fs.existsSync(freshArtifact), true);

    const expiredRow = dbMod.db
      .prepare('SELECT artifact_path, download_token FROM builds WHERE id = ?')
      .get(expiredId) as { artifact_path: string | null; download_token: string | null };
    assert.equal(expiredRow.artifact_path, null);
    assert.equal(expiredRow.download_token, null);
  });

  it('escapes Android strings.xml metadata and enforces signed release artifact checks in CI workflow (F-18)', async () => {
    const { assembleAndroidGradleProject } = await import('../../scripts/prepare-android-ci');
    const ciDir = fs.mkdtempSync(path.join(tempDir, 'ci-xml-'));
    const distDir = path.join(ciDir, 'dist');
    const outDir = path.join(ciDir, 'android');
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>OK</body></html>');
    fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log("ok");');

    const assembled = assembleAndroidGradleProject({
      webDistDir: distDir,
      outDir,
      appName: 'Carmen & "Audit" <App>',
      packageId: 'id.carmen.ci.verify',
      versionName: '2.1.0',
      versionCode: 12,
    });
    assert.equal(assembled.assetFilesCopied, 2);

    const stringsXml = fs.readFileSync(path.join(outDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf8');
    assert.match(stringsXml, /&amp;/);
    assert.match(stringsXml, /&quot;/);
    assert.match(stringsXml, /&lt;App&gt;/);

    const gradleFile = fs.readFileSync(path.join(outDir, 'app', 'build.gradle'), 'utf8');
    assert.match(gradleFile, /versionCode 12/);
    assert.match(gradleFile, /versionName "2\.1\.0"/);

    const ciWorkflow = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/android-build.yml'), 'utf8');
    assert.match(ciWorkflow, /ANDROID_KEYSTORE_BASE64/);
    assert.match(ciWorkflow, /apksigner.*verify/);
    assert.match(ciWorkflow, /jarsigner -verify/);
  });
});
