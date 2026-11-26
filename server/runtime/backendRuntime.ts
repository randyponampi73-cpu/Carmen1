import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import type { Request, Response } from 'express';
import type { BackendRuntimeStatus } from '../../src/types';
import { asyncDb, SANDBOX_DIR } from '../db';
import { normalizeProjectPath, scrubSecrets, validateTenantWorkspacePath } from '../security';
import {
  detectSandboxIsolation,
  getSandboxProcessLimit,
  getSandboxResourceLimits,
  spawnIsolatedProcess,
  type IsolatedSpawnHandle,
  type SandboxIsolationDriver,
} from './isolation';
import {
  buildSanitizedChildEnvAsync,
  ensureProjectDependenciesInstalled,
  getWorkspacePaths,
  projectRuntime,
  registerBackendLifecycleHooks,
} from './sandbox';

const BACKEND_ENTRY_CANDIDATES = [
  'server.ts',
  'server/index.ts',
  'server/server.ts',
  'server/app.ts',
  'server/index.js',
  'server.js',
  'server/index.mjs',
  'server.mjs',
  'server/index.cjs',
  'server.cjs',
  'src/server.ts',
  'src/server.js',
  'api/index.ts',
  'api/index.js',
];

const RUNTIME_DIR_NAME = '.carmen-runtime';
const BACKEND_STARTUP_TIMEOUT_MS = 15_000;
const BACKEND_HEALTH_PROBE_TIMEOUT_MS = 2_000;
const BACKEND_PROXY_TIMEOUT_MS = 30_000;
const MAX_BACKEND_LOGS = 200;

export interface InternalBackendRecord {
  projectId: string;
  status: BackendRuntimeStatus['status'];
  pid: number | null;
  pgid: number | null;
  runId: string | null;
  driver: SandboxIsolationDriver | null;
  port: number | null;
  socketPath: string | null;
  bridgeDir: string | null;
  entryPoint: string | null;
  builtEntry: string | null;
  startedAt: string | null;
  lastHealthCheckAt: string | null;
  healthy: boolean;
  lastError: string | null;
  restartCount: number;
  sourceHash: string | null;
  logs: string[];
  handle: IsolatedSpawnHandle | null;
  secretValues: string[];
  stopping: boolean;
}

const activeBackends = new Map<string, InternalBackendRecord>();
const inflightStarts = new Map<string, Promise<BackendRuntimeStatus>>();

function toPublicStatus(rec: InternalBackendRecord): BackendRuntimeStatus {
  return {
    projectId: rec.projectId,
    status: rec.status,
    pid: rec.pid,
    port: rec.port,
    entryPoint: rec.entryPoint,
    healthy: rec.healthy,
    driver: rec.driver,
    startedAt: rec.startedAt,
    lastHealthCheckAt: rec.lastHealthCheckAt,
    restartCount: rec.restartCount,
    lastError: rec.lastError,
  };
}

function appendBackendLog(rec: InternalBackendRecord, level: 'info' | 'warn' | 'error' | 'success', rawLine: string): void {
  const cleaned = scrubSecrets(rawLine, rec.secretValues).trim();
  if (!cleaned) return;
  for (const line of cleaned.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rec.logs.push(trimmed);
    if (rec.logs.length > MAX_BACKEND_LOGS) {
      rec.logs.splice(0, rec.logs.length - MAX_BACKEND_LOGS);
    }
    projectRuntime.appendLog(rec.projectId, 'dev', level, `[backend] ${trimmed}`);
  }
}

export function identifyBackendEntryFromFiles(paths: string[], packageJsonContent?: string): string | null {
  const pathSet = new Set(paths);

  if (packageJsonContent) {
    try {
      const pkg = JSON.parse(packageJsonContent) as { main?: unknown };
      if (typeof pkg.main === 'string') {
        const normMain = normalizeProjectPath(pkg.main.trim());
        if (
          normMain &&
          pathSet.has(normMain) &&
          /\.(ts|mts|cts|js|mjs|cjs)$/i.test(normMain) &&
          !/^(src|client)\/(main|App|index)\./i.test(normMain)
        ) {
          return normMain;
        }
      }
    } catch {
      // Invalid package.json is handled cleanly during validation
    }
  }

  for (const cand of BACKEND_ENTRY_CANDIDATES) {
    if (pathSet.has(cand)) return cand;
  }

  return (
    paths.find((p) => /^(?:server|api)\/.+\.(?:ts|js|mjs|cjs|mts)$/i.test(p) && !/\.test\.|\.spec\./i.test(p)) || null
  );
}

