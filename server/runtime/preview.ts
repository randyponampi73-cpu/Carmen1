import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';
import type { ProjectArchitectureInfo } from '../../src/types';
import { asyncDb, db, SANDBOX_DIR } from '../db';
import { normalizeProjectPath, scrubSecrets } from '../security';
import { stopProjectContainers } from './isolation';
import {
  ensureProjectDependenciesInstalled,
  getDependencyInstallState,
  inspectMissingDependencies,
  triggerProjectDependenciesInstallIfNeededAsync,
} from './sandbox';

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const TEXT_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.mts',
  '.cts',
  '.json',
  '.webmanifest',
  '.svg',
  '.txt',
  '.md',
  '.xml',
  '.map',
]);

const SENSITIVE_PREVIEW_BASENAMES = new Set(['.env', '.env.local', '.env.production', '.env.development', '.npmrc']);

const SAFE_BROWSER_PACKAGES = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'lucide-react',
  'motion',
  'motion/react',
  '@monaco-editor/react',
  '@monaco-editor/loader',
  'monaco-editor',
  'state-local',
]);

const SAFE_TRANSITIVE_BROWSER_PACKAGES = new Set([
  'react',
  'react-dom',
  'scheduler',
  'motion-dom',
  'motion-utils',
  'tslib',
  'clsx',
  '@monaco-editor/loader',
  'state-local',
]);

const HOST_NODE_MODULES_DIR = (() => {
  try {
    return fs.realpathSync(path.resolve(process.cwd(), 'node_modules'));
  } catch {
    return path.resolve(process.cwd(), 'node_modules');
  }
})();

const BLOCKED_NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
]);

interface CachedBundle {
  ok: boolean;
  code?: string;
  error?: string;
}

const bundleCache = new Map<string, CachedBundle>();
const MAX_BUNDLE_CACHE = 48;

const cssCache = new Map<string, { ok: boolean; css?: string; error?: string }>();
const MAX_CSS_CACHE = 48;

const hostRequire = createRequire(import.meta.url);

export function getPreviewMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function invalidatePreviewCache(projectId: string): void {
  const prefix = `${projectId}:`;
  for (const key of bundleCache.keys()) {
    if (key.startsWith(prefix)) bundleCache.delete(key);
  }
  for (const key of cssCache.keys()) {
    if (key.startsWith(prefix)) cssCache.delete(key);
  }
}

function buildProjectArchitectureFromPaths(paths: string[]): ProjectArchitectureInfo {
  const pathSet = new Set(paths);

  const frontendEntry = pathSet.has('index.html')
    ? 'index.html'
    : pathSet.has('client/index.html')
      ? 'client/index.html'
      : null;

  const hasSchemaSql = pathSet.has('schema.sql') || paths.some((p) => p.toLowerCase().endsWith('.sql'));
  const backendCandidates = [
    'server.ts',
    'server/index.ts',
    'server/index.js',
    'server.js',
    'src/server.ts',
    'api/index.ts',
    'api/index.js',
  ];
  const backendEntry =
    backendCandidates.find((c) => pathSet.has(c)) ||
    paths.find((p) => /^(?:server|api)\/.+\.(?:ts|js|mjs|mts)$/i.test(p) && !/\.test\.|\.spec\./i.test(p)) ||
    null;

  const hasCustomBackend = Boolean(backendEntry);
  const hasModularFrontend =
    pathSet.has('package.json') || paths.some((p) => p.startsWith('src/') || p.startsWith('client/'));

  const stackKind: ProjectArchitectureInfo['stackKind'] = hasCustomBackend
    ? 'fullstack-custom-backend'
    : hasSchemaSql
      ? 'sqlite-crud'
      : hasModularFrontend
        ? 'modular-spa'
        : 'static';

  return {
    stackKind,
    hasFrontend: Boolean(frontendEntry),
    frontendEntry,
    hasSchemaSql,
    hasCustomBackend,
    backendEntry,
  };
}

export function detectProjectArchitecture(projectId: string): ProjectArchitectureInfo {
  const rows = db
    .prepare('SELECT path FROM project_files WHERE project_id = ? ORDER BY path ASC')
    .all(projectId) as Array<{ path: string }>;
  return buildProjectArchitectureFromPaths(rows.map((r) => r.path));
}

export async function detectProjectArchitectureAsync(projectId: string): Promise<ProjectArchitectureInfo> {
  const rows = await asyncDb.all<{ path: string }>(
    'SELECT path FROM project_files WHERE project_id = ? ORDER BY path ASC',
    projectId
  );
  return buildProjectArchitectureFromPaths(rows.map((r) => r.path));
}

export type PreviewLifecycleState = 'active' | 'sleeping' | 'waking';

export interface PreviewSessionRecord {
  projectId: string;
  userId: string;
  state: PreviewLifecycleState;
  lastActivityAt: number;
  sleepAt?: number;
  wakeCount: number;
}

export interface PreviewTouchResult {
  state: PreviewLifecycleState;
  wokeFromSleep: boolean;
  lastActivityAt: number;
  idleTimeoutMs: number;
  evictedProjectIds: string[];
}

export function getPreviewIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PREVIEW_IDLE_TIMEOUT_MS || 900_000);
  if (Number.isFinite(raw) && raw >= 1_000 && raw <= 86_400_000) {
    return Math.floor(raw);
  }
  return 900_000;
}

export function getMaxConcurrentPreviewsPerUser(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PREVIEW_MAX_CONCURRENT_PER_USER || 3);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 50) {
    return Math.floor(raw);
  }
  return 3;
}

class PreviewLifecycleManager {
  private readonly sessions = new Map<string, PreviewSessionRecord>();
  private reaperTimer: NodeJS.Timeout | null = null;

  getSession(projectId: string): PreviewSessionRecord | null {
    return this.sessions.get(projectId) ?? null;
  }

  listSessions(): PreviewSessionRecord[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Records preview activity, enforces PREVIEW_MAX_CONCURRENT_PER_USER by sleeping the oldest active
   * sibling preview for that user if needed, and seamlessly wakes sleeping previews without losing files.
   */
  touchPreviewSession(
    projectId: string,
    userId: string,
    nowMs = Date.now(),
    maxConcurrent = getMaxConcurrentPreviewsPerUser()
  ): PreviewTouchResult {
    const idleTimeoutMs = getPreviewIdleTimeoutMs();
    const existing = this.sessions.get(projectId);
    const wokeFromSleep = existing?.state === 'sleeping';

    const evictedProjectIds: string[] = [];
    if (!existing || existing.state !== 'active') {
      const otherActive = Array.from(this.sessions.values())
        .filter((s) => s.userId === userId && s.projectId !== projectId && s.state === 'active')
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);

      const excessCount = otherActive.length - Math.max(0, maxConcurrent - 1);
      for (let i = 0; i < excessCount; i += 1) {
        const victim = otherActive[i];
        if (victim) {
          this.sleepPreviewSession(victim.projectId, nowMs);
          evictedProjectIds.push(victim.projectId);
        }
      }
    }

    const updated: PreviewSessionRecord = {
      projectId,
      userId,
      state: 'active',
      lastActivityAt: nowMs,
      wakeCount: (existing?.wakeCount ?? 0) + (wokeFromSleep ? 1 : 0),
    };
    this.sessions.set(projectId, updated);

    return {
      state: updated.state,
      wokeFromSleep,
      lastActivityAt: updated.lastActivityAt,
      idleTimeoutMs,
      evictedProjectIds,
    };
  }

  /**
   * Puts an idle or evicted preview into sleep mode: stops active sandbox processes/containers
   * and frees bundle/CSS memory caches while keeping all project source files intact.
   */
  sleepPreviewSession(projectId: string, nowMs = Date.now()): boolean {
    const existing = this.sessions.get(projectId);
    if (!existing) {
      return false;
    }
    if (existing.state !== 'sleeping') {
      existing.state = 'sleeping';
      existing.sleepAt = nowMs;
      invalidatePreviewCache(projectId);
      stopProjectContainers(projectId);
      return true;
    }
    return false;
  }

  /**
   * Sweeps active preview sessions and sleeps any whose lastActivityAt exceeds idleTimeoutMs.
   */
  reapIdlePreviews(nowMs = Date.now(), idleTimeoutMs = getPreviewIdleTimeoutMs()): string[] {
    const slept: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.state === 'active' && nowMs - session.lastActivityAt >= idleTimeoutMs) {
        if (this.sleepPreviewSession(session.projectId, nowMs)) {
          slept.push(session.projectId);
        }
      }
    }
    return slept;
  }

  removeProjectSession(projectId: string): void {
    this.sessions.delete(projectId);
  }

  startReaper(intervalMs = 60_000): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      this.reapIdlePreviews();
    }, intervalMs);
    this.reaperTimer.unref();
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  resetForTest(): void {
    this.stopReaper();
    this.sessions.clear();
  }
}

export const previewLifecycleManager = new PreviewLifecycleManager();

export function getProjectWorkspaceDir(projectId: string): string {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('ID proyek tidak valid.');
  return path.join(SANDBOX_DIR, safeId, 'workspace');
}

function computeSourceHashFromRows(rows: Array<{ path: string; hash: string }>): string {
  const hasher = crypto.createHash('sha256');
  for (const row of rows) {
    hasher.update(row.path);
    hasher.update(':');
    hasher.update(row.hash);
    hasher.update('\n');
  }
  return hasher.digest('hex').slice(0, 16);
}

export function computeProjectSourceHash(projectId: string): string {
  const rows = db
    .prepare('SELECT path, hash FROM project_files WHERE project_id = ? ORDER BY path')
    .all(projectId) as Array<{ path: string; hash: string }>;
  return computeSourceHashFromRows(rows);
}

export async function computeProjectSourceHashAsync(projectId: string): Promise<string> {
  const rows = await asyncDb.all<{ path: string; hash: string }>(
    'SELECT path, hash FROM project_files WHERE project_id = ? ORDER BY path',
    projectId
  );
  return computeSourceHashFromRows(rows);
}

