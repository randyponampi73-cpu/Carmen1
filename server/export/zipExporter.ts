import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { asyncDb, SANDBOX_DIR } from '../db';
import { normalizeProjectPath, sanitizeDownloadFilename, scrubSecrets, validateTenantWorkspacePath } from '../security';

const BINARY_EXPORT_EXT_RE =
  /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|ico|wasm|svgz|mp3|mp4|wav|ogg|webm|bin)$/i;

export interface CollectedProjectFile {
  path: string;
  isBinary: boolean;
  buffer: Buffer;
  textContent?: string;
}

export function isExcludedFromExport(filePath: string): boolean {
  const norm = normalizeProjectPath(filePath);
  if (!norm) return true;
  const lower = norm.toLowerCase();
  const segments = lower.split('/');
  if (
    segments.includes('node_modules') ||
    segments.includes('.git') ||
    segments[0] === 'data' ||
    segments.includes('.aistudio') ||
    segments.includes('.playwright-cli') ||
    segments.includes('.cache') ||
    segments.includes('.carmen-runtime') ||
    segments.includes('artifacts')
  ) {
    return true;
  }
  const base = segments[segments.length - 1] || '';
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return true;
  if (base === '.ds_store' || base === 'thumbs.db') return true;
  if (
    /\.(db|db-wal|db-shm|wal|shm|sqlite|sqlite3|log|tmp|bak|jks|keystore|p12|pfx|pem|key|apk|aab|zip)$/i.test(
      base
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Collects clean project files consistently across ZIP export and remote/self-hosted deployment adapters (F-11).
 * Combines DB-persisted files with disk-stored binary/text assets inside the tenant sandbox workspace,
 * preserving raw binary buffers without UTF-8 corruption, rejecting symlinks/traversal, and scrubbing secrets.
 */
export async function collectProjectFilesForDistribution(
  projectId: string,
  activeUserSecrets: string[] = []
): Promise<{
  project: { name: string; type: string; stack: string };
  files: CollectedProjectFile[];
  hasPackageJson: boolean;
  packageJsonContent: string | null;
}> {
  const project = await asyncDb.get<{ name: string; type: string; stack: string }>(
    'SELECT name, type, stack FROM projects WHERE id = ?',
    projectId
  );

  if (!project) {
    throw new Error('Proyek tidak ditemukan.');
  }

  const dbFiles = await asyncDb.all<{ path: string; content: string }>(
    'SELECT path, content FROM project_files WHERE project_id = ? ORDER BY path',
    projectId
  );

  const envVars = await asyncDb.all<{ key: string }>(
    'SELECT key FROM env_vars WHERE project_id = ? ORDER BY key',
    projectId
  );

  const collected: CollectedProjectFile[] = [];
  const addedPaths = new Set<string>();
  let hasPackageJson = false;
  let packageJsonContent: string | null = null;

  for (const file of dbFiles) {
    const norm = normalizeProjectPath(file.path);
    if (!norm || isExcludedFromExport(norm)) continue;
    if (norm === '.env.example' && envVars.length > 0) continue;
    const scrubbed = scrubSecrets(file.content, activeUserSecrets);
    if (norm === 'package.json') {
      hasPackageJson = true;
      packageJsonContent = scrubbed;
    }
    collected.push({
      path: norm,
      isBinary: false,
      textContent: scrubbed,
      buffer: Buffer.from(scrubbed, 'utf8'),
    });
    addedPaths.add(norm);
  }

  // Include non-DB disk assets (e.g., imported .woff2/.png/.ico in public/) without ever following symlinks.
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (safeId) {
    const workspaceDir = path.resolve(path.join(SANDBOX_DIR, safeId, 'workspace'));
    try {
      const wsStat = fs.lstatSync(workspaceDir);
      if (wsStat.isDirectory() && !wsStat.isSymbolicLink()) {
        const walkDisk = (dir: string, relPrefix: string) => {
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const ent of entries) {
            if (ent.isSymbolicLink()) continue;
            if (
              ent.name === 'node_modules' ||
              ent.name === '.git' ||
              ent.name === 'dist' ||
              ent.name === '.carmen-runtime'
            ) {
              continue;
            }
            const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
              walkDisk(full, rel);
              continue;
            }
            if (!ent.isFile()) continue;
            const norm = normalizeProjectPath(rel);
            if (!norm || addedPaths.has(norm) || isExcludedFromExport(norm)) continue;
            if (norm === '.env.example' && envVars.length > 0) continue;
            const tenantCheck = validateTenantWorkspacePath(workspaceDir, norm, SANDBOX_DIR);
            if (!tenantCheck.valid || !tenantCheck.resolvedPath) continue;
            try {
              const buf = fs.readFileSync(tenantCheck.resolvedPath);
              addedPaths.add(norm);
              const isBinary = BINARY_EXPORT_EXT_RE.test(norm) || buf.includes(0);
              if (isBinary) {
                collected.push({
                  path: norm,
                  isBinary: true,
                  buffer: buf,
                });
              } else {
                const scrubbed = scrubSecrets(buf.toString('utf8'), activeUserSecrets);
                if (norm === 'package.json') {
                  hasPackageJson = true;
                  packageJsonContent = scrubbed;
                }
                collected.push({
                  path: norm,
                  isBinary: false,
                  textContent: scrubbed,
                  buffer: Buffer.from(scrubbed, 'utf8'),
                });
              }
            } catch {
              // Skip unreadable file cleanly
            }
          }
        };
        walkDisk(workspaceDir, '');
      }
    } catch {
      // Workspace directory not provisioned yet — SQLite files are sufficient
    }
  }

  if (envVars.length > 0) {
    const envExample = envVars.map((e) => `${e.key}=`).join('\n') + '\n';
    collected.push({
      path: '.env.example',
      isBinary: false,
      textContent: envExample,
      buffer: Buffer.from(envExample, 'utf8'),
    });
  }

  collected.sort((a, b) => a.path.localeCompare(b.path));
  return {
    project,
    files: collected,
    hasPackageJson,
    packageJsonContent,
  };
}

/**
 * Exports a project into a clean, runnable ZIP archive (PRD WEB-7 & Acceptance Criterion #7).
 * Strictly excludes user API keys, secret env values, node_modules/, .git/, data/, .aistudio/,
 * .env, keystores, temp files, symlinks, and database files, while preserving imported/generated binary assets on disk.
 */
export async function exportProjectZip(
  projectId: string,
  activeUserSecrets: string[] = []
): Promise<{ buffer: Buffer; filename: string }> {
  const { project, files } = await collectProjectFilesForDistribution(projectId, activeUserSecrets);
  const zip = new JSZip();

  for (const file of files) {
    zip.file(file.path, file.buffer);
  }

  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'carmen-project';
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, filename: sanitizeDownloadFilename(`${slug}.zip`, 'carmen-project.zip') };
}