export function isBackendSourceRunnableServer(entryContent: string): boolean {
  return /\b(listen\s*\(|createServer\s*\(|express\s*\(|fastify\s*\(|new\s+Hono\b|@hono\/node-server|Bun\.serve\s*\(|Deno\.serve\s*\(|serve\s*\()/i.test(
    entryContent
  );
}

function getCpuLimitSeconds(): number {
  const raw = Number(process.env.CARMEN_BACKEND_MAX_CPU_SECONDS || 180);
  if (Number.isFinite(raw) && raw >= 10 && raw <= 3600) {
    return Math.floor(raw);
  }
  return 180;
}

async function isLocalPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', () => resolve(false));
    tester.listen(port, '127.0.0.1', () => {
      tester.close(() => resolve(true));
    });
  });
}

async function allocateUniqueBackendPort(projectId: string): Promise<number> {
  const usedPorts = new Set<number>();
  for (const rec of activeBackends.values()) {
    if (rec.projectId !== projectId && rec.port && rec.status !== 'stopped') {
      usedPorts.add(rec.port);
    }
  }

  const hash = crypto.createHash('sha256').update(projectId).digest().readUInt16BE(0);
  const startPort = 41000 + (hash % 8000);

  for (let offset = 0; offset < 500; offset += 1) {
    const candidate = 41000 + ((startPort - 41000 + offset) % 9000);
    if (usedPorts.has(candidate)) continue;
    if (await isLocalPortAvailable(candidate)) {
      return candidate;
    }
  }

  // Fallback ephemeral probe
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 49500;
      srv.close(() => resolve(port));
    });
  });
}

