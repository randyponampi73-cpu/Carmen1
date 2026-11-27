import crypto from 'node:crypto';
import type { ChatMessage, ProjectType, ProviderErrorCode, ProviderType, ToolActionEvent } from '../../src/types';
import { asyncDb, db, runInTransaction } from '../db';
import { parseJsonColumn } from '../db/dialect';
import {
  estimateModelCostUsd,
  getProviderAdapter,
  getSecretsToScrub,
  type AdapterMessage,
  type AdapterToolDefinition,
  type ProviderAdapterConfig,
} from '../providers';
import { backendRuntimeManager } from '../runtime/backendRuntime';
import { projectRuntime } from '../runtime/sandbox';
import { normalizeProjectPath, scrubSecrets, sha256 } from '../security';
import { buildAgentSystemPrompt, parseStructuredActions } from './parser';
import { advancePlanForTool, buildExecutionPlan, formatPlanMarkdown, type AgentExecutionPlan } from './planner';
import {
  buildDeterministicHandoff,
  getProjectHandoffAsync,
  getProjectMemoryAsync,
  setProjectHandoffAsync,
  setProjectMemoryAsync,
  type HandoffTurnStatus,
} from './projectMemory';
import {
  buildOrderedFallbackChain,
  makeCredentialFingerprint,
  providerHealthMonitor,
  selectNextFallbackRoute,
  type ProviderHealthMonitor,
  type RouteCandidate,
} from './router';
import { CANONICAL_AGENT_TOOLS, isParallelReadOnlyTool, validateToolArguments } from './toolRegistry';
import {
  prepareSkillsForAgentTurn,
  recordSkillExecutionResult,
  type SkillInvocationMode,
  type SkillPackageRecord,
  type SkillPermission,
  type SkillPreflightOutcome,
} from '../skills';

export type AgentTaskState =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentErrorClass = 'transient' | 'validation' | 'permission' | 'fatal' | 'cancelled';

export function classifyAgentToolError(resultText: string): AgentErrorClass {
  const lower = String(resultText || '').toLowerCase();
  if (/dibatalkan|aborted|cancelled/.test(lower)) return 'cancelled';
  if (/ditolak|izin|permission|admin|traversal|tidak diizinkan|terlarang/.test(lower)) return 'permission';
  if (/argumen wajib|tidak valid|tidak dikenal|format|ambigu|tidak ditemukan di/.test(lower)) return 'validation';
  if (/timeout|econn|enotfound|rate limit|temporarily|sibuk/.test(lower)) return 'transient';
  return 'fatal';
}

export const READ_FILE_MAX_CHARS = 16000;

/**
 * Returns file content for read_file. Without a range, small files are returned intact and large
 * files are clipped to READ_FILE_MAX_CHARS with a clear truncation notice. With startLine/endLine
 * (1-based inclusive), returns only that line slice (also capped at READ_FILE_MAX_CHARS).
 */
export function formatFileSlice(content: string, startLine?: unknown, endLine?: unknown): string {
  const hasStart = startLine !== undefined && startLine !== null && startLine !== '';
  const hasEnd = endLine !== undefined && endLine !== null && endLine !== '';

  if (!hasStart && !hasEnd) {
    if (content.length <= READ_FILE_MAX_CHARS) {
      return content;
    }
    const totalLines = content.split('\n').length;
    const clipped = content.slice(0, READ_FILE_MAX_CHARS);
    const shownLines = clipped.split('\n').length;
    return `${clipped}\n\n[TERPOTONG: menampilkan ${READ_FILE_MAX_CHARS} dari ${content.length} karakter (~baris 1-${shownLines} dari ${totalLines}). Gunakan start_line dan end_line untuk membaca bagian berikutnya.]`;
  }

  const lines = content.split('\n');
  const totalLines = lines.length;
  const parsedStart = hasStart ? Number(startLine) : 1;
  const start = Number.isFinite(parsedStart) && parsedStart >= 1 ? Math.floor(parsedStart) : 1;

  if (start > totalLines) {
    return `[Baris ${start} melebihi jumlah baris file (${totalLines} baris).]`;
  }

  const parsedEnd = hasEnd ? Number(endLine) : totalLines;
  let end = Number.isFinite(parsedEnd) ? Math.min(totalLines, Math.floor(parsedEnd)) : totalLines;
  if (end < start) {
    end = start;
  }

  const slice = lines.slice(start - 1, end).join('\n');
  if (slice.length <= READ_FILE_MAX_CHARS) {
    return `[Baris ${start}-${end} dari ${totalLines}]\n${slice}`;
  }

  const clipped = slice.slice(0, READ_FILE_MAX_CHARS);
  const clippedEnd = start + clipped.split('\n').length - 1;
  return `[Baris ${start}-${clippedEnd} dari ${totalLines}]\n${clipped}\n\n[TERPOTONG: rentang melebihi ${READ_FILE_MAX_CHARS} karakter. Perkecil rentang atau lanjutkan dari start_line=${clippedEnd + 1}.]`;
}

/**
 * Reads an integer limit from the environment. Falls back to `fallback` when the variable is unset, empty,
 * not a finite number, or outside [min, max] (so a typo can never disable or blow up a safety limit).
 */
export function readIntEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const rawText = env[name];
  if (rawText === undefined || rawText.trim() === '') return fallback;
  const raw = Number(rawText);
  return Number.isFinite(raw) && raw >= min && raw <= max ? Math.floor(raw) : fallback;
}

// Per-file size limit. Env: CARMEN_MAX_FILE_BYTES (16 KB - 5 MB, default 512 KB)
export const MAX_PROJECT_FILE_BYTES = readIntEnv('CARMEN_MAX_FILE_BYTES', 512 * 1024, 16 * 1024, 5 * 1024 * 1024);
// Files per project. Env: CARMEN_MAX_PROJECT_FILES (20 - 5000, default 500)
export const MAX_PROJECT_FILES = readIntEnv('CARMEN_MAX_PROJECT_FILES', 500, 20, 5000);
export const MAX_PROJECT_VERSIONS = 50;
// Automatic build/test repair cycles per turn. Env: CARMEN_MAX_AUTO_FIX_CYCLES (1 - 10, default 5)
export const MAX_AUTO_FIX_CYCLES = readIntEnv('CARMEN_MAX_AUTO_FIX_CYCLES', 5, 1, 10);
// Agent tool-steps per turn. Env: CARMEN_MAX_AGENT_STEPS (5 - 200, default 100)
export const DEFAULT_MAX_AGENT_STEPS = readIntEnv('CARMEN_MAX_AGENT_STEPS', 100, 5, 200);
export const MAX_IDENTICAL_FAILING_CALLS = 3;

export function formatByteLimitLabel(bytes: number): string {
  const kb = Math.round(bytes / 1024);
  if (kb >= 1024 && kb % 1024 === 0) {
    return `${kb / 1024} MB (${kb} KB)`;
  }
  return `${kb} KB`;
}

function safeParseJsonObject<T>(raw: unknown, fallback: T): T {
  const parsed = parseJsonColumn<unknown>(raw, fallback);
  return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
}

export const AGENT_TOOLS: AdapterToolDefinition[] = CANONICAL_AGENT_TOOLS;

interface ActiveSessionRecord {
  sessionId: string;
  controller: AbortController;
  startedAt: number;
}

const activeSessions = new Map<string, ActiveSessionRecord>();
const preTurnCheckpoints = new Map<string, Record<string, string>>();

export function getActiveSessionCount(): number {
  return activeSessions.size;
}

export function getActiveSessionId(projectId: string): string | null {
  return activeSessions.get(projectId)?.sessionId ?? null;
}

export function hasActiveSession(projectId: string): boolean {
  return activeSessions.has(projectId);
}

export function clearProjectCheckpoint(projectId: string): void {
  preTurnCheckpoints.delete(projectId);
}

/**
 * Safely aborts an active agent session.
 * If expectedSessionId is provided, an older session's cleanup or disconnect handler
 * will NEVER accidentally abort or delete a newer session.
 */
export function stopAgentSession(projectId: string, expectedSessionId?: string): boolean {
  const existing = activeSessions.get(projectId);
  if (!existing) {
    if (!expectedSessionId) {
      projectRuntime.stopRunningProcess(projectId);
    }
    return false;
  }
  if (expectedSessionId && existing.sessionId !== expectedSessionId) {
    return false;
  }
  projectRuntime.stopRunningProcess(projectId);
  existing.controller.abort();
  activeSessions.delete(projectId);
  return true;
}

function captureWorkspaceSnapshotMap(projectId: string): Record<string, string> {
  const rows = db
    .prepare('SELECT path, content FROM project_files WHERE project_id = ? ORDER BY path')
    .all(projectId) as Array<{ path: string; content: string }>;
  const map: Record<string, string> = {};
  for (const r of rows) map[r.path] = r.content;
  return map;
}

async function captureWorkspaceSnapshotMapAsync(projectId: string): Promise<Record<string, string>> {
  const rows = await asyncDb.all<{ path: string; content: string }>(
    'SELECT path, content FROM project_files WHERE project_id = ? ORDER BY path',
    projectId
  );
  const map: Record<string, string> = {};
  for (const r of rows) map[r.path] = r.content;
  return map;
}

