import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseTableInfo, TerminalLogEntry } from '../../src/types';
import { asyncDb, db, SANDBOX_DIR } from '../db';
import {
  decryptSecret,
  isMasterKeyConfigured,
  isSensitiveHostResourcePath,
  normalizeProjectPath,
  scrubSecrets,
  validateSandboxCommand,
  validateSqlSchemaSafe,
  validateTenantWorkspacePath,
} from '../security';
import {
  detectSandboxIsolation,
  processRegistry,
  spawnIsolatedProcess,
  stopProjectContainers,
  type SandboxIsolationCapabilities,
  type SandboxIsolationDriver,
  type TrackedProcessInfo,
} from './isolation';
import { invalidatePreviewCache } from './preview';
import { sandboxExecutionSemaphore } from './resourceBudget';

fs.mkdirSync(SANDBOX_DIR, { recursive: true });

export interface CommandExecutionResult {
  ok: boolean;
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  killed?: boolean;
  isolationDriver?: SandboxIsolationDriver;
  syncedFiles?: string[];
}

export interface ProjectRuntime {
  ensureReady(projectId: string): { status: 'running' | 'error'; error?: string };
  syncWorkspaceToDisk(projectId: string): string;
  writeBinaryFile(projectId: string, relPath: string, buffer: Buffer): string;
  syncSchema(projectId: string): { ok: boolean; error?: string };
  runCommand(projectId: string, cmd: string): { ok: boolean; output: string };
  runCommandAsync(
    projectId: string,
    cmd: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<CommandExecutionResult>;
  stopRunningProcess(projectId: string): boolean;
  stopAllProcesses(): void;
  cleanupProjectSandbox(projectId: string): void;
  getIsolationCapabilities(): SandboxIsolationCapabilities;
  getActiveProcesses(projectId: string): TrackedProcessInfo[];
  getLogs(projectId: string): TerminalLogEntry[];
  getLastError(projectId: string): string | null;
  clearError(projectId: string): void;
  appendLog(
    projectId: string,
    processName: 'dev' | 'install' | 'build',
    level: 'info' | 'warn' | 'error' | 'success',
    message: string
  ): void;
  inspectDatabase(projectId: string): DatabaseTableInfo[];
  inspectDatabaseAsync(projectId: string): Promise<DatabaseTableInfo[]>;
  queryTable(projectId: string, table: string): Record<string, unknown>[];
  queryTableAsync(projectId: string, table: string): Promise<Record<string, unknown>[]>;
  insertRow(projectId: string, table: string, body: Record<string, unknown>): { id: number | bigint };
  insertRowAsync(projectId: string, table: string, body: Record<string, unknown>): Promise<{ id: number | bigint }>;
  updateRow(projectId: string, table: string, id: string, body: Record<string, unknown>): void;
  updateRowAsync(projectId: string, table: string, id: string, body: Record<string, unknown>): Promise<void>;
  deleteRow(projectId: string, table: string, id: string): void;
  deleteRowAsync(projectId: string, table: string, id: string): Promise<void>;
  ensureReadyAsync(projectId: string): Promise<{ status: 'running' | 'error'; error?: string }>;
  syncWorkspaceToDiskAsync(projectId: string): Promise<string>;
  syncSchemaAsync(projectId: string): Promise<{ ok: boolean; error?: string }>;
  getLogsAsync(projectId: string): Promise<TerminalLogEntry[]>;
}

const sandboxDbs = new Map<string, DatabaseSync>();
const sandboxLogs = new Map<string, TerminalLogEntry[]>();
const lastRuntimeErrors = new Map<string, string | null>();
const lastSyncedSchemaHash = new Map<string, string>();
const announcedReadyProjects = new Set<string>();

export interface BackendStopListener {
  stopProject: (projectId: string) => boolean;
  stopAll: () => void;
}
const backendStopListeners = new Set<BackendStopListener>();
export function registerBackendLifecycleHooks(listener: BackendStopListener): void {
  backendStopListeners.add(listener);
}

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_CMD_TIMEOUT_MS = 60_000;
const INSTALL_CMD_TIMEOUT_MS = 120_000;

const ALLOWED_NPM_SUBCOMMANDS = new Set([
  'install',
  'i',
  'ci',
  'run',
  'test',
  't',
  'start',
  'ls',
  'list',
  'outdated',
  'audit',
  '--version',
  '-v',
]);

const ALLOWED_NPX_BINS = new Set(['tsc', 'vite', 'eslint', 'prettier', 'tsx', 'vitest', 'jest', 'cap']);

const BINARY_DISK_ASSET_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.wasm',
  '.pdf',
  '.svgz',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.bin',
]);

/**
 * Mendeteksi cache npm rusak / setengah tertulis (mis. sisa instalasi yang terputus).
 */
export function isNpmCacheCorruption(output: string): boolean {
  if (!output) return false;
  if (/zlib: unexpected end of file|EINTEGRITY|ECOMPROMISED|TAR_BAD_ARCHIVE|Z_BUF_ERROR/i.test(output)) return true;
  return /EEXIST/.test(output) && /_cacache|npm-cache/.test(output);
}

function getSafeProjectId(projectId: string): string {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('ID proyek tidak valid.');
  return safeId;
}

export function getWorkspacePaths(projectId: string): {
  rootDir: string;
  workspaceDir: string;
  tmpDir: string;
  npmCacheDir: string;
  dbFile: string;
} {
  const safeId = getSafeProjectId(projectId);
  const rootDir = path.join(SANDBOX_DIR, safeId);
  const workspaceDir = path.join(rootDir, 'workspace');
  const tmpDir = path.join(rootDir, 'tmp');
  const npmCacheDir = path.join(rootDir, 'npm-cache');
  const dbFile = path.join(SANDBOX_DIR, `${safeId}.db`);
  return { rootDir, workspaceDir, tmpDir, npmCacheDir, dbFile };
}

function getSandboxDb(projectId: string): DatabaseSync {
  const existing = sandboxDbs.get(projectId);
  if (existing) return existing;
  const { dbFile } = getWorkspacePaths(projectId);
  const instance = new DatabaseSync(dbFile);
  try {
    instance.exec('PRAGMA journal_mode = WAL;');
    instance.exec('PRAGMA synchronous = NORMAL;');
  } catch {
    // Fallback cleanly
  }
  instance.exec('PRAGMA busy_timeout = 5000;');
  sandboxDbs.set(projectId, instance);
  return instance;
}

function isSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]{0,60}$/.test(name);
}

/**
 * Simple shell-free argument tokenizer (supports single and double quotes, rejects unbalanced quotes).
 */
export function tokenizeCommand(cmd: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (quote) return null;
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Builds a strictly sanitized environment for project child processes:
 * - ZERO host secrets (GEMINI_API_KEY, CARMEN_MASTER_KEY, SESSION_SECRET, etc. are NEVER passed).
 * - Only essential minimal system variables + decrypted project-specific env_vars.
 */
function buildSanitizedChildEnvFromRows(
  rows: Array<{ key: string; encrypted_value: string }>,
  workspaceDir: string,
  tmpDir: string,
  npmCacheDir: string
): { env: NodeJS.ProcessEnv; secretValues: string[] } {
  const secretValues: string[] = [];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: workspaceDir,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    NODE_ENV: 'development',
    NODE_OPTIONS: '--max-old-space-size=256',
    CI: 'true',
    NO_COLOR: '1',
    npm_config_cache: npmCacheDir,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };

  if (isMasterKeyConfigured()) {
    for (const row of rows) {
      try {
        const val = decryptSecret(row.encrypted_value);
        // Never allow overriding security-sensitive execution env vars
        if (
          ![
            'PATH',
            'LD_PRELOAD',
            'LD_LIBRARY_PATH',
            'NODE_OPTIONS',
            'HOME',
            'PWD',
            'TMPDIR',
            'TEMP',
            'TMP',
            'npm_config_cache',
            'GRADLE_USER_HOME',
          ].includes(row.key)
        ) {
          env[row.key] = val;
          secretValues.push(val);
        }
      } catch {
        // Skip undecryptable env vars
      }
    }
  }

  return { env, secretValues };
}