function resolveInsideWorkspaceNode(realWorkspaceDir: string, importerDir: string, specifier: string): string | null {
  const baseDir = specifier.startsWith('/') ? realWorkspaceDir : importerDir;
  const rawSpec = specifier.startsWith('/') ? specifier.slice(1) : specifier;
  const cleanSpec = rawSpec.split(/[?#]/)[0];
  const candidateBase = path.resolve(baseDir, cleanSpec);
  if (!candidateBase.startsWith(realWorkspaceDir + path.sep) && candidateBase !== realWorkspaceDir) {
    return null;
  }

  const probes = [
    candidateBase,
    `${candidateBase}.ts`,
    `${candidateBase}.tsx`,
    `${candidateBase}.mts`,
    `${candidateBase}.cts`,
    `${candidateBase}.js`,
    `${candidateBase}.mjs`,
    `${candidateBase}.cjs`,
    `${candidateBase}.json`,
    path.join(candidateBase, 'index.ts'),
    path.join(candidateBase, 'index.js'),
    path.join(candidateBase, 'index.mjs'),
    path.join(candidateBase, 'index.cjs'),
  ];

  for (const probe of probes) {
    try {
      const st = fs.lstatSync(probe);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      const real = fs.realpathSync(probe);
      if (!real.startsWith(realWorkspaceDir + path.sep)) continue;
      return real;
    } catch {
      // Probe next extension
    }
  }
  return null;
}

async function prepareExecutableEntry(
  projectId: string,
  workspaceDir: string,
  entryRel: string,
  pkgJson: { type?: string; scripts?: Record<string, string> } | null
): Promise<{ ok: boolean; executableRel?: string; error?: string }> {
  const realWorkspaceDir = fs.realpathSync(workspaceDir);
  const runtimeDir = path.join(realWorkspaceDir, RUNTIME_DIR_NAME);
  fs.mkdirSync(runtimeDir, { recursive: true });

  const entryCheck = validateTenantWorkspacePath(realWorkspaceDir, entryRel, SANDBOX_DIR);
  if (!entryCheck.valid || !entryCheck.resolvedPath) {
    return { ok: false, error: entryCheck.reason || `Entrypoint backend tidak valid: ${entryRel}` };
  }

  // Optional custom backend build script (e.g. build:server)
  if (pkgJson?.scripts && typeof pkgJson.scripts['build:server'] === 'string' && pkgJson.scripts['build:server'].trim()) {
    const buildRes = await projectRuntime.runCommandAsync(projectId, 'npm run build:server', { timeoutMs: 60_000 });
    if (!buildRes.ok) {
      return {
        ok: false,
        error: `Build backend ("npm run build:server") gagal: ${buildRes.stderr || buildRes.output}`,
      };
    }
  }

  const ext = path.extname(entryRel).toLowerCase();
  const isTypeScript = ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts';

  let rawSource: string;
  try {
    rawSource = fs.readFileSync(entryCheck.resolvedPath, 'utf8');
  } catch (err) {
    return { ok: false, error: `Gagal membaca entrypoint backend: ${err instanceof Error ? err.message : String(err)}` };
  }

  const hasCjsSyntax = /\b(require\s*\(|module\.exports\b|exports\.[A-Za-z_$])/.test(rawSource);
  const hasEsmSyntax = /(^|\n)\s*(import|export)\s+/.test(rawSource) || /\bimport\.meta\b/.test(rawSource);
  const needsJsCompile =
    ext === '.js' &&
    ((pkgJson?.type === 'module' && hasCjsSyntax && !hasEsmSyntax) ||
      (pkgJson?.type !== 'module' && hasEsmSyntax && !hasCjsSyntax));

  if (isTypeScript || needsJsCompile) {
    const usesEsm =
      (ext === '.mts' || pkgJson?.type === 'module' || /\bimport\.meta\b/.test(rawSource)) &&
      !(hasCjsSyntax && !hasEsmSyntax);
    const outFormat: 'esm' | 'cjs' = usesEsm ? 'esm' : 'cjs';
    const outFileName = usesEsm ? 'server.mjs' : 'server.cjs';
    const outAbs = path.join(runtimeDir, outFileName);

    const confinedWorkspacePlugin: esbuild.Plugin = {
      name: 'carmen-confined-backend-resolver',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const spec = args.path;
          if (!spec) return null;
          if (spec.startsWith('node:')) {
            return { path: spec, external: true };
          }
          if (args.kind === 'entry-point' || path.isAbsolute(spec)) {
            const candidate = path.resolve(spec);
            if (candidate.startsWith(realWorkspaceDir + path.sep)) {
              try {
                const st = fs.lstatSync(candidate);
                if (!st.isFile() || st.isSymbolicLink()) {
                  return { errors: [{ text: `Entrypoint/import symlink "${spec}" ditolak.` }] };
                }
                const real = fs.realpathSync(candidate);
                if (!real.startsWith(realWorkspaceDir + path.sep)) {
                  return { errors: [{ text: `Path di luar workspace proyek ditolak.` }] };
                }
                return { path: real };
              } catch {
                return { errors: [{ text: `File backend tidak ditemukan: ${spec}` }] };
              }
            }
            // Fall through if '/' was used as workspace-relative import (e.g. '/shared/contract')
            if (args.kind === 'entry-point') {
              return { errors: [{ text: `Entrypoint "${spec}" berada di luar workspace proyek.` }] };
            }
          }
          if (spec.startsWith('.') || spec.startsWith('/')) {
            const importerDir = args.resolveDir || realWorkspaceDir;
            const resolved = resolveInsideWorkspaceNode(realWorkspaceDir, importerDir, spec);
            if (!resolved) {
              return { errors: [{ text: `Import lokal "${spec}" di luar workspace proyek ditolak.` }] };
            }
            return { path: resolved };
          }
          return { path: spec, external: true };
        });
      },
    };

    try {
      await esbuild.build({
        entryPoints: [entryCheck.resolvedPath],
        bundle: true,
        platform: 'node',
        target: ['node22'],
        format: outFormat,
        outfile: outAbs,
        plugins: [confinedWorkspacePlugin],
        logLevel: 'silent',
      });
    } catch (err) {
      const msg = scrubSecrets(err instanceof Error ? err.message : String(err)).split(realWorkspaceDir).join('');
      return { ok: false, error: `Kompilasi backend TypeScript gagal: ${msg}` };
    }

    return { ok: true, executableRel: `${RUNTIME_DIR_NAME}/${outFileName}` };
  }

  return { ok: true, executableRel: entryRel };
}