async function restoreWorkspaceSnapshotMapAsync(projectId: string, snapshot: Record<string, string>): Promise<void> {
  await asyncDb.transaction(async (tx) => {
    await tx.run('DELETE FROM project_files WHERE project_id = ?', projectId);
    for (const [filePath, content] of Object.entries(snapshot)) {
      const norm = normalizeProjectPath(filePath);
      if (!norm) continue;
      await tx.run(
        `INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        projectId,
        norm,
        content,
        sha256(content)
      );
    }
    await tx.run(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`, projectId);
  });
  backendRuntimeManager.stopBackend(projectId);
  await projectRuntime.ensureReadyAsync(projectId);
}

export async function executeTool(
  projectId: string,
  name: string,
  args: Record<string, unknown>,
  activeSecrets: string[],
  signal?: AbortSignal
): Promise<{
  ok: boolean;
  target: string;
  result: string;
  mutated: boolean;
  isVerificationCmd?: boolean;
  errorClass?: AgentErrorClass;
}> {
  if (signal?.aborted) {
    return { ok: false, target: name, result: 'Eksekusi tool dibatalkan oleh pengguna.', mutated: false, errorClass: 'cancelled' };
  }
  const validation = validateToolArguments(name, args);
  if (!validation.valid) {
    return {
      ok: false,
      target: String((args && typeof args === 'object' ? args.path || args.cmd || args.query : '') || name),
      result: validation.error || `Argumen tool "${name}" tidak valid.`,
      mutated: false,
      errorClass: 'validation',
    };
  }
  const safeArgs = validation.normalizedArgs;

  if (name === 'list_files') {
    const rawDir = String(safeArgs.dir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
    const normDir = rawDir ? normalizeProjectPath(rawDir) : '';
    if (rawDir && !normDir) {
      return { ok: false, target: rawDir, result: 'Path direktori tidak valid.', mutated: false };
    }
    const rows = await asyncDb.all<{ path: string }>(
      'SELECT path FROM project_files WHERE project_id = ? ORDER BY path',
      projectId
    );
    const filtered = normDir
      ? rows.filter((r) => r.path === normDir || r.path.startsWith(`${normDir}/`))
      : rows;
    const LIST_CAP = 500;
    const shown = filtered.slice(0, LIST_CAP).map((f) => f.path);
    if (filtered.length > LIST_CAP) {
      shown.push(`... (+${filtered.length - LIST_CAP} file lainnya; gunakan parameter dir untuk mempersempit)`);
    }
    return {
      ok: true,
      target: normDir || '/',
      result: shown.join('\n') || '(kosong)',
      mutated: false,
    };
  }

  if (name === 'search_files') {
    const query = String(safeArgs.query || '').trim();
    const rawDir = String(safeArgs.dir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
    const normDir = rawDir ? normalizeProjectPath(rawDir) : '';
    if (rawDir && !normDir) {
      return { ok: false, target: rawDir, result: 'Path direktori pencarian tidak valid.', mutated: false };
    }
    if (!query || query.length > 200) {
      return { ok: false, target: query || '(kosong)', result: 'Query pencarian harus 1–200 karakter.', mutated: false };
    }
    const rows = await asyncDb.all<{ path: string; content: string }>(
      'SELECT path, content FROM project_files WHERE project_id = ? ORDER BY path',
      projectId
    );
    const needle = query.toLowerCase();
    const matches: string[] = [];
    for (const row of rows) {
      if (normDir && row.path !== normDir && !row.path.startsWith(`${normDir}/`)) continue;
      const lines = row.content.split('\n');
      for (let idx = 0; idx < lines.length; idx += 1) {
        if (lines[idx].toLowerCase().includes(needle)) {
          matches.push(`${row.path}:${idx + 1}: ${lines[idx].trim().slice(0, 160)}`);
          if (matches.length >= 50) break;
        }
      }
      if (matches.length >= 50) break;
    }
    return {
      ok: true,
      target: query,
      result: matches.length > 0 ? matches.join('\n') : `Tidak ditemukan kecocokan untuk "${query}".`,
      mutated: false,
    };
  }

  if (name === 'create_directory') {
    const norm = normalizeProjectPath(String(safeArgs.path || '').replace(/\/+$/, ''));
    if (!norm) {
      return { ok: false, target: String(safeArgs.path || ''), result: 'Path direktori tidak valid.', mutated: false };
    }
    const keepPath = `${norm}/.gitkeep`;
    const existing = await asyncDb.get<{ id: string }>(
      'SELECT id FROM project_files WHERE project_id = ? AND path = ?',
      projectId,
      keepPath
    );
    if (!existing) {
      const countRow = await asyncDb.get<{ c: number | string }>(
        'SELECT COUNT(*) as c FROM project_files WHERE project_id = ?',
        projectId
      );
      if (Number(countRow?.c ?? 0) >= MAX_PROJECT_FILES) {
        return { ok: false, target: norm, result: `Batas maksimal ${MAX_PROJECT_FILES} file per proyek tercapai.`, mutated: false };
      }
      await asyncDb.run(
        `INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, '', ?)`,
        crypto.randomUUID(),
        projectId,
        keepPath,
        sha256('')
      );
    }
    await projectRuntime.syncWorkspaceToDiskAsync(projectId);
    return { ok: true, target: norm, result: `Direktori ${norm} berhasil dibuat.`, mutated: true };
  }

  if (name === 'update_project_memory') {
    const res = await setProjectMemoryAsync(projectId, String(safeArgs.content ?? ''), activeSecrets);
    return { ok: res.ok, target: 'catatan proyek', result: res.result, mutated: false };
  }

  if (name === 'read_file') {
    const norm = normalizeProjectPath(String(safeArgs.path || ''));
    if (!norm) return { ok: false, target: String(safeArgs.path || ''), result: 'Path file tidak valid.', mutated: false };
    const row = await asyncDb.get<{ content: string }>(
      'SELECT content FROM project_files WHERE project_id = ? AND path = ?',
      projectId,
      norm
    );
    if (!row) return { ok: false, target: norm, result: `File ${norm} tidak ditemukan.`, mutated: false };
    return {
      ok: true,
      target: norm,
      result: formatFileSlice(row.content, safeArgs.start_line, safeArgs.end_line),
      mutated: false,
    };
  }

  if (name === 'write_file') {
    const norm = normalizeProjectPath(String(safeArgs.path || ''));
    if (!norm) return { ok: false, target: String(safeArgs.path || ''), result: 'Path file tidak valid.', mutated: false };
    if (safeArgs.content === undefined || safeArgs.content === null) {
      return { ok: false, target: norm, result: 'Argumen content wajib diisi untuk write_file.', mutated: false };
    }
    const rawContent = String(safeArgs.content);
    if (Buffer.byteLength(rawContent, 'utf8') > MAX_PROJECT_FILE_BYTES) {
      return {
        ok: false,
        target: norm,
        result: `Ukuran file melebihi batas maksimal ${formatByteLimitLabel(MAX_PROJECT_FILE_BYTES)}.`,
        mutated: false,
      };
    }
    const content = scrubSecrets(rawContent, activeSecrets);
    const wasRedacted = content !== rawContent;
    const existing = await asyncDb.get<{ id: string }>(
      'SELECT id FROM project_files WHERE project_id = ? AND path = ?',
      projectId,
      norm
    );
    if (existing) {
      await asyncDb.run(
        `UPDATE project_files SET content = ?, hash = ?, updated_at = datetime('now') WHERE id = ?`,
        content,
        sha256(content),
        existing.id
      );
    } else {
      const countRow = await asyncDb.get<{ c: number | string }>(
        'SELECT COUNT(*) as c FROM project_files WHERE project_id = ?',
        projectId
      );
      if (Number(countRow?.c ?? 0) >= MAX_PROJECT_FILES) {
        return { ok: false, target: norm, result: `Batas maksimal ${MAX_PROJECT_FILES} file per proyek tercapai.`, mutated: false };
      }
      await asyncDb.run(
        `INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        projectId,
        norm,
        content,
        sha256(content)
      );
    }
    await asyncDb.run(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`, projectId);
    if (norm === 'schema.sql') {
      const sync = await projectRuntime.syncSchemaAsync(projectId);
      if (!sync.ok) {
        return { ok: false, target: norm, result: `File ${norm} ditulis, tetapi schema SQL gagal: ${sync.error}`, mutated: true };
      }
    }
    const redactionNote = wasRedacted
      ? ' Peringatan: pola rahasia/API key terdeteksi dan otomatis disamarkan menjadi [REDACTED_KEY].'
      : '';
    return {
      ok: true,
      target: norm,
      result: `File ${norm} berhasil ditulis (${content.length} karakter).${redactionNote}`,
      mutated: true,
    };
  }

  if (name === 'edit_file') {
    const norm = normalizeProjectPath(String(safeArgs.path || ''));
    if (!norm) return { ok: false, target: String(safeArgs.path || ''), result: 'Path file tidak valid.', mutated: false };
    const row = await asyncDb.get<{ id: string; content: string }>(
      'SELECT id, content FROM project_files WHERE project_id = ? AND path = ?',
      projectId,
      norm
    );
    if (!row) return { ok: false, target: norm, result: `File ${norm} tidak ditemukan.`, mutated: false };
    const rawSearch = String(safeArgs.search || safeArgs.find || '');
    const rawReplace = String(safeArgs.replace ?? '');
    const replace = scrubSecrets(rawReplace, activeSecrets);
    const wasRedacted = replace !== rawReplace;

    let search = rawSearch;
    let effectiveReplace = replace;
    if (search && !row.content.includes(search) && row.content.includes('\r\n') && !search.includes('\r\n')) {
      const crlfSearch = search.replace(/\n/g, '\r\n');
      if (row.content.includes(crlfSearch)) {
        search = crlfSearch;
        effectiveReplace = replace.replace(/\r?\n/g, '\r\n');
      }
    }

    const firstIdx = search ? row.content.indexOf(search) : -1;
    if (firstIdx === -1) {
      return { ok: false, target: norm, result: `Teks target tidak ditemukan di ${norm}.`, mutated: false };
    }
    const secondIdx = row.content.indexOf(search, firstIdx + search.length);
    if (secondIdx !== -1) {
      return {
        ok: false,
        target: norm,
        result: `Teks target ditemukan lebih dari satu kali di ${norm} sehingga ambigu. Sertakan baris konteks di sekitarnya agar unik.`,
        mutated: false,
      };
    }

    const nextContent =
      row.content.slice(0, firstIdx) + effectiveReplace + row.content.slice(firstIdx + search.length);
    if (Buffer.byteLength(nextContent, 'utf8') > MAX_PROJECT_FILE_BYTES) {
      return {
        ok: false,
        target: norm,
        result: `Ukuran file hasil edit melebihi batas maksimal ${formatByteLimitLabel(MAX_PROJECT_FILE_BYTES)}.`,
        mutated: false,
      };
    }
    await asyncDb.run(
      `UPDATE project_files SET content = ?, hash = ?, updated_at = datetime('now') WHERE id = ?`,
      nextContent,
      sha256(nextContent),
      row.id
    );
    await asyncDb.run(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`, projectId);
    if (norm === 'schema.sql') {
      const sync = await projectRuntime.syncSchemaAsync(projectId);
      if (!sync.ok) {
        return { ok: false, target: norm, result: `File ${norm} diperbarui, tetapi schema SQL gagal: ${sync.error}`, mutated: true };
      }
    }
    const redactionNote = wasRedacted
      ? ' Peringatan: pola rahasia/API key terdeteksi dan otomatis disamarkan menjadi [REDACTED_KEY].'
      : '';
    return { ok: true, target: norm, result: `File ${norm} berhasil diperbarui.${redactionNote}`, mutated: true };
  }

  if (name === 'delete_file') {
    const norm = normalizeProjectPath(String(safeArgs.path || ''));
    if (!norm) return { ok: false, target: String(safeArgs.path || ''), result: 'Path file tidak valid.', mutated: false };
    const info = await asyncDb.run('DELETE FROM project_files WHERE project_id = ? AND path = ?', projectId, norm);
    if (!info.changes) {
      return { ok: false, target: norm, result: `File ${norm} tidak ditemukan.`, mutated: false };
    }
    await asyncDb.run(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`, projectId);
    if (norm === 'schema.sql') {
      await projectRuntime.syncSchemaAsync(projectId);
    }
    await projectRuntime.syncWorkspaceToDiskAsync(projectId);
    return { ok: true, target: norm, result: `File ${norm} dihapus.`, mutated: true };
  }

  if (name === 'run_command') {
    const cmd = String(safeArgs.cmd || safeArgs.command || '').trim();
    if (!cmd) return { ok: false, target: '(kosong)', result: 'Perintah tidak boleh kosong.', mutated: false };
    const res = await projectRuntime.runCommandAsync(projectId, cmd, { signal });
    const syncedNote =
      res.syncedFiles && res.syncedFiles.length > 0
        ? `\n[File disinkronkan ke proyek: ${res.syncedFiles.join(', ')}]`
        : '';
    return {
      ok: res.ok,
      target: cmd,
      result: `${scrubSecrets(res.output, activeSecrets).slice(0, 7800)}${syncedNote}`,
      mutated: Boolean(res.syncedFiles && res.syncedFiles.length > 0),
      isVerificationCmd: true,
    };
  }

  if (name === 'install_dependencies') {
    const rawPkgs = String(safeArgs.packages || '').trim();
    const pkgTokens = rawPkgs
      ? rawPkgs.split(/\s+/).filter((p) => /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[a-z0-9._^~-]+)?$/i.test(p))
      : [];
    if (rawPkgs && pkgTokens.length === 0) {
      return { ok: false, target: rawPkgs, result: 'Format nama paket npm tidak valid.', mutated: false };
    }
    const cmd = pkgTokens.length > 0 ? `npm install ${pkgTokens.join(' ')}` : 'npm install';
    const res = await projectRuntime.runCommandAsync(projectId, cmd, { signal });
    const syncedNote =
      res.syncedFiles && res.syncedFiles.length > 0
        ? `\n[File disinkronkan ke proyek: ${res.syncedFiles.join(', ')}]`
        : '';
    return {
      ok: res.ok,
      target: cmd,
      result: `${scrubSecrets(res.output, activeSecrets).slice(0, 7800)}${syncedNote}`,
      mutated: Boolean(res.syncedFiles && res.syncedFiles.length > 0),
      isVerificationCmd: true,
    };
  }

  if (name === 'run_tests') {
    const res = await projectRuntime.runCommandAsync(projectId, 'npm test', { signal });
    return {
      ok: res.ok,
      target: 'npm test',
      result: scrubSecrets(res.output, activeSecrets).slice(0, 8000),
      mutated: false,
      isVerificationCmd: true,
    };
  }

  if (name === 'build_project') {
    const res = await projectRuntime.runCommandAsync(projectId, 'npm run build', { signal });
    return {
      ok: res.ok,
      target: 'npm run build',
      result: scrubSecrets(res.output, activeSecrets).slice(0, 8000),
      mutated: false,
      isVerificationCmd: true,
    };
  }

  if (name === 'validate_project') {
    const files = await asyncDb.all<{ path: string; content: string }>(
      'SELECT path, content FROM project_files WHERE project_id = ? ORDER BY path',
      projectId
    );
    const issues: string[] = [];
    const checks: string[] = [];

    const indexFile = files.find((f) => f.path === 'index.html');
    if (!indexFile) {
      issues.push('index.html tidak ditemukan.');
    } else if (indexFile.content.includes('<!-- carmen:blank-starter -->')) {
      issues.push('index.html masih berupa template kosong.');
    } else {
      checks.push(`index.html OK (${indexFile.content.length} byte)`);
    }

    const pkgFile = files.find((f) => f.path === 'package.json');
    if (pkgFile) {
      try {
        const parsedPkg = JSON.parse(pkgFile.content) as { name?: string; scripts?: Record<string, string> };
        checks.push(`package.json valid (scripts: ${Object.keys(parsedPkg.scripts || {}).join(', ') || 'none'})`);
      } catch (err) {
        issues.push(`package.json tidak valid: ${err instanceof Error ? err.message : 'JSON parse error'}`);
      }
    }

    const schemaFile = files.find((f) => f.path === 'schema.sql');
    if (schemaFile) {
      const sync = await projectRuntime.syncSchemaAsync(projectId);
      if (!sync.ok) {
        issues.push(`schema.sql error: ${sync.error || 'gagal sinkronisasi SQLite'}`);
      } else {
        checks.push('schema.sql sinkron dengan SQLite');
      }
    }

    // Check for accidental plaintext secret patterns in generated project files
    const secretPattern = /\b(sk-ant-[a-zA-Z0-9_-]{16,}|sk-or-v1-[a-zA-Z0-9]{16,}|AIza[0-9A-Za-z_-]{25,}|gsk_[a-zA-Z0-9]{20,}|coa_[a-f0-9]{24,})\b/;
    for (const f of files) {
      if (secretPattern.test(f.content)) {
        issues.push(`Terdeteksi potensi API key plaintext di ${f.path} — segera hapus.`);
      }
    }

    const lastErr = projectRuntime.getLastError(projectId);
    if (lastErr) {
      issues.push(`Error runtime/preview terakhir: ${lastErr}`);
    }

    const ok = issues.length === 0;
    const summary = [
      ok ? 'VALIDASI PROYEK LULUS.' : `VALIDASI PROYEK MENEMUKAN ${issues.length} MASALAH:`,
      ...issues.map((i) => `- [ERROR] ${i}`),
      ...checks.map((c) => `- [OK] ${c}`),
    ].join('\n');

    return {
      ok,
      target: 'project',
      result: summary,
      mutated: false,
      isVerificationCmd: true,
    };
  }

  if (name === 'inspect_dependencies') {
    const pkgRow = await asyncDb.get<{ content: string }>(
      'SELECT content FROM project_files WHERE project_id = ? AND path = ?',
      projectId,
      'package.json'
    );
    if (!pkgRow) {
      return {
        ok: true,
        target: 'package.json',
        result: 'Proyek ini belum memiliki package.json (aplikasi web statis / vanilla).',
        mutated: false,
      };
    }
    try {
      const parsed = JSON.parse(pkgRow.content) as {
        name?: string;
        version?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = parsed.scripts || {};
      const deps = Object.entries(parsed.dependencies || {}).map(([k, v]) => `${k}@${v}`);
      const devDeps = Object.entries(parsed.devDependencies || {}).map(([k, v]) => `${k}@${v}`);
      const riskyHooks: string[] = [];
      for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
        const val = scripts[hook];
        if (val && /(curl|wget|bash|sh\s+-c|powershell|nc\s|rm\s+-rf)/i.test(val)) {
          riskyHooks.push(`${hook}: ${val}`);
        }
      }
      const report = [
        `Paket: ${parsed.name || '(tanpa nama)'}@${parsed.version || '0.0.0'}`,
        `Scripts: ${Object.keys(scripts).join(', ') || '(tidak ada)'}`,
        `Dependencies (${deps.length}): ${deps.join(', ') || '(kosong)'}`,
        `DevDependencies (${devDeps.length}): ${devDeps.join(', ') || '(kosong)'}`,
        riskyHooks.length > 0
          ? `PERINGATAN KEAMANAN lifecycle script: ${riskyHooks.join('; ')}`
          : 'Audit lifecycle script: aman.',
      ].join('\n');
      return { ok: riskyHooks.length === 0, target: 'package.json', result: report, mutated: false };
    } catch (err) {
      return {
        ok: false,
        target: 'package.json',
        result: `package.json tidak valid: ${err instanceof Error ? err.message : 'JSON parse error'}`,
        mutated: false,
      };
    }
  }

  if (name === 'workspace_diff') {
    const current = await captureWorkspaceSnapshotMapAsync(projectId);
    const latestVer = await asyncDb.get<{ label: string; snapshot_json: unknown }>(
      'SELECT label, snapshot_json FROM project_versions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      projectId
    );
    const base: Record<string, string> = latestVer
      ? safeParseJsonObject<Record<string, string>>(latestVer.snapshot_json, {})
      : {};
    const allPaths = Array.from(new Set([...Object.keys(base), ...Object.keys(current)])).sort();
    const lines: string[] = [];
    for (const p of allPaths) {
      if (!(p in base)) lines.push(`A  ${p} (+${current[p].length} chars)`);
      else if (!(p in current)) lines.push(`D  ${p}`);
      else if (base[p] !== current[p]) {
        const delta = current[p].length - base[p].length;
        lines.push(`M  ${p} (${delta >= 0 ? '+' : ''}${delta} chars)`);
      }
    }
    return {
      ok: true,
      target: latestVer?.label || 'baseline',
      result: lines.length > 0 ? lines.join('\n') : 'Tidak ada perubahan dibandingkan snapshot terakhir.',
      mutated: false,
    };
  }

  if (name === 'rollback_checkpoint') {
    const checkpoint = preTurnCheckpoints.get(projectId);
    if (!checkpoint) {
      return {
        ok: false,
        target: 'checkpoint',
        result: 'Tidak ada checkpoint pra-giliran yang tersedia untuk dipulihkan.',
        mutated: false,
      };
    }
    await restoreWorkspaceSnapshotMapAsync(projectId, checkpoint);
    return {
      ok: true,
      target: 'checkpoint',
      result: `Workspace dipulihkan ke checkpoint pra-giliran (${Object.keys(checkpoint).length} file).`,
      mutated: true,
    };
  }

  if (name === 'read_logs') {
    const logs = (await projectRuntime.getLogsAsync(projectId)).slice(-30);
    const out = logs.map((l) => `[${l.timestamp}] [${l.process}:${l.level}] ${l.message}`).join('\n');
    return { ok: true, target: 'terminal', result: out || '(tidak ada log)', mutated: false };
  }

  return { ok: false, target: name, result: `Tool tidak dikenal: ${name}`, mutated: false };
}

export function createVersionSnapshot(projectId: string, messageId: string | null, label: string): string {
  return runInTransaction(() => {
    const snapshot = captureWorkspaceSnapshotMap(projectId);
    const serialized = JSON.stringify(snapshot);

    const countRow = db
      .prepare('SELECT COUNT(*) as c FROM project_versions WHERE project_id = ?')
      .get(projectId) as { c: number };
    const versionId = `ver_${crypto.randomUUID().slice(0, 8)}`;
    const fullLabel = `Versi ${countRow.c + 1} — ${label.slice(0, 60)}`;

    db.prepare(
      `INSERT INTO project_versions (id, project_id, message_id, label, snapshot_json) VALUES (?, ?, ?, ?, ?)`
    ).run(versionId, projectId, messageId, fullLabel, serialized);

    // Enforce retention cap (keep latest MAX_PROJECT_VERSIONS per project)
    db.prepare(
      `DELETE FROM project_versions
       WHERE project_id = ?
         AND id NOT IN (
           SELECT id FROM project_versions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
         )`
    ).run(projectId, projectId, MAX_PROJECT_VERSIONS);

    return versionId;
  });
}

export async function createVersionSnapshotAsync(
  projectId: string,
  messageId: string | null,
  label: string
): Promise<string> {
  return await asyncDb.transaction(async (tx) => {
    const fileRows = await tx.all<{ path: string; content: string }>(
      'SELECT path, content FROM project_files WHERE project_id = ? ORDER BY path',
      projectId
    );
    const snapshot: Record<string, string> = {};
    for (const r of fileRows) snapshot[r.path] = r.content;
    const serialized = JSON.stringify(snapshot);

    const countRow = await tx.get<{ c: number | string }>(
      'SELECT COUNT(*) as c FROM project_versions WHERE project_id = ?',
      projectId
    );
    const versionId = `ver_${crypto.randomUUID().slice(0, 8)}`;
    const fullLabel = `Versi ${Number(countRow?.c ?? 0) + 1} — ${label.slice(0, 60)}`;

    await tx.run(
      `INSERT INTO project_versions (id, project_id, message_id, label, snapshot_json) VALUES (?, ?, ?, ?, ?)`,
      versionId,
      projectId,
      messageId,
      fullLabel,
      serialized
    );

    await tx.run(
      `DELETE FROM project_versions
       WHERE project_id = ?
         AND id NOT IN (
           SELECT id FROM project_versions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
         )`,
      projectId,
      projectId,
      MAX_PROJECT_VERSIONS
    );

    return versionId;
  });
}

/**
 * Creates a version snapshot only if the workspace differs from the latest saved snapshot,
 * preventing redundant duplicate snapshot rows when a turn leaves files identical.
 */
export function createVersionSnapshotIfChanged(
  projectId: string,
  messageId: string | null,
  label: string
): string | null {
  const snapshot = captureWorkspaceSnapshotMap(projectId);
  const serialized = JSON.stringify(snapshot);
  const latest = db
    .prepare('SELECT snapshot_json FROM project_versions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(projectId) as { snapshot_json: unknown } | undefined;
  if (latest) {
    const latestSerialized =
      typeof latest.snapshot_json === 'string' ? latest.snapshot_json : JSON.stringify(latest.snapshot_json);
    if (latestSerialized === serialized) {
      return null;
    }
  }
  return createVersionSnapshot(projectId, messageId, label);
}

export async function createVersionSnapshotIfChangedAsync(
  projectId: string,
  messageId: string | null,
  label: string
): Promise<string | null> {
  const snapshot = await captureWorkspaceSnapshotMapAsync(projectId);
  const serialized = JSON.stringify(snapshot);
  const latest = await asyncDb.get<{ snapshot_json: unknown }>(
    'SELECT snapshot_json FROM project_versions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    projectId
  );
  if (latest) {
    const latestSerialized =
      typeof latest.snapshot_json === 'string' ? latest.snapshot_json : JSON.stringify(latest.snapshot_json);
    if (latestSerialized === serialized) {
      return null;
    }
  }
  return await createVersionSnapshotAsync(projectId, messageId, label);
}

export const MODEL_REQUEST_TIMEOUT_MS = 120_000;
export const NO_WRITE_RETRY_PROMPT =
  'Kamu belum menulis file apa pun. Panggil write_file sekarang untuk membuat aplikasi yang diminta.';
export const NO_CHANGE_WARNING_TEXT =
  'AI tidak menghasilkan perubahan. Coba model lain atau ulangi perintah.';

const SYSTEM_NOISE_PATTERNS =
  /^(?:\[HTTP \d+\]|Key ditolak oleh provider|Kuota (?:atau saldo kredit|akun) provider|Batas permintaan \(rate limit\) provider|Model tidak ditemukan pada provider|Layanan provider sedang tidak tersedia|Permintaan ke model melebihi batas waktu|Konteks percakapan melebihi kapasitas model)/i;

export function truncateSafeForPrompt(text: string, maxChars = 3000): string {
  const input = String(text || '');
  if (input.length <= maxChars) return input;
  let cut = input.slice(0, maxChars).trimEnd();
  const fenceCount = (cut.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    cut += '\n```';
  }
  return `${cut}\n...[riwayat dipotong]`;
}

function buildRecentHistoryFromRows(
  rows: Array<{ id: string; role: string; content: string; tool_events_json?: unknown }>
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const h of rows.reverse()) {
    const role: 'user' | 'assistant' = h.role === 'assistant' ? 'assistant' : 'user';
    const rawContent = String(h.content || '').trim();
    const parsedRaw = parseJsonColumn<unknown>(h.tool_events_json, []);
    const parsedEvents: ToolActionEvent[] = Array.isArray(parsedRaw) ? (parsedRaw as ToolActionEvent[]) : [];

    const hasSuccessfulTool = parsedEvents.some((e) => e.status === 'success');
    if (role === 'assistant' && !hasSuccessfulTool) {
      if (
        !rawContent ||
        rawContent === NO_CHANGE_WARNING_TEXT ||
        rawContent === 'Generasi dihentikan oleh pengguna.' ||
        rawContent === 'Tidak ada respons teks dari model.' ||
        SYSTEM_NOISE_PATTERNS.test(rawContent)
      ) {
        continue;
      }
    }

    let combined = rawContent;
    if (role === 'assistant' && parsedEvents.length > 0) {
      const compactSummary = parsedEvents
        .slice(0, 8)
        .map((e) => `${e.tool}(${String(e.target || '').slice(0, 40)}):${e.status}`)
        .join(', ');
      const extra = parsedEvents.length > 8 ? `, +${parsedEvents.length - 8} lagi` : '';
      const actionLine = `[Aksi sebelumnya: ${compactSummary}${extra}]`;
      combined = combined ? `${combined}\n${actionLine}` : actionLine;
    }

    if (!combined) continue;
    out.push({
      role,
      content: truncateSafeForPrompt(combined, 3000),
    });
  }
  return out;
}

export function getRecentHistoryForPrompt(
  projectId: string,
  excludeMessageId: string,
  limit = 16
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const rows = db
    .prepare(
      'SELECT id, role, content, tool_events_json FROM messages WHERE project_id = ? AND id != ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
    )
    .all(projectId, excludeMessageId, limit) as Array<{
    id: string;
    role: string;
    content: string;
    tool_events_json?: unknown;
  }>;
  return buildRecentHistoryFromRows(rows);
}

export async function getRecentHistoryForPromptAsync(
  projectId: string,
  excludeMessageId: string,
  limit = 16
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const rows = await asyncDb.all<{
    id: string;
    role: string;
    content: string;
    tool_events_json?: unknown;
  }>(
    'SELECT id, role, content, tool_events_json FROM messages WHERE project_id = ? AND id != ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    projectId,
    excludeMessageId,
    limit
  );
  return buildRecentHistoryFromRows(rows);
}

function sanitizeToolCallId(rawId: string | undefined, idx: number): string {
  const cleaned = String(rawId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || `tc_${idx}`;
}

function flattenAssistantToolCallsText(m: AdapterMessage): string {
  const calls = m.toolCalls || [];
  const callSummary = calls
    .map((tc) => `${tc.name}(${JSON.stringify(tc.arguments || {}).slice(0, 140)})`)
    .join('; ');
  const prefix = m.content?.trim() ? `${m.content.trim()}\n` : '';
  return `${prefix}[Memanggil tool: ${callSummary}]`;
}

/**
 * Normalizes conversation messages for a specific target provider route:
 * - Preserves native toolCalls/tool responses only when target supports tools AND provider matches.
 * - Converts foreign/unsupported tool exchanges into readable user/assistant text so Gemini doesn't fail
 *   on missing thoughtSignature and OpenAI/Anthropic don't fail on mismatched tool_call_id.
 * - Sanitizes toolCall IDs, strips leading non-user messages, drops empties, and enforces clean role grouping.
 */
export function normalizeMessagesForRoute(params: {
  messages: AdapterMessage[];
  targetProvider: ProviderType;
  supportsTools: boolean;
}): AdapterMessage[] {
  const { messages, targetProvider, supportsTools } = params;
  const intermediate: AdapterMessage[] = [];
  let activeToolIdMap = new Map<string, string>();
  let fallbackCounter = 0;

  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const providerMatches = m.toolCalls.every((tc) => !tc.provider || tc.provider === targetProvider);
        const canKeepNative = supportsTools && providerMatches;

        if (canKeepNative) {
          activeToolIdMap = new Map<string, string>();
          const sanitizedCalls = m.toolCalls.map((tc) => {
            fallbackCounter += 1;
            const origKey = tc.id || `__idx_${fallbackCounter}`;
            const cleanId = sanitizeToolCallId(tc.id, fallbackCounter);
            activeToolIdMap.set(origKey, cleanId);
            return {
              ...tc,
              id: cleanId,
            };
          });
          intermediate.push({
            role: 'assistant',
            content: m.content || '',
            toolCalls: sanitizedCalls,
          });
        } else {
          activeToolIdMap.clear();
          intermediate.push({
            role: 'assistant',
            content: flattenAssistantToolCallsText(m),
          });
        }
      } else {
        activeToolIdMap.clear();
        if (m.content && m.content.trim()) {
          intermediate.push({ role: 'assistant', content: m.content });
        }
      }
      continue;
    }

    if (m.role === 'tool') {
      const providerMatches = !m.toolProvider || m.toolProvider === targetProvider;
      const mappedId = m.toolCallId ? activeToolIdMap.get(m.toolCallId) : undefined;
      if (supportsTools && providerMatches && mappedId) {
        intermediate.push({
          role: 'tool',
          toolCallId: mappedId,
          toolName: m.toolName,
          toolProvider: m.toolProvider,
          content: m.content || '(kosong)',
        });
      } else {
        const label = m.toolName || 'tool';
        intermediate.push({
          role: 'user',
          content: `[Hasil tool ${label}: ${m.content || '(kosong)'}]`,
        });
      }
      continue;
    }

    // User message
    activeToolIdMap.clear();
    if ((m.content && m.content.trim()) || (m.imageBase64 && m.imageMimeType)) {
      intermediate.push({
        role: 'user',
        content: m.content || '',
        ...(m.imageBase64 && m.imageMimeType ? { imageBase64: m.imageBase64, imageMimeType: m.imageMimeType } : {}),
      });
    }
  }

  // Ensure every kept assistant toolCalls block actually has matching tool response(s) directly after it;
  // otherwise flatten its toolCalls into plain text so strict APIs never reject dangling tool_use blocks.
  for (let i = 0; i < intermediate.length; i += 1) {
    const cur = intermediate[i];
    if (cur.role === 'assistant' && cur.toolCalls && cur.toolCalls.length > 0) {
      const nextMsg = intermediate[i + 1];
      if (!nextMsg || nextMsg.role !== 'tool') {
        intermediate[i] = {
          role: 'assistant',
          content: flattenAssistantToolCallsText(cur),
        };
      }
    }
  }

  // Strip leading non-user messages so the first turn is always user
  while (intermediate.length > 0 && intermediate[0].role !== 'user') {
    intermediate.shift();
  }

  // Merge consecutive user or plain assistant messages so strict alternating providers (Anthropic/Gemini) accept history cleanly
  const merged: AdapterMessage[] = [];
  for (const m of intermediate) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === 'user' && m.role === 'user') {
      prev.content = [prev.content, m.content].filter((s) => Boolean(s && s.trim())).join('\n\n');
      if (!prev.imageBase64 && m.imageBase64 && m.imageMimeType) {
        prev.imageBase64 = m.imageBase64;
        prev.imageMimeType = m.imageMimeType;
      }
      continue;
    }
    if (
      prev &&
      prev.role === 'assistant' &&
      m.role === 'assistant' &&
      (!prev.toolCalls || prev.toolCalls.length === 0) &&
      (!m.toolCalls || m.toolCalls.length === 0)
    ) {
      prev.content = [prev.content, m.content].filter((s) => Boolean(s && s.trim())).join('\n\n');
      continue;
    }
    merged.push({ ...m });
  }

  return merged;
}