export async function buildSanitizedChildEnvAsync(
  projectId: string,
  workspaceDir: string,
  tmpDir: string,
  npmCacheDir: string
): Promise<{ env: NodeJS.ProcessEnv; secretValues: string[] }> {
  const rows = isMasterKeyConfigured()
    ? await asyncDb.all<{ key: string; encrypted_value: string }>(
        'SELECT key, encrypted_value FROM env_vars WHERE project_id = ?',
        projectId
      )
    : [];
  return buildSanitizedChildEnvFromRows(rows, workspaceDir, tmpDir, npmCacheDir);
}

const DISALLOWED_NODE_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--inspect',
  '--inspect-brk',
  '--inspect-wait',
  '--inspect-port',
  '--expose-gc',
  '--allow-addons',
  '--env-file',
  '--env-file-if-exists',
]);

const DISALLOWED_NPM_FLAGS = new Set([
  '--foreground-scripts',
  '--registry',
  '--userconfig',
  '--globalconfig',
  '--script-shell',
  '--prefix',
  '-g',
  '--global',
]);

const DISALLOWED_NPX_FLAGS = new Set([
  '-p',
  '--package',
  '-c',
  '--call',
  '--shell',
  '--shell-auto-fallback',
  '--registry',
  '--userconfig',
]);

function normalizeFlagName(arg: string): string {
  const eq = arg.indexOf('=');
  return (eq === -1 ? arg : arg.slice(0, eq)).toLowerCase();
}

function hasDisallowedPackageSource(arg: string): boolean {
  const lower = arg.trim().toLowerCase();
  return (
    lower.startsWith('file:') ||
    lower.startsWith('git+') ||
    lower.startsWith('git://') ||
    lower.startsWith('ssh://') ||
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('github:') ||
    lower.startsWith('link:')
  );
}

export function validateParsedCommand(tokens: string[]): { allowed: boolean; bin?: string; args?: string[]; reason?: string } {
  if (tokens.length === 0) return { allowed: false, reason: 'Perintah kosong.' };
  const [bin, ...args] = tokens;

  // Block path traversal, absolute host paths, or sensitive secret access in any argument
  for (const arg of args) {
    if (
      arg.includes('..') ||
      isSensitiveHostResourcePath(arg) ||
      /(^|\/)(etc|proc|sys|root|var\/run)\b/i.test(arg) ||
      arg.includes('carmen.db') ||
      arg.startsWith('/app/') ||
      arg.startsWith('/')
    ) {
      return { allowed: false, reason: 'Argumen path absolut atau di luar direktori proyek ditolak oleh kebijakan sandbox.' };
    }
  }

  if (bin === 'npm') {
    const sub = args[0] || '';
    if (!ALLOWED_NPM_SUBCOMMANDS.has(sub)) {
      return {
        allowed: false,
        reason: `Subperintah npm "${sub}" tidak diizinkan. Gunakan install, ci, run, test, ls, atau --version.`,
      };
    }
    for (const arg of args.slice(1)) {
      const lower = arg.toLowerCase();
      const flagName = normalizeFlagName(arg);
      if (
        DISALLOWED_NPM_FLAGS.has(flagName) ||
        lower === '--ignore-scripts=false' ||
        lower === '--no-ignore-scripts'
      ) {
        return {
          allowed: false,
          reason: `Flag npm "${flagName}" ditolak oleh kebijakan keamanan sandbox.`,
        };
      }
      if ((sub === 'install' || sub === 'i' || sub === 'ci') && hasDisallowedPackageSource(arg)) {
        return {
          allowed: false,
          reason: `Sumber paket tidak tepercaya "${arg}" ditolak di sandbox. Gunakan nama paket registry standar.`,
        };
      }
    }
    return { allowed: true, bin, args };
  }

  if (bin === 'npx') {
    let actualBin = '';
    for (const arg of args) {
      const flagName = normalizeFlagName(arg);
      if (DISALLOWED_NPX_FLAGS.has(flagName)) {
        return {
          allowed: false,
          reason: `Flag npx "${flagName}" ditolak untuk mencegah package smuggling di sandbox.`,
        };
      }
      if (hasDisallowedPackageSource(arg)) {
        return {
          allowed: false,
          reason: `Sumber paket npx "${arg}" ditolak oleh kebijakan keamanan sandbox.`,
        };
      }
      if (!actualBin && arg !== '--yes' && arg !== '-y' && !arg.startsWith('-')) {
        actualBin = arg;
      }
    }
    if (!ALLOWED_NPX_BINS.has(actualBin)) {
      return {
        allowed: false,
        reason: `Binary npx "${actualBin}" tidak termasuk daftar yang diizinkan (${Array.from(ALLOWED_NPX_BINS).join(', ')}).`,
      };
    }
    return { allowed: true, bin, args };
  }

  if (bin === 'bun') {
    const sub = args[0] || '';
    if (sub !== 'install') {
      return {
        allowed: false,
        reason: `Subperintah bun "${sub}" tidak diizinkan. Hanya "bun install" yang diizinkan di sandbox.`,
      };
    }
    for (const arg of args.slice(1)) {
      const flagName = normalizeFlagName(arg);
      if (DISALLOWED_NPM_FLAGS.has(flagName) || hasDisallowedPackageSource(arg)) {
        return {
          allowed: false,
          reason: `Argumen bun "${arg}" ditolak oleh kebijakan keamanan sandbox.`,
        };
      }
    }
    return { allowed: true, bin, args };
  }

  if (bin === 'node') {
    if (args.length === 0) {
      return { allowed: false, reason: 'Jalankan node dengan argumen (mis. node -v, node --check file.js, atau node script.js).' };
    }
    for (const arg of args) {
      const flagName = normalizeFlagName(arg);
      if (DISALLOWED_NODE_FLAGS.has(flagName) || flagName.startsWith('--inspect')) {
        return {
          allowed: false,
          reason: `Flag node "${flagName}" ditolak oleh kebijakan keamanan sandbox (gunakan file script dalam workspace).`,
        };
      }
    }
    return { allowed: true, bin, args };
  }

  if (bin === 'git') {
    const sub = args[0] || '';
    if (!['status', 'diff', 'log', '--version'].includes(sub)) {
      return { allowed: false, reason: `Subperintah git "${sub}" tidak diizinkan di sandbox.` };
    }
    return { allowed: true, bin, args };
  }

  return {
    allowed: false,
    reason: `Perintah "${bin}" tidak termasuk binary sandbox yang diizinkan (ls, pwd, db:sync, node, npm, npx, git status/diff).`,
  };
}

class IsolatedSandboxRuntime implements ProjectRuntime {
  getIsolationCapabilities(): SandboxIsolationCapabilities {
    return detectSandboxIsolation();
  }

  getActiveProcesses(projectId: string): TrackedProcessInfo[] {
    return processRegistry.listProjectProcesses(projectId);
  }
  appendLog(
    projectId: string,
    processName: 'dev' | 'install' | 'build',
    level: 'info' | 'warn' | 'error' | 'success',
    message: string
  ): void {
    const logs = sandboxLogs.get(projectId) ?? [];
    logs.push({
      id: crypto.randomUUID(),
      process: processName,
      timestamp: new Date().toISOString().slice(11, 19),
      level,
      message,
    });
    if (logs.length > 300) logs.splice(0, logs.length - 300);
    sandboxLogs.set(projectId, logs);
  }

  getLogs(projectId: string): TerminalLogEntry[] {
    const logs = sandboxLogs.get(projectId);
    if (!logs || logs.length === 0) {
      this.ensureReady(projectId);
    }
    return sandboxLogs.get(projectId) ?? [];
  }

  async getLogsAsync(projectId: string): Promise<TerminalLogEntry[]> {
    const logs = sandboxLogs.get(projectId);
    if (!logs || logs.length === 0) {
      await this.ensureReadyAsync(projectId);
    }
    return sandboxLogs.get(projectId) ?? [];
  }