function writeBackendLauncherScript(workspaceDir: string): string {
  const runtimeDir = path.join(workspaceDir, RUNTIME_DIR_NAME);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const launcherPath = path.join(runtimeDir, 'launcher.mjs');
  const script = `import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const targetPort = Number(process.argv[2]);
const sockPath = process.argv[3];
const entryRel = process.argv[4];
const entryAbs = path.resolve(process.cwd(), entryRel);

try { fs.unlinkSync(sockPath); } catch {}
try { fs.mkdirSync(path.resolve(process.cwd(), 'data'), { recursive: true }); } catch {}

const bridge = net.createServer((client) => {
  const connectTcp = (host, canFallback) => {
    const upstream = net.connect({ port: targetPort, host });
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on('error', () => {
      if (!connected && canFallback) {
        connectTcp('::1', false);
        return;
      }
      client.destroy();
    });
    client.on('error', () => upstream.destroy());
  };
  connectTcp('127.0.0.1', true);
});
bridge.unref();
bridge.listen(sockPath);

const shutdown = () => {
  try { bridge.close(); } catch {}
  try { fs.unlinkSync(sockPath); } catch {}
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await import(pathToFileURL(entryAbs).href);
`;
  fs.writeFileSync(launcherPath, script, 'utf8');
  return `${RUNTIME_DIR_NAME}/launcher.mjs`;
}

async function probeUnixHttp(
  socketPath: string,
  probePath: string,
  timeoutMs = BACKEND_HEALTH_PROBE_TIMEOUT_MS
): Promise<{ reachable: boolean; statusCode?: number; error?: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    const done = (result: { reachable: boolean; statusCode?: number; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = http.request(
      {
        socketPath,
        path: probePath,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        done({ reachable: true, statusCode: res.statusCode ?? 200 });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Health check timeout'));
      done({ reachable: false, error: 'Health check timeout' });
    });
    req.on('error', (err) => {
      done({ reachable: false, error: err.message });
    });
    req.end();
  });
}

async function probeBackendHttpHealth(socketPath: string): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  for (const candidatePath of ['/health', '/api/health', '/']) {
    const res = await probeUnixHttp(socketPath, candidatePath);
    if (res.reachable) {
      if (candidatePath !== '/' && res.statusCode === 404) {
        // Endpoint not registered at /health or /api/health; continue checking root
        const rootCheck = await probeUnixHttp(socketPath, '/');
        if (rootCheck.reachable) {
          return { ok: true, statusCode: rootCheck.statusCode };
        }
      }
      if ((res.statusCode ?? 500) < 500 || candidatePath === '/') {
        return { ok: true, statusCode: res.statusCode };
      }
    }
  }
  return { ok: false, error: 'Server backend tidak merespons health check HTTP.' };
}