export function estimateMessagesChars(systemPrompt: string, messages: AdapterMessage[]): number {
  let total = systemPrompt.length;
  for (const m of messages) {
    total += (m.content || '').length;
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        total += tc.name.length + JSON.stringify(tc.arguments || {}).length;
      }
    }
  }
  return total;
}

export function compactLoopMessages(messages: AdapterMessage[], maxContentChars = 140_000): AdapterMessage[] {
  const cloned = messages.map((m) => ({ ...m }));
  const preserveTailCount = 4;
  const compactLimit = Math.max(0, cloned.length - preserveTailCount);

  const countAll = (arr: AdapterMessage[]) =>
    arr.reduce((sum, m) => sum + (m.content || '').length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), 0);

  if (countAll(cloned) <= maxContentChars) return cloned;

  // Pass 1: compact older tool results & structured tool-result user blocks
  for (let i = 0; i < compactLimit; i += 1) {
    const m = cloned[i];
    if (m.role === 'tool' && m.content.length > 420) {
      m.content = `[Ringkasan hasil ${m.toolName || 'tool'} (${m.content.length} chars): ${m.content.slice(0, 260)}...]`;
    } else if (m.role === 'user' && m.content.length > 700 && /^\[Hasil /i.test(m.content)) {
      m.content = `[Ringkasan hasil aksi (${m.content.length} chars): ${m.content.slice(0, 320)}...]`;
    } else if (m.role === 'assistant' && m.content.length > 1500) {
      m.content = truncateSafeForPrompt(m.content, 1200);
    }
  }

  if (countAll(cloned) <= maxContentChars) return cloned;

  // Pass 2: trim remaining tool contents (except the very last message) and drop oldest middle turns cleanly
  for (let i = 0; i < cloned.length - 1; i += 1) {
    const m = cloned[i];
    if (m.role === 'tool' && m.content.length > 220) {
      m.content = `[Hasil ${m.toolName || 'tool'} dipadatkan: ${m.content.slice(0, 160)}...]`;
    } else if (m.role === 'user' && m.content.length > 1200 && i > 0) {
      m.content = truncateSafeForPrompt(m.content, 900);
    }
  }

  // Keep at least the first user message and recent tail; drop oldest middle messages if still over budget
  while (cloned.length > 3 && countAll(cloned) > maxContentChars) {
    cloned.splice(1, 1);
  }

  return cloned;
}