function isSensitivePreviewPath(normPath: string): boolean {
  const lower = normPath.toLowerCase();
  const base = path.posix.basename(lower);
  if (SENSITIVE_PREVIEW_BASENAMES.has(base) || base.startsWith('.env.')) return true;
  if (lower.startsWith('.git/') || lower === '.git') return true;
  if (lower.startsWith('node_modules/') || lower === 'node_modules') return true;
  if (lower.startsWith('.carmen-runtime/') || lower === '.carmen-runtime') return true;
  if (lower.endsWith('.db') || lower.endsWith('.sqlite') || lower.endsWith('.sqlite3')) return true;
  return false;
}

function readConfinedFile(baseDir: string, relPath: string): Buffer | null {
  let realBase: string;
  try {
    realBase = fs.realpathSync(baseDir);
  } catch {
    return null;
  }
  const target = path.resolve(realBase, relPath);
  if (!target.startsWith(realBase + path.sep)) return null;
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const realTarget = fs.realpathSync(target);
    if (!realTarget.startsWith(realBase + path.sep)) return null;
    return fs.readFileSync(realTarget);
  } catch {
    return null;
  }
}

function getLatestSourceMtimeMs(workspaceDir: string): number {
  let latest = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (
        ent.name === 'node_modules' ||
        ent.name === 'dist' ||
        ent.name === '.git' ||
        ent.name === '.carmen-runtime' ||
        ent.isSymbolicLink()
      ) {
        continue;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs > latest) latest = st.mtimeMs;
        } catch {
          // Ignore transient stat failure
        }
      }
    }
  };
  walk(workspaceDir);
  return latest;
}

export function isFreshDistAvailable(workspaceDir: string): boolean {
  const candidates = [
    path.join(workspaceDir, 'dist', 'index.html'),
    path.join(workspaceDir, 'dist', 'client', 'index.html'),
    path.join(workspaceDir, 'client', 'dist', 'index.html'),
  ];
  const latestSource = getLatestSourceMtimeMs(workspaceDir);
  for (const distIndex of candidates) {
    try {
      const st = fs.statSync(distIndex);
      if (st.isFile() && st.size > 0 && st.mtimeMs >= latestSource) {
        return true;
      }
    } catch {
      // Probe next dist directory
    }
  }
  return false;
}

async function resolveFileBytesAsync(
  projectId: string,
  normPath: string,
  workspaceDir: string,
  useDist: boolean
): Promise<{ buffer: Buffer; source: 'dist' | 'db' | 'disk'; resolvedPath: string } | null> {
  if (isSensitivePreviewPath(normPath)) return null;

  if (useDist) {
    const distDir = path.join(workspaceDir, 'dist');
    const distBuf = readConfinedFile(distDir, normPath);
    if (distBuf !== null) {
      return { buffer: distBuf, source: 'dist', resolvedPath: `dist/${normPath}` };
    }
    if (!normPath.startsWith('client/')) {
      const distClientBuf = readConfinedFile(path.join(distDir, 'client'), normPath);
      if (distClientBuf !== null) {
        return { buffer: distClientBuf, source: 'dist', resolvedPath: `dist/client/${normPath}` };
      }
      const clientDistBuf = readConfinedFile(path.join(workspaceDir, 'client', 'dist'), normPath);
      if (clientDistBuf !== null) {
        return { buffer: clientDistBuf, source: 'dist', resolvedPath: `client/dist/${normPath}` };
      }
    }
  }

  const dbRow = await asyncDb.get<{ content: string }>(
    'SELECT content FROM project_files WHERE project_id = ? AND path = ?',
    projectId,
    normPath
  );
  if (dbRow) {
    return {
      buffer: Buffer.from(dbRow.content, 'utf8'),
      source: 'db',
      resolvedPath: normPath,
    };
  }

  // Fallback check under public/<normPath> in DB (Vite convention for /favicon.svg, /logo.png, etc.)
  const publicNorm = `public/${normPath}`;
  const dbPublicRow = await asyncDb.get<{ content: string }>(
    'SELECT content FROM project_files WHERE project_id = ? AND path = ?',
    projectId,
    publicNorm
  );
  if (dbPublicRow) {
    return {
      buffer: Buffer.from(dbPublicRow.content, 'utf8'),
      source: 'db',
      resolvedPath: publicNorm,
    };
  }

  // Binary or generated workspace assets on disk (public/* or root inside workspaceDir)
  const diskBuf = readConfinedFile(workspaceDir, normPath);
  if (diskBuf !== null) {
    return { buffer: diskBuf, source: 'disk', resolvedPath: normPath };
  }
  const diskPublicBuf = readConfinedFile(path.join(workspaceDir, 'public'), normPath);
  if (diskPublicBuf !== null) {
    return { buffer: diskPublicBuf, source: 'disk', resolvedPath: publicNorm };
  }

  // Full-stack monorepo fallback: client/<normPath> and client/public/<normPath>
  if (!normPath.startsWith('client/')) {
    const clientNorm = `client/${normPath}`;
    const dbClientRow = await asyncDb.get<{ content: string }>(
      'SELECT content FROM project_files WHERE project_id = ? AND path = ?',
      projectId,
      clientNorm
    );
    if (dbClientRow) {
      return {
        buffer: Buffer.from(dbClientRow.content, 'utf8'),
        source: 'db',
        resolvedPath: clientNorm,
      };
    }

    const clientPublicNorm = `client/public/${normPath}`;
    const dbClientPublicRow = await asyncDb.get<{ content: string }>(
      'SELECT content FROM project_files WHERE project_id = ? AND path = ?',
      projectId,
      clientPublicNorm
    );
    if (dbClientPublicRow) {
      return {
        buffer: Buffer.from(dbClientPublicRow.content, 'utf8'),
        source: 'db',
        resolvedPath: clientPublicNorm,
      };
    }

    const diskClientBuf = readConfinedFile(path.join(workspaceDir, 'client'), normPath);
    if (diskClientBuf !== null) {
      return { buffer: diskClientBuf, source: 'disk', resolvedPath: clientNorm };
    }
    const diskClientPublicBuf = readConfinedFile(path.join(workspaceDir, 'client', 'public'), normPath);
    if (diskClientPublicBuf !== null) {
      return { buffer: diskClientPublicBuf, source: 'disk', resolvedPath: clientPublicNorm };
    }
  }

  return null;
}