function cleanupBridgeDir(bridgeDir: string | null): void {
  if (!bridgeDir) return;
  try {
    fs.rmSync(bridgeDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

export class BackendRuntimeManager {
  getStatus(projectId: string): BackendRuntimeStatus {
    const rec = activeBackends.get(projectId);
    if (!rec) {
      return {
        projectId,
        status: 'stopped',
        pid: null,
        port: null,
        entryPoint: null,
        healthy: false,
        driver: null,
        startedAt: null,
        lastHealthCheckAt: null,
        restartCount: 0,
        lastError: null,
      };
    }
    return toPublicStatus(rec);
  }

  getLogs(projectId: string): string[] {
    return [...(activeBackends.get(projectId)?.logs ?? [])];
  }

  async hasRunnableBackend(projectId: string): Promise<boolean> {
    const existing = activeBackends.get(projectId);
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      return true;
    }
    const files = await asyncDb.all<{ path: string; content: string }>(
      'SELECT path, content FROM project_files WHERE project_id = ? ORDER BY path ASC',
      projectId
    );
    const paths = files.map((f) => f.path);
    const pkgRow = files.find((f) => f.path === 'package.json');
    const entryRel = identifyBackendEntryFromFiles(paths, pkgRow?.content);
    if (!entryRel) return false;
    const entryRow = files.find((f) => f.path === entryRel);
    return Boolean(entryRow && entryRow.content.trim() && isBackendSourceRunnableServer(entryRow.content));
  }

  async checkHealth(projectId: string): Promise<BackendRuntimeStatus> {
    const rec = activeBackends.get(projectId);
    if (!rec || rec.status !== 'running' || !rec.socketPath) {
      return this.getStatus(projectId);
    }

    const childAlive =
      rec.handle && rec.handle.child.exitCode === null && rec.handle.child.signalCode === null;
    if (!childAlive) {
      rec.status = 'error';
      rec.healthy = false;
      rec.pid = null;
      rec.lastError = rec.lastError || 'Proses backend berhenti secara tidak terduga.';
      return toPublicStatus(rec);
    }

    const probe = await probeBackendHttpHealth(rec.socketPath);
    rec.lastHealthCheckAt = new Date().toISOString();
    if (!probe.ok) {
      rec.healthy = false;
      rec.status = 'error';
      rec.lastError = probe.error || 'Health check HTTP backend gagal.';
    } else {
      rec.healthy = true;
      rec.lastError = null;
    }
    return toPublicStatus(rec);
  }

  stopBackend(projectId: string): boolean {
    const rec = activeBackends.get(projectId);
    if (!rec) return false;

    const wasRunning = rec.status === 'running' || rec.status === 'starting';
    rec.stopping = true;
    if (rec.handle) {
      try {
        rec.handle.terminate('Backend stopped');
      } catch {
        // Best effort
      }
      try {
        rec.handle.cleanup();
      } catch {
        // Best effort
      }
      rec.handle = null;
    }
    cleanupBridgeDir(rec.bridgeDir);
    rec.bridgeDir = null;
    rec.socketPath = null;
    rec.pid = null;
    rec.pgid = null;
    rec.port = null;
    rec.healthy = false;
    rec.status = 'stopped';
    if (wasRunning) {
      appendBackendLog(rec, 'warn', 'Backend proyek dihentikan.');
    }
    return wasRunning;
  }

  stopAllBackends(): void {
    for (const projectId of Array.from(activeBackends.keys())) {
      this.stopBackend(projectId);
    }
  }

  async invalidateOnFilesChanged(projectId: string, changedPaths: string[]): Promise<void> {
    const rec = activeBackends.get(projectId);
    if (!rec || rec.status === 'stopped') return;
    const touchesBackend = changedPaths.some(
      (p) =>
        p === 'package.json' ||
        p === 'schema.sql' ||
        p === rec.entryPoint ||
        p.startsWith('server/') ||
        p.startsWith('server.') ||
        p.startsWith('shared/') ||
        p.startsWith('api/')
    );
    if (touchesBackend) {
      this.stopBackend(projectId);
    }
  }

  async ensureRunning(
    projectId: string,
    options: { requireRunnable?: boolean; forceRestart?: boolean } = {}
  ): Promise<BackendRuntimeStatus> {
    if (options.forceRestart) {
      this.stopBackend(projectId);
    }

    const existing = activeBackends.get(projectId);
    if (
      !options.forceRestart &&
      existing &&
      existing.status === 'running' &&
      existing.socketPath &&
      existing.handle &&
      existing.handle.child.exitCode === null &&
      existing.handle.child.signalCode === null
    ) {
      return toPublicStatus(existing);
    }

    const inflight = inflightStarts.get(projectId);
    if (inflight) {
      return inflight;
    }

    const promise = this.startBackendInternal(projectId, options).finally(() => {
      inflightStarts.delete(projectId);
    });
    inflightStarts.set(projectId, promise);
    return promise;
  }

  private async startBackendInternal(
    projectId: string,
    options: { requireRunnable?: boolean } = {}
  ): Promise<BackendRuntimeStatus> {
    const prevRec = activeBackends.get(projectId);
    const prevRestarts = prevRec?.restartCount ?? 0;
    if (prevRec && (prevRec.status === 'running' || prevRec.status === 'starting')) {
      this.stopBackend(projectId);
    }

    const files = await asyncDb.all<{ path: string; content: string; hash: string }>(
      'SELECT path, content, hash FROM project_files WHERE project_id = ? ORDER BY path ASC',
      projectId
    );
    const paths = files.map((f) => f.path);
    const pkgRow = files.find((f) => f.path === 'package.json');
    const entryRel = identifyBackendEntryFromFiles(paths, pkgRow?.content);

    if (!entryRel) {
      const err = 'Entrypoint backend tidak ditemukan pada proyek.';
      return {
        projectId,
        status: 'stopped',
        pid: null,
        port: null,
        entryPoint: null,
        healthy: false,
        driver: null,
        startedAt: null,
        lastHealthCheckAt: null,
        restartCount: prevRestarts,
        lastError: options.requireRunnable ? err : null,
      };
    }

    const entryRow = files.find((f) => f.path === entryRel);
    if (!entryRow || !entryRow.content.trim()) {
      const err = `File backend "${entryRel}" kosong atau tidak ditemukan.`;
      return {
        projectId,
        status: 'error',
        pid: null,
        port: null,
        entryPoint: entryRel,
        healthy: false,
        driver: null,
        startedAt: null,
        lastHealthCheckAt: null,
        restartCount: prevRestarts,
        lastError: err,
      };
    }

    if (options.requireRunnable === false && !isBackendSourceRunnableServer(entryRow.content)) {
      return {
        projectId,
        status: 'stopped',
        pid: null,
        port: null,
        entryPoint: entryRel,
        healthy: false,
        driver: null,
        startedAt: null,
        lastHealthCheckAt: null,
        restartCount: prevRestarts,
        lastError: null,
      };
    }

    let pkgParsed: { type?: string; scripts?: Record<string, string> } | null = null;
    if (pkgRow) {
      try {
        pkgParsed = JSON.parse(pkgRow.content) as { type?: string; scripts?: Record<string, string> };
      } catch (err) {
        const msg = `package.json tidak valid JSON: ${err instanceof Error ? err.message : String(err)}`;
        return {
          projectId,
          status: 'error',
          pid: null,
          port: null,
          entryPoint: entryRel,
          healthy: false,
          driver: null,
          startedAt: null,
          lastHealthCheckAt: null,
          restartCount: prevRestarts,
          lastError: msg,
        };
      }
    }

    const rec: InternalBackendRecord = {
      projectId,
      status: 'starting',
      pid: null,
      pgid: null,
      runId: null,
      driver: null,
      port: null,
      socketPath: null,
      bridgeDir: null,
      entryPoint: entryRel,
      builtEntry: null,
      startedAt: prevRec?.startedAt ?? null,
      lastHealthCheckAt: null,
      healthy: false,
      lastError: null,
      restartCount: prevRec ? prevRestarts + (prevRec.startedAt ? 1 : 0) : 0,
      sourceHash: null,
      logs: prevRec?.logs ?? [],
      handle: null,
      secretValues: [],
      stopping: false,
    };
    activeBackends.set(projectId, rec);

    // 1. Sync workspace to disk
    const workspaceDir = await projectRuntime.syncWorkspaceToDiskAsync(projectId);

    // 2. Install isolated dependencies when package.json declares missing runtime packages
    const depInstall = await ensureProjectDependenciesInstalled(projectId);
    if (!depInstall.ok) {
      rec.status = 'error';
      rec.lastError = `Instalasi dependensi backend gagal: ${depInstall.error || 'unknown error'}`;
      appendBackendLog(rec, 'error', rec.lastError);
      return toPublicStatus(rec);
    }

    // 3. Build backend (npm run build:server or confined TypeScript esbuild)
    const buildOut = await prepareExecutableEntry(projectId, workspaceDir, entryRel, pkgParsed);
    if (!buildOut.ok || !buildOut.executableRel) {
      rec.status = 'error';
      rec.lastError = buildOut.error || 'Gagal menyiapkan entrypoint backend.';
      appendBackendLog(rec, 'error', rec.lastError);
      return toPublicStatus(rec);
    }
    rec.builtEntry = buildOut.executableRel;

    const launcherRel = writeBackendLauncherScript(workspaceDir);

    // 4. Allocate unique internal port & isolated Unix domain bridge dir
    const port = await allocateUniqueBackendPort(projectId);
    const bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), `carmen-run-${projectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16)}-`));
    const hostSockPath = path.join(bridgeDir, 'backend.sock');
    const caps = detectSandboxIsolation();
    const containerSockPath =
      caps.driver === 'docker' || caps.driver === 'podman' ? '/run/carmen/backend.sock' : hostSockPath;

    const { tmpDir, npmCacheDir } = getWorkspacePaths(projectId);
    const { env: baseEnv, secretValues } = await buildSanitizedChildEnvAsync(
      projectId,
      workspaceDir,
      tmpDir,
      npmCacheDir
    );
    rec.secretValues = secretValues;

    const childEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(port),
      HOST: '127.0.0.1',
      SQLITE_DB_PATH: baseEnv.SQLITE_DB_PATH || './data/app.db',
      DATABASE_PATH: baseEnv.DATABASE_PATH || './data/app.db',
    };

    rec.port = port;
    rec.bridgeDir = bridgeDir;
    rec.socketPath = hostSockPath;

    const limits = getSandboxResourceLimits();
    const maxProcs = getSandboxProcessLimit();

    let handle: IsolatedSpawnHandle;
    try {
      handle = spawnIsolatedProcess({
        projectId,
        bin: 'node',
        args: [launcherRel, String(port), containerSockPath, buildOut.executableRel],
        workspaceDir,
        tmpDir,
        env: childEnv,
        timeoutMs: 0,
        cpuLimitSeconds: getCpuLimitSeconds(),
        allowNetwork: false,
        memoryLimitMb: limits.memoryLimitMb,
        maxProcs,
        hostBridgeDir: bridgeDir,
        label: `backend:${entryRel}`,
      });
    } catch (err) {
      cleanupBridgeDir(bridgeDir);
      rec.bridgeDir = null;
      rec.socketPath = null;
      rec.port = null;
      rec.status = 'error';
      rec.lastError = err instanceof Error ? err.message : 'Gagal menjalankan proses backend terisolasi.';
      appendBackendLog(rec, 'error', rec.lastError);
      return toPublicStatus(rec);
    }

    rec.handle = handle;
    rec.driver = handle.driver;
    rec.runId = handle.runId;
    rec.pid = handle.child.pid ?? null;
    rec.pgid = handle.child.pid ?? null;
    rec.startedAt = new Date().toISOString();

    appendBackendLog(rec, 'info', `Menjalankan backend ${entryRel} pada port internal ${port} (${handle.driver})...`);

    let stderrBuffer = '';
    handle.child.stdout?.on('data', (chunk: Buffer) => {
      appendBackendLog(rec, 'info', chunk.toString('utf8'));
    });
    handle.child.stderr?.on('data', (chunk: Buffer) => {
      const txt = chunk.toString('utf8');
      stderrBuffer += txt;
      if (stderrBuffer.length > 8192) stderrBuffer = stderrBuffer.slice(-8192);
      appendBackendLog(rec, 'error', txt);
    });

    let exitedEarly: { code: number | null; signal: string | null } | null = null;
    handle.child.once('close', (code, signal) => {
      exitedEarly = { code, signal };
      const quota = handle.getQuotaExceededReason();
      handle.cleanup();
      cleanupBridgeDir(rec.bridgeDir);
      rec.bridgeDir = null;
      rec.socketPath = null;
      rec.handle = null;
      rec.pid = null;
      rec.pgid = null;
      rec.port = null;
      rec.healthy = false;
      if (rec.stopping) {
        rec.status = 'stopped';
        return;
      }
      rec.status = 'error';
      if (quota === 'memory-limit') {
        rec.lastError = `Backend melebihi kuota memori (${limits.memoryLimitMb} MB) dan dihentikan.`;
      } else if (quota === 'process-limit') {
        rec.lastError = `Backend melebihi batas jumlah proses (${maxProcs}) dan dihentikan.`;
      } else {
        const tailErr = scrubSecrets(stderrBuffer.trim(), rec.secretValues).slice(-400);
        rec.lastError = tailErr
          ? `Backend berhenti (exit ${code ?? signal ?? 'unknown'}): ${tailErr}`
          : `Backend berhenti secara tak terduga (exit ${code ?? signal ?? 'unknown'}).`;
      }
    });

    // Wait for real HTTP listener readiness over the project-private Unix socket bridge
    const deadline = Date.now() + BACKEND_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exitedEarly !== null || rec.stopping) {
        break;
      }
      if (fs.existsSync(hostSockPath)) {
        const health = await probeBackendHttpHealth(hostSockPath);
        if (health.ok) {
          rec.status = 'running';
          rec.healthy = true;
          rec.lastError = null;
          rec.lastHealthCheckAt = new Date().toISOString();
          appendBackendLog(rec, 'success', `Backend siap dan lolos HTTP health check (HTTP ${health.statusCode}).`);
          return toPublicStatus(rec);
        }
      }
      await new Promise((r) => setTimeout(r, 60));
    }

    if (exitedEarly === null && !rec.stopping) {
      rec.lastError = `Timeout (${Math.round(BACKEND_STARTUP_TIMEOUT_MS / 1000)}s) menunggu backend mendengarkan HTTP di port ${port}.`;
      rec.stopping = true;
      handle.terminate('Startup health check timeout');
      handle.cleanup();
      cleanupBridgeDir(rec.bridgeDir);
      rec.bridgeDir = null;
      rec.socketPath = null;
      rec.handle = null;
      rec.pid = null;
      rec.pgid = null;
      rec.port = null;
      rec.status = 'error';
      rec.healthy = false;
      appendBackendLog(rec, 'error', rec.lastError);
    }

    return toPublicStatus(rec);
  }

  async proxyHttpRequest(
    projectId: string,
    req: Request,
    res: Response,
    targetApiPathWithQuery: string
  ): Promise<void> {
    const state = await this.ensureRunning(projectId, { requireRunnable: true });
    const rec = activeBackends.get(projectId);

    if (state.status !== 'running' || !rec?.socketPath) {
      res.status(502).json({
        error: state.lastError || 'Server backend proyek tidak aktif.',
        backendStatus: state.status,
      });
      return;
    }

    const forwardHeaders: http.OutgoingHttpHeaders = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (val === undefined) continue;
      const lower = key.toLowerCase();
      if (
        lower === 'host' ||
        lower === 'connection' ||
        lower === 'content-length' ||
        lower === 'transfer-encoding' ||
        lower === 'keep-alive' ||
        lower === 'upgrade'
      ) {
        continue;
      }
      if (lower === 'cookie') {
        const rawCookie = Array.isArray(val) ? val.join('; ') : String(val);
        const filtered = rawCookie
          .split(';')
          .map((c) => c.trim())
          .filter((c) => c && !c.startsWith('carmen_session='))
          .join('; ');
        if (filtered) forwardHeaders.cookie = filtered;
        continue;
      }
      forwardHeaders[lower] = val;
    }
    forwardHeaders.host = `127.0.0.1:${rec.port || 3000}`;

    let bodyPayload: Buffer | null = null;
    const reqWithRaw = req as Request & { rawBody?: Buffer };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (Buffer.isBuffer(reqWithRaw.rawBody)) {
        bodyPayload = reqWithRaw.rawBody;
      } else if (req.readableEnded && req.body !== undefined) {
        if (Buffer.isBuffer(req.body)) {
          bodyPayload = req.body;
        } else if (typeof req.body === 'string') {
          bodyPayload = Buffer.from(req.body, 'utf8');
        } else if (typeof req.body === 'object' && Object.keys(req.body as Record<string, unknown>).length > 0) {
          bodyPayload = Buffer.from(JSON.stringify(req.body), 'utf8');
          if (!forwardHeaders['content-type']) {
            forwardHeaders['content-type'] = 'application/json';
          }
        }
      }
    }

    if (bodyPayload !== null) {
      forwardHeaders['content-length'] = String(bodyPayload.length);
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const proxyReq = http.request(
        {
          socketPath: rec.socketPath!,
          path: targetApiPathWithQuery,
          method: req.method,
          headers: forwardHeaders,
          timeout: BACKEND_PROXY_TIMEOUT_MS,
        },
        (proxyRes) => {
          if (!res.headersSent) {
            res.status(proxyRes.statusCode || 200);
            for (const [hk, hv] of Object.entries(proxyRes.headers)) {
              if (hv === undefined) continue;
              const lower = hk.toLowerCase();
              if (
                lower === 'transfer-encoding' ||
                lower === 'connection' ||
                lower === 'content-security-policy'
              ) {
                continue;
              }
              res.setHeader(hk, hv);
            }
          }
          proxyRes.pipe(res);
          proxyRes.once('end', done);
          proxyRes.once('error', () => {
            if (!res.headersSent) res.status(502).json({ error: 'Stream respons backend terputus.' });
            done();
          });
        }
      );

      proxyReq.once('timeout', () => {
        proxyReq.destroy(new Error('Proxy request timeout'));
        if (!res.headersSent) {
          res.status(504).json({ error: 'Timeout menunggu respons backend proyek.' });
        }
        done();
      });

      proxyReq.once('error', (err) => {
        if (!res.headersSent) {
          res.status(502).json({
            error: `Gagal menghubungi backend proyek: ${scrubSecrets(err.message, rec.secretValues)}`,
          });
        }
        done();
      });

      if (bodyPayload !== null) {
        proxyReq.end(bodyPayload);
      } else if (req.method !== 'GET' && req.method !== 'HEAD' && req.readable && !req.readableEnded) {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    });
  }
}

export const backendRuntimeManager = new BackendRuntimeManager();

registerBackendLifecycleHooks({
  stopProject: (projectId: string) => backendRuntimeManager.stopBackend(projectId),
  stopAll: () => backendRuntimeManager.stopAllBackends(),
});