class StructuredActionStreamFilter {
  private buffer = '';
  private state: 'normal' | 'in_open_tag' | 'in_body' = 'normal';

  push(chunk: string): string {
    if (!chunk) return '';
    this.buffer += chunk;
    let out = '';

    while (this.buffer.length > 0) {
      if (this.state === 'normal') {
        const lower = this.buffer.toLowerCase();
        const idx = lower.indexOf('<carmen_action');
        if (idx === -1) {
          // Hold back trailing potential prefix of '<carmen_action'
          const lastLt = this.buffer.lastIndexOf('<');
          if (lastLt !== -1 && '<carmen_action'.startsWith(lower.slice(lastLt))) {
            out += this.buffer.slice(0, lastLt);
            this.buffer = this.buffer.slice(lastLt);
          } else {
            out += this.buffer;
            this.buffer = '';
          }
          break;
        }
        out += this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx);
        this.state = 'in_open_tag';
        continue;
      }

      if (this.state === 'in_open_tag') {
        const gtIdx = this.buffer.indexOf('>');
        if (gtIdx === -1) break;
        const isSelfClosing = gtIdx > 0 && this.buffer[gtIdx - 1] === '/';
        this.buffer = this.buffer.slice(gtIdx + 1);
        this.state = isSelfClosing ? 'normal' : 'in_body';
        continue;
      }

      // state === 'in_body'
      const lower = this.buffer.toLowerCase();
      const closeTag = '</carmen_action>';
      const closeIdx = lower.indexOf(closeTag);
      if (closeIdx === -1) {
        if (this.buffer.length > closeTag.length) {
          this.buffer = this.buffer.slice(this.buffer.length - closeTag.length);
        }
        break;
      }
      this.buffer = this.buffer.slice(closeIdx + closeTag.length);
      this.state = 'normal';
    }