  getLastError(projectId: string): string | null {
    return lastRuntimeErrors.get(projectId) ?? null;
  }

  recordPreviewError(projectId: string, message: string): void {
    const formatted = `[preview] ${message}`;
    lastRuntimeErrors.set(projectId, formatted);
    this.appendLog(projectId, 'dev', 'error', formatted);
  }

  clearError(projectId: string): void {
    lastRuntimeErrors.set(projectId, null);
  }

  private writeRowsToWorkspaceDisk(
    projectId: string,
    rows: Array<{ path: string; content: string }>
  ): string {
    const { workspaceDir, tmpDir, npmCacheDir } = getWorkspacePaths(projectId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(npmCacheDir, { recursive: true });

    const expectedPaths = new Set<string>();
    const resolvedBase = path.resolve(workspaceDir);
    let mutated = false;

    for (const row of rows) {
      const norm = normalizeProjectPath(row.path);
      if (!norm) continue;
      const tenantCheck = validateTenantWorkspacePath(resolvedBase, norm, SANDBOX_DIR);
      if (!tenantCheck.valid || !tenantCheck.resolvedPath) continue;
      const target = tenantCheck.resolvedPath;
      expectedPaths.add(norm);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let unchanged = false;
      try {
        const existing = fs.readFileSync(target, 'utf8');
        if (existing === row.content) unchanged = true;
      } catch {
        // File does not exist yet
      }
      if (!unchanged) {
        fs.writeFileSync(target, row.content, 'utf8');
        mutated = true;
      }
    }

    // Remove stale workspace files that were deleted in DB (preserve node_modules and dist)
    const pruneDir = (dir: string, relPrefix: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (
          ent.name === 'node_modules' ||
          ent.name === '.git' ||
          ent.name === 'dist' ||
          ent.name === '.carmen-runtime'
        ) {
          continue;
        }
        const full = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) {
          // Never allow symlinks inside project workspaces (prevents symlink escape)
          try {
            fs.unlinkSync(full);
            mutated = true;
          } catch {
            // Ignore
          }
          continue;
        }
        const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          pruneDir(full, rel);
          try {
            if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
          } catch {
            // Ignore non-empty dir
          }
        } else if (!expectedPaths.has(rel)) {
          if (
            BINARY_DISK_ASSET_EXTS.has(path.extname(ent.name).toLowerCase()) ||
            rel.startsWith('data/') ||
            /\.(db|db-wal|db-shm|sqlite|sqlite3)$/i.test(ent.name) ||
            rel === 'package-lock.json' ||
            rel === 'bun.lock'
          ) {
            continue;
          }
          try {
            fs.unlinkSync(full);
            mutated = true;
          } catch {
            // Ignore
          }
        }
      }
    };
    pruneDir(resolvedBase, '');

    if (mutated) {
      invalidatePreviewCache(projectId);
    }

    return resolvedBase;
  }

  /**
   * Synchronizes project files from DB into the isolated per-project workspace directory on disk
   * so real child processes (node, npm, npx) operate on the actual project files.
   */
  syncWorkspaceToDisk(projectId: string): string {
    const rows = db
      .prepare('SELECT path, content FROM project_files WHERE project_id = ?')
      .all(projectId) as Array<{ path: string; content: string }>;
    return this.writeRowsToWorkspaceDisk(projectId, rows);
  }

  async syncWorkspaceToDiskAsync(projectId: string): Promise<string> {
    const rows = await asyncDb.all<{ path: string; content: string }>(
      'SELECT path, content FROM project_files WHERE project_id = ?',
      projectId
    );
    return this.writeRowsToWorkspaceDisk(projectId, rows);
  }

  writeBinaryFile(projectId: string, relPath: string, buffer: Buffer): string {
    const norm = normalizeProjectPath(relPath);
    if (!norm) {
      throw new Error(`Path aset biner tidak valid: ${relPath}`);
    }
    const { workspaceDir } = getWorkspacePaths(projectId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const resolvedBase = path.resolve(workspaceDir);
    const tenantCheck = validateTenantWorkspacePath(resolvedBase, norm, SANDBOX_DIR);
    if (!tenantCheck.valid || !tenantCheck.resolvedPath) {
      throw new Error(tenantCheck.reason || `Path aset biner ditolak: ${norm}`);
    }
    fs.mkdirSync(path.dirname(tenantCheck.resolvedPath), { recursive: true });
    fs.writeFileSync(tenantCheck.resolvedPath, buffer);
    invalidatePreviewCache(projectId);
    return tenantCheck.resolvedPath;
  }

  private applySchemaContent(projectId: string, schemaContent?: string): { ok: boolean; error?: string } {
    if (!schemaContent || !schemaContent.trim()) {
      lastSyncedSchemaHash.delete(projectId);
      if (lastRuntimeErrors.get(projectId)?.startsWith('SQLite ')) {
        lastRuntimeErrors.set(projectId, null);
      }
      return { ok: true };
    }

    const safety = validateSqlSchemaSafe(schemaContent);
    if (!safety.safe) {
      const errMsg = safety.reason || 'Skema SQL ditolak oleh kebijakan keamanan.';
      lastRuntimeErrors.set(projectId, `SQLite security error: ${errMsg}`);
      this.appendLog(projectId, 'dev', 'error', errMsg);
      return { ok: false, error: errMsg };
    }

    const schemaHash = crypto.createHash('sha256').update(schemaContent).digest('hex');
    const prevErr = lastRuntimeErrors.get(projectId);
    if (lastSyncedSchemaHash.get(projectId) === schemaHash && (!prevErr || !prevErr.startsWith('SQLite '))) {
      return { ok: true };
    }

    try {
      const sdb = getSandboxDb(projectId);
      sdb.exec(schemaContent);
      lastSyncedSchemaHash.set(projectId, schemaHash);
      if (lastRuntimeErrors.get(projectId)?.startsWith('SQLite ')) {
        lastRuntimeErrors.set(projectId, null);
      }
      this.appendLog(projectId, 'dev', 'success', 'SQLite schema.sql berhasil disinkronkan.');
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastSyncedSchemaHash.delete(projectId);
      lastRuntimeErrors.set(projectId, `SQLite schema error: ${message}`);
      this.appendLog(projectId, 'dev', 'error', `Gagal sinkronisasi schema.sql: ${message}`);
      return { ok: false, error: message };
    }
  }

  syncSchema(projectId: string): { ok: boolean; error?: string } {
    const schemaRow = db
      .prepare('SELECT content FROM project_files WHERE project_id = ? AND path = ?')
      .get(projectId, 'schema.sql') as { content: string } | undefined;
    return this.applySchemaContent(projectId, schemaRow?.content);
  }

  async syncSchemaAsync(projectId: string): Promise<{ ok: boolean; error?: string }> {
    const schemaRow = await asyncDb.get<{ content: string }>(
      'SELECT content FROM project_files WHERE project_id = ? AND path = ?',
      projectId,
      'schema.sql'
    );
    return this.applySchemaContent(projectId, schemaRow?.content);
  }

  ensureReady(projectId: string): { status: 'running' | 'error'; error?: string } {
    if (!sandboxLogs.has(projectId)) {
      this.appendLog(projectId, 'dev', 'info', 'Menyiapkan workspace proyek terisolasi...');
    }
    try {
      this.syncWorkspaceToDisk(projectId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      announcedReadyProjects.delete(projectId);
      lastRuntimeErrors.set(projectId, `Workspace sync error: ${msg}`);
      this.appendLog(projectId, 'dev', 'error', `Gagal sinkronisasi workspace: ${msg}`);
      return { status: 'error', error: msg };
    }

    const schemaRes = this.syncSchema(projectId);
    if (!schemaRes.ok) {
      announcedReadyProjects.delete(projectId);
      return { status: 'error', error: schemaRes.error };
    }

    const htmlRow = db
      .prepare("SELECT content FROM project_files WHERE project_id = ? AND path IN ('index.html', 'client/index.html') ORDER BY path ASC LIMIT 1")
      .get(projectId) as { content: string } | undefined;

    if (!htmlRow) {
      const err = 'File index.html tidak ditemukan pada proyek.';
      announcedReadyProjects.delete(projectId);
      lastRuntimeErrors.set(projectId, err);
      this.appendLog(projectId, 'dev', 'error', err);
      return { status: 'error', error: err };
    }
    if (lastRuntimeErrors.get(projectId) === 'File index.html tidak ditemukan pada proyek.') {
      lastRuntimeErrors.set(projectId, null);
    }

    if (!announcedReadyProjects.has(projectId)) {
      announcedReadyProjects.add(projectId);
      this.appendLog(projectId, 'dev', 'success', `Server preview aktif pada /preview/${projectId}/`);
    }
    const existingErr = lastRuntimeErrors.get(projectId);
    if (existingErr) {
      return { status: 'error', error: existingErr };
    }
    return { status: 'running' };
  }

  async ensureReadyAsync(projectId: string): Promise<{ status: 'running' | 'error'; error?: string }> {
    if (!sandboxLogs.has(projectId)) {
      this.appendLog(projectId, 'dev', 'info', 'Menyiapkan workspace proyek terisolasi...');
    }
    try {
      await this.syncWorkspaceToDiskAsync(projectId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      announcedReadyProjects.delete(projectId);
      lastRuntimeErrors.set(projectId, `Workspace sync error: ${msg}`);
      this.appendLog(projectId, 'dev', 'error', `Gagal sinkronisasi workspace: ${msg}`);
      return { status: 'error', error: msg };
    }

    const schemaRes = await this.syncSchemaAsync(projectId);
    if (!schemaRes.ok) {
      announcedReadyProjects.delete(projectId);
      return { status: 'error', error: schemaRes.error };
    }

    const htmlRow = await asyncDb.get<{ content: string }>(
      "SELECT content FROM project_files WHERE project_id = ? AND path IN ('index.html', 'client/index.html') ORDER BY path ASC LIMIT 1",
      projectId
    );

    if (!htmlRow) {
      const err = 'File index.html tidak ditemukan pada proyek.';
      announcedReadyProjects.delete(projectId);
      lastRuntimeErrors.set(projectId, err);
      this.appendLog(projectId, 'dev', 'error', err);
      return { status: 'error', error: err };
    }
    if (lastRuntimeErrors.get(projectId) === 'File index.html tidak ditemukan pada proyek.') {
      lastRuntimeErrors.set(projectId, null);
    }

    if (!announcedReadyProjects.has(projectId)) {
      announcedReadyProjects.add(projectId);
      this.appendLog(projectId, 'dev', 'success', `Server preview aktif pada /preview/${projectId}/`);
    }
    const existingErr = lastRuntimeErrors.get(projectId);
    if (existingErr) {
      return { status: 'error', error: existingErr };
    }
    return { status: 'running' };
  }

  stopRunningProcess(projectId: string): boolean {
    let backendStopped = false;
    for (const listener of backendStopListeners) {
      try {
        if (listener.stopProject(projectId)) backendStopped = true;
      } catch {
        // Best effort
      }
    }
    const killedCount = stopProjectContainers(projectId);
    if (killedCount === 0 && !backendStopped) return false;
    this.appendLog(
      projectId,
      'build',
      'warn',
      `Menghentikan ${Math.max(killedCount, backendStopped ? 1 : 0)} proses/kontainer aktif beserta seluruh sub-prosesnya.`
    );
    return true;
  }

  stopAllProcesses(): void {
    for (const listener of backendStopListeners) {
      try {
        listener.stopAll();
      } catch {
        // Best effort
      }
    }
    processRegistry.terminateAll('Server shutdown');
  }

  cleanupProjectSandbox(projectId: string): void {
    this.stopRunningProcess(projectId);
    const sdb = sandboxDbs.get(projectId);
    if (sdb) {
      try {
        sdb.close();
      } catch {
        // Ignore
      }
      sandboxDbs.delete(projectId);
    }
    sandboxLogs.delete(projectId);
    lastRuntimeErrors.delete(projectId);
    lastSyncedSchemaHash.delete(projectId);
    announcedReadyProjects.delete(projectId);
    invalidateDependencyInstallState(projectId);

    try {
      const { rootDir, dbFile } = getWorkspacePaths(projectId);
      fs.rmSync(rootDir, { recursive: true, force: true });
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${dbFile}${suffix}`, { force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Synchronous helper for fast built-in commands; prefer runCommandAsync for all shell/process execution.
   */
  runCommand(projectId: string, cmd: string): { ok: boolean; output: string } {
    const check = validateSandboxCommand(cmd);
    if (!check.allowed) {
      const reason = check.reason || 'Perintah ditolak.';
      this.appendLog(projectId, 'build', 'error', `$ ${cmd} -> ${reason}`);
      return { ok: false, output: reason };
    }
    const trimmed = cmd.trim();
    if (trimmed === 'ls' || trimmed.startsWith('ls ')) {
      const files = db
        .prepare('SELECT path FROM project_files WHERE project_id = ? ORDER BY path')
        .all(projectId) as Array<{ path: string }>;
      const out = files.map((f) => f.path).join('\n') || '(kosong)';
      this.appendLog(projectId, 'build', 'info', `$ ${trimmed}`);
      this.appendLog(projectId, 'build', 'info', out);
      return { ok: true, output: out };
    }
    if (trimmed === 'pwd') {
      return { ok: true, output: '/workspace' };
    }
    if (trimmed.startsWith('sqlite') || trimmed.startsWith('db:sync')) {
      const sync = this.syncSchema(projectId);
      return { ok: sync.ok, output: sync.ok ? 'Skema SQLite berhasil disinkronkan.' : sync.error || 'Error SQLite' };
    }
    return {
      ok: false,
      output: 'Gunakan eksekusi asinkron (runCommandAsync) untuk menjalankan proses nyata.',
    };
  }

  /**
   * Executes real project commands inside the isolated per-project workspace directory
   * with stripped host env vars, shell: false, allowlisted binaries, memory cap, output cap, and timeout.
   */
  async runCommandAsync(
    projectId: string,
    cmd: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<CommandExecutionResult> {
    const start = Date.now();
    let releaseSlot: () => void;
    try {
      const acquireTimeout = Math.max(5_000, Math.min(30_000, options.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS));
      releaseSlot = await sandboxExecutionSemaphore.acquire({
        signal: options.signal,
        timeoutMs: acquireTimeout,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Slot eksekusi sandbox tidak tersedia.';
      this.appendLog(projectId, 'build', 'error', `$ ${cmd} -> ${reason}`);
      return {
        ok: false,
        output: reason,
        stdout: '',
        stderr: reason,
        exitCode: options.signal?.aborted ? 130 : 429,
        durationMs: Date.now() - start,
        killed: Boolean(options.signal?.aborted),
      };
    }

    try {
      const first = await this.runCommandOnce(projectId, cmd, options);
      if (first.ok || first.timedOut || first.killed || options.signal?.aborted) return first;
      if (!/^npm\s+(install|i|ci)(\s|$)/.test(cmd.trim())) return first;
      if (!isNpmCacheCorruption(first.output)) return first;

      // Self-heal: hapus cache npm privat proyek sekali, lalu ulangi instalasi.
      const { npmCacheDir } = getWorkspacePaths(projectId);
      this.appendLog(
        projectId,
        'install',
        'warn',
        'Cache npm rusak terdeteksi (unduhan terputus / file sementara tersisa). Membersihkan cache dan mencoba ulang sekali...'
      );
      try {
        fs.rmSync(npmCacheDir, { recursive: true, force: true });
        fs.mkdirSync(npmCacheDir, { recursive: true });
      } catch {
        return first;
      }
      return await this.runCommandOnce(projectId, cmd, options);
    } finally {
      releaseSlot();
    }
  }

  private async runCommandOnce(
    projectId: string,
    cmd: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<CommandExecutionResult> {
    const start = Date.now();
    const check = validateSandboxCommand(cmd);
    if (!check.allowed) {
      const reason = check.reason || 'Perintah ditolak.';
      this.appendLog(projectId, 'build', 'error', `$ ${cmd} -> ${reason}`);
      return { ok: false, output: reason, stdout: '', stderr: reason, exitCode: 126, durationMs: 0 };
    }

    const trimmed = cmd.trim();
    const processName: 'dev' | 'install' | 'build' = trimmed.includes('install')
      ? 'install'
      : trimmed.includes('dev')
        ? 'dev'
        : 'build';

    this.appendLog(projectId, processName, 'info', `$ ${trimmed}`);

    // Built-in workspace-safe commands
    if (trimmed === 'ls' || trimmed.startsWith('ls ')) {
      await this.syncWorkspaceToDiskAsync(projectId);
      const files = await asyncDb.all<{ path: string }>(
        'SELECT path FROM project_files WHERE project_id = ? ORDER BY path',
        projectId
      );
      const out = files.map((f) => f.path).join('\n') || '(kosong)';
      this.appendLog(projectId, processName, 'info', out);
      return { ok: true, output: out, stdout: out, stderr: '', exitCode: 0, durationMs: Date.now() - start };
    }

    if (trimmed === 'pwd') {
      this.appendLog(projectId, processName, 'info', '/workspace');
      return { ok: true, output: '/workspace', stdout: '/workspace', stderr: '', exitCode: 0, durationMs: Date.now() - start };
    }

    if (trimmed.startsWith('sqlite') || trimmed.startsWith('db:sync')) {
      lastSyncedSchemaHash.delete(projectId);
      const sync = await this.syncSchemaAsync(projectId);
      const out = sync.ok ? 'Skema SQLite berhasil disinkronkan.' : sync.error || 'Error SQLite';
      return {
        ok: sync.ok,
        output: out,
        stdout: sync.ok ? out : '',
        stderr: sync.ok ? '' : out,
        exitCode: sync.ok ? 0 : 1,
        durationMs: Date.now() - start,
      };
    }

    const tokens = tokenizeCommand(trimmed);
    if (!tokens) {
      const err = 'Sintaks tanda kutip pada perintah tidak seimbang.';
      this.appendLog(projectId, processName, 'error', err);
      return { ok: false, output: err, stdout: '', stderr: err, exitCode: 2, durationMs: Date.now() - start };
    }

    const parsed = validateParsedCommand(tokens);
    if (!parsed.allowed || !parsed.bin || !parsed.args) {
      const reason = parsed.reason || 'Perintah tidak diizinkan.';
      this.appendLog(projectId, processName, 'error', reason);
      return { ok: false, output: reason, stdout: '', stderr: reason, exitCode: 126, durationMs: Date.now() - start };
    }

    // Ensure workspace files are up to date on disk before spawning isolated process
    const workspaceDir = await this.syncWorkspaceToDiskAsync(projectId);
    const { tmpDir, npmCacheDir } = getWorkspacePaths(projectId);
    const { env, secretValues } = await buildSanitizedChildEnvAsync(projectId, workspaceDir, tmpDir, npmCacheDir);

    // Stop any previous running process group for this project before launching a new one
    if (processRegistry.listProjectProcesses(projectId).length > 0) {
      this.stopRunningProcess(projectId);
    }

    const finalBin = parsed.bin!;
    const finalArgs = [...parsed.args!];
    const isNpmInstall =
      finalBin === 'npm' && (finalArgs[0] === 'install' || finalArgs[0] === 'i' || finalArgs[0] === 'ci');
    const isBunInstall = finalBin === 'bun' && finalArgs[0] === 'install';
    const isPkgInstall = isNpmInstall || isBunInstall;

    // Prevent untrusted lifecycle scripts (preinstall/postinstall) from running unless explicitly allowed
    if (isPkgInstall && process.env.CARMEN_SANDBOX_ALLOW_NPM_SCRIPTS !== '1') {
      if (!finalArgs.includes('--ignore-scripts')) {
        finalArgs.push('--ignore-scripts');
      }
    }

    // Network access is disabled by default for all arbitrary code execution (node, npm test, npm run, npx, git).
    // Only package install/ci (with --ignore-scripts enforced) may use network unless CARMEN_SANDBOX_OFFLINE_ONLY=1.
    const allowNetwork = isPkgInstall && process.env.CARMEN_SANDBOX_OFFLINE_ONLY !== '1';

    const timeoutMs =
      options.timeoutMs ?? (processName === 'install' ? INSTALL_CMD_TIMEOUT_MS : DEFAULT_CMD_TIMEOUT_MS);

    return await new Promise<CommandExecutionResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let outputTruncated = false;
      let timedOut = false;
      let killed = false;
      let settled = false;

      let handle: ReturnType<typeof spawnIsolatedProcess>;
      try {
        handle = spawnIsolatedProcess({
          projectId,
          bin: finalBin,
          args: finalArgs,
          workspaceDir,
          tmpDir,
          env,
          timeoutMs,
          allowNetwork,
          label: trimmed,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Isolasi OS sandbox tidak tersedia.';
        lastRuntimeErrors.set(projectId, reason.slice(0, 600));
        this.appendLog(projectId, processName, 'error', reason);
        resolve({
          ok: false,
          output: reason,
          stdout: '',
          stderr: reason,
          exitCode: 126,
          durationMs: Date.now() - start,
          isolationDriver: 'restricted-host',
        });
        return;
      }

      const { child } = handle;

      const timer = setTimeout(() => {
        timedOut = true;
        handle.terminate('Timeout');
      }, timeoutMs);
      timer.unref();

      const onAbort = () => {
        killed = true;
        handle.terminate('Aborted');
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const appendChunk = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        if (stdout.length + stderr.length >= MAX_OUTPUT_BYTES) {
          outputTruncated = true;
          return;
        }
        const text = chunk.toString('utf8');
        if (target === 'stdout') stdout += text;
        else stderr += text;
      };

      child.stdout?.on('data', (d: Buffer) => appendChunk('stdout', d));
      child.stderr?.on('data', (d: Buffer) => appendChunk('stderr', d));

      const finalize = async (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        handle.cleanup();

        const cleanOut = scrubSecrets(stdout.trim(), secretValues);
        const cleanErr = scrubSecrets(stderr.trim(), secretValues);
        const quotaReason = handle.getQuotaExceededReason();
        const parts: string[] = [];
        if (cleanOut) parts.push(cleanOut);
        if (cleanErr) parts.push(cleanErr);
        if (outputTruncated) parts.push('[Output dipotong karena melebihi batas 256 KB]');
        if (quotaReason === 'process-limit') {
          parts.push(`[Kuota proses (${handle.driver}) terlampaui — seluruh grup proses dihentikan]`);
        } else if (quotaReason === 'memory-limit') {
          parts.push(`[Kuota memori (${handle.driver}) terlampaui — seluruh grup proses dihentikan]`);
        } else if (timedOut) {
          parts.push(`[Timeout: proses dihentikan setelah ${Math.round(timeoutMs / 1000)} detik]`);
        } else if (killed) {
          parts.push('[Proses dihentikan]');
        }

        const combined = parts.join('\n') || `(selesai dengan kode keluar ${exitCode})`;
        const ok = exitCode === 0 && !timedOut && !killed && !quotaReason;
        const durationMs = Date.now() - start;

        let syncedFiles: string[] = [];
        if (finalBin === 'npm' || finalBin === 'bun' || finalBin === 'npx') {
          syncedFiles = await this.syncGeneratedFilesFromDiskAsync(projectId, workspaceDir);
          if (syncedFiles.length > 0) {
            invalidatePreviewCache(projectId);
          }
        }

        if (ok) {
          lastRuntimeErrors.set(projectId, null);
          this.appendLog(
            projectId,
            processName,
            'success',
            `${combined}\n[exit ${exitCode} · ${durationMs}ms · ${handle.driver}]`
          );
        } else {
          lastRuntimeErrors.set(
            projectId,
            `Command "${trimmed}" failed (exit ${exitCode}): ${cleanErr || combined}`.slice(0, 600)
          );
          this.appendLog(
            projectId,
            processName,
            'error',
            `${combined}\n[exit ${exitCode} · ${durationMs}ms · ${handle.driver}]`
          );
        }

        resolve({
          ok,
          output: combined,
          stdout: cleanOut,
          stderr: cleanErr,
          exitCode,
          durationMs,
          timedOut,
          killed,
          isolationDriver: handle.driver,
          ...(syncedFiles.length > 0 ? { syncedFiles } : {}),
        });
      };

      child.on('error', (err) => {
        stderr += err.message;
        void finalize(127);
      });

      child.on('close', (code) => {
        void finalize(typeof code === 'number' ? code : timedOut ? 124 : killed ? 137 : 1);
      });
    });
  }

  private collectGeneratedFilesFromDisk(
    workspaceDirArg?: string,
    projectId?: string
  ): Array<{ relPath: string; content: string; nextHash: string }> {
    const workspaceDir = workspaceDirArg || getWorkspacePaths(projectId!).workspaceDir;
    const rawMaxBytes = Number(process.env.CARMEN_MAX_FILE_BYTES || 512 * 1024);
    const maxFileBytes =
      Number.isFinite(rawMaxBytes) && rawMaxBytes >= 16 * 1024 && rawMaxBytes <= 5 * 1024 * 1024
        ? Math.floor(rawMaxBytes)
        : 512 * 1024;
    const candidates = ['package.json', 'package-lock.json', 'bun.lock'];
    const entries: Array<{ relPath: string; content: string; nextHash: string }> = [];
    for (const relPath of candidates) {
      const check = validateTenantWorkspacePath(workspaceDir, relPath, SANDBOX_DIR);
      if (!check.valid || !check.resolvedPath) continue;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(check.resolvedPath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFileBytes) continue;
      let buf: Buffer;
      try {
        buf = fs.readFileSync(check.resolvedPath);
      } catch {
        continue;
      }
      if (buf.includes(0)) continue;
      const content = buf.toString('utf8');
      const nextHash = crypto.createHash('sha256').update(content).digest('hex');
      entries.push({ relPath, content, nextHash });
    }
    return entries;
  }

  syncGeneratedFilesFromDisk(projectId: string, workspaceDirArg?: string): string[] {
    const rawMaxFiles = Number(process.env.CARMEN_MAX_PROJECT_FILES || 500);
    const maxFiles =
      Number.isFinite(rawMaxFiles) && rawMaxFiles >= 20 && rawMaxFiles <= 5000 ? Math.floor(rawMaxFiles) : 500;
    const candidates = this.collectGeneratedFilesFromDisk(workspaceDirArg, projectId);
    const changed: string[] = [];

    for (const item of candidates) {
      const existing = db
        .prepare('SELECT id, hash FROM project_files WHERE project_id = ? AND path = ?')
        .get(projectId, item.relPath) as { id: string; hash: string } | undefined;

      if (existing) {
        if (existing.hash === item.nextHash) continue;
        db.prepare(`UPDATE project_files SET content = ?, hash = ?, updated_at = datetime('now') WHERE id = ?`).run(
          item.content,
          item.nextHash,
          existing.id
        );
        changed.push(item.relPath);
      } else {
        const countRow = db
          .prepare('SELECT COUNT(*) as c FROM project_files WHERE project_id = ?')
          .get(projectId) as { c: number };
        if (countRow.c >= maxFiles) continue;
        db.prepare(`INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`).run(
          crypto.randomUUID(),
          projectId,
          item.relPath,
          item.content,
          item.nextHash
        );
        changed.push(item.relPath);
      }
    }

    if (changed.length > 0) {
      db.prepare(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`).run(projectId);
    }
    return changed;
  }

  async syncGeneratedFilesFromDiskAsync(projectId: string, workspaceDirArg?: string): Promise<string[]> {
    const rawMaxFiles = Number(process.env.CARMEN_MAX_PROJECT_FILES || 500);
    const maxFiles =
      Number.isFinite(rawMaxFiles) && rawMaxFiles >= 20 && rawMaxFiles <= 5000 ? Math.floor(rawMaxFiles) : 500;
    const candidates = this.collectGeneratedFilesFromDisk(workspaceDirArg, projectId);
    const changed: string[] = [];

    for (const item of candidates) {
      const existing = await asyncDb.get<{ id: string; hash: string }>(
        'SELECT id, hash FROM project_files WHERE project_id = ? AND path = ?',
        projectId,
        item.relPath
      );

      if (existing) {
        if (existing.hash === item.nextHash) continue;
        await asyncDb.run(
          `UPDATE project_files SET content = ?, hash = ?, updated_at = datetime('now') WHERE id = ?`,
          item.content,
          item.nextHash,
          existing.id
        );
        changed.push(item.relPath);
      } else {
        const countRow = await asyncDb.get<{ c: number | string }>(
          'SELECT COUNT(*) as c FROM project_files WHERE project_id = ?',
          projectId
        );
        if (Number(countRow?.c ?? 0) >= maxFiles) continue;
        await asyncDb.run(
          `INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          projectId,
          item.relPath,
          item.content,
          item.nextHash
        );
        changed.push(item.relPath);
      }
    }

    if (changed.length > 0) {
      await asyncDb.run(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`, projectId);
    }
    return changed;
  }

  private readDatabaseInspection(projectId: string): DatabaseTableInfo[] {
    const sdb = getSandboxDb(projectId);
    const tables = sdb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;

    return tables.map((t) => {
      if (!isSafeIdentifier(t.name)) {
        return { name: t.name, columns: [], rows: [], rowCount: 0 };
      }
      const pragma = sdb.prepare(`PRAGMA table_info("${t.name}")`).all() as Array<{ name: string }>;
      const columns = pragma.map((c) => c.name);
      const rows = sdb.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid DESC LIMIT 100`).all() as Record<
        string,
        unknown
      >[];
      const countRow = sdb.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get() as { c: number };
      return {
        name: t.name,
        columns,
        rows,
        rowCount: countRow.c,
      };
    });
  }

  inspectDatabase(projectId: string): DatabaseTableInfo[] {
    const sync = this.syncSchema(projectId);
    if (!sync.ok) {
      throw new Error(sync.error || 'Skema SQLite gagal disinkronkan.');
    }
    return this.readDatabaseInspection(projectId);
  }

  async inspectDatabaseAsync(projectId: string): Promise<DatabaseTableInfo[]> {
    const sync = await this.syncSchemaAsync(projectId);
    if (!sync.ok) {
      throw new Error(sync.error || 'Skema SQLite gagal disinkronkan.');
    }
    return this.readDatabaseInspection(projectId);
  }

  private executeTableQuery(projectId: string, table: string): Record<string, unknown>[] {
    const sdb = getSandboxDb(projectId);
    const pragma = sdb.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    const hasId = pragma.some((col) => col.name === 'id');
    const orderExpr = hasId ? 'id DESC' : 'rowid DESC';
    return sdb.prepare(`SELECT * FROM "${table}" ORDER BY ${orderExpr} LIMIT 200`).all() as Record<string, unknown>[];
  }

  private toSafeSqliteValue(v: unknown): string | number | null {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') return v;
    if (typeof v === 'bigint') return Number(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  private executeTableInsert(projectId: string, table: string, body: Record<string, unknown>): { id: number | bigint } {
    const sdb = getSandboxDb(projectId);
    const pragma = sdb.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    const validCols = new Set(pragma.map((c) => c.name));
    const entries = Object.entries(body).filter(([k]) => validCols.has(k) && k !== 'id');
    if (entries.length === 0) throw new Error('Tidak ada kolom valid untuk dimasukkan.');
    const cols = entries.map(([k]) => `"${k}"`).join(', ');
    const placeholders = entries.map(() => '?').join(', ');
    const values = entries.map(([, v]) => this.toSafeSqliteValue(v));
    const info = sdb.prepare(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`).run(...values);
    return { id: info.lastInsertRowid };
  }

  queryTable(projectId: string, table: string): Record<string, unknown>[] {
    if (!isSafeIdentifier(table)) throw new Error('Nama tabel tidak valid.');
    const sync = this.syncSchema(projectId);
    if (!sync.ok) throw new Error(sync.error || 'Skema database tidak valid.');
    return this.executeTableQuery(projectId, table);
  }

  async queryTableAsync(projectId: string, table: string): Promise<Record<string, unknown>[]> {
    if (!isSafeIdentifier(table)) throw new Error('Nama tabel tidak valid.');
    const sync = await this.syncSchemaAsync(projectId);
    if (!sync.ok) throw new Error(sync.error || 'Skema database tidak valid.');
    return this.executeTableQuery(projectId, table);
  }

  insertRow(projectId: string, table: string, body: Record<string, unknown>): { id: number | bigint } {
    if (!isSafeIdentifier(table)) throw new Error('Nama tabel tidak valid.');
    const sync = this.syncSchema(projectId);
    if (!sync.ok) throw new Error(sync.error || 'Skema database tidak valid.');
    return this.executeTableInsert(projectId, table, body);
  }

  async insertRowAsync(projectId: string, table: string, body: Record<string, unknown>): Promise<{ id: number | bigint }> {
    if (!isSafeIdentifier(table)) throw new Error('Nama tabel tidak valid.');
    const sync = await this.syncSchemaAsync(projectId);
    if (!sync.ok) throw new Error(sync.error || 'Skema database tidak valid.');
    return this.executeTableInsert(projectId, table, body);
  }

  private executeTableUpdate(projectId: string, table: string, id: string, body: Record<string, unknown>): void {
    const sdb = getSandboxDb(projectId);
    const pragma = sdb.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    const validCols = new Set(pragma.map((c) => c.name));
    const entries = Object.entries(body).filter(([k]) => validCols.has(k) && k !== 'id');
    if (entries.length === 0) return;
    const setSql = entries.map(([k]) => `"${k}" = ?`).join(', ');
    const values = entries.map(([, v]) => this.toSafeSqliteValue(v));
    sdb.prepare(`UPDATE "${table}" SET ${setSql} WHERE id = ?`).run(...values, id);
  }

  updateRow(projectId: string, table: string, id: string, body: Record<string, unknown>): void {
    if (!isSafeIdentifier(table)) throw new Error('Nama tabel tidak valid.');
    const sync = this.syncSchema(projectId);
    if (!sync.ok) throw new Error(sync.error || 'Skema database tidak valid.');
    this.executeTableUpdate(projectId, table, id, body);
  }

  async updateRowAsync(projectId: string, table: string, id: string, body: Record<string, unknown>): Promise<void> {
    if (!isSafeIdentifier(table)) throw new Error('Nama tabel tidak valid.');
    const sync = await this.syncSchemaAsync(projectId);
    if (!sync.ok) throw new Error(sync.error || 'Skema database tidak valid.');
    this.executeTableUpdate(projectId, table, id, body);
  }

  deleteRow(projectId: string, table: string, id: string): void {
    if (!isSafeIdentifier(table)) throw new Error('Nama tabel tidak valid.');
    const sync = this.syncSchema(projectId);
    if (!sync.ok) throw new Error(sync.error || 'Skema database tidak valid.');
    const sdb = getSandboxDb(projectId);
    sdb.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
  }

  async deleteRowAsync(projectId: string, table: string, id: string): Promise<void> {
    if (!isSafeIdentifier(table)) throw new Error('Nama tabel tidak valid.');
    const sync = await this.syncSchemaAsync(projectId);
    if (!sync.ok) throw new Error(sync.error || 'Skema database tidak valid.');
    const sdb = getSandboxDb(projectId);
    sdb.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
  }
}

export const projectRuntime = new IsolatedSandboxRuntime();

export interface DependencyInstallInspection {
  hasPackageJson: boolean;
  missingPackages: string[];
  allPackages: string[];
  packageManager: 'npm' | 'bun';
  packageJsonHash: string;
}

export interface DependencyInstallState {
  status: 'idle' | 'installing' | 'ready' | 'error';
  packageManager: 'npm' | 'bun';
  missingPackages: string[];
  error?: string;
  updatedAt: number;
}

export interface DependencyInstallResult {
  ok: boolean;
  installed: boolean;
  skipped?: boolean;
  packageManager: 'npm' | 'bun';
  missingPackages: string[];
  error?: string;
}

let cachedHostBunAvailable: boolean | null = null;
function defaultCheckBunAvailable(): boolean {
  const caps = detectSandboxIsolation();
  if (caps.driver === 'docker' || caps.driver === 'podman') {
    const image = (process.env.CARMEN_SANDBOX_IMAGE || 'node:22-alpine').toLowerCase();
    // Standard node:* sandbox images do not include bun; fall back to npm inside OCI containers
    if (!image.includes('bun')) {
      return false;
    }
  }
  if (cachedHostBunAvailable !== null) return cachedHostBunAvailable;
  try {
    const res = spawnSync('bun', ['--version'], { timeout: 2000, stdio: 'ignore' });
    cachedHostBunAvailable = res.status === 0 && !res.error;
  } catch {
    cachedHostBunAvailable = false;
  }
  return cachedHostBunAvailable;
}

const HOST_PROVIDED_PREVIEW_PACKAGES = new Set([
  'react',
  'react-dom',
  'lucide-react',
  'motion',
  '@monaco-editor/react',
  'monaco-editor',
  'express',
]);

function isPackagePresentInNodeModules(workspaceDir: string, pkgName: string): boolean {
  if (!pkgName || pkgName.includes('..') || pkgName.includes('\\')) return true;
  const parts = pkgName.split('/').filter(Boolean);
  if (parts.length === 0) return true;
  const pkgDir = path.join(workspaceDir, 'node_modules', ...parts);
  return fs.existsSync(path.join(pkgDir, 'package.json')) || fs.existsSync(pkgDir);
}

export function inspectMissingDependencies(
  workspaceDir: string,
  options?: { checkBunAvailable?: () => boolean }
): DependencyInstallInspection {
  const pkgPath = path.join(workspaceDir, 'package.json');
  let rawPkg: string;
  try {
    rawPkg = fs.readFileSync(pkgPath, 'utf8');
  } catch {
    return {
      hasPackageJson: false,
      missingPackages: [],
      allPackages: [],
      packageManager: 'npm',
      packageJsonHash: '',
    };
  }

  let parsed: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    parsed = JSON.parse(rawPkg) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  } catch {
    return {
      hasPackageJson: false,
      missingPackages: [],
      allPackages: [],
      packageManager: 'npm',
      packageJsonHash: '',
    };
  }

  const runtimeDeps = Object.keys(parsed.dependencies || {});
  const devDeps = Object.keys(parsed.devDependencies || {});
  const toCheck = runtimeDeps.filter((pkg) => !HOST_PROVIDED_PREVIEW_PACKAGES.has(pkg));
  const allPackages = Array.from(new Set([...runtimeDeps, ...devDeps]));

  const missingPackages: string[] = [];
  for (const pkg of toCheck) {
    if (!isPackagePresentInNodeModules(workspaceDir, pkg)) {
      missingPackages.push(pkg);
    }
  }

  const hasBunLock =
    fs.existsSync(path.join(workspaceDir, 'bun.lock')) || fs.existsSync(path.join(workspaceDir, 'bun.lockb'));
  const checkBun = options?.checkBunAvailable ?? defaultCheckBunAvailable;
  const packageManager: 'npm' | 'bun' = hasBunLock && checkBun() ? 'bun' : 'npm';
  const packageJsonHash = crypto.createHash('sha256').update(rawPkg).digest('hex').slice(0, 16);

  return {
    hasPackageJson: true,
    missingPackages,
    allPackages,
    packageManager,
    packageJsonHash,
  };
}

const dependencyInstallStates = new Map<string, DependencyInstallState>();
const inflightDependencyInstalls = new Map<string, Promise<DependencyInstallResult>>();
const failedInstallPackageHashes = new Map<string, { hash: string; error: string }>();

export function getDependencyInstallState(projectId: string): DependencyInstallState {
  return (
    dependencyInstallStates.get(projectId) ?? {
      status: 'idle',
      packageManager: 'npm',
      missingPackages: [],
      updatedAt: 0,
    }
  );
}

export function invalidateDependencyInstallState(projectId: string): void {
  dependencyInstallStates.delete(projectId);
  failedInstallPackageHashes.delete(projectId);
}

export async function ensureProjectDependenciesInstalled(
  projectId: string,
  options?: {
    runner?: (projectId: string, cmd: string) => Promise<CommandExecutionResult>;
    checkBunAvailable?: () => boolean;
    forceRetry?: boolean;
  }
): Promise<DependencyInstallResult> {
  const inflight = inflightDependencyInstalls.get(projectId);
  if (inflight) return inflight;

  const promise = (async (): Promise<DependencyInstallResult> => {
      try {
        const workspaceDir = await projectRuntime.syncWorkspaceToDiskAsync(projectId);
        const inspection = inspectMissingDependencies(workspaceDir, {
          checkBunAvailable: options?.checkBunAvailable,
        });

        if (!inspection.hasPackageJson || inspection.missingPackages.length === 0) {
          dependencyInstallStates.set(projectId, {
            status: 'ready',
            packageManager: inspection.packageManager,
            missingPackages: [],
            updatedAt: Date.now(),
          });
          failedInstallPackageHashes.delete(projectId);
          return {
            ok: true,
            installed: false,
            skipped: true,
            packageManager: inspection.packageManager,
            missingPackages: [],
          };
        }

        const prevFail = failedInstallPackageHashes.get(projectId);
        if (!options?.forceRetry && prevFail && prevFail.hash === inspection.packageJsonHash) {
          dependencyInstallStates.set(projectId, {
            status: 'error',
            packageManager: inspection.packageManager,
            missingPackages: inspection.missingPackages,
            error: prevFail.error,
            updatedAt: Date.now(),
          });
          return {
            ok: false,
            installed: false,
            skipped: true,
            packageManager: inspection.packageManager,
            missingPackages: inspection.missingPackages,
            error: prevFail.error,
          };
        }

        const hasPackageLock = fs.existsSync(path.join(workspaceDir, 'package-lock.json'));
        const hasNodeModules = fs.existsSync(path.join(workspaceDir, 'node_modules'));
        const installCmd =
          inspection.packageManager === 'bun'
            ? 'bun install'
            : hasPackageLock && !hasNodeModules
              ? 'npm ci --no-audit --no-fund --ignore-scripts'
              : 'npm install --no-audit --no-fund --ignore-scripts';
        dependencyInstallStates.set(projectId, {
          status: 'installing',
          packageManager: inspection.packageManager,
          missingPackages: inspection.missingPackages,
          updatedAt: Date.now(),
        });
        projectRuntime.appendLog(
          projectId,
          'install',
          'info',
          `Memasang dependensi otomatis (${installCmd}) untuk: ${inspection.missingPackages.join(', ')}`
        );

        const runInstall =
          options?.runner ??
          ((id: string, cmd: string) => projectRuntime.runCommandAsync(id, cmd, { timeoutMs: INSTALL_CMD_TIMEOUT_MS }));

        try {
          const res = await runInstall(projectId, installCmd);
          if (res.ok) {
            failedInstallPackageHashes.delete(projectId);
            const postInspection = inspectMissingDependencies(workspaceDir, {
              checkBunAvailable: options?.checkBunAvailable,
            });
            dependencyInstallStates.set(projectId, {
              status: 'ready',
              packageManager: inspection.packageManager,
              missingPackages: postInspection.missingPackages,
              updatedAt: Date.now(),
            });
            invalidatePreviewCache(projectId);
            return {
              ok: true,
              installed: true,
              packageManager: inspection.packageManager,
              missingPackages: postInspection.missingPackages,
            };
          }
          const errMsg = scrubSecrets(res.stderr || res.output || `${installCmd} gagal (exit ${res.exitCode})`);
          failedInstallPackageHashes.set(projectId, { hash: inspection.packageJsonHash, error: errMsg });
          dependencyInstallStates.set(projectId, {
            status: 'error',
            packageManager: inspection.packageManager,
            missingPackages: inspection.missingPackages,
            error: errMsg,
            updatedAt: Date.now(),
          });
          return {
            ok: false,
            installed: false,
            packageManager: inspection.packageManager,
            missingPackages: inspection.missingPackages,
            error: errMsg,
          };
        } catch (err) {
          const errMsg = scrubSecrets(err instanceof Error ? err.message : String(err));
          failedInstallPackageHashes.set(projectId, { hash: inspection.packageJsonHash, error: errMsg });
          dependencyInstallStates.set(projectId, {
            status: 'error',
            packageManager: inspection.packageManager,
            missingPackages: inspection.missingPackages,
            error: errMsg,
            updatedAt: Date.now(),
          });
          return {
            ok: false,
            installed: false,
            packageManager: inspection.packageManager,
            missingPackages: inspection.missingPackages,
            error: errMsg,
          };
        }
      } catch (outerErr) {
        const errMsg = scrubSecrets(outerErr instanceof Error ? outerErr.message : String(outerErr));
        dependencyInstallStates.set(projectId, {
          status: 'error',
          packageManager: 'npm',
          missingPackages: [],
          error: errMsg,
          updatedAt: Date.now(),
        });
        return {
          ok: false,
          installed: false,
          packageManager: 'npm',
          missingPackages: [],
          error: errMsg,
        };
      } finally {
        inflightDependencyInstalls.delete(projectId);
      }
  })();

  inflightDependencyInstalls.set(projectId, promise);
  return promise;
}

export function triggerProjectDependenciesInstallIfNeeded(
  projectId: string,
  options?: {
    runner?: (projectId: string, cmd: string) => Promise<CommandExecutionResult>;
    checkBunAvailable?: () => boolean;
  }
): { started: boolean; state: DependencyInstallState; inspection: DependencyInstallInspection } {
  const workspaceDir = projectRuntime.syncWorkspaceToDisk(projectId);
  return triggerInstallFromWorkspaceDir(projectId, workspaceDir, options);
}

export async function triggerProjectDependenciesInstallIfNeededAsync(
  projectId: string,
  options?: {
    runner?: (projectId: string, cmd: string) => Promise<CommandExecutionResult>;
    checkBunAvailable?: () => boolean;
  }
): Promise<{ started: boolean; state: DependencyInstallState; inspection: DependencyInstallInspection }> {
  const workspaceDir = await projectRuntime.syncWorkspaceToDiskAsync(projectId);
  return triggerInstallFromWorkspaceDir(projectId, workspaceDir, options);
}

function triggerInstallFromWorkspaceDir(
  projectId: string,
  workspaceDir: string,
  options?: {
    runner?: (projectId: string, cmd: string) => Promise<CommandExecutionResult>;
    checkBunAvailable?: () => boolean;
  }
): { started: boolean; state: DependencyInstallState; inspection: DependencyInstallInspection } {
  const inspection = inspectMissingDependencies(workspaceDir, {
    checkBunAvailable: options?.checkBunAvailable,
  });

  if (!inspection.hasPackageJson || inspection.missingPackages.length === 0) {
    const readyState: DependencyInstallState = {
      status: 'ready',
      packageManager: inspection.packageManager,
      missingPackages: [],
      updatedAt: Date.now(),
    };
    dependencyInstallStates.set(projectId, readyState);
    return { started: false, state: readyState, inspection };
  }

  if (inflightDependencyInstalls.has(projectId)) {
    return { started: false, state: getDependencyInstallState(projectId), inspection };
  }

  const prevFail = failedInstallPackageHashes.get(projectId);
  if (prevFail && prevFail.hash === inspection.packageJsonHash) {
    return { started: false, state: getDependencyInstallState(projectId), inspection };
  }

  void ensureProjectDependenciesInstalled(projectId, options);
  return { started: true, state: getDependencyInstallState(projectId), inspection };
}