function rewriteRootRelativeUrlsInHtml(html: string, previewBasePath: string): string {
  // Rewrite root-relative src="/...", href="/...", poster="/...", action="/..." (skip //protocol-relative & /preview/)
  const rewritten = html.replace(
    /\b(src|href|poster|action)=(["'])\/(?!\/|preview\/)([^"']*)\2/gi,
    (_m, attr: string, quote: string, rest: string) => `${attr}=${quote}${previewBasePath}${rest}${quote}`
  );
  // Also rewrite CSS url('/...') in inline <style> blocks
  return rewritten.replace(
    /url\(\s*(['"]?)\/(?!\/|preview\/)([^)'"]*)\1\s*\)/gi,
    (_m, quote: string, rest: string) => `url(${quote}${previewBasePath}${rest}${quote})`
  );
}

function rewriteRootRelativeUrlsInCss(css: string, previewBasePath: string): string {
  return css.replace(
    /url\(\s*(['"]?)\/(?!\/|preview\/)([^)'"]*)\1\s*\)/gi,
    (_m, quote: string, rest: string) => `url(${quote}${previewBasePath}${rest}${quote})`
  );
}

function extractLocalSubPath(rawUrl: string, previewBasePath: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || /^(https?:\/\/|\/\/|data:|blob:|mailto:|#)/i.test(trimmed)) {
    return null;
  }
  let rel = trimmed;
  if (rel.startsWith(previewBasePath)) {
    rel = rel.slice(previewBasePath.length);
  }
  rel = rel.replace(/^\.?\//, '').split(/[?#]/)[0];
  return normalizeProjectPath(rel);
}

async function inlineLocalUrlsInCssAsync(
  css: string,
  projectId: string,
  workspaceDir: string,
  previewBasePath: string,
  useDist: boolean
): Promise<string> {
  const regex = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
  const matches = Array.from(css.matchAll(regex));
  if (matches.length === 0) return css;

  const resolvedMap = new Map<string, { norm: string; dataUri: string }>();
  for (const m of matches) {
    const rawRef = m[2];
    const norm = extractLocalSubPath(rawRef, previewBasePath);
    if (!norm || resolvedMap.has(norm)) continue;
    const found = await resolveFileBytesAsync(projectId, norm, workspaceDir, useDist);
    if (!found || found.buffer.length > 512 * 1024) continue;
    const mime = getPreviewMimeType(norm);
    resolvedMap.set(norm, {
      norm,
      dataUri: `data:${mime};base64,${found.buffer.toString('base64')}`,
    });
  }

  return css.replace(regex, (full, quote: string, rawRef: string) => {
    const norm = extractLocalSubPath(rawRef, previewBasePath);
    if (!norm) return full;
    const hit = resolvedMap.get(norm);
    if (!hit) return full;
    return `url(${quote}${hit.dataUri}${quote})`;
  });
}

async function extractTailwindCandidatesAsync(projectId: string, workspaceDir: string): Promise<string[]> {
  const tokenSet = new Set<string>();
  const rows = await asyncDb.all<{ path: string; content: string }>(
    'SELECT path, content FROM project_files WHERE project_id = ?',
    projectId
  );

  const collectFromText = (text: string) => {
    const matches = text.match(/[A-Za-z0-9_:/.\-[\]()#%!]+/g);
    if (!matches) return;
    for (const m of matches) {
      if (m.length <= 80) tokenSet.add(m);
    }
  };

  for (const row of rows) {
    const ext = path.extname(row.path).toLowerCase();
    if (['.html', '.htm', '.tsx', '.ts', '.jsx', '.js', '.mjs'].includes(ext)) {
      collectFromText(row.content);
    }
  }

  if (tokenSet.size === 0 && fs.existsSync(workspaceDir)) {
    const indexBuf =
      readConfinedFile(workspaceDir, 'index.html') || readConfinedFile(workspaceDir, 'client/index.html');
    if (indexBuf) collectFromText(indexBuf.toString('utf8'));
  }

  return Array.from(tokenSet);
}

async function compileCssForPreview(
  projectId: string,
  cssPath: string,
  rawCss: string,
  workspaceDir: string,
  previewBasePath: string,
  sourceHash: string
): Promise<{ ok: boolean; css?: string; error?: string }> {
  const cacheKey = `${projectId}:css:${cssPath}:${sourceHash}:${previewBasePath}`;
  const cached = cssCache.get(cacheKey);
  if (cached) return cached;

  let processed = rawCss;
  const usesTailwindV4 = /@import\s+["']tailwindcss["']/.test(rawCss);
  const usesTailwindV3 = /@tailwind\s+(base|components|utilities)\b/.test(rawCss);

  if (usesTailwindV4 || usesTailwindV3) {
    try {
      const normalizedCss = usesTailwindV3
        ? rawCss.replace(/@tailwind\s+(base|components|utilities)\s*;?/g, '')
        : rawCss;
      const tailwindInput = usesTailwindV3 ? `@import "tailwindcss";\n${normalizedCss}` : normalizedCss;
      const { compile } = await import('@tailwindcss/node');
      const compiler = await compile(tailwindInput, {
        base: process.cwd(),
        onDependency() {
          // Tracked via sourceHash
        },
      });
      const candidates = await extractTailwindCandidatesAsync(projectId, workspaceDir);
      processed = compiler.build(candidates);
    } catch (err) {
      const msg = scrubSecrets(err instanceof Error ? err.message : String(err));
      const res = { ok: false, error: `Gagal mengompilasi CSS (${cssPath}): ${msg}` };
      if (cssCache.size >= MAX_CSS_CACHE) {
        const first = cssCache.keys().next().value;
        if (first) cssCache.delete(first);
      }
      cssCache.set(cacheKey, res);
      return res;
    }
  }

  processed = rewriteRootRelativeUrlsInCss(processed, previewBasePath);
  processed = await inlineLocalUrlsInCssAsync(processed, projectId, workspaceDir, previewBasePath, false);
  const out = { ok: true, css: processed };
  if (cssCache.size >= MAX_CSS_CACHE) {
    const first = cssCache.keys().next().value;
    if (first) cssCache.delete(first);
  }
  cssCache.set(cacheKey, out);
  return out;
}

function resolveInsideWorkspace(realWorkspaceDir: string, importerDir: string, specifier: string): string | null {
  const baseDir = specifier.startsWith('/') ? realWorkspaceDir : importerDir;
  const rawSpec = specifier.startsWith('/') ? specifier.slice(1) : specifier;
  const cleanSpec = rawSpec.split(/[?#]/)[0];
  const candidateBase = path.resolve(baseDir, cleanSpec);
  if (!candidateBase.startsWith(realWorkspaceDir + path.sep) && candidateBase !== realWorkspaceDir) {
    return null;
  }

  const allowContainedSymlinks = realOrSame(importerDir).split(path.sep).includes('node_modules');

  const probes = [
    candidateBase,
    `${candidateBase}.tsx`,
    `${candidateBase}.ts`,
    `${candidateBase}.jsx`,
    `${candidateBase}.js`,
    `${candidateBase}.mjs`,
    `${candidateBase}.json`,
    `${candidateBase}.css`,
    path.join(candidateBase, 'index.tsx'),
    path.join(candidateBase, 'index.ts'),
    path.join(candidateBase, 'index.jsx'),
    path.join(candidateBase, 'index.js'),
    path.join(candidateBase, 'index.mjs'),
  ];

  for (const probe of probes) {
    try {
      const lstat = fs.lstatSync(probe);
      if (lstat.isSymbolicLink() && !allowContainedSymlinks) continue;
      const real = fs.realpathSync(probe);
      const stat = fs.statSync(real);
      if (!stat.isFile()) continue;
      if (real.startsWith(realWorkspaceDir + path.sep)) {
        return real;
      }
    } catch {
      // Probe next extension
    }
  }
  return null;
}

function isAllowedSafeBrowserPackage(specifier: string): boolean {
  if (specifier.includes('..') || specifier.includes('\\')) return false;
  if (SAFE_BROWSER_PACKAGES.has(specifier)) return true;
  if (
    specifier.startsWith('react/') ||
    specifier.startsWith('react-dom/') ||
    specifier.startsWith('lucide-react/') ||
    specifier.startsWith('motion/') ||
    specifier.startsWith('monaco-editor/') ||
    specifier.startsWith('@monaco-editor/react/')
  ) {
    return true;
  }
  return false;
}

function isInsideDir(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function realOrSame(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function topLevelPackageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function extractConditionalExport(node: unknown): string | null {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = extractConditionalExport(item);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    for (const key of ['browser', 'import', 'module', 'default', 'require', 'style']) {
      if (key in rec) {
        const hit = extractConditionalExport(rec[key]);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function resolvePackageSubpathFromDir(pkgDir: string, subPath: string, realWorkspaceDir: string): string | null {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  const exportKey = subPath ? `./${subPath}` : '.';

  const verifyFile = (relOrAbs: string): string | null => {
    const candidate = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(pkgDir, relOrAbs);
    const probes = [
      candidate,
      `${candidate}.mjs`,
      `${candidate}.js`,
      `${candidate}.css`,
      path.join(candidate, 'index.mjs'),
      path.join(candidate, 'index.js'),
    ];
    for (const p of probes) {
      try {
        const real = fs.realpathSync(p);
        if (fs.statSync(real).isFile() && isInsideDir(real, realWorkspaceDir)) {
          return real;
        }
      } catch {
        // try next
      }
    }
    return null;
  };

  try {
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        exports?: unknown;
        browser?: unknown;
        module?: string;
        main?: string;
      };
      if (pkg.exports) {
        let target: string | null = null;
        if (typeof pkg.exports === 'string') {
          if (exportKey === '.') target = pkg.exports;
        } else if (typeof pkg.exports === 'object' && pkg.exports !== null) {
          const expObj = pkg.exports as Record<string, unknown>;
          if (exportKey in expObj) {
            target = extractConditionalExport(expObj[exportKey]);
          } else if (exportKey === '.' && !Object.keys(expObj).some((k) => k.startsWith('.'))) {
            target = extractConditionalExport(expObj);
          } else {
            for (const [pattern, val] of Object.entries(expObj)) {
              if (!pattern.includes('*')) continue;
              const [prefix, suffix] = pattern.split('*');
              if (exportKey.startsWith(prefix) && exportKey.endsWith(suffix)) {
                const wildcard = exportKey.slice(prefix.length, exportKey.length - suffix.length);
                const rawTarget = extractConditionalExport(val);
                if (rawTarget) {
                  target = rawTarget.replace(/\*/g, wildcard);
                  break;
                }
              }
            }
          }
        }
        if (target) {
          const hit = verifyFile(target);
          if (hit) return hit;
        }
      }

      if (exportKey === '.') {
        const candidates = [
          typeof pkg.browser === 'string' ? pkg.browser : null,
          typeof pkg.module === 'string' ? pkg.module : null,
          typeof pkg.main === 'string' ? pkg.main : null,
          'index.mjs',
          'index.js',
        ];
        for (const cand of candidates) {
          if (!cand) continue;
          const hit = verifyFile(cand);
          if (hit) return hit;
        }
      }
    }
  } catch {
    // Fallback to direct file probe
  }

  return verifyFile(subPath || 'index.js');
}

function resolveFromWorkspaceNodeModules(
  spec: string,
  importerDir: string,
  realWorkspaceDir: string
): string | null {
  if (!spec || spec.includes('..') || spec.includes('\\')) return null;
  const parts = spec.split('/');
  const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subPath = spec.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/');
  if (!pkgName) return null;

  let cursor = isInsideDir(importerDir, realWorkspaceDir) ? importerDir : realWorkspaceDir;
  while (isInsideDir(cursor, realWorkspaceDir)) {
    const candidatePkgDir = path.join(cursor, 'node_modules', ...pkgName.split('/'));
    if (fs.existsSync(candidatePkgDir)) {
      const resolved = resolvePackageSubpathFromDir(candidatePkgDir, subPath, realWorkspaceDir);
      if (resolved) return resolved;
    }
    if (cursor === realWorkspaceDir) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function resolveBareDependency(
  spec: string,
  resolveDir: string | undefined,
  realWorkspaceDir: string,
  workspaceRequire: NodeRequire
): string | null {
  const importerDir = resolveDir ? realOrSame(path.resolve(resolveDir)) : realWorkspaceDir;
  const importerInWorkspace = isInsideDir(importerDir, realWorkspaceDir);
  const importerInHost = isInsideDir(importerDir, HOST_NODE_MODULES_DIR);

  const esmFound = resolveFromWorkspaceNodeModules(spec, importerDir, realWorkspaceDir);
  if (esmFound) return esmFound;

  const workspaceResolvers: NodeRequire[] = [];
  if (importerInWorkspace) workspaceResolvers.push(createRequire(path.join(importerDir, 'noop.js')));
  workspaceResolvers.push(workspaceRequire);
  for (const req of workspaceResolvers) {
    try {
      const found = realOrSame(req.resolve(spec));
      if (found.startsWith(realWorkspaceDir + path.sep)) return found;
    } catch {
      // coba resolver berikutnya / allowlist host
    }
  }

  const importerInNodeModules =
    importerInHost || (importerInWorkspace && importerDir.split(path.sep).includes('node_modules'));
  if (
    isAllowedSafeBrowserPackage(spec) ||
    (importerInNodeModules && SAFE_TRANSITIVE_BROWSER_PACKAGES.has(topLevelPackageName(spec)))
  ) {
    const hostResolvers: NodeRequire[] = [];
    if (importerInHost) hostResolvers.push(createRequire(path.join(importerDir, 'noop.js')));
    hostResolvers.push(hostRequire);
    for (const req of hostResolvers) {
      try {
        const found = realOrSame(req.resolve(spec));
        if (found.startsWith(HOST_NODE_MODULES_DIR + path.sep)) return found;
      } catch {
        // lanjut ke error dependensi hilang
      }
    }
  }
  return null;
}

function installViteWorkerStub(build: esbuild.PluginBuild): void {
  build.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'carmen-vite-worker-stub' }));
  build.onLoad({ filter: /.*/, namespace: 'carmen-vite-worker-stub' }, () => ({
    contents:
      'export default class PreviewWorkerStub { constructor() { throw new Error("Web Worker tidak tersedia di pratinjau sandbox."); } }',
    loader: 'js',
  }));
}

export async function bundlePreviewEntry(
  projectId: string,
  entrySubPath: string,
  workspaceDir: string,
  previewBasePath: string,
  sourceHash: string
): Promise<CachedBundle> {
  let realWorkspaceDir: string;
  try {
    realWorkspaceDir = fs.realpathSync(workspaceDir);
  } catch {
    return { ok: false, error: 'Direktori workspace proyek belum siap.' };
  }

  // Ensure package.json dependencies are installed inside the isolated workspace before bundling
  let expectedSandboxWorkspace = '';
  try {
    expectedSandboxWorkspace = realOrSame(getProjectWorkspaceDir(projectId));
  } catch {
    // Allow temporary non-DB test workspaces cleanly
  }
  if (expectedSandboxWorkspace && realWorkspaceDir === expectedSandboxWorkspace) {
    const depCheck = inspectMissingDependencies(realWorkspaceDir);
    if (depCheck.hasPackageJson && depCheck.missingPackages.length > 0) {
      await ensureProjectDependenciesInstalled(projectId);
    }
  }

  const hasNodeModules = fs.existsSync(path.join(realWorkspaceDir, 'node_modules')) ? 'nm1' : 'nm0';
  const cacheKey = `${projectId}:entry:${entrySubPath}:${sourceHash}:${previewBasePath}:${hasNodeModules}`;
  const cached = bundleCache.get(cacheKey);
  if (cached) return cached;

  const resolvedEntry =
    resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./${entrySubPath}`) ||
    (!entrySubPath.startsWith('client/')
      ? resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./client/${entrySubPath}`)
      : null);
  if (!resolvedEntry) {
    return { ok: false, error: `Entrypoint pratinjau tidak ditemukan: ${entrySubPath}` };
  }

  const workspaceRequire = createRequire(path.join(realWorkspaceDir, 'package.json'));

  const sandboxPlugin: esbuild.Plugin = {
    name: 'carmen-preview-sandbox-resolver',
    setup(build) {
      installViteWorkerStub(build);
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        if (!spec) return null;

        if (args.kind === 'entry-point') {
          return { path: resolvedEntry };
        }

        // Allow external CDN, data/blob, or rewritten CARMEN preview asset URLs
        if (/^(https?:\/\/|data:|blob:)/i.test(spec) || spec.startsWith('/preview/')) {
          return { path: spec, external: true };
        }

        // Exclude CSS url(...) font/image/asset references from JS/TS module validation
        if (args.kind === 'url-token') {
          if (/^(#|\/\/)/i.test(spec)) {
            return { path: spec, external: true };
          }
          const importerDir = args.resolveDir ? realOrSame(path.resolve(args.resolveDir)) : realWorkspaceDir;
          if (spec.startsWith('.')) {
            const resolvedUrlAsset = resolveInsideWorkspace(realWorkspaceDir, importerDir, spec);
            if (resolvedUrlAsset) return { path: resolvedUrlAsset };
          } else if (spec.startsWith('/')) {
            const resolvedRootAsset =
              resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./${spec.slice(1)}`) ||
              resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./public/${spec.slice(1)}`) ||
              resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./client/${spec.slice(1)}`);
            if (resolvedRootAsset) return { path: resolvedRootAsset };
            return { path: `${previewBasePath}${spec.replace(/^\/+/, '')}`, external: true };
          }
          return { path: spec, external: true };
        }

        // Block raw Node built-in modules explicitly in browser preview
        const bareBuiltin = spec.startsWith('node:') ? spec.slice(5) : spec.split('/')[0];
        if (spec.startsWith('node:') || BLOCKED_NODE_BUILTINS.has(bareBuiltin)) {
          return {
            errors: [
              {
                text: `Modul Node.js "${spec}" tidak dapat dijalankan di kode browser (client preview). Pindahkan logika server ke API backend.`,
              },
            ],
          };
        }

        // Vite root alias "@/..." -> src/... or client/src/... or ./... inside workspace
        if (spec.startsWith('@/')) {
          const aliasRel = spec.slice(2);
          const resolvedAlias =
            resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./src/${aliasRel}`) ||
            resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./client/src/${aliasRel}`) ||
            resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./${aliasRel}`) ||
            resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./client/${aliasRel}`);
          if (!resolvedAlias) {
            return {
              errors: [{ text: `Modul lokal "${spec}" tidak ditemukan di dalam workspace proyek.` }],
            };
          }
          return { path: resolvedAlias };
        }

        // Local relative or project root-relative import
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const importerDir = args.resolveDir ? path.resolve(args.resolveDir) : realWorkspaceDir;
          let realImporterDir = importerDir;
          try {
            realImporterDir = fs.realpathSync(importerDir);
          } catch {
            // Keep normalized path
          }

          // Internal relative files inside an already-allowlisted host UI package (e.g. react-dom/cjs/*)
          if (
            spec.startsWith('.') &&
            (realImporterDir === HOST_NODE_MODULES_DIR || realImporterDir.startsWith(HOST_NODE_MODULES_DIR + path.sep))
          ) {
            const resolvedHost = resolveInsideWorkspace(HOST_NODE_MODULES_DIR, realImporterDir, spec);
            if (resolvedHost) return { path: resolvedHost };
          }

          const resolved =
            resolveInsideWorkspace(realWorkspaceDir, importerDir, spec) ||
            (spec.startsWith('/') && !spec.startsWith('/client/')
              ? resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./client/${spec.slice(1)}`)
              : null);
          if (!resolved) {
            return {
              errors: [{ text: `Modul lokal "${spec}" tidak ditemukan di dalam workspace proyek.` }],
            };
          }
          return { path: resolved };
        }

        const bareResolved = resolveBareDependency(spec, args.resolveDir, realWorkspaceDir, workspaceRequire);
        if (bareResolved) return { path: bareResolved };
        return {
          errors: [
            {
              text: `Dependensi "${spec}" tidak ditemukan di sandbox proyek. Jalankan npm install atau periksa import/package.json.`,
            },
          ],
        };
      });

      // Compile imported CSS (including Tailwind v4/v3) cleanly during bundling
      build.onLoad({ filter: /\.css$/i }, async (args) => {
        const real = fs.realpathSync(args.path);
        const insideWorkspace = real.startsWith(realWorkspaceDir + path.sep);
        const insideHostNodeModules = real.includes(`${path.sep}node_modules${path.sep}`);
        if (!insideWorkspace && !insideHostNodeModules) {
          return { errors: [{ text: `Akses file CSS di luar workspace ditolak: ${path.basename(args.path)}` }] };
        }
        const rawCss = fs.readFileSync(real, 'utf8');
        const relName = insideWorkspace ? path.relative(realWorkspaceDir, real).replace(/\\/g, '/') : path.basename(real);
        const compiled = await compileCssForPreview(
          projectId,
          relName,
          rawCss,
          workspaceDir,
          previewBasePath,
          sourceHash
        );
        if (!compiled.ok) {
          return { errors: [{ text: compiled.error || `Gagal memproses CSS ${relName}` }] };
        }
        return { contents: compiled.css || '', loader: 'css' };
      });
    },
  };

  let out: CachedBundle;
  try {
    const result = await esbuild.build({
      entryPoints: [resolvedEntry],
      bundle: true,
      write: false,
      outdir: 'carmen_bundle',
      format: 'esm',
      platform: 'browser',
      target: ['es2020'],
      jsx: 'automatic',
      sourcemap: 'inline',
      absWorkingDir: realWorkspaceDir,
      define: {
        'process.env.NODE_ENV': '"development"',
      },
      loader: {
        '.ts': 'ts',
        '.tsx': 'tsx',
        '.js': 'js',
        '.mjs': 'js',
        '.jsx': 'jsx',
        '.json': 'json',
        '.png': 'dataurl',
        '.jpg': 'dataurl',
        '.jpeg': 'dataurl',
        '.gif': 'dataurl',
        '.webp': 'dataurl',
        '.svg': 'dataurl',
        '.woff': 'dataurl',
        '.woff2': 'dataurl',
        '.ttf': 'dataurl',
        '.eot': 'dataurl',
        '.wasm': 'binary',
      },
      plugins: [sandboxPlugin],
      logLevel: 'silent',
    });

    const jsOutput = result.outputFiles.find((f) => f.path.endsWith('.js') || f.path.endsWith('.mjs'));
    const cssOutputs = result.outputFiles.filter((f) => f.path.endsWith('.css'));

    if (!jsOutput) {
      out = { ok: false, error: `Bundler tidak menghasilkan output JavaScript untuk ${entrySubPath}.` };
    } else {
      let combinedJs = jsOutput.text;
      if (cssOutputs.length > 0) {
        const mergedCss = cssOutputs.map((f) => f.text).join('\n');
        const injectCssSnippet = `(function(){try{var id='carmen-bundled-style';var prev=document.getElementById(id);if(prev)prev.remove();var s=document.createElement('style');s.id=id;s.textContent=${serializeJsForHtmlScript(mergedCss)};document.head.appendChild(s);}catch(_){}})();\n`;
        combinedJs = `${injectCssSnippet}${combinedJs}`;
      }
      out = { ok: true, code: combinedJs };
    }
  } catch (err) {
    let rawMsg: string;
    if (err && typeof err === 'object' && Array.isArray((err as { errors?: unknown[] }).errors)) {
      const errs = (err as { errors: Array<{ text?: string; location?: { file?: string; line?: number } }> }).errors;
      rawMsg = errs
        .slice(0, 3)
        .map((e) => {
          const loc = e.location?.file
            ? `${e.location.file.replace(realWorkspaceDir + path.sep, '')}${e.location.line ? `:${e.location.line}` : ''}: `
            : '';
          return `${loc}${e.text || 'Build error'}`;
        })
        .join('\n');
    } else {
      rawMsg = err instanceof Error ? err.message : String(err);
    }
    const sanitized = scrubSecrets(rawMsg).split(realWorkspaceDir).join('');
    out = { ok: false, error: sanitized || `Gagal mengompilasi ${entrySubPath}.` };
  }

  if (bundleCache.size >= MAX_BUNDLE_CACHE) {
    const firstKey = bundleCache.keys().next().value;
    if (firstKey) bundleCache.delete(firstKey);
  }
  bundleCache.set(cacheKey, out);
  return out;
}

async function bundleInlineModuleCode(
  projectId: string,
  inlineCode: string,
  workspaceDir: string,
  previewBasePath: string,
  sourceHash: string
): Promise<CachedBundle> {
  const inlineHash = crypto.createHash('sha256').update(inlineCode).digest('hex').slice(0, 12);
  const cacheKey = `${projectId}:inline:${inlineHash}:${sourceHash}:${previewBasePath}`;
  const cached = bundleCache.get(cacheKey);
  if (cached) return cached;

  let realWorkspaceDir: string;
  try {
    realWorkspaceDir = fs.realpathSync(workspaceDir);
  } catch {
    return { ok: false, error: 'Direktori workspace proyek belum siap.' };
  }

  const workspaceRequire = createRequire(path.join(realWorkspaceDir, 'package.json'));
  const sandboxPlugin: esbuild.Plugin = {
    name: 'carmen-preview-inline-resolver',
    setup(build) {
      installViteWorkerStub(build);
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        if (!spec || args.kind === 'entry-point') return null;
        if (/^(https?:\/\/|data:|blob:)/i.test(spec) || spec.startsWith('/preview/')) {
          return { path: spec, external: true };
        }
        if (args.kind === 'url-token') {
          if (/^(#|\/\/)/i.test(spec)) {
            return { path: spec, external: true };
          }
          const importerDir = args.resolveDir ? realOrSame(path.resolve(args.resolveDir)) : realWorkspaceDir;
          if (spec.startsWith('.')) {
            const resolvedUrlAsset = resolveInsideWorkspace(realWorkspaceDir, importerDir, spec);
            if (resolvedUrlAsset) return { path: resolvedUrlAsset };
          } else if (spec.startsWith('/')) {
            const resolvedRootAsset =
              resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./${spec.slice(1)}`) ||
              resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./public/${spec.slice(1)}`);
            if (resolvedRootAsset) return { path: resolvedRootAsset };
            return { path: `${previewBasePath}${spec.replace(/^\/+/, '')}`, external: true };
          }
          return { path: spec, external: true };
        }
        const bareBuiltin = spec.startsWith('node:') ? spec.slice(5) : spec.split('/')[0];
        if (spec.startsWith('node:') || BLOCKED_NODE_BUILTINS.has(bareBuiltin)) {
          return {
            errors: [{ text: `Modul Node.js "${spec}" tidak dapat dijalankan di kode browser.` }],
          };
        }
        if (spec.startsWith('@/')) {
          const aliasRel = spec.slice(2);
          const resolvedAlias =
            resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./src/${aliasRel}`) ||
            resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./client/src/${aliasRel}`) ||
            resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./${aliasRel}`) ||
            resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./client/${aliasRel}`);
          if (!resolvedAlias) return { errors: [{ text: `Modul lokal "${spec}" tidak ditemukan.` }] };
          return { path: resolvedAlias };
        }
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const importerDir = args.resolveDir ? path.resolve(args.resolveDir) : realWorkspaceDir;
          let realImporterDir = importerDir;
          try {
            realImporterDir = fs.realpathSync(importerDir);
          } catch {
            // Keep normalized
          }
          if (
            spec.startsWith('.') &&
            (realImporterDir === HOST_NODE_MODULES_DIR || realImporterDir.startsWith(HOST_NODE_MODULES_DIR + path.sep))
          ) {
            const resolvedHost = resolveInsideWorkspace(HOST_NODE_MODULES_DIR, realImporterDir, spec);
            if (resolvedHost) return { path: resolvedHost };
          }
          const resolved =
            resolveInsideWorkspace(realWorkspaceDir, importerDir, spec) ||
            (spec.startsWith('/') && !spec.startsWith('/client/')
              ? resolveInsideWorkspace(realWorkspaceDir, realWorkspaceDir, `./client/${spec.slice(1)}`)
              : null);
          if (!resolved) return { errors: [{ text: `Modul lokal "${spec}" tidak ditemukan.` }] };
          return { path: resolved };
        }
        const bareResolved = resolveBareDependency(spec, args.resolveDir, realWorkspaceDir, workspaceRequire);
        if (bareResolved) return { path: bareResolved };
        return {
          errors: [{ text: `Dependensi "${spec}" tidak ditemukan di sandbox proyek.` }],
        };
      });

      build.onLoad({ filter: /\.css$/i }, async (args) => {
        const real = fs.realpathSync(args.path);
        const insideWorkspace = real.startsWith(realWorkspaceDir + path.sep);
        const insideHostNodeModules = real.includes(`${path.sep}node_modules${path.sep}`);
        if (!insideWorkspace && !insideHostNodeModules) {
          return { errors: [{ text: `Akses file CSS ditolak: ${path.basename(args.path)}` }] };
        }
        const rawCss = fs.readFileSync(real, 'utf8');
        const relName = insideWorkspace ? path.relative(realWorkspaceDir, real).replace(/\\/g, '/') : path.basename(real);
        const compiled = await compileCssForPreview(projectId, relName, rawCss, workspaceDir, previewBasePath, sourceHash);
        if (!compiled.ok) return { errors: [{ text: compiled.error || `Gagal memproses CSS ${relName}` }] };
        return { contents: compiled.css || '', loader: 'css' };
      });
    },
  };

  let out: CachedBundle;
  try {
    const result = await esbuild.build({
      stdin: { contents: inlineCode, resolveDir: realWorkspaceDir, sourcefile: 'inline-module.tsx', loader: 'tsx' },
      bundle: true,
      write: false,
      outdir: 'carmen_bundle',
      format: 'esm',
      platform: 'browser',
      target: ['es2020'],
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [sandboxPlugin],
      logLevel: 'silent',
    });
    const jsOutput = result.outputFiles.find((f) => f.path.endsWith('.js') || f.path.endsWith('.mjs'));
    const cssOutputs = result.outputFiles.filter((f) => f.path.endsWith('.css'));
    if (!jsOutput) {
      out = { ok: false, error: 'Bundler tidak menghasilkan output untuk script module inline.' };
    } else {
      let combinedJs = jsOutput.text;
      if (cssOutputs.length > 0) {
        const mergedCss = cssOutputs.map((f) => f.text).join('\n');
        combinedJs = `(function(){try{var id='carmen-bundled-style';var prev=document.getElementById(id);if(prev)prev.remove();var s=document.createElement('style');s.id=id;s.textContent=${serializeJsForHtmlScript(mergedCss)};document.head.appendChild(s);}catch(_){}})();\n${combinedJs}`;
      }
      out = { ok: true, code: combinedJs };
    }
  } catch (err) {
    const msg = scrubSecrets(err instanceof Error ? err.message : String(err)).split(realWorkspaceDir).join('');
    out = { ok: false, error: msg || 'Gagal mengompilasi inline module script.' };
  }
  if (bundleCache.size >= MAX_BUNDLE_CACHE) {
    const firstKey = bundleCache.keys().next().value;
    if (firstKey) bundleCache.delete(firstKey);
  }
  bundleCache.set(cacheKey, out);
  return out;
}

export function serializeJsForHtmlScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface PreviewBridgeOptions {
  bridgeNonce?: string;
  parentOrigin?: string;
  cspMeta?: string;
  baseTagHref?: string;
}

export function injectPreviewRuntimeBridge(
  html: string,
  projectId: string,
  _token: string,
  previewBasePath: string,
  opts?: PreviewBridgeOptions
): string {
  const safeProjectId = serializeJsForHtmlScript(projectId);
  const safeBasePath = serializeJsForHtmlScript(previewBasePath);
  const effectiveBaseHref = opts?.baseTagHref || previewBasePath;
  const safeAssetBaseHref = serializeJsForHtmlScript(effectiveBaseHref);
  const safeNonce = serializeJsForHtmlScript(opts?.bridgeNonce || '');
  const safeParentOrigin = serializeJsForHtmlScript(opts?.parentOrigin || '');

  const bridge = `<script>(function(){var PID=${safeProjectId},BASE=${safeBasePath},ABS_BASE=${safeAssetBaseHref},NONCE=${safeNonce},PARENT_ORIGIN=${safeParentOrigin},sentErr=false,sentReady=false,origFetch=window.fetch,pendingFetches={},pendingAssets={};function post(payload){try{if(window.parent&&window.parent!==window){if(NONCE&&payload&&typeof payload==='object'){payload.bridgeNonce=NONCE;}var target=(PARENT_ORIGIN&&PARENT_ORIGIN!=='null')?PARENT_ORIGIN:(window.location.origin&&window.location.origin!=='null'?window.location.origin:'*');window.parent.postMessage(payload,target);}}catch(_){}}function sendErr(msg,extra){sentErr=true;var m=String(msg||'Runtime error').slice(0,500);var p={type:'carmen-preview-error',projectId:PID,message:m};if(extra&&extra.code)p.code=extra.code;if(extra&&typeof extra.status==='number')p.status=extra.status;post(p);}function rewriteRootUrl(val){if(typeof val!=='string')return val;if(val.length>1&&val.charAt(0)==='/'&&val.charAt(1)!=='/'&&val.indexOf('/preview/')!==0&&val.indexOf('/api/')!==0){return ABS_BASE+val.slice(1);}return val;}try{var origSetAttr=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){if(typeof name==='string'&&(name==='src'||name==='poster')&&typeof value==='string'){var t=this.tagName;if(t==='IMG'||t==='SOURCE'||t==='VIDEO'||t==='AUDIO'||t==='TRACK'){value=rewriteRootUrl(value);}}return origSetAttr.call(this,name,value);};[typeof HTMLImageElement!=='undefined'?HTMLImageElement.prototype:null,typeof HTMLMediaElement!=='undefined'?HTMLMediaElement.prototype:null,typeof HTMLSourceElement!=='undefined'?HTMLSourceElement.prototype:null].forEach(function(proto){if(!proto)return;var desc=Object.getOwnPropertyDescriptor(proto,'src');if(desc&&desc.set&&desc.get){Object.defineProperty(proto,'src',{configurable:true,enumerable:desc.enumerable,get:function(){return desc.get.call(this);},set:function(v){return desc.set.call(this,rewriteRootUrl(v));}});}});}catch(_){}window.addEventListener('message',function(ev){if(!ev||ev.source!==window.parent)return;if(PARENT_ORIGIN&&ev.origin!==PARENT_ORIGIN)return;var d=ev.data;if(!d||typeof d!=='object'||d.projectId!==PID||!d.reqId)return;if(NONCE&&d.bridgeNonce!==NONCE)return;if(d.type==='carmen-preview-fetch-result'){var entry=pendingFetches[d.reqId];if(!entry)return;delete pendingFetches[d.reqId];clearTimeout(entry.timer);if(d.error){entry.reject(new Error(d.error));return;}var headers=new Headers({'Content-Type':d.contentType||'application/json'});entry.resolve(new Response(d.body||'',{status:d.status||200,headers:headers}));return;}if(d.type==='carmen-preview-asset-result'){var aEntry=pendingAssets[d.reqId];if(!aEntry)return;delete pendingAssets[d.reqId];clearTimeout(aEntry.timer);aEntry.resolve(d);}});function proxyFetchThroughParent(apiPath,init){return new Promise(function(resolve,reject){if(!window.parent||window.parent===window){reject(new Error('Parent bridge unavailable'));return;}var reqId='cpf_'+Math.random().toString(36).slice(2)+Date.now().toString(36);var timer=setTimeout(function(){delete pendingFetches[reqId];reject(new Error('Preview API bridge timeout'));},12000);pendingFetches[reqId]={resolve:resolve,reject:reject,timer:timer};var bodyStr;if(init&&typeof init.body==='string'){bodyStr=init.body;}else if(init&&init.body!=null){try{bodyStr=String(init.body);}catch(_){bodyStr='';}}post({type:'carmen-preview-fetch',projectId:PID,reqId:reqId,apiPath:apiPath,method:(init&&init.method)||'GET',body:bodyStr});});}function proxyAssetThroughParent(assetPath){return new Promise(function(resolve){if(!window.parent||window.parent===window){resolve({ok:false});return;}var reqId='cpa_'+Math.random().toString(36).slice(2)+Date.now().toString(36);var timer=setTimeout(function(){delete pendingAssets[reqId];resolve({ok:false});},10000);pendingAssets[reqId]={resolve:resolve,timer:timer};post({type:'carmen-preview-asset',projectId:PID,reqId:reqId,assetPath:assetPath});});}function extractPreviewApiPath(rawUrl){if(typeof rawUrl!=='string')return null;if(rawUrl.indexOf('/api/')===0&&rawUrl.indexOf('/preview/')!==0)return 'api/'+rawUrl.slice(5);if(rawUrl.indexOf('./api/')===0)return 'api/'+rawUrl.slice(6);if(rawUrl.indexOf('api/')===0)return rawUrl;var bIdx=rawUrl.indexOf(BASE+'api/');if(bIdx!==-1)return 'api/'+rawUrl.slice(bIdx+(BASE+'api/').length);if(ABS_BASE&&ABS_BASE!==BASE){var abIdx=rawUrl.indexOf(ABS_BASE+'api/');if(abIdx!==-1)return 'api/'+rawUrl.slice(abIdx+(ABS_BASE+'api/').length);}return null;}if(typeof origFetch==='function'){window.fetch=function(input,init){var rawUrl=typeof input==='string'?input:(input&&typeof Request!=='undefined'&&input instanceof Request?input.url:'');var apiPath=extractPreviewApiPath(rawUrl);if(apiPath&&window.location&&window.location.protocol==='about:'&&window.parent&&window.parent!==window){return proxyFetchThroughParent(apiPath,init);}var rewrittenInput=input;try{if(typeof input==='string'&&input.indexOf('/api/')===0&&input.indexOf('/preview/')!==0){rewrittenInput=ABS_BASE+input.slice(1);}else if(input&&typeof Request!=='undefined'&&input instanceof Request){var u=input.url;var idx=u.indexOf('/api/');if(idx>0&&u.indexOf('/preview/')===-1&&u.indexOf(window.location.origin)===0){rewrittenInput=new Request(ABS_BASE+u.slice(idx+1),input);}}}catch(_){}var p=origFetch.call(this,rewrittenInput,init);if(!apiPath)return p;return p.then(function(resp){var ct=(resp.headers&&resp.headers.get('content-type'))||'';if((resp.redirected&&resp.url&&resp.url.indexOf('/preview/')===-1)||ct.indexOf('text/html')!==-1){return proxyFetchThroughParent(apiPath,init);}return resp;}).catch(function(err){if(window.parent&&window.parent!==window){return proxyFetchThroughParent(apiPath,init);}throw err;});};}window.addEventListener('error',function(e){if(!e)return;if(e.target&&e.target!==window){var tag=String(e.target.tagName||'').toUpperCase();var url=e.target.src||e.target.href||'';if(!url)return;if(tag==='LINK'){var rel=String(e.target.rel||'').toLowerCase();if(rel!=='stylesheet')return;}if(tag==='IMG'&&(url.indexOf(BASE)!==-1||(ABS_BASE&&url.indexOf(ABS_BASE)!==-1))&&!e.target.getAttribute('data-carmen-retried')&&window.parent&&window.parent!==window){var matchedBase=(ABS_BASE&&url.indexOf(ABS_BASE)!==-1)?ABS_BASE:BASE;var assetIdx=url.indexOf(matchedBase);var relAsset=url.slice(assetIdx+matchedBase.length).split(/[?#]/)[0];if(relAsset){e.target.setAttribute('data-carmen-retried','1');proxyAssetThroughParent(relAsset).then(function(res){if(res&&res.ok&&res.dataUrl){e.target.src=res.dataUrl;return;}sendErr('Gagal memuat resource img: '+url,{status:res&&res.status});});return;}}if(tag==='SCRIPT'||tag==='LINK'||tag==='IMG'){if(typeof origFetch==='function'&&url.indexOf(BASE)!==-1&&window.location&&window.location.protocol!=='about:'){origFetch.call(window,url).then(function(r){if(!r.ok){return r.text().then(function(txt){sendErr('Gagal memuat '+tag.toLowerCase()+': '+url+' (HTTP '+r.status+')'+(txt?' — '+txt.slice(0,220):''),{status:r.status});});}sendErr('Gagal memuat resource '+tag.toLowerCase()+': '+url);}).catch(function(){sendErr('Gagal memuat resource '+tag.toLowerCase()+': '+url);});}else{sendErr('Gagal memuat resource '+tag.toLowerCase()+': '+url);}return;}}sendErr((e&&e.message)||'Uncaught error');},true);window.addEventListener('unhandledrejection',function(e){var r=e&&e.reason;sendErr((r&&r.message)||String(r||'Unhandled rejection'));});window.addEventListener('securitypolicyviolation',function(e){var dir=(e&&e.violatedDirective)||'CSP';var uri=(e&&e.blockedURI)||'inline';sendErr('CSP memblokir '+dir+': '+uri);});function hasMountedContent(){var root=document.getElementById('root')||document.getElementById('app');if(root&&root.children.length>0)return true;if(document.body){var txt=(document.body.innerText||'').trim();if(txt.length>0)return true;var els=document.body.querySelectorAll('canvas,svg,img,video,iframe,input,button,form,table');if(els.length>0)return true;for(var i=0;i<document.body.children.length;i++){var ch=document.body.children[i];if(ch.tagName!=='SCRIPT'&&ch.tagName!=='STYLE'&&ch.id!=='root'&&ch.id!=='app')return true;}}return false;}function checkMount(){if(sentErr||sentReady)return;if(hasMountedContent()){sentReady=true;post({type:'carmen-preview-ready',projectId:PID});return;}var hasRoot=!!(document.getElementById('root')||document.getElementById('app'));var hasModule=!!document.querySelector('script[type="module"]');if(hasRoot&&hasModule){setTimeout(function(){if(sentErr||sentReady)return;if(hasMountedContent()){sentReady=true;post({type:'carmen-preview-ready',projectId:PID});}else{sendErr('Aplikasi dimuat tetapi tidak merender konten (#root kosong). Periksa error mount React atau console.');}},450);}else{sentReady=true;post({type:'carmen-preview-ready',projectId:PID});}}if(document.readyState==='complete'){setTimeout(checkMount,80);}else{window.addEventListener('load',function(){setTimeout(checkMount,120);});}})();</script>`;

  const cspMetaTag = opts?.cspMeta
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(opts.cspMeta)}" />`
    : '';
  const baseTag = `<base href="${escapeHtml(effectiveBaseHref)}" />`;
  const headInjection = `${cspMetaTag}${baseTag}${bridge}`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${headInjection}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${headInjection}</head>`);
  }
  return `${headInjection}${html}`;
}

function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}

export function renderPreviewErrorHtml(opts: {
  projectId: string;
  token?: string;
  status: number;
  title: string;
  message: string;
  code?: string;
  bridgeNonce?: string;
  parentOrigin?: string;
  cspMeta?: string;
}): string {
  const safePid = serializeJsForHtmlScript(opts.projectId);
  const safeMsg = serializeJsForHtmlScript(opts.message);
  const safeCode = serializeJsForHtmlScript(opts.code || '');
  const safeNonce = serializeJsForHtmlScript(opts.bridgeNonce || '');
  const safeParentOrigin = serializeJsForHtmlScript(opts.parentOrigin || '');
  const safeStatus = Number(opts.status) || 500;
  const cspMetaTag = opts.cspMeta
    ? `\n  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(opts.cspMeta)}" />`
    : '';
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="UTF-8" />${cspMetaTag}
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(opts.title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0E0F11; color: #E8E9EA; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { max-width: 520px; width: 100%; background: #151618; border: 1px solid #26282C; border-radius: 8px; padding: 20px; }
    .badge { display: inline-block; font-family: monospace; font-size: 11px; color: #EF6B73; border: 1px solid rgba(239,107,115,0.4); border-radius: 4px; padding: 2px 8px; margin-bottom: 10px; }
    h1 { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
    p { font-size: 13px; color: #B4B7BD; line-height: 1.5; word-break: break-word; font-family: monospace; background: #0E0F11; border: 1px solid #26282C; border-radius: 6px; padding: 10px 12px; }
  </style>
  <script>
    try {
      if (window.parent && window.parent !== window) {
        var parentOrigin = ${safeParentOrigin};
        var nonce = ${safeNonce};
        var msg = {
          type: 'carmen-preview-error',
          projectId: ${safePid},
          status: ${safeStatus},
          code: ${safeCode},
          message: ${safeMsg}
        };
        if (nonce) msg.bridgeNonce = nonce;
        var target = (parentOrigin && parentOrigin !== 'null') ? parentOrigin : (window.location.origin && window.location.origin !== 'null' ? window.location.origin : '*');
        window.parent.postMessage(msg, target);
      }
    } catch (_) {}
  </script>
</head>
<body>
  <div class="card">
    <span class="badge">HTTP ${safeStatus}</span>
    <h1>${escapeHtml(opts.title)}</h1>
    <p>${escapeHtml(opts.message)}</p>
  </div>
</body>
</html>`;
}

export function extractLocalAssetsFromHtml(html: string): {
  moduleEntries: string[];
  classicScripts: string[];
  stylesheets: string[];
} {
  const moduleEntries: string[] = [];
  const classicScripts: string[] = [];
  const stylesheets: string[] = [];

  const isExternal = (u: string) => /^(https?:\/\/|\/\/|data:|blob:|mailto:|#)/i.test(u);

  const scriptRegex = /<script\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRegex.exec(html)) !== null) {
    const attrs = m[1] || '';
    const srcMatch = /\bsrc=(["'])([^"']+)\1/i.exec(attrs);
    if (!srcMatch) continue;
    const rawSrc = srcMatch[2].trim();
    if (!rawSrc || isExternal(rawSrc)) continue;
    const norm = normalizeProjectPath(rawSrc.replace(/^\.?\//, '').split(/[?#]/)[0]);
    if (!norm) continue;
    if (/\btype=(["'])module\1/i.test(attrs)) {
      moduleEntries.push(norm);
    } else {
      classicScripts.push(norm);
    }
  }

  const linkRegex = /<link\b([^>]*)>/gi;
  while ((m = linkRegex.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (!/\brel=(["'])stylesheet\1/i.test(attrs)) continue;
    const hrefMatch = /\bhref=(["'])([^"']+)\1/i.exec(attrs);
    if (!hrefMatch) continue;
    const rawHref = hrefMatch[2].trim();
    if (!rawHref || isExternal(rawHref)) continue;
    const norm = normalizeProjectPath(rawHref.replace(/^\.?\//, '').split(/[?#]/)[0]);
    if (norm) stylesheets.push(norm);
  }

  return { moduleEntries, classicScripts, stylesheets };
}

export interface PreviewStaticResult {
  status: number;
  contentType: string;
  body: Buffer | string;
}

function escapeScriptBody(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1');
}

function escapeStyleBody(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

async function preparePreviewHtmlDocument(opts: {
  projectId: string;
  rawHtml: string;
  workspaceDir: string;
  previewBasePath: string;
  token: string;
  useDist: boolean;
  sourceHash: string;
  bridgeOptions?: PreviewBridgeOptions;
}): Promise<PreviewStaticResult> {
  const { projectId, rawHtml, workspaceDir, previewBasePath, token, useDist, sourceHash, bridgeOptions } = opts;

  if (rawHtml.includes('<!-- carmen:blank-starter -->')) {
    const html = injectPreviewRuntimeBridge(
      rewriteRootRelativeUrlsInHtml(rawHtml, previewBasePath),
      projectId,
      token,
      previewBasePath,
      bridgeOptions
    );
    return { status: 200, contentType: 'text/html; charset=utf-8', body: html };
  }

  let html = rawHtml;

  // 1) Resolve & inline local <link rel="stylesheet" href="..."> (from dist/ or compiled CSS)
  const linkMatches = Array.from(html.matchAll(/<link\b([^>]*)>/gi));
  for (const match of linkMatches) {
    const fullTag = match[0];
    const attrs = match[1] || '';
    if (!/\brel=(["'])stylesheet\1/i.test(attrs)) continue;
    const hrefMatch = /\bhref=(["'])([^"']+)\1/i.exec(attrs);
    if (!hrefMatch) continue;
    const norm = extractLocalSubPath(hrefMatch[2], previewBasePath);
    if (!norm) continue; // External CDN stylesheet stays untouched

    const cssFile = await resolveFileBytesAsync(projectId, norm, workspaceDir, useDist);
    if (!cssFile) {
      return {
        status: 404,
        contentType: 'text/html; charset=utf-8',
        body: renderPreviewErrorHtml({
          projectId,
          status: 404,
          title: 'Stylesheet tidak ditemukan',
          message: `Stylesheet "${norm}" tidak ditemukan pada proyek.`,
          code: 'MISSING_ASSET',
          bridgeNonce: bridgeOptions?.bridgeNonce,
          parentOrigin: bridgeOptions?.parentOrigin,
          cspMeta: bridgeOptions?.cspMeta,
        }),
      };
    }

    let cssText = cssFile.buffer.toString('utf8');
    if (cssFile.source !== 'dist') {
      const compiledCss = await compileCssForPreview(
        projectId,
        norm,
        cssText,
        workspaceDir,
        previewBasePath,
        sourceHash
      );
      if (!compiledCss.ok) {
        return {
          status: 500,
          contentType: 'text/html; charset=utf-8',
          body: renderPreviewErrorHtml({
            projectId,
            status: 500,
            title: 'Gagal mengompilasi CSS pratinjau',
            message: compiledCss.error || `Gagal memproses CSS ${norm}.`,
            code: 'CSS_BUILD_ERROR',
            bridgeNonce: bridgeOptions?.bridgeNonce,
            parentOrigin: bridgeOptions?.parentOrigin,
            cspMeta: bridgeOptions?.cspMeta,
          }),
        };
      }
      cssText = compiledCss.css || '';
    } else {
      cssText = await inlineLocalUrlsInCssAsync(
        rewriteRootRelativeUrlsInCss(cssText, previewBasePath),
        projectId,
        workspaceDir,
        previewBasePath,
        true
      );
    }

    const replacement = `<style data-carmen-asset="${escapeHtml(previewBasePath + norm)}">${escapeStyleBody(cssText)}</style>`;
    html = html.replace(fullTag, () => replacement);
  }

  // 2) Resolve, compile, and inline local <script src="..."> (both module & classic) + inline module scripts
  const scriptMatches = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi));
  for (const match of scriptMatches) {
    const fullTag = match[0];
    const attrs = match[1] || '';
    const innerCode = match[2] || '';
    const isModule = /\btype=(["'])module\1/i.test(attrs);
    const srcMatch = /\bsrc=(["'])([^"']+)\1/i.exec(attrs);

    if (srcMatch) {
      const norm = extractLocalSubPath(srcMatch[2], previewBasePath);
      if (!norm) continue; // External CDN script stays untouched

      const jsFile = await resolveFileBytesAsync(projectId, norm, workspaceDir, useDist);
      if (!jsFile) {
        return {
          status: 404,
          contentType: 'text/html; charset=utf-8',
          body: renderPreviewErrorHtml({
            projectId,
            status: 404,
            title: 'Script pratinjau tidak ditemukan',
            message: `Script "${norm}" tidak ditemukan pada proyek.`,
            code: 'MISSING_SCRIPT',
            bridgeNonce: bridgeOptions?.bridgeNonce,
            parentOrigin: bridgeOptions?.parentOrigin,
            cspMeta: bridgeOptions?.cspMeta,
          }),
        };
      }

      const ext = path.extname(norm).toLowerCase();
      const rawStr = TEXT_EXTENSIONS.has(ext) ? jsFile.buffer.toString('utf8') : '';
      const isTsOrJsx = ext === '.ts' || ext === '.tsx' || ext === '.jsx' || ext === '.mts' || ext === '.cts';
      const isEsmWithImports =
        (ext === '.js' || ext === '.mjs') && /(^|\n)\s*(import|export)\s+/.test(rawStr);

      let finalJs = rawStr;
      if (jsFile.source !== 'dist' && (isTsOrJsx || isEsmWithImports)) {
        const bundled = await bundlePreviewEntry(projectId, norm, workspaceDir, previewBasePath, sourceHash);
        if (!bundled.ok) {
          return {
            status: 500,
            contentType: 'text/html; charset=utf-8',
            body: renderPreviewErrorHtml({
              projectId,
              status: 500,
              title: 'Build pratinjau gagal',
              message: bundled.error || `Gagal mengompilasi modul ${norm}.`,
              code: 'JS_BUILD_ERROR',
              bridgeNonce: bridgeOptions?.bridgeNonce,
              parentOrigin: bridgeOptions?.parentOrigin,
              cspMeta: bridgeOptions?.cspMeta,
            }),
          };
        }
        finalJs = bundled.code || '';
      } else if (jsFile.source === 'dist') {
        finalJs = jsFile.buffer.toString('utf8');
      }

      const typeAttr = isModule ? ' type="module"' : '';
      const replacement = `<script${typeAttr} data-carmen-asset="${escapeHtml(previewBasePath + norm)}">${escapeScriptBody(finalJs)}</script>`;
      html = html.replace(fullTag, () => replacement);
      continue;
    }

    if (isModule && /(^|\n)\s*(import|export)\s+/.test(innerCode)) {
      const bundledInline = await bundleInlineModuleCode(
        projectId,
        innerCode,
        workspaceDir,
        previewBasePath,
        sourceHash
      );
      if (!bundledInline.ok) {
        return {
          status: 500,
          contentType: 'text/html; charset=utf-8',
          body: renderPreviewErrorHtml({
            projectId,
            status: 500,
            title: 'Build modul inline pratinjau gagal',
            message: bundledInline.error || 'Gagal mengompilasi script module inline.',
            code: 'JS_BUILD_ERROR',
            bridgeNonce: bridgeOptions?.bridgeNonce,
            parentOrigin: bridgeOptions?.parentOrigin,
            cspMeta: bridgeOptions?.cspMeta,
          }),
        };
      }
      const replacement = `<script type="module">${escapeScriptBody(bundledInline.code || '')}</script>`;
      html = html.replace(fullTag, () => replacement);
    }
  }

  // 3) Rewrite remaining root-relative URLs in HTML
  html = rewriteRootRelativeUrlsInHtml(html, previewBasePath);

  // 4) Inline small local <img> assets (<= 512 KB) so opaque-origin iframes behind auth proxies never lose images
  const imgRegex = /<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi;
  const imgMatches = Array.from(html.matchAll(imgRegex));
  const resolvedImages = new Map<string, string>();
  for (const m of imgMatches) {
    const norm = extractLocalSubPath(m[3], previewBasePath);
    if (!norm || resolvedImages.has(norm)) continue;
    const found = await resolveFileBytesAsync(projectId, norm, workspaceDir, useDist);
    if (!found || found.buffer.length > 512 * 1024) continue;
    const mime = getPreviewMimeType(norm);
    if (!mime.startsWith('image/')) continue;
    resolvedImages.set(norm, `data:${mime};base64,${found.buffer.toString('base64')}`);
  }
  html = html.replace(imgRegex, (full, pre, quote, srcVal, post) => {
    const norm = extractLocalSubPath(srcVal, previewBasePath);
    if (!norm) return full;
    const dataUri = resolvedImages.get(norm);
    if (!dataUri) return full;
    return `<img${pre}src=${quote}${dataUri}${quote} data-carmen-src=${quote}${escapeHtml(previewBasePath + norm)}${quote}${post}>`;
  });

  html = injectPreviewRuntimeBridge(html, projectId, token, previewBasePath, bridgeOptions);
  return {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: html,
  };
}

export async function servePreviewStaticAsset(opts: {
  projectId: string;
  cleanedSub: string;
  previewBasePath: string;
  token: string;
  bridgeOptions?: PreviewBridgeOptions;
}): Promise<PreviewStaticResult> {
  const { projectId, cleanedSub, previewBasePath, token, bridgeOptions } = opts;
  const workspaceDir = getProjectWorkspaceDir(projectId);
  const useDist = isFreshDistAvailable(workspaceDir);
  const sourceHash = await computeProjectSourceHashAsync(projectId);

  const found = await resolveFileBytesAsync(projectId, cleanedSub, workspaceDir, useDist);

  if (cleanedSub === 'index.html') {
    if (!found) {
      const msg = 'File index.html tidak ditemukan pada proyek.';
      return {
        status: 404,
        contentType: 'text/html; charset=utf-8',
        body: renderPreviewErrorHtml({
          projectId,
          status: 404,
          title: 'Halaman pratinjau tidak ditemukan',
          message: msg,
          code: 'MISSING_INDEX',
          bridgeNonce: bridgeOptions?.bridgeNonce,
          parentOrigin: bridgeOptions?.parentOrigin,
          cspMeta: bridgeOptions?.cspMeta,
        }),
      };
    }
    return await preparePreviewHtmlDocument({
      projectId,
      rawHtml: found.buffer.toString('utf8'),
      workspaceDir,
      previewBasePath,
      token,
      useDist,
      sourceHash,
      bridgeOptions,
    });
  }

  if (!found) {
    return {
      status: 404,
      contentType: 'text/plain; charset=utf-8',
      body: `File pratinjau tidak ditemukan: ${cleanedSub}`,
    };
  }

  const ext = path.extname(cleanedSub).toLowerCase();

  // Handle TypeScript / JSX / TSX or ESM module scripts (when not already built in dist/)
  if (found.source !== 'dist') {
    const isTsOrJsx = ext === '.ts' || ext === '.tsx' || ext === '.jsx' || ext === '.mts' || ext === '.cts';
    const rawStr = TEXT_EXTENSIONS.has(ext) ? found.buffer.toString('utf8') : '';
    const isEsmWithImports =
      (ext === '.js' || ext === '.mjs') &&
      /(^|\n)\s*(import|export)\s+/.test(rawStr);

    if (isTsOrJsx || isEsmWithImports) {
      const bundled = await bundlePreviewEntry(projectId, cleanedSub, workspaceDir, previewBasePath, sourceHash);
      if (!bundled.ok) {
        return {
          status: 500,
          contentType: 'text/plain; charset=utf-8',
          body: bundled.error || `Gagal mengompilasi modul ${cleanedSub}.`,
        };
      }
      return {
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: bundled.code || '',
      };
    }

    if (ext === '.css') {
      const compiledCss = await compileCssForPreview(
        projectId,
        cleanedSub,
        rawStr,
        workspaceDir,
        previewBasePath,
        sourceHash
      );
      if (!compiledCss.ok) {
        return {
          status: 500,
          contentType: 'text/plain; charset=utf-8',
          body: compiledCss.error || `Gagal memproses CSS ${cleanedSub}.`,
        };
      }
      return {
        status: 200,
        contentType: 'text/css; charset=utf-8',
        body: compiledCss.css || '',
      };
    }
  }

  if (ext === '.html' || ext === '.htm') {
    return await preparePreviewHtmlDocument({
      projectId,
      rawHtml: found.buffer.toString('utf8'),
      workspaceDir,
      previewBasePath,
      token,
      useDist,
      sourceHash,
      bridgeOptions,
    });
  }

  return {
    status: 200,
    contentType: getPreviewMimeType(cleanedSub),
    body: found.buffer,
  };
}

export async function inspectPreviewEntryHealth(projectId: string): Promise<{
  ok: boolean;
  error?: string;
  installing?: boolean;
  packageManager?: 'npm' | 'bun';
  missingPackages?: string[];
}> {
  const workspaceDir = getProjectWorkspaceDir(projectId);
  const useDist = isFreshDistAvailable(workspaceDir);
  const sourceHash = await computeProjectSourceHashAsync(projectId);

  const indexFile = await resolveFileBytesAsync(projectId, 'index.html', workspaceDir, useDist);
  if (!indexFile) {
    return { ok: false, error: 'File index.html tidak ditemukan pada proyek.' };
  }

  const html = indexFile.buffer.toString('utf8');
  if (html.includes('<!-- carmen:blank-starter -->') || useDist) {
    return { ok: true };
  }

  const { moduleEntries, classicScripts, stylesheets } = extractLocalAssetsFromHtml(html);

  let anyEntryNeedsBundle = false;
  for (const entry of moduleEntries) {
    const jsFile = await resolveFileBytesAsync(projectId, entry, workspaceDir, false);
    if (!jsFile) continue;
    const ext = path.extname(entry).toLowerCase();
    if (
      ext === '.ts' ||
      ext === '.tsx' ||
      ext === '.jsx' ||
      ext === '.mts' ||
      ext === '.cts' ||
      /(^|\n)\s*(import|export)\s+/.test(jsFile.buffer.toString('utf8'))
    ) {
      anyEntryNeedsBundle = true;
      break;
    }
  }

  if (anyEntryNeedsBundle) {
    const depCheck = inspectMissingDependencies(workspaceDir);
    if (depCheck.hasPackageJson && depCheck.missingPackages.length > 0) {
      const triggered = await triggerProjectDependenciesInstallIfNeededAsync(projectId);
      const curState = getDependencyInstallState(projectId);
      if (triggered.started || curState.status === 'installing') {
        return {
          ok: false,
          installing: true,
          packageManager: curState.packageManager,
          missingPackages: curState.missingPackages,
        };
      }
    }
  }

  for (const cssPath of stylesheets) {
    const cssFile = await resolveFileBytesAsync(projectId, cssPath, workspaceDir, false);
    if (!cssFile) {
      return { ok: false, error: `Stylesheet tidak ditemukan: ${cssPath}` };
    }
    const compiled = await compileCssForPreview(
      projectId,
      cssPath,
      cssFile.buffer.toString('utf8'),
      workspaceDir,
      `/preview/${projectId}/`,
      sourceHash
    );
    if (!compiled.ok) {
      return { ok: false, error: compiled.error };
    }
  }

  for (const scriptPath of classicScripts) {
    const jsFile = await resolveFileBytesAsync(projectId, scriptPath, workspaceDir, false);
    if (!jsFile) {
      return { ok: false, error: `Script tidak ditemukan: ${scriptPath}` };
    }
  }

  for (const entry of moduleEntries) {
    const jsFile = await resolveFileBytesAsync(projectId, entry, workspaceDir, false);
    if (!jsFile) {
      return { ok: false, error: `Entrypoint module tidak ditemukan: ${entry}` };
    }
    const ext = path.extname(entry).toLowerCase();
    const needsBundle =
      ext === '.ts' ||
      ext === '.tsx' ||
      ext === '.jsx' ||
      ext === '.mts' ||
      ext === '.cts' ||
      /(^|\n)\s*(import|export)\s+/.test(jsFile.buffer.toString('utf8'));
    if (needsBundle) {
      const bundled = await bundlePreviewEntry(
        projectId,
        entry,
        workspaceDir,
        `/preview/${projectId}/`,
        sourceHash
      );
      if (!bundled.ok) {
        return { ok: false, error: bundled.error };
      }
    }
  }

  return { ok: true };
}