    return out;
  }

  flush(): string {
    if (this.state === 'normal') {
      const rest = this.buffer;
      this.buffer = '';
      return rest;
    }
    this.buffer = '';
    return '';
  }
}

export interface RunAgentTurnParams {
  projectId: string;
  userId?: string;
  prompt: string;
  mode: 'build' | 'discuss';
  imageBase64?: string;
  imageMimeType?: string;
  adapterConfig: ProviderAdapterConfig;
  modelId: string;
  fallbackCandidates?: RouteCandidate[];
  sessionId?: string;
  maxSteps?: number;
  requestTimeoutMs?: number;
  skillMode?: SkillInvocationMode;
  requestedSkillNames?: string[];
  disableAllSkills?: boolean;
  approvedSkillPermissions?: Record<string, SkillPermission[]>;
  forceEmptySkills?: boolean;
  loadSkillOverride?: (slug: string) => Promise<SkillPackageRecord | null>;
  skillPreflightOverride?: () => Promise<SkillPreflightOutcome>;
  adapterOverride?: ReturnType<typeof getProviderAdapter>;
  adapterResolver?: (provider: ProviderAdapterConfig['provider']) => ReturnType<typeof getProviderAdapter>;
  healthMonitor?: ProviderHealthMonitor;
  emit: (event: string, payload: unknown) => void;
}

export async function runAgentTurn(params: RunAgentTurnParams): Promise<ChatMessage> {
  const {
    projectId,
    userId,
    prompt,
    mode,
    imageBase64,
    imageMimeType,
    adapterConfig,
    modelId,
    fallbackCandidates = [],
    sessionId = `sess_${crypto.randomUUID().slice(0, 12)}`,
    maxSteps = DEFAULT_MAX_AGENT_STEPS,
    requestTimeoutMs = MODEL_REQUEST_TIMEOUT_MS,
    skillMode = 'auto',
    requestedSkillNames,
    disableAllSkills = false,
    approvedSkillPermissions,
    forceEmptySkills = false,
    loadSkillOverride,
    skillPreflightOverride,
    adapterOverride,
    adapterResolver,
    healthMonitor = providerHealthMonitor,
    emit,
  } = params;

  const project = await asyncDb.get<{ id: string; user_id: string; name: string; type: ProjectType; stack: string; rules: string }>(
    'SELECT id, user_id, name, type, stack, rules FROM projects WHERE id = ?',
    projectId
  );

  if (!project) {
    throw new Error('Proyek tidak ditemukan.');
  }
  const effectiveUserId = userId || project.user_id;

  // Persist user message immediately
  const userMessageId = `msg_${crypto.randomUUID().slice(0, 10)}`;
  await asyncDb.run(
    `INSERT INTO messages (id, project_id, role, content, mode) VALUES (?, ?, 'user', ?, ?)`,
    userMessageId,
    projectId,
    prompt,
    mode
  );

  // Race-free session registration: abort any previous session and bind a unique sessionId
  stopAgentSession(projectId);
  const abortController = new AbortController();
  activeSessions.set(projectId, {
    sessionId,
    controller: abortController,
    startedAt: Date.now(),
  });

  // Capture pre-turn workspace checkpoint for safe rollback in build mode
  let turnCheckpoint: Record<string, string> | null = null;
  if (mode === 'build') {
    turnCheckpoint = await captureWorkspaceSnapshotMapAsync(projectId);
    preTurnCheckpoints.set(projectId, turnCheckpoint);
  }

  try {

  const fileRows = await asyncDb.all<{ path: string; content: string }>(
    'SELECT path, content FROM project_files WHERE project_id = ? ORDER BY path',
    projectId
  );
  const initialFilePaths = fileRows.map((f) => f.path);
  const indexContent = fileRows.find((f) => f.path === 'index.html')?.content || '';
  const isBlankStarter = !indexContent || indexContent.includes('<!-- carmen:blank-starter -->');
  const initialRuntimeError = projectRuntime.getLastError(projectId);
  const initialHandoff = await getProjectHandoffAsync(projectId);

  // Optional Dynamic Skill Intelligence Layer: discovery -> on-demand activation -> permission check -> composition.
  // Built-in Agent Core MUST proceed cleanly even if the skill system has 0 skills, is disabled, or throws.
  const skillTurnStartMs = Date.now();
  let skillPreflight: SkillPreflightOutcome;
  try {
    skillPreflight = skillPreflightOverride
      ? await skillPreflightOverride()
      : await prepareSkillsForAgentTurn({
          ctx: {
            prompt,
            mode,
            projectId,
            userId: effectiveUserId,
            projectType: project.type,
            stack: project.stack,
            existingFiles: initialFilePaths,
            lastError: initialRuntimeError,
            skillMode,
            requestedSkillNames,
            disableAllSkills,
          },
          forceEmptySkills,
          approvedPermissionsOverride: approvedSkillPermissions,
          loadSkillOverride,
        });
  } catch (skillErr) {
    const errMsg = skillErr instanceof Error ? skillErr.message : String(skillErr);
    skillPreflight = {
      skillSystemAvailable: false,
      mode: skillMode,
      disabled: disableAllSkills,
      discoveredCount: 0,
      selectedMatches: [],
      loadedSkills: [],
      composition: { steps: [], skippedConflicts: [], missingDependencies: [], hasCycle: false },
      deniedSkills: [],
      loadFailures: [{ skillName: 'skill-system', error: errMsg }],
      promptInstructions: '',
      warnings: [`Sistem Skill mengalami gangguan (${errMsg}); melanjutkan dengan Agent Core bawaan.`],
    };
  }

  const activeSkillSlugs = skillPreflight.loadedSkills.map((s) => s.slug);

  emit('skill_discovery', {
    available: skillPreflight.skillSystemAvailable,
    disabled: skillPreflight.disabled,
    mode: skillPreflight.mode,
    discoveredCount: skillPreflight.discoveredCount,
    selectedCount: skillPreflight.loadedSkills.length,
    warnings: skillPreflight.warnings,
  });

  for (const match of skillPreflight.selectedMatches) {
    if (!activeSkillSlugs.includes(match.skill.slug)) continue;
    emit('skill_selected', {
      skillId: match.skill.id,
      skillName: match.skill.slug,
      category: match.skill.category,
      confidence: match.confidence,
      reason: match.reason,
      explicit: match.explicit,
    });
    emit('skill_execution', {
      skillId: match.skill.id,
      skillName: match.skill.slug,
      mode: skillPreflight.mode,
      status: 'running',
      reason: match.reason,
      fallbackUsed: false,
    });
  }

  for (const denied of skillPreflight.deniedSkills) {
    emit('skill_permission_required', denied);
    emit('skill_execution', {
      skillName: denied.skillName,
      mode: skillPreflight.mode,
      status: 'denied',
      reason: denied.reason,
      fallbackUsed: true,
      missingPermissions: denied.missingPermissions,
    });
    await recordSkillExecutionResult({
      projectId,
      userId: effectiveUserId,
      attempt: {
        skillId: '',
        skillName: denied.skillName,
        mode: skillPreflight.mode,
        status: 'denied',
        confidence: 0,
        reason: denied.reason,
        fallbackUsed: true,
        toolsInvoked: [],
        errorSummary: denied.reason,
        durationMs: 0,
        missingPermissions: denied.missingPermissions,
      },
    });
  }

  for (const failure of skillPreflight.loadFailures) {
    emit('skill_execution', {
      skillName: failure.skillName,
      mode: skillPreflight.mode,
      status: 'fallback',
      reason: failure.error,
      fallbackUsed: true,
    });
    await recordSkillExecutionResult({
      projectId,
      userId: effectiveUserId,
      attempt: {
        skillId: '',
        skillName: failure.skillName,
        mode: skillPreflight.mode,
        status: 'fallback',
        confidence: 0,
        reason: 'Skill gagal dimuat; beralih aman ke kemampuan bawaan CARMEN.',
        fallbackUsed: true,
        toolsInvoked: [],
        errorSummary: failure.error,
        durationMs: 0,
      },
    });
  }

  // Structured intent classification & execution planning (with continuation handoff inheritance)
  let executionPlan: AgentExecutionPlan = buildExecutionPlan({
    prompt,
    mode,
    projectType: project.type,
    existingFiles: initialFilePaths,
    lastError: initialRuntimeError,
    isBlankStarter,
    projectHandoff: initialHandoff,
  });
  if (activeSkillSlugs.length > 0) {
    executionPlan = { ...executionPlan, activeSkills: activeSkillSlugs };
  }

  const resolveAdapter = (provider: ProviderAdapterConfig['provider']) => {
    if (adapterResolver) return adapterResolver(provider);
    if (adapterOverride) return adapterOverride;
    return getProviderAdapter(provider);
  };

  // Enrich fallback candidates with real adapter capabilities (supportsTools / maxContext)
  const enrichedFallbackCandidates: RouteCandidate[] = fallbackCandidates.map((cand) => {
    const adp = resolveAdapter(cand.adapterConfig.provider);
    const caps = adp.capabilities(cand.modelId, cand.adapterConfig);
    return {
      ...cand,
      supportsTools: cand.supportsTools ?? caps.toolCalling !== 'no',
      maxContext: cand.maxContext ?? caps.maxContext,
    };
  });

  // Build ordered intelligent routing & fallback chain
  const primaryAdapter = resolveAdapter(adapterConfig.provider);
  const primaryCaps = primaryAdapter.capabilities(modelId, adapterConfig);
  const primaryCandidate: RouteCandidate = {
    adapterConfig,
    modelId,
    priority: 100,
    supportsTools: primaryCaps.toolCalling !== 'no',
    maxContext: primaryCaps.maxContext,
  };
  const orderedChain = buildOrderedFallbackChain({
    primary: primaryCandidate,
    candidates: enrichedFallbackCandidates,
    complexity: executionPlan.complexity,
    requireTools: mode === 'build',
    health: healthMonitor,
  });

  let activeRoute: RouteCandidate = orderedChain[0] ?? primaryCandidate;
  const attemptedRoutes = new Set<string>([`${activeRoute.adapterConfig.providerKeyId}::${activeRoute.modelId}`]);
  const activeSecrets = new Set<string>([
    ...getSecretsToScrub(adapterConfig),
    ...enrichedFallbackCandidates.flatMap((c) => getSecretsToScrub(c.adapterConfig)),
  ]);
  const forcedStructuredRoutes = new Set<string>();
  const compactedRoutes = new Set<string>();

  const getActiveSystemPrompt = async (route: RouteCandidate): Promise<{
    systemPrompt: string;
    useStructuredFallback: boolean;
    toolCallingCapability: 'yes' | 'no' | 'unknown';
    maxContext: number | 'unknown';
  }> => {
    const adp = resolveAdapter(route.adapterConfig.provider);
    const caps = adp.capabilities(route.modelId, route.adapterConfig);
    const routeKey = `${route.adapterConfig.providerKeyId}::${route.modelId}`;
    const useStructuredFallback =
      mode === 'build' && (caps.toolCalling === 'no' || forcedStructuredRoutes.has(routeKey));
    const currentFilePaths = (
      await asyncDb.all<{ path: string }>('SELECT path FROM project_files WHERE project_id = ? ORDER BY path', projectId)
    ).map((r) => r.path);
    const currentLastError = projectRuntime.getLastError(projectId);
    const basePrompt = buildAgentSystemPrompt({
      projectName: project.name,
      projectType: project.type,
      stack: project.stack,
      filePaths: currentFilePaths,
      rules: project.rules || '',
      lastError: currentLastError,
      mode,
      useStructuredFallback,
      projectMemory: await getProjectMemoryAsync(projectId),
      projectHandoff: await getProjectHandoffAsync(projectId),
      skillInstructions: skillPreflight.promptInstructions,
    });
    const planAppendix = executionPlan.requiresHeavyPlanning
      ? `\n\nRencana Eksekusi Terstruktur:\n${formatPlanMarkdown(executionPlan)}`
      : '';
    return {
      systemPrompt: `${basePrompt}${planAppendix}`,
      useStructuredFallback,
      toolCallingCapability: caps.toolCalling,
      maxContext: caps.maxContext,
    };
  };

  // Load LATEST messages in chronological order without duplicating the new user message
  let loopMessages: AdapterMessage[] = await getRecentHistoryForPromptAsync(projectId, userMessageId, 16);
  loopMessages.push({
    role: 'user',
    content: prompt,
    imageBase64,
    imageMimeType,
  });

  const toolEvents: ToolActionEvent[] = [];
  let fullAssistantText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let filesMutated = false;
  let hasSuccessfulWriteOrEdit = false;
  let retriedNoWrite = false;
  let timedOut = false;
  let lastStreamError: { code: ProviderErrorCode; message: string } | null = null;
  let stepCount = 0;
  let failedVerificationCycles = 0;
  const failedCallCounts = new Map<string, number>();
  let loopBrokenReason: string | null = null;
  let lastStepHadToolCalls = false;
  let truncationContinuations = 0;
  let lastStepTruncated = false;
  let lastMutationEventIdx = -1;
  let taskState: AgentTaskState = 'idle';

  const setTaskState = (next: AgentTaskState, detail?: string) => {
    if (taskState === next && !detail) return;
    taskState = next;
    emit('task_state', {
      state: next,
      sessionId,
      stepCount,
      ...(detail ? { detail } : {}),
      timestamp: Date.now(),
    });
  };

  setTaskState('planning');

  emit('plan', {
    intent: executionPlan.intent,
    complexity: executionPlan.complexity,
    objective: executionPlan.objective,
    requiresHeavyPlanning: executionPlan.requiresHeavyPlanning,
    steps: executionPlan.steps,
  });

  emit('status', { stage: 'thinking', sessionId });

  try {
    while (stepCount < maxSteps && !abortController.signal.aborted) {
      stepCount += 1;
      lastStepHadToolCalls = false;
      const routeKey = `${activeRoute.adapterConfig.providerKeyId}::${activeRoute.modelId}`;
      const currentAdapter = resolveAdapter(activeRoute.adapterConfig.provider);
      const { systemPrompt, useStructuredFallback, toolCallingCapability, maxContext } = await getActiveSystemPrompt(activeRoute);

      if (stepCount === 1 && useStructuredFallback) {
        emit('status', {
          warning: 'Model tidak mendukung tool-calling asli; menggunakan mode format teks terstruktur.',
        });
      }

      const routeMaxContentChars =
        typeof maxContext === 'number' && maxContext > 0
          ? Math.max(16_000, Math.floor(maxContext * 3) - systemPrompt.length)
          : 1_000_000;

      const normalizedMessages = normalizeMessagesForRoute({
        messages: loopMessages,
        targetProvider: activeRoute.adapterConfig.provider,
        supportsTools: mode === 'build' && !useStructuredFallback,
      });
      const preparedMessages =
        estimateMessagesChars(systemPrompt, normalizedMessages) > systemPrompt.length + routeMaxContentChars
          ? compactLoopMessages(normalizedMessages, routeMaxContentChars)
          : normalizedMessages;

      const assistantTextBeforeStep = fullAssistantText;
      const structuredFilter = mode === 'build' && useStructuredFallback ? new StructuredActionStreamFilter() : null;
      let stepText = '';
      const stepToolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        thoughtSignature?: string;
        provider?: ProviderType;
      }> = [];
      let streamError: { code: ProviderErrorCode; message: string } | null = null;
      let stepTruncated = false;

      // Per-step idle watchdog (resets on stream progress) plus hard upper ceiling
      const stepAbort = new AbortController();
      let stepTimedOut = false;
      const onParentAbort = () => stepAbort.abort();
      abortController.signal.addEventListener('abort', onParentAbort, { once: true });
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const armIdleWatchdog = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        timeoutHandle = setTimeout(() => {
          stepTimedOut = true;
          stepAbort.abort();
        }, requestTimeoutMs);
      };
      const hardCeilingMs = Math.max(requestTimeoutMs * 4, 600_000);
      const hardCeilingHandle = setTimeout(() => {
        stepTimedOut = true;
        stepAbort.abort();
      }, hardCeilingMs);
      armIdleWatchdog();
      const stepStartMs = Date.now();

      try {
        for await (const evt of currentAdapter.chatStream({
          config: activeRoute.adapterConfig,
          modelId: activeRoute.modelId,
          systemPrompt,
          messages: preparedMessages,
          tools: mode === 'build' && !useStructuredFallback ? AGENT_TOOLS : undefined,
          signal: stepAbort.signal,
        })) {
          if (abortController.signal.aborted || stepTimedOut) break;
          armIdleWatchdog();
          if (evt.type === 'text_delta') {
            stepText += evt.text;
            if (structuredFilter) {
              const visibleText = structuredFilter.push(evt.text);
              if (visibleText) {
                fullAssistantText += visibleText;
                emit('text_delta', { text: visibleText });
              }
            } else {
              fullAssistantText += evt.text;
              emit('text_delta', { text: evt.text });
            }
          } else if (evt.type === 'tool_call') {
            stepToolCalls.push({
              id: evt.id,
              name: evt.name,
              arguments: evt.arguments,
              provider: activeRoute.adapterConfig.provider,
              ...(evt.thoughtSignature ? { thoughtSignature: evt.thoughtSignature } : {}),
            });
          } else if (evt.type === 'usage') {
            tokensIn += evt.tokensIn;
            tokensOut += evt.tokensOut;
          } else if (evt.type === 'truncated') {
            stepTruncated = true;
            lastStepTruncated = true;
          } else if (evt.type === 'error') {
            streamError = { code: evt.code, message: evt.message };
            lastStreamError = streamError;
            break;
          }
        }
        if (structuredFilter && !streamError && !abortController.signal.aborted && !stepTimedOut) {
          const tailVisible = structuredFilter.flush();
          if (tailVisible) {
            fullAssistantText += tailVisible;
            emit('text_delta', { text: tailVisible });
          }
        }
      } catch (err) {
        if (!stepTimedOut && !abortController.signal.aborted) {
          const msg = err instanceof Error ? err.message : 'Gagal membaca stream dari model AI.';
          streamError = { code: 'PROVIDER_DOWN', message: msg };
          lastStreamError = streamError;
        }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        clearTimeout(hardCeilingHandle);
        abortController.signal.removeEventListener('abort', onParentAbort);
      }

      if (stepTimedOut) {
        timedOut = true;
        const secs = Math.max(1, Math.round(requestTimeoutMs / 1000));
        streamError = {
          code: 'PROVIDER_DOWN',
          message: `Permintaan ke model melebihi batas waktu (${secs} detik). Silakan coba lagi atau pilih model lain.`,
        };
        lastStreamError = streamError;
      }

      // Recover gracefully when an unknown-capability model rejects native `tools` (HTTP 400 / UNKNOWN)
      if (
        streamError &&
        !abortController.signal.aborted &&
        mode === 'build' &&
        !useStructuredFallback &&
        toolCallingCapability === 'unknown' &&
        streamError.code === 'UNKNOWN' &&
        !forcedStructuredRoutes.has(routeKey) &&
        /\b(tools?|tool_choice|function(?:_call|s)?|not\s+support|unsupported)\b/i.test(streamError.message)
      ) {
        forcedStructuredRoutes.add(routeKey);
        fullAssistantText = assistantTextBeforeStep;
        lastStreamError = null;
        stepCount = Math.max(0, stepCount - 1);
        emit('status', {
          warning: 'Model menolak parameter tool-calling asli; beralih otomatis ke mode format teks terstruktur.',
        });
        continue;
      }

      // Recover from CONTEXT_TOO_LONG by compacting loopMessages once before failing over to another route
      if (
        streamError &&
        !abortController.signal.aborted &&
        streamError.code === 'CONTEXT_TOO_LONG' &&
        !compactedRoutes.has(routeKey)
      ) {
        compactedRoutes.add(routeKey);
        fullAssistantText = assistantTextBeforeStep;
        loopMessages = compactLoopMessages(loopMessages, 24_000);
        lastStreamError = null;
        stepCount = Math.max(0, stepCount - 1);
        emit('status', {
          warning: 'Konteks melebihi kapasitas model; memadatkan riwayat tool dan mencoba ulang.',
        });
        continue;
      }

      // Automatic multi-provider / multi-model fallback while preserving task context & plan
      if (streamError && !abortController.signal.aborted) {
        healthMonitor.recordFailure(
          activeRoute.adapterConfig.provider,
          activeRoute.modelId,
          streamError.code,
          Date.now(),
          makeCredentialFingerprint(activeRoute.adapterConfig)
        );
        const { next, decision } = selectNextFallbackRoute({
          chain: orderedChain,
          attemptedIds: attemptedRoutes,
          failedCandidate: activeRoute,
          errorCode: streamError.code,
          health: healthMonitor,
        });

        if (next) {
          const previous = activeRoute;
          activeRoute = next;
          attemptedRoutes.add(`${next.adapterConfig.providerKeyId}::${next.modelId}`);
          timedOut = false;
          lastStreamError = null;
          // Roll back partial text emitted before the failed stream errored
          fullAssistantText = assistantTextBeforeStep;
          // Do not consume a full agent step on transparent failover
          stepCount = Math.max(0, stepCount - 1);
          emit('fallback', {
            fromProvider: previous.adapterConfig.provider,
            fromModel: previous.modelId,
            toProvider: next.adapterConfig.provider,
            toModel: next.modelId,
            errorCode: streamError.code,
            reason: decision.reason,
          });
          emit('status', {
            stage: 'thinking',
            warning: `Beralih otomatis dari ${previous.adapterConfig.provider}/${previous.modelId} ke ${next.adapterConfig.provider}/${next.modelId} (${streamError.code}).`,
          });
          continue;
        }

        // Preserve any non-mutated rollback before terminating on fatal stream error
        fullAssistantText = assistantTextBeforeStep || fullAssistantText;
        emit('error', streamError);
        break;
      }

      if (abortController.signal.aborted) {
        break;
      }

      healthMonitor.recordSuccess(
        activeRoute.adapterConfig.provider,
        activeRoute.modelId,
        Date.now() - stepStartMs,
        makeCredentialFingerprint(activeRoute.adapterConfig)
      );

      const secretList = Array.from(activeSecrets);

      // Multi-step structured fallback parsing for non-tool-calling models (Section 7.4)
      if (mode === 'build' && useStructuredFallback && stepToolCalls.length === 0) {
        const parsed = parseStructuredActions(stepText);
        // Ensure persisted text contains only clean narrative (never raw <carmen_action> blocks)
        const separator = assistantTextBeforeStep.trim() && parsed.cleanText ? '\n' : '';
        fullAssistantText = `${assistantTextBeforeStep.trimEnd()}${separator}${parsed.cleanText}`;

        if (parsed.actions.length > 0) {
          const actionResultLines: string[] = [];
          lastStepHadToolCalls = true;

          for (const act of parsed.actions) {
            if (abortController.signal.aborted) break;
            const targetLabel = String(
              act.args.path || act.args.cmd || act.args.query || act.args.dir || act.tool
            );
            if (
              act.tool === 'write_file' ||
              act.tool === 'edit_file' ||
              act.tool === 'delete_file' ||
              act.tool === 'create_directory'
            ) {
              const isRepair = failedVerificationCycles > 0;
              setTaskState(isRepair ? 'repairing' : 'executing', targetLabel);
              emit('status', {
                stage: isRepair ? 'repairing' : 'executing',
                target: targetLabel,
              });
            } else if (
              act.tool === 'validate_project' ||
              act.tool === 'read_logs' ||
              act.tool === 'run_command'
            ) {
              setTaskState('verifying', targetLabel);
              emit('status', { stage: 'verifying', target: targetLabel });
            }

            executionPlan = advancePlanForTool(executionPlan, act.tool, 'running');
            emit('plan', {
              intent: executionPlan.intent,
              complexity: executionPlan.complexity,
              objective: executionPlan.objective,
              requiresHeavyPlanning: executionPlan.requiresHeavyPlanning,
              steps: executionPlan.steps,
            });

            const actionEvent: ToolActionEvent = {
              id: `act_${crypto.randomUUID().slice(0, 6)}`,
              tool: act.tool,
              target: targetLabel,
              status: 'running',
            };
            toolEvents.push(actionEvent);
            emit('tool_event', actionEvent);

            let res: {
              ok: boolean;
              target: string;
              result: string;
              mutated: boolean;
              isVerificationCmd?: boolean;
              errorClass?: AgentErrorClass;
            };
            try {
              res = await executeTool(projectId, act.tool, act.args, secretList, abortController.signal);
            } catch (toolErr) {
              res = {
                ok: false,
                target: targetLabel,
                result: `Tool ${act.tool} error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`,
                mutated: false,
              };
            }
            actionEvent.status = res.ok ? 'success' : 'error';
            actionEvent.detail = res.result;
            if (res.mutated) {
              filesMutated = true;
              lastMutationEventIdx = toolEvents.indexOf(actionEvent);
            }
            if (res.ok && (act.tool === 'write_file' || act.tool === 'edit_file')) {
              hasSuccessfulWriteOrEdit = true;
            }
            executionPlan = advancePlanForTool(executionPlan, act.tool, actionEvent.status);
            emit('plan', {
              intent: executionPlan.intent,
              complexity: executionPlan.complexity,
              objective: executionPlan.objective,
              requiresHeavyPlanning: executionPlan.requiresHeavyPlanning,
              steps: executionPlan.steps,
            });
            emit('tool_event', actionEvent);

            actionResultLines.push(`[Hasil ${act.tool} (${targetLabel}) — ${res.ok ? 'OK' : 'GAGAL'}]:\n${res.result}`);

            if (!res.ok) {
              const errClass = res.errorClass || classifyAgentToolError(res.result);
              const sig = `${act.tool}:${JSON.stringify(act.args)}`;
              const nextFailCount = (failedCallCounts.get(sig) || 0) + 1;
              failedCallCounts.set(sig, nextFailCount);
              if (errClass === 'permission' && nextFailCount >= 2) {
                loopBrokenReason = `Eksekusi tool "${act.tool}" dihentikan karena penolakan izin/keamanan berulang (${res.result.slice(0, 120)}).`;
                emit('status', { warning: loopBrokenReason });
                break;
              }
              if (nextFailCount >= MAX_IDENTICAL_FAILING_CALLS) {
                loopBrokenReason = `Loop dihentikan otomatis karena pemanggilan tool "${act.tool}" gagal berulang (${MAX_IDENTICAL_FAILING_CALLS}x) dengan argumen identik.`;
                emit('status', { warning: loopBrokenReason });
                break;
              }
              if (res.isVerificationCmd) {
                failedVerificationCycles += 1;
                setTaskState('repairing', act.tool);
                if (failedVerificationCycles > MAX_AUTO_FIX_CYCLES) {
                  loopBrokenReason = `Batas maksimal perbaikan otomatis (${MAX_AUTO_FIX_CYCLES} siklus build/test) tercapai. Periksa log error di tab Terminal.`;
                  emit('status', { warning: loopBrokenReason });
                  break;
                }
              }
            }
          }

          loopMessages.push({
            role: 'assistant',
            content:
              parsed.cleanText ||
              `[Menjalankan aksi terstruktur: ${parsed.actions.map((a) => a.tool).join(', ')}]`,
          });
          if (actionResultLines.length > 0) {
            loopMessages.push({
              role: 'user',
              content: `${actionResultLines.join('\n\n')}\n\nLanjutkan langkah berikutnya atau berikan ringkasan akhir tanpa blok <carmen_action> jika semua sudah selesai.`,
            });
          }

          if (loopBrokenReason) break;
          continue;
        }

        if (stepTruncated && truncationContinuations < 32 && stepCount < maxSteps) {
          truncationContinuations += 1;
          emit('status', {
            warning: 'Respons model terpotong oleh batas output token. Meminta lanjutan otomatis...',
          });
          loopMessages.push({
            role: 'assistant',
            content: parsed.cleanText || '[Respons terpotong karena batas output token]',
          });
          loopMessages.push({
            role: 'user',
            content:
              'Respons sebelumnya terpotong oleh batas output token. Lanjutkan blok aksi atau bagian yang terpotong tanpa mengulang yang sudah selesai.',
          });
          continue;
        }

        if (!hasSuccessfulWriteOrEdit && !fullAssistantText.trim() && !retriedNoWrite) {
          retriedNoWrite = true;
          emit('status', { warning: 'AI belum menulis file. Mencoba ulang otomatis...' });
          loopMessages.push({ role: 'user', content: NO_WRITE_RETRY_PROMPT });
          continue;
        }
        lastStepTruncated = stepTruncated;
        break;
      }

      if (stepToolCalls.length === 0) {
        if (stepTruncated && truncationContinuations < 32 && stepCount < maxSteps) {
          truncationContinuations += 1;
          emit('status', {
            warning: 'Respons model terpotong oleh batas output token. Meminta lanjutan otomatis...',
          });
          loopMessages.push({
            role: 'assistant',
            content: stepText || '[Respons terpotong karena batas output token]',
          });
          loopMessages.push({
            role: 'user',
            content:
              'Respons sebelumnya terpotong oleh batas output token. Lanjutkan bagian yang belum selesai tanpa mengulang yang sudah selesai.',
          });
          continue;
        }
        if (mode === 'build' && !hasSuccessfulWriteOrEdit && !fullAssistantText.trim() && !retriedNoWrite) {
          retriedNoWrite = true;
          emit('status', { warning: 'AI belum menulis file. Mencoba ulang otomatis...' });
          loopMessages.push({ role: 'user', content: NO_WRITE_RETRY_PROMPT });
          continue;
        }
        lastStepTruncated = stepTruncated;
        break;
      }
      lastStepTruncated = stepTruncated;

      loopMessages.push({
        role: 'assistant',
        content: stepText,
        toolCalls: stepToolCalls,
      });

      lastStepHadToolCalls = true;

      const executeSingleToolCall = async (tc: (typeof stepToolCalls)[number]) => {
        const targetLabel = String(
          tc.arguments.path ||
            tc.arguments.cmd ||
            tc.arguments.command ||
            tc.arguments.query ||
            tc.arguments.dir ||
            tc.arguments.packages ||
            tc.name
        );

        if (
          tc.name === 'list_files' ||
          tc.name === 'read_file' ||
          tc.name === 'search_files' ||
          tc.name === 'inspect_dependencies' ||
          tc.name === 'workspace_diff'
        ) {
          setTaskState('executing', targetLabel);
          emit('status', { stage: 'inspecting', target: targetLabel });
        } else if (
          tc.name === 'write_file' ||
          tc.name === 'edit_file' ||
          tc.name === 'delete_file' ||
          tc.name === 'create_directory' ||
          tc.name === 'rollback_checkpoint'
        ) {
          const isRepair = failedVerificationCycles > 0 || tc.name === 'rollback_checkpoint';
          setTaskState(isRepair ? 'repairing' : 'executing', targetLabel);
          emit('status', {
            stage: isRepair ? 'repairing' : 'executing',
            target: targetLabel,
          });
        } else if (
          tc.name === 'validate_project' ||
          tc.name === 'build_project' ||
          tc.name === 'run_tests' ||
          tc.name === 'read_logs' ||
          tc.name === 'run_command'
        ) {
          setTaskState('verifying', targetLabel);
          emit('status', { stage: 'verifying', target: targetLabel });
        }

        executionPlan = advancePlanForTool(executionPlan, tc.name, 'running');
        emit('plan', {
          intent: executionPlan.intent,
          complexity: executionPlan.complexity,
          objective: executionPlan.objective,
          requiresHeavyPlanning: executionPlan.requiresHeavyPlanning,
          steps: executionPlan.steps,
        });

        const actionEvent: ToolActionEvent = {
          id: tc.id || `act_${crypto.randomUUID().slice(0, 6)}`,
          tool: tc.name as ToolActionEvent['tool'],
          target: targetLabel,
          status: 'running',
        };
        toolEvents.push(actionEvent);
        emit('tool_event', actionEvent);

        let execRes: {
          ok: boolean;
          target: string;
          result: string;
          mutated: boolean;
          isVerificationCmd?: boolean;
          errorClass?: AgentErrorClass;
        };
        try {
          execRes = await executeTool(projectId, tc.name, tc.arguments, secretList, abortController.signal);
        } catch (toolErr) {
          execRes = {
            ok: false,
            target: targetLabel,
            result: `Tool ${tc.name} error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`,
            mutated: false,
          };
        }
        return { tc, actionEvent, execRes };
      };

      const recordToolOutcome = (
        outcome: {
          tc: (typeof stepToolCalls)[number];
          actionEvent: ToolActionEvent;
          execRes: {
            ok: boolean;
            target: string;
            result: string;
            mutated: boolean;
            isVerificationCmd?: boolean;
            errorClass?: AgentErrorClass;
          };
        }
      ) => {
        const { tc, actionEvent, execRes } = outcome;
        actionEvent.status = execRes.ok ? 'success' : 'error';
        actionEvent.detail = execRes.result;
        if (execRes.mutated) {
          filesMutated = true;
          lastMutationEventIdx = toolEvents.indexOf(actionEvent);
        }
        if (execRes.ok && (tc.name === 'write_file' || tc.name === 'edit_file')) {
          hasSuccessfulWriteOrEdit = true;
        }
        executionPlan = advancePlanForTool(executionPlan, tc.name, actionEvent.status);
        emit('plan', {
          intent: executionPlan.intent,
          complexity: executionPlan.complexity,
          objective: executionPlan.objective,
          requiresHeavyPlanning: executionPlan.requiresHeavyPlanning,
          steps: executionPlan.steps,
        });
        emit('tool_event', actionEvent);

        loopMessages.push({
          role: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          toolProvider: activeRoute.adapterConfig.provider,
          content: execRes.result,
        });

        if (!execRes.ok) {
          const errClass = execRes.errorClass || classifyAgentToolError(execRes.result);
          const sig = `${tc.name}:${JSON.stringify(tc.arguments)}`;
          const nextFailCount = (failedCallCounts.get(sig) || 0) + 1;
          failedCallCounts.set(sig, nextFailCount);
          if (errClass === 'permission' && nextFailCount >= 2) {
            loopBrokenReason = `Eksekusi tool "${tc.name}" dihentikan karena penolakan izin/keamanan berulang (${execRes.result.slice(0, 120)}).`;
            emit('status', { warning: loopBrokenReason });
            return false;
          }
          if (nextFailCount >= MAX_IDENTICAL_FAILING_CALLS) {
            loopBrokenReason = `Loop dihentikan otomatis karena pemanggilan tool "${tc.name}" gagal berulang (${MAX_IDENTICAL_FAILING_CALLS}x) dengan argumen identik.`;
            emit('status', { warning: loopBrokenReason });
            return false;
          }
          if (execRes.isVerificationCmd) {
            failedVerificationCycles += 1;
            setTaskState('repairing', tc.name);
            if (failedVerificationCycles > MAX_AUTO_FIX_CYCLES) {
              loopBrokenReason = `Batas maksimal perbaikan otomatis (${MAX_AUTO_FIX_CYCLES} siklus build/test) tercapai. Periksa log error di tab Terminal.`;
              emit('status', { warning: loopBrokenReason });
              return false;
            }
          }
        }
        return true;
      };

      // Execute consecutive pure read-only tool calls in parallel while keeping verification, memory & mutating tools serialized
      const isReadOnlyBatchCandidate = (tc: (typeof stepToolCalls)[number]) => isParallelReadOnlyTool(tc.name);

      let tcIdx = 0;
      while (tcIdx < stepToolCalls.length && !abortController.signal.aborted) {
        if (isReadOnlyBatchCandidate(stepToolCalls[tcIdx])) {
          const readBatch: Array<(typeof stepToolCalls)[number]> = [];
          while (tcIdx < stepToolCalls.length && isReadOnlyBatchCandidate(stepToolCalls[tcIdx])) {
            readBatch.push(stepToolCalls[tcIdx]);
            tcIdx += 1;
          }
          const batchOutcomes = await Promise.all(readBatch.map((tc) => executeSingleToolCall(tc)));
          for (const out of batchOutcomes) {
            if (!recordToolOutcome(out)) break;
          }
          if (loopBrokenReason) break;
          continue;
        }

        const out = await executeSingleToolCall(stepToolCalls[tcIdx]);
        tcIdx += 1;
        if (!recordToolOutcome(out)) break;
      }

      if (loopBrokenReason) {
        break;
      }
    }
  } finally {
    // Race-free cleanup: ONLY delete if this sessionId is still the registered owner
    if (activeSessions.get(projectId)?.sessionId === sessionId) {
      activeSessions.delete(projectId);
    }
  }

  // The loop ended only because the per-turn step budget ran out while the model was still calling tools:
  // tell the user the work may be unfinished instead of reporting a false "done".
  const hitStepLimit = !loopBrokenReason && !abortController.signal.aborted && stepCount >= maxSteps && lastStepHadToolCalls;
  if (hitStepLimit) {
    loopBrokenReason = `Batas ${maxSteps} langkah per giliran tercapai, jadi pekerjaan mungkin belum selesai. Kirim "lanjutkan" untuk meneruskan dari titik ini.`;
    emit('status', { warning: loopBrokenReason });
  }

  if (filesMutated) {
    backendRuntimeManager.stopBackend(projectId);
    projectRuntime.clearError(projectId);
    await projectRuntime.ensureReadyAsync(projectId);
  }

  // Tool-Evidence Verification Gate: track latest post-mutation outcome per check so any failing check blocks verified_pass
  const VERIFICATION_TOOL_NAMES = new Set(['validate_project', 'build_project', 'run_tests', 'run_command']);
  const postMutationVerifications = toolEvents
    .slice(Math.max(0, lastMutationEventIdx + 1))
    .filter((ev) => VERIFICATION_TOOL_NAMES.has(ev.tool));
  const latestCheckStatus = new Map<string, 'success' | 'error'>();
  for (const ev of postMutationVerifications) {
    if (ev.status === 'success' || ev.status === 'error') {
      latestCheckStatus.set(`${ev.tool}(${ev.target})`, ev.status);
    }
  }
  const passedChecks = Array.from(latestCheckStatus.entries())
    .filter(([, status]) => status === 'success')
    .map(([key]) => key);
  const failedChecks = Array.from(latestCheckStatus.entries())
    .filter(([, status]) => status === 'error')
    .map(([key]) => key);

  const verificationGateStatus: 'verified_pass' | 'verified_fail' | 'not_verified' | 'not_required' =
    mode !== 'build' || !filesMutated
      ? 'not_required'
      : failedChecks.length > 0
        ? 'verified_fail'
        : passedChecks.length > 0
          ? 'verified_pass'
          : 'not_verified';

  emit('verification_gate', {
    status: verificationGateStatus,
    passedChecks,
    failedChecks,
  });

  const assistantMessageId = `msg_${crypto.randomUUID().slice(0, 10)}`;
  let versionId: string | null = null;
  if (filesMutated) {
    versionId = await createVersionSnapshotIfChangedAsync(projectId, assistantMessageId, prompt);
    if (versionId) {
      emit('version', { versionId });
    }
  }

  let finalText = fullAssistantText.trim();
  if (!finalText) {
    if (abortController.signal.aborted) {
      finalText = 'Generasi dihentikan oleh pengguna.';
    } else if (loopBrokenReason) {
      finalText = loopBrokenReason;
    } else if (timedOut && lastStreamError) {
      finalText = lastStreamError.message;
    } else if (lastStreamError) {
      finalText = lastStreamError.message;
    } else if (mode === 'build' && !hasSuccessfulWriteOrEdit) {
      finalText = NO_CHANGE_WARNING_TEXT;
      emit('status', { warning: NO_CHANGE_WARNING_TEXT });
    } else if (filesMutated) {
      finalText = 'Perubahan file selesai diterapkan dan pratinjau telah diperbarui.';
    } else {
      finalText = 'Tidak ada respons teks dari model.';
    }
  } else if (loopBrokenReason && !finalText.includes(loopBrokenReason)) {
    finalText = `${finalText}\n\n${loopBrokenReason}`;
  }
  if (lastStreamError && !abortController.signal.aborted && !finalText.includes(lastStreamError.message)) {
    finalText = `${finalText}\n\n${lastStreamError.message}`;
  }

  if (lastStepTruncated && !abortController.signal.aborted && !lastStreamError) {
    const truncNote =
      'Peringatan: Respons terakhir model mencapai batas output token (terpotong). Periksa hasil atau kirim "lanjutkan" bila masih ada bagian yang belum lengkap.';
    emit('status', { warning: truncNote });
    if (!finalText.includes(truncNote)) {
      finalText = `${finalText}\n\n${truncNote}`;
    }
  }

  if (!abortController.signal.aborted && !lastStreamError) {
    if (verificationGateStatus === 'verified_fail') {
      const failNote = `Status verifikasi: FAILED — tool verifikasi gagal setelah perubahan terakhir (${failedChecks.join(', ')}).`;
      if (!/gagal|failed|error/i.test(finalText)) {
        finalText = `${finalText}\n\n${failNote}`;
      }
    } else if (
      verificationGateStatus === 'not_verified' &&
      /\b(?:build\s+lulus|tests?\s+(?:passed|lulus)|semua\s+(?:test|uji|verifikasi)\s+lulus|verified\s+pass)\b/i.test(
        finalText
      )
    ) {
      finalText = `${finalText}\n\n[NOT VERIFIED: Belum ada eksekusi validate_project/build_project/run_tests yang lulus setelah mutasi file terakhir.]`;
    }
  }

  if (abortController.signal.aborted) {
    setTaskState('cancelled');
  } else if (lastStreamError || loopBrokenReason || verificationGateStatus === 'verified_fail') {
    setTaskState('failed', lastStreamError?.message || loopBrokenReason || 'Verification failed');
  } else {
    setTaskState('completed');
  }

  const planText = executionPlan.requiresHeavyPlanning ? formatPlanMarkdown(executionPlan) : null;
  const secretListForScrub = Array.from(activeSecrets);
  const scrubbedFinalText = scrubSecrets(finalText, secretListForScrub);

  // Deterministic cross-provider handoff saved on EVERY build turn (success, error, abort, step-limit, failover)
  if (mode === 'build') {
    const handoffStatus: HandoffTurnStatus = abortController.signal.aborted
      ? 'aborted'
      : lastStreamError
        ? 'error'
        : hitStepLimit
          ? 'step_limit'
          : loopBrokenReason
            ? 'loop_broken'
            : !filesMutated && !hasSuccessfulWriteOrEdit && finalText === NO_CHANGE_WARNING_TEXT
              ? 'no_change'
              : 'completed';

    const modifiedFiles = Array.from(
      new Set(
        toolEvents
          .filter(
            (e) =>
              e.status === 'success' &&
              (e.tool === 'write_file' || e.tool === 'edit_file' || e.tool === 'delete_file') &&
              e.target
          )
          .map((e) => String(e.target))
      )
    );
    const completedActions = toolEvents
      .filter((e) => e.status === 'success')
      .map((e) => `${e.tool}(${e.target})`);
    const failedActions = toolEvents
      .filter((e) => e.status === 'error')
      .map((e) => `${e.tool}(${e.target}): ${String(e.detail || '').slice(0, 80)}`);
    const remainingSteps = executionPlan.steps
      .filter((s) => s.status !== 'done')
      .map((s) => s.title);

    const handoffText = buildDeterministicHandoff({
      objective: executionPlan.objective,
      lastPrompt: prompt,
      provider: activeRoute.adapterConfig.provider,
      model: activeRoute.modelId,
      status: handoffStatus,
      completedActions,
      failedActions,
      modifiedFiles,
      remainingSteps,
      lastError: lastStreamError?.message || projectRuntime.getLastError(projectId),
      summaryNote: scrubbedFinalText.slice(0, 300),
    });
    await setProjectHandoffAsync(projectId, handoffText, secretListForScrub);
  }

  const estimatedCostUsd = estimateModelCostUsd(
    activeRoute.adapterConfig.provider,
    activeRoute.modelId,
    tokensIn,
    tokensOut
  );

  await asyncDb.run(
    `INSERT INTO messages (id, project_id, role, content, mode, plan, tool_events_json, provider, model, tokens_in, tokens_out, estimated_cost_usd, version_id)
     VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    assistantMessageId,
    projectId,
    scrubbedFinalText,
    mode,
    planText,
    JSON.stringify(toolEvents),
    activeRoute.adapterConfig.provider,
    activeRoute.modelId,
    tokensIn || null,
    tokensOut || null,
    estimatedCostUsd > 0 ? estimatedCostUsd : null,
    versionId
  );

  const saved: ChatMessage = {
    id: assistantMessageId,
    projectId,
    role: 'assistant',
    content: scrubbedFinalText,
    mode,
    plan: planText,
    toolEvents,
    provider: activeRoute.adapterConfig.provider,
    model: activeRoute.modelId,
    tokensIn: tokensIn || null,
    tokensOut: tokensOut || null,
    estimatedCostUsd: estimatedCostUsd > 0 ? estimatedCostUsd : null,
    versionId,
    createdAt: new Date().toISOString(),
  };

  if (skillPreflight.loadedSkills.length > 0) {
    const skillDurationMs = Date.now() - skillTurnStartMs;
    const toolsInvoked = Array.from(new Set(toolEvents.map((e) => e.tool)));
    const turnSucceeded =
      !abortController.signal.aborted &&
      !lastStreamError &&
      !loopBrokenReason &&
      (mode === 'discuss' || hasSuccessfulWriteOrEdit || filesMutated || Boolean(scrubbedFinalText));
    const hadToolRecovery = toolEvents.some((e) => e.status === 'error') && turnSucceeded;

    for (const pkg of skillPreflight.loadedSkills) {
      const match = skillPreflight.selectedMatches.find((m) => m.skill.slug === pkg.slug);
      const status = turnSucceeded ? (hadToolRecovery ? 'fallback' : 'success') : 'failed';
      const reason = match?.reason || 'Skill dijalankan bersama CARMEN Agent Core.';
      const errSummary = !turnSucceeded
        ? lastStreamError?.message || loopBrokenReason || 'Giliran selesai tanpa mutasi/respons sukses.'
        : hadToolRecovery
          ? 'Sebagian langkah tool gagal lalu dipulihkan oleh kemampuan agen bawaan.'
          : null;

      emit('skill_execution', {
        skillId: pkg.id,
        skillName: pkg.slug,
        mode: skillPreflight.mode,
        status,
        reason,
        fallbackUsed: status === 'fallback' || status === 'failed',
        durationMs: skillDurationMs,
        toolsInvoked,
        errorSummary: errSummary,
      });

      await recordSkillExecutionResult({
        projectId,
        userId: effectiveUserId,
        attempt: {
          skillId: pkg.id,
          skillName: pkg.slug,
          mode: skillPreflight.mode,
          status,
          confidence: match?.confidence ?? 0.5,
          reason,
          fallbackUsed: status !== 'success',
          toolsInvoked,
          errorSummary: errSummary,
          durationMs: skillDurationMs,
        },
        activeSecrets: secretListForScrub,
      });
    }
  }

    emit('done', {
      message: saved,
      filesMutated,
      usedProviderKeyId: activeRoute.adapterConfig.providerKeyId,
    });
    return saved;
  } finally {
    if (turnCheckpoint && preTurnCheckpoints.get(projectId) === turnCheckpoint) {
      preTurnCheckpoints.delete(projectId);
    }
  }
}
