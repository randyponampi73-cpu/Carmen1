import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { asyncDb } from '../db';
import { parseJsonColumn, toBooleanFlag, toIsoTimestamp } from '../db/dialect';
import { computeEffectivePermissions } from './permissions';
import {
  ALLOWED_SKILL_PERMISSIONS,
  SKILL_CATEGORIES,
  type SkillCategory,
  type SkillManifest,
  type SkillMetadata,
  type SkillPackageRecord,
  type SkillPermission,
  type SkillSource,
  type SkillTrustLevel,
  type SkillVersionRecord,
} from './types';
import {
  isAllowedSkillPackageFile,
  MAX_SKILL_FILE_BYTES,
  normalizeSkillRelativePath,
  validateSkillPackage,
} from './validator';

export function getBuiltinSkillsRoot(): string {
  const configured = process.env.CARMEN_BUILTIN_SKILLS_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), 'skills');
}

export const BUILTIN_SKILLS_ROOT = getBuiltinSkillsRoot();

const CATEGORY_SET = new Set<string>(SKILL_CATEGORIES);
const PERM_SET = new Set<string>(ALLOWED_SKILL_PERMISSIONS);

export interface ScannedBuiltinSkill {
  category: SkillCategory;
  slug: string;
  name: string;
  description: string;
  manifest: SkillManifest;
  skillMd: string;
  references: Record<string, string>;
  scripts: Record<string, string>;
  assets: Record<string, string>;
  checksum: string;
}

export interface BuiltinScanResult {
  packages: ScannedBuiltinSkill[];
  failures: Array<{ slug: string; path: string; error: string }>;
}

export function computePackageChecksum(pkg: {
  skillMd: string;
  references: Record<string, string>;
  scripts: Record<string, string>;
  assets: Record<string, string>;
}): string {
  const hash = crypto.createHash('sha256');
  hash.update(pkg.skillMd, 'utf8');
  for (const map of [pkg.references, pkg.scripts, pkg.assets]) {
    for (const key of Object.keys(map).sort()) {
      hash.update(`\0${key}\0${map[key]}`, 'utf8');
    }
  }
  return hash.digest('hex').slice(0, 24);
}

export function verifySkillPackageIntegrity(pkg: {
  checksum?: string;
  skillMd: string;
  references: Record<string, string>;
  scripts: Record<string, string>;
  assets: Record<string, string>;
}): { valid: boolean; expectedChecksum: string; actualChecksum: string } {
  const actualChecksum = computePackageChecksum({
    skillMd: pkg.skillMd,
    references: pkg.references || {},
    scripts: pkg.scripts || {},
    assets: pkg.assets || {},
  });
  const expectedChecksum = String(pkg.checksum || '').trim();
  if (!expectedChecksum) {
    return { valid: false, expectedChecksum, actualChecksum };
  }
  const aBuf = Buffer.from(actualChecksum, 'utf8');
  const bBuf = Buffer.from(expectedChecksum, 'utf8');
  const valid = aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
  return { valid, expectedChecksum, actualChecksum };
}

export function signSkillChecksumHmac(checksum: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(checksum, 'utf8').digest('hex');
}

export function verifySkillChecksumHmac(checksum: string, signatureHex: string, secret: string): boolean {
  if (!checksum || !signatureHex || !secret) return false;
  const expected = signSkillChecksumHmac(checksum, secret);
  const aBuf = Buffer.from(expected, 'utf8');
  const bBuf = Buffer.from(signatureHex.trim(), 'utf8');
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

function readSubtreeFiles(
  baseDir: string,
  subDirName: 'references' | 'scripts' | 'assets'
): { files: Record<string, string>; errors: string[] } {
  const files: Record<string, string> = {};
  const errors: string[] = [];
  const subPath = path.join(baseDir, subDirName);
  if (!fs.existsSync(subPath)) return { files, errors };

  const walk = (dir: string, prefix: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : `${subDirName}/${ent.name}`;
      if (ent.isSymbolicLink()) {
        errors.push(`Symlink tidak diizinkan pada paket skill: ${rel}`);
        continue;
      }
      if (ent.isDirectory()) {
        walk(full, rel);
        continue;
      }
      const allowed = isAllowedSkillPackageFile(rel);
      if (!allowed.ok) {
        errors.push(allowed.reason || `File tidak diizinkan: ${rel}`);
        continue;
      }
      const stat = fs.statSync(full);
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        errors.push(`File ${rel} melebihi batas ukuran.`);
        continue;
      }
      files[rel] = fs.readFileSync(full, 'utf8');
    }
  };

  walk(subPath, subDirName);
  return { files, errors };
}

/**
 * Scans ONLY CARMEN's 8 category folders under `skills/` (`development`, `debugging`, ...),
 * ignoring unrelated system folders such as `skills/system_skills`.
 */
export function scanBuiltinSkillPackages(rootDir = getBuiltinSkillsRoot()): BuiltinScanResult {
  const packages: ScannedBuiltinSkill[] = [];
  const failures: Array<{ slug: string; path: string; error: string }> = [];

  if (!fs.existsSync(rootDir)) {
    return { packages, failures };
  }

  for (const category of SKILL_CATEGORIES) {
    const catDir = path.join(rootDir, category);
    if (!fs.existsSync(catDir)) continue;
    let skillDirs: fs.Dirent[];
    try {
      skillDirs = fs.readdirSync(catDir, { withFileTypes: true });
    } catch (err) {
      failures.push({
        slug: category,
        path: catDir,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const ent of skillDirs) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      const folderName = ent.name;
      const skillDir = path.join(catDir, folderName);
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) {
        failures.push({
          slug: folderName,
          path: skillDir,
          error: 'SKILL.md tidak ditemukan di dalam direktori skill.',
        });
        continue;
      }

      try {
        const skillMd = fs.readFileSync(skillMdPath, 'utf8');
        const refs = readSubtreeFiles(skillDir, 'references');
        const scripts = readSubtreeFiles(skillDir, 'scripts');
        const assets = readSubtreeFiles(skillDir, 'assets');
        const subtreeErrors = [...refs.errors, ...scripts.errors, ...assets.errors];

        const validation = validateSkillPackage({
          expectedFolderName: folderName,
          skillMd,
          references: refs.files,
          scripts: scripts.files,
          assets: assets.files,
        });

        if (subtreeErrors.length > 0 || !validation.valid || !validation.parsed) {
          failures.push({
            slug: folderName,
            path: skillMdPath,
            error: [...subtreeErrors, ...validation.errors].join('; '),
          });
          continue;
        }

        if (validation.parsed.manifest.category !== category) {
          failures.push({
            slug: folderName,
            path: skillMdPath,
            error: `Kategori YAML "${validation.parsed.manifest.category}" tidak cocok dengan folder "${category}".`,
          });
          continue;
        }

        packages.push({
          category,
          slug: validation.parsed.name,
          name: validation.parsed.name,
          description: validation.parsed.description,
          manifest: validation.parsed.manifest,
          skillMd,
          references: refs.files,
          scripts: scripts.files,
          assets: assets.files,
          checksum: computePackageChecksum({
            skillMd,
            references: refs.files,
            scripts: scripts.files,
            assets: assets.files,
          }),
        });
      } catch (err) {
        failures.push({
          slug: folderName,
          path: skillMdPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { packages, failures };
}

interface SkillDbRow {
  id: string;
  scope_key: string;
  owner_user_id: string | null;
  slug: string;
  name: string;
  category: string;
  description: string;
  source: string;
  trust_level: string;
  enabled: unknown;
  current_version: string;
  manifest_json: unknown;
  skill_md: string;
  references_json: unknown;
  scripts_json: unknown;
  assets_json: unknown;
  checksum: string;
  created_at: unknown;
  updated_at: unknown;
}

function sanitizePermissionList(raw: unknown): SkillPermission[] {
  const arr = parseJsonColumn<unknown>(raw, []);
  if (!Array.isArray(arr)) return [];
  const out: SkillPermission[] = [];
  for (const item of arr) {
    const up = String(item || '').trim().toUpperCase();
    if (up !== 'ADMIN' && PERM_SET.has(up) && !out.includes(up as SkillPermission)) {
      out.push(up as SkillPermission);
    }
  }
  return out;
}

function normalizeManifest(raw: unknown, category: SkillCategory): SkillManifest {
  const parsed = parseJsonColumn<Partial<SkillManifest>>(raw, {});
  const perms = Array.isArray(parsed.permissions)
    ? parsed.permissions
        .map((p) => String(p || '').toUpperCase())
        .filter((p): p is SkillPermission => p !== 'ADMIN' && PERM_SET.has(p))
    : [];
  const rawQuality = parsed.quality;
  const quality =
    rawQuality &&
    typeof rawQuality === 'object' &&
    typeof rawQuality.score === 'number' &&
    (rawQuality.grade === 'A' || rawQuality.grade === 'B' || rawQuality.grade === 'C')
      ? {
          score: rawQuality.score,
          grade: rawQuality.grade,
          checksPassed: Number(rawQuality.checksPassed || 0),
          checksTotal: Number(rawQuality.checksTotal || 0),
          missingRecommendedSections: Array.isArray(rawQuality.missingRecommendedSections)
            ? rawQuality.missingRecommendedSections.map(String)
            : [],
        }
      : undefined;

  const rawProv = parsed.provenance;
  const provOrigin =
    rawProv &&
    typeof rawProv === 'object' &&
    (rawProv.origin === 'carmen-builtin' ||
      rawProv.origin === 'community-inspired' ||
      rawProv.origin === 'user-created' ||
      rawProv.origin === 'imported' ||
      rawProv.origin === 'remote')
      ? rawProv.origin
      : undefined;
  const provenance = provOrigin
    ? {
        origin: provOrigin,
        ...(Array.isArray(rawProv?.sourceRepos) && rawProv.sourceRepos.length > 0
          ? { sourceRepos: rawProv.sourceRepos.map(String) }
          : {}),
        ...(typeof rawProv?.license === 'string' && rawProv.license.trim()
          ? { license: rawProv.license.trim() }
          : {}),
        ...(typeof rawProv?.researchedAt === 'string' && rawProv.researchedAt.trim()
          ? { researchedAt: rawProv.researchedAt.trim() }
          : {}),
      }
    : undefined;

  return {
    category: CATEGORY_SET.has(String(parsed.category || category)) ? (parsed.category as SkillCategory) : category,
    version: String(parsed.version || '1.0.0'),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    frameworks: Array.isArray(parsed.frameworks) ? parsed.frameworks.map(String) : [],
    tools: Array.isArray(parsed.tools) ? parsed.tools.map(String) : [],
    permissions: perms,
    triggers: Array.isArray(parsed.triggers) ? parsed.triggers.map(String) : [],
    dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies.map(String) : [],
    conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.map(String) : [],
    executionMode: parsed.executionMode === 'parallel-safe' ? 'parallel-safe' : 'sequential',
    verification: Array.isArray(parsed.verification) ? parsed.verification.map(String) : [],
    examples: Array.isArray(parsed.examples) ? parsed.examples.map(String) : [],
    hasReferences: Boolean(parsed.hasReferences),
    hasScripts: Boolean(parsed.hasScripts),
    ...(provenance ? { provenance } : {}),
    ...(quality ? { quality } : {}),
  };
}

function rowToMetadata(
  row: Omit<SkillDbRow, 'skill_md'> & {
    pref_enabled?: unknown;
    pref_perms?: unknown;
    proj_enabled?: unknown;
    proj_perms?: unknown;
  }
): SkillMetadata {
  const category = CATEGORY_SET.has(row.category) ? (row.category as SkillCategory) : 'development';
  const manifest = normalizeManifest(row.manifest_json, category);
  const refs = parseJsonColumn<Record<string, string>>(row.references_json, {});
  const scripts = parseJsonColumn<Record<string, string>>(row.scripts_json, {});
  const assets = parseJsonColumn<Record<string, string>>(row.assets_json, {});

  const baseEnabled = toBooleanFlag(row.enabled);
  const hasUserPref = row.pref_enabled !== undefined && row.pref_enabled !== null;
  const hasProjCfg = row.proj_enabled !== undefined && row.proj_enabled !== null;
  const userEnabled = hasUserPref ? toBooleanFlag(row.pref_enabled) : baseEnabled;
  const projEnabled = hasProjCfg ? toBooleanFlag(row.proj_enabled) : undefined;
  const effectiveEnabled = hasProjCfg ? Boolean(userEnabled && projEnabled) : userEnabled;

  const approvedPerms = Array.from(
    new Set<SkillPermission>([
      ...sanitizePermissionList(row.pref_perms),
      ...sanitizePermissionList(row.proj_perms),
    ])
  );

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category,
    description: row.description,
    source: (row.source as SkillSource) || 'builtin',
    trustLevel: (row.trust_level as SkillTrustLevel) || 'BUILTIN',
    enabled: effectiveEnabled,
    ...(projEnabled !== undefined ? { projectEnabled: projEnabled } : {}),
    approvedPermissions: approvedPerms,
    currentVersion: row.current_version,
    manifest,
    checksum: row.checksum,
    ownerUserId: row.owner_user_id,
    referencePaths: Object.keys(refs).sort(),
    scriptPaths: Object.keys(scripts).sort(),
    assetPaths: Object.keys(assets).sort(),
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

/**
 * Syncs built-in `skills/<category>/<skill-name>/SKILL.md` packages into the `skills` and `skill_versions` tables.
 * Idempotent via SHA-256 package checksums. Never throws if `skills/` is empty or contains invalid packages.
 */
export async function syncBuiltinSkillsAsync(options?: { rootDir?: string }): Promise<{
  synced: number;
  updated: number;
  failures: Array<{ slug: string; path: string; error: string }>;
}> {
  const scan = scanBuiltinSkillPackages(options?.rootDir ?? BUILTIN_SKILLS_ROOT);
  let synced = 0;
  let updated = 0;

  for (const pkg of scan.packages) {
    const existing = await asyncDb.get<{
      id: string;
      checksum: string;
      current_version: string;
      manifest_json: unknown;
    }>(
      `SELECT id, checksum, current_version, manifest_json FROM skills WHERE scope_key = 'system' AND slug = ?`,
      pkg.slug
    );

    if (!existing) {
      const skillId = `skl_builtin_${pkg.slug}`;
      await asyncDb.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO skills (
            id, scope_key, owner_user_id, slug, name, category, description,
            source, trust_level, enabled, current_version, manifest_json,
            skill_md, references_json, scripts_json, assets_json, checksum
          ) VALUES (?, 'system', NULL, ?, ?, ?, ?, 'builtin', 'BUILTIN', ?, ?, ?, ?, ?, ?, ?, ?)`,
          skillId,
          pkg.slug,
          pkg.name,
          pkg.category,
          pkg.description,
          true,
          pkg.manifest.version,
          JSON.stringify(pkg.manifest),
          pkg.skillMd,
          JSON.stringify(pkg.references),
          JSON.stringify(pkg.scripts),
          JSON.stringify(pkg.assets),
          pkg.checksum
        );
        await tx.run(
          `INSERT INTO skill_versions (
            id, skill_id, version, skill_md, manifest_json, references_json, scripts_json, assets_json, checksum, changelog, created_by_user_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          `skv_${crypto.randomUUID().slice(0, 12)}`,
          skillId,
          pkg.manifest.version,
          pkg.skillMd,
          JSON.stringify(pkg.manifest),
          JSON.stringify(pkg.references),
          JSON.stringify(pkg.scripts),
          JSON.stringify(pkg.assets),
          pkg.checksum,
          'Inisialisasi paket skill bawaan CARMEN'
        );
      });
      synced += 1;
    } else if (
      existing.checksum !== pkg.checksum ||
      existing.current_version !== pkg.manifest.version ||
      !parseJsonColumn<Partial<SkillManifest>>(existing.manifest_json, {}).quality
    ) {
      await asyncDb.transaction(async (tx) => {
        await tx.run(
          `UPDATE skills
           SET name = ?, category = ?, description = ?, trust_level = 'BUILTIN',
               current_version = ?, manifest_json = ?, skill_md = ?,
               references_json = ?, scripts_json = ?, assets_json = ?, checksum = ?,
               updated_at = datetime('now')
           WHERE id = ?`,
          pkg.name,
          pkg.category,
          pkg.description,
          pkg.manifest.version,
          JSON.stringify(pkg.manifest),
          pkg.skillMd,
          JSON.stringify(pkg.references),
          JSON.stringify(pkg.scripts),
          JSON.stringify(pkg.assets),
          pkg.checksum,
          existing.id
        );
        await tx.run(
          `INSERT INTO skill_versions (
            id, skill_id, version, skill_md, manifest_json, references_json, scripts_json, assets_json, checksum, changelog, created_by_user_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          `skv_${crypto.randomUUID().slice(0, 12)}`,
          existing.id,
          pkg.manifest.version,
          pkg.skillMd,
          JSON.stringify(pkg.manifest),
          JSON.stringify(pkg.references),
          JSON.stringify(pkg.scripts),
          JSON.stringify(pkg.assets),
          pkg.checksum,
          'Pembaruan paket skill bawaan'
        );
      });
      updated += 1;
    }
  }

  return { synced, updated, failures: scan.failures };
}

export async function listSkillsForContext(params: {
  userId?: string;
  projectId?: string;
  includeDisabled?: boolean;
  category?: SkillCategory | 'all';
  search?: string;
  forceEmpty?: boolean;
}): Promise<SkillMetadata[]> {
  if (params.forceEmpty) {
    return [];
  }

  const userId = params.userId || null;
  const projectId = params.projectId || null;

  const rows = await asyncDb.all<
    Omit<SkillDbRow, 'skill_md'> & {
      pref_enabled?: unknown;
      pref_perms?: unknown;
      proj_enabled?: unknown;
      proj_perms?: unknown;
    }
  >(
    `SELECT
       s.id, s.scope_key, s.owner_user_id, s.slug, s.name, s.category, s.description,
       s.source, s.trust_level, s.enabled, s.current_version, s.manifest_json,
       s.references_json, s.scripts_json, s.assets_json, s.checksum,
       s.created_at, s.updated_at,
       u.enabled AS pref_enabled, u.approved_permissions_json AS pref_perms,
       p.enabled AS proj_enabled, p.approved_permissions_json AS proj_perms
     FROM skills s
     LEFT JOIN user_skill_preferences u ON u.skill_id = s.id AND u.user_id = ?
     LEFT JOIN project_skill_configs p ON p.skill_id = s.id AND p.project_id = ?
     WHERE s.scope_key = 'system' OR s.owner_user_id = ?
     ORDER BY s.category ASC, s.slug ASC`,
    userId,
    projectId,
    userId
  );

  let items = rows.map(rowToMetadata);
  if (!params.includeDisabled) {
    items = items.filter((s) => s.enabled);
  }
  if (params.category && params.category !== 'all') {
    items = items.filter((s) => s.category === params.category);
  }
  if (params.search && params.search.trim()) {
    const needle = params.search.trim().toLowerCase();
    items = items.filter(
      (s) =>
        s.slug.toLowerCase().includes(needle) ||
        s.name.toLowerCase().includes(needle) ||
        s.description.toLowerCase().includes(needle) ||
        s.manifest.tags.some((t) => t.toLowerCase().includes(needle)) ||
        (s.manifest.frameworks || []).some((f) => f.toLowerCase().includes(needle))
    );
  }

  return items;
}

export async function getSkillPackage(
  skillIdOrSlug: string,
  ctx: { userId?: string; projectId?: string } = {}
): Promise<SkillPackageRecord | null> {
  const userId = ctx.userId || null;
  const projectId = ctx.projectId || null;
  const clean = skillIdOrSlug.trim();
  if (!clean) return null;

  const rows = await asyncDb.all<
    SkillDbRow & {
      pref_enabled?: unknown;
      pref_perms?: unknown;
      proj_enabled?: unknown;
      proj_perms?: unknown;
    }
  >(
    `SELECT
       s.*,
       u.enabled AS pref_enabled, u.approved_permissions_json AS pref_perms,
       p.enabled AS proj_enabled, p.approved_permissions_json AS proj_perms
     FROM skills s
     LEFT JOIN user_skill_preferences u ON u.skill_id = s.id AND u.user_id = ?
     LEFT JOIN project_skill_configs p ON p.skill_id = s.id AND p.project_id = ?
     WHERE (s.id = ? OR s.slug = ?) AND (s.scope_key = 'system' OR s.owner_user_id = ?)`,
    userId,
    projectId,
    clean,
    clean,
    userId
  );

  if (rows.length === 0) return null;
  // Prefer exact ID match, else user-owned override, else system built-in
  const picked =
    rows.find((r) => r.id === clean) ||
    rows.find((r) => r.owner_user_id && r.owner_user_id === userId) ||
    rows[0];

  const meta = rowToMetadata(picked);
  return {
    ...meta,
    skillMd: picked.skill_md,
    references: parseJsonColumn<Record<string, string>>(picked.references_json, {}),
    scripts: parseJsonColumn<Record<string, string>>(picked.scripts_json, {}),
    assets: parseJsonColumn<Record<string, string>>(picked.assets_json, {}),
  };
}

export async function loadSkillReferences(
  skillIdOrSlug: string,
  requestedPaths: string[],
  ctx: { userId?: string; projectId?: string } = {}
): Promise<Record<string, string>> {
  const pkg = await getSkillPackage(skillIdOrSlug, ctx);
  if (!pkg) return {};

  const out: Record<string, string> = {};
  let totalChars = 0;
  const keys = requestedPaths.length > 0 ? requestedPaths : Object.keys(pkg.references).slice(0, 2);

  for (const rawPath of keys) {
    const norm = normalizeSkillRelativePath(rawPath.startsWith('references/') ? rawPath : `references/${rawPath}`);
    if (!norm) continue;
    const content = pkg.references[norm];
    if (typeof content !== 'string') continue;
    if (totalChars + content.length > 16_000) {
      out[norm] = content.slice(0, Math.max(0, 16_000 - totalChars));
      break;
    }
    out[norm] = content;
    totalChars += content.length;
    if (Object.keys(out).length >= 3) break;
  }
  return out;
}

export async function setUserSkillEnabled(
  skillId: string,
  userId: string,
  enabled: boolean
): Promise<SkillMetadata | null> {
  const pkg = await getSkillPackage(skillId, { userId });
  if (!pkg) return null;

  await asyncDb.run(
    `INSERT INTO user_skill_preferences (user_id, skill_id, enabled, approved_permissions_json, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, skill_id) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`,
    userId,
    pkg.id,
    enabled,
    JSON.stringify(pkg.approvedPermissions)
  );

  await recordSkillInstallHistory({
    userId,
    skillId: pkg.id,
    skillSlug: pkg.slug,
    skillName: pkg.name,
    action: enabled ? 'enable' : 'disable',
    version: pkg.currentVersion,
    source: pkg.source,
    detail: enabled ? 'Diaktifkan untuk akun pengguna' : 'Dinonaktifkan untuk akun pengguna',
  });

  const updated = await getSkillPackage(pkg.id, { userId });
  return updated;
}

export async function setProjectSkillConfig(
  projectId: string,
  skillId: string,
  userId: string,
  patch: { enabled?: boolean; approvedPermissions?: SkillPermission[] }
): Promise<SkillMetadata | null> {
  const ownedProject = await asyncDb.get<{ id: string }>(
    'SELECT id FROM projects WHERE id = ? AND user_id = ?',
    projectId,
    userId
  );
  if (!ownedProject) return null;

  const pkg = await getSkillPackage(skillId, { userId, projectId });
  if (!pkg) return null;

  const nextEnabled = patch.enabled !== undefined ? patch.enabled : (pkg.projectEnabled ?? pkg.enabled);
  const sanitizedPerms = patch.approvedPermissions
    ? patch.approvedPermissions.filter(
        (p): p is SkillPermission => String(p).toUpperCase() !== 'ADMIN' && PERM_SET.has(String(p).toUpperCase())
      )
    : pkg.approvedPermissions;

  await asyncDb.run(
    `INSERT INTO project_skill_configs (
       project_id, skill_id, enabled, approved_permissions_json, approved_by_user_id, approved_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(project_id, skill_id) DO UPDATE SET
       enabled = excluded.enabled,
       approved_permissions_json = excluded.approved_permissions_json,
       approved_by_user_id = excluded.approved_by_user_id,
       approved_at = datetime('now'),
       updated_at = datetime('now')`,
    projectId,
    pkg.id,
    nextEnabled,
    JSON.stringify(sanitizedPerms),
    userId
  );

  return await getSkillPackage(pkg.id, { userId, projectId });
}

export async function approveSkillPermissions(params: {
  skillId: string;
  userId: string;
  permissions: SkillPermission[];
  projectId?: string;
  promoteTrust?: boolean;
}): Promise<{ ok: boolean; error?: string; skill?: SkillMetadata }> {
  const { skillId, userId, permissions, projectId, promoteTrust = true } = params;

  if ((permissions as string[]).some((p) => String(p).toUpperCase() === 'ADMIN')) {
    return { ok: false, error: 'Izin ADMIN ditolak mutlak untuk seluruh Skill.' };
  }

  const invalidPerm = permissions.find((p) => !PERM_SET.has(String(p).toUpperCase()));
  if (invalidPerm) {
    return { ok: false, error: `Izin permission tidak valid: ${invalidPerm}` };
  }

  const pkg = await getSkillPackage(skillId, { userId, projectId });
  if (!pkg) {
    return { ok: false, error: 'Skill tidak ditemukan atau tidak dimiliki pengguna.' };
  }
  if (pkg.trustLevel === 'REVOKED') {
    return { ok: false, error: 'Skill yang telah dicabut (REVOKED) tidak dapat disetujui atau diaktifkan.' };
  }

  const normalizedPerms = Array.from(
    new Set(permissions.map((p) => String(p).toUpperCase() as SkillPermission))
  );

  if (pkg.ownerUserId === userId && promoteTrust && (pkg.trustLevel === 'DRAFT' || pkg.trustLevel === 'UNTRUSTED')) {
    const check = validateSkillPackage({
      expectedFolderName: pkg.slug,
      skillMd: pkg.skillMd,
      references: pkg.references,
      scripts: pkg.scripts,
      assets: pkg.assets,
    });
    if (!check.valid) {
      return { ok: false, error: `Validasi paket skill gagal: ${check.errors.join('; ')}` };
    }
    await asyncDb.run(
      `UPDATE skills SET trust_level = 'APPROVED', enabled = ?, updated_at = datetime('now') WHERE id = ? AND owner_user_id = ?`,
      true,
      pkg.id,
      userId
    );
  }

  await asyncDb.run(
    `INSERT INTO user_skill_preferences (user_id, skill_id, enabled, approved_permissions_json, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, skill_id) DO UPDATE SET
       enabled = ?,
       approved_permissions_json = excluded.approved_permissions_json,
       updated_at = datetime('now')`,
    userId,
    pkg.id,
    true,
    JSON.stringify(normalizedPerms),
    true
  );

  if (projectId) {
    await setProjectSkillConfig(projectId, pkg.id, userId, {
      enabled: true,
      approvedPermissions: normalizedPerms,
    });
  }

  const updated = await getSkillPackage(pkg.id, { userId, projectId });
  return { ok: true, skill: updated || undefined };
}

export async function listSkillVersions(
  skillId: string,
  userId: string
): Promise<SkillVersionRecord[]> {
  const pkg = await getSkillPackage(skillId, { userId });
  if (!pkg) return [];

  const rows = await asyncDb.all<{
    id: string;
    skill_id: string;
    version: string;
    skill_md: string;
    manifest_json: unknown;
    checksum: string;
    changelog: string;
    created_by_user_id: string | null;
    created_at: unknown;
  }>(
    `SELECT id, skill_id, version, skill_md, manifest_json, checksum, changelog, created_by_user_id, created_at
     FROM skill_versions WHERE skill_id = ? ORDER BY created_at DESC`,
    pkg.id
  );

  return rows.map((r) => ({
    id: r.id,
    skillId: r.skill_id,
    version: r.version,
    skillMd: r.skill_md,
    manifest: normalizeManifest(r.manifest_json, pkg.category),
    checksum: r.checksum,
    changelog: r.changelog,
    createdByUserId: r.created_by_user_id,
    createdAt: toIsoTimestamp(r.created_at),
  }));
}

export async function saveUserSkillPackage(params: {
  userId: string;
  skillId?: string;
  skillMd: string;
  references?: Record<string, string>;
  scripts?: Record<string, string>;
  assets?: Record<string, string>;
  source: SkillSource;
  trustLevel: SkillTrustLevel;
  enabled: boolean;
  changelog?: string;
}): Promise<{ ok: boolean; error?: string; skill?: SkillPackageRecord }> {
  const references = params.references || {};
  const scripts = params.scripts || {};
  const assets = params.assets || {};

  const validation = validateSkillPackage({
    skillMd: params.skillMd,
    references,
    scripts,
    assets,
  });
  if (!validation.valid || !validation.parsed) {
    return { ok: false, error: validation.errors.join('; ') };
  }

  const parsed = validation.parsed;
  const checksum = computePackageChecksum({
    skillMd: params.skillMd,
    references,
    scripts,
    assets,
  });

  if (params.skillId) {
    const existing = await asyncDb.get<{
      id: string;
      owner_user_id: string | null;
      scope_key: string;
      category: string;
      trust_level: string;
      manifest_json: unknown;
      scripts_json: unknown;
    }>(
      'SELECT id, owner_user_id, scope_key, category, trust_level, manifest_json, scripts_json FROM skills WHERE id = ?',
      params.skillId
    );
    if (!existing) {
      return { ok: false, error: 'Skill tidak ditemukan.' };
    }
    if (existing.scope_key === 'system' || existing.owner_user_id !== params.userId) {
      return { ok: false, error: 'Skill bawaan atau milik pengguna lain tidak dapat dimodifikasi.' };
    }

    // Security: if an APPROVED skill is edited to add/modify scripts or request newly escalated permissions/tools,
    // automatically demote trust_level back to DRAFT and disable until the user explicitly re-approves.
    let nextTrustLevel: SkillTrustLevel = params.trustLevel;
    let nextEnabled: boolean = params.enabled;
    if (existing.trust_level === 'APPROVED' && nextTrustLevel === 'APPROVED') {
      const prevManifest = normalizeManifest(existing.manifest_json, existing.category as SkillCategory);
      const prevScripts = parseJsonColumn<Record<string, string>>(existing.scripts_json, {});
      const scriptsChanged = JSON.stringify(prevScripts) !== JSON.stringify(scripts);
      const elevatedSet = new Set<SkillPermission>(['WRITE', 'EXECUTE', 'NETWORK', 'DEPLOY']);
      const prevPerms = new Set<SkillPermission>(prevManifest.permissions);
      const prevTools = new Set<string>(prevManifest.tools);
      const newElevatedPerm = parsed.manifest.permissions.some(
        (p) => elevatedSet.has(p) && !prevPerms.has(p)
      );
      const newToolAdded = parsed.manifest.tools.some((t) => !prevTools.has(t));
      if (scriptsChanged || newElevatedPerm || newToolAdded) {
        nextTrustLevel = 'DRAFT';
        nextEnabled = false;
      }
    }

    await asyncDb.transaction(async (tx) => {
      await tx.run(
        `UPDATE skills
         SET slug = ?, name = ?, category = ?, description = ?, trust_level = ?, enabled = ?,
             current_version = ?, manifest_json = ?, skill_md = ?,
             references_json = ?, scripts_json = ?, assets_json = ?, checksum = ?,
             updated_at = datetime('now')
         WHERE id = ? AND owner_user_id = ?`,
        parsed.name,
        parsed.name,
        parsed.manifest.category,
        parsed.description,
        nextTrustLevel,
        nextEnabled,
        parsed.manifest.version,
        JSON.stringify(parsed.manifest),
        params.skillMd,
        JSON.stringify(references),
        JSON.stringify(scripts),
        JSON.stringify(assets),
        checksum,
        existing.id,
        params.userId
      );
      await tx.run(
        `INSERT INTO skill_versions (
           id, skill_id, version, skill_md, manifest_json, references_json, scripts_json, assets_json, checksum, changelog, created_by_user_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `skv_${crypto.randomUUID().slice(0, 12)}`,
        existing.id,
        parsed.manifest.version,
        params.skillMd,
        JSON.stringify(parsed.manifest),
        JSON.stringify(references),
        JSON.stringify(scripts),
        JSON.stringify(assets),
        checksum,
        params.changelog || 'Pembaruan skill pengguna',
        params.userId
      );
    });

    const reloaded = await getSkillPackage(existing.id, { userId: params.userId });
    return { ok: true, skill: reloaded || undefined };
  }

  // Creating new user-scoped skill; check collision in user scope
  const dup = await asyncDb.get<{ id: string }>(
    'SELECT id FROM skills WHERE scope_key = ? AND slug = ?',
    params.userId,
    parsed.name
  );
  if (dup) {
    return {
      ok: false,
      error: `Kamu sudah memiliki skill bernama "${parsed.name}". Gunakan endpoint update atau ganti nama skill.`,
    };
  }

  const skillId = `skl_${crypto.randomUUID().slice(0, 12)}`;
  await asyncDb.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO skills (
        id, scope_key, owner_user_id, slug, name, category, description,
        source, trust_level, enabled, current_version, manifest_json,
        skill_md, references_json, scripts_json, assets_json, checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      skillId,
      params.userId,
      params.userId,
      parsed.name,
      parsed.name,
      parsed.manifest.category,
      parsed.description,
      params.source,
      params.trustLevel,
      params.enabled,
      parsed.manifest.version,
      JSON.stringify(parsed.manifest),
      params.skillMd,
      JSON.stringify(references),
      JSON.stringify(scripts),
      JSON.stringify(assets),
      checksum
    );
    await tx.run(
      `INSERT INTO skill_versions (
        id, skill_id, version, skill_md, manifest_json, references_json, scripts_json, assets_json, checksum, changelog, created_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `skv_${crypto.randomUUID().slice(0, 12)}`,
      skillId,
      parsed.manifest.version,
      params.skillMd,
      JSON.stringify(parsed.manifest),
      JSON.stringify(references),
      JSON.stringify(scripts),
      JSON.stringify(assets),
      checksum,
      params.changelog || 'Versi awal dibuat',
      params.userId
    );
  });

  const created = await getSkillPackage(skillId, { userId: params.userId });
  return { ok: true, skill: created || undefined };
}

export async function rollbackSkillVersion(
  skillId: string,
  userId: string,
  versionId: string
): Promise<{ ok: boolean; error?: string; skill?: SkillPackageRecord }> {
  const existing = await asyncDb.get<{
    id: string;
    owner_user_id: string | null;
    scope_key: string;
    category: string;
    trust_level: SkillTrustLevel;
    enabled: unknown;
    manifest_json: unknown;
    scripts_json: unknown;
  }>(
    'SELECT id, owner_user_id, scope_key, category, trust_level, enabled, manifest_json, scripts_json FROM skills WHERE id = ?',
    skillId
  );
  if (!existing) return { ok: false, error: 'Skill tidak ditemukan.' };
  if (existing.scope_key === 'system' || existing.owner_user_id !== userId) {
    return { ok: false, error: 'Hanya skill milik pengguna sendiri yang dapat di-rollback.' };
  }

  const ver = await asyncDb.get<{
    id: string;
    version: string;
    skill_md: string;
    manifest_json: unknown;
    references_json: unknown;
    scripts_json: unknown;
    assets_json: unknown;
    checksum: string;
  }>(
    'SELECT * FROM skill_versions WHERE id = ? AND skill_id = ?',
    versionId,
    existing.id
  );
  if (!ver) return { ok: false, error: 'Versi skill target tidak ditemukan.' };

  const references = parseJsonColumn<Record<string, string>>(ver.references_json, {});
  const scripts = parseJsonColumn<Record<string, string>>(ver.scripts_json, {});
  const assets = parseJsonColumn<Record<string, string>>(ver.assets_json, {});

  const validation = validateSkillPackage({
    skillMd: ver.skill_md,
    references,
    scripts,
    assets,
  });
  if (!validation.valid || !validation.parsed) {
    return { ok: false, error: `Versi target tidak lolos validasi: ${validation.errors.join('; ')}` };
  }

  let nextTrustLevel: SkillTrustLevel = existing.trust_level;
  let nextEnabled = toBooleanFlag(existing.enabled);
  if (existing.trust_level === 'APPROVED') {
    const prevManifest = normalizeManifest(existing.manifest_json, existing.category as SkillCategory);
    const prevScripts = parseJsonColumn<Record<string, string>>(existing.scripts_json, {});
    const scriptsChanged = JSON.stringify(prevScripts) !== JSON.stringify(scripts);
    const elevatedSet = new Set<SkillPermission>(['WRITE', 'EXECUTE', 'NETWORK', 'DEPLOY']);
    const prevPerms = new Set<SkillPermission>(prevManifest.permissions);
    const prevTools = new Set<string>(prevManifest.tools);
    const newElevatedPerm = validation.parsed.manifest.permissions.some(
      (p) => elevatedSet.has(p) && !prevPerms.has(p)
    );
    const newToolAdded = validation.parsed.manifest.tools.some((t) => !prevTools.has(t));
    if (scriptsChanged || newElevatedPerm || newToolAdded) {
      nextTrustLevel = 'DRAFT';
      nextEnabled = false;
    }
  }

  await asyncDb.transaction(async (tx) => {
    await tx.run(
      `UPDATE skills
       SET current_version = ?, trust_level = ?, enabled = ?, manifest_json = ?, skill_md = ?,
           references_json = ?, scripts_json = ?, assets_json = ?, checksum = ?,
           description = ?, category = ?, updated_at = datetime('now')
       WHERE id = ? AND owner_user_id = ?`,
      ver.version,
      nextTrustLevel,
      nextEnabled,
      typeof ver.manifest_json === 'string' ? ver.manifest_json : JSON.stringify(ver.manifest_json),
      ver.skill_md,
      JSON.stringify(references),
      JSON.stringify(scripts),
      JSON.stringify(assets),
      ver.checksum,
      validation.parsed!.description,
      validation.parsed!.manifest.category,
      existing.id,
      userId
    );
    await tx.run(
      `INSERT INTO skill_versions (
        id, skill_id, version, skill_md, manifest_json, references_json, scripts_json, assets_json, checksum, changelog, created_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `skv_${crypto.randomUUID().slice(0, 12)}`,
      existing.id,
      ver.version,
      ver.skill_md,
      typeof ver.manifest_json === 'string' ? ver.manifest_json : JSON.stringify(ver.manifest_json),
      JSON.stringify(references),
      JSON.stringify(scripts),
      JSON.stringify(assets),
      ver.checksum,
      `Rollback ke versi ${ver.version}`,
      userId
    );
  });

  const updated = await getSkillPackage(existing.id, { userId });
  return { ok: true, skill: updated || undefined };
}

export async function deleteUserSkill(
  skillId: string,
  userId: string
): Promise<{ ok: boolean; error?: string }> {
  const existing = await asyncDb.get<{ id: string; owner_user_id: string | null; scope_key: string }>(
    'SELECT id, owner_user_id, scope_key FROM skills WHERE id = ?',
    skillId
  );
  if (!existing) return { ok: false, error: 'Skill tidak ditemukan.' };
  if (existing.scope_key === 'system' || !existing.owner_user_id) {
    return {
      ok: false,
      error: 'Akses ditolak: skill bawaan CARMEN tidak boleh dihapus; gunakan toggle untuk menonaktifkan.',
    };
  }
  if (existing.owner_user_id !== userId) {
    return { ok: false, error: 'Skill tidak ditemukan.' };
  }

  await asyncDb.run('DELETE FROM skills WHERE id = ? AND owner_user_id = ?', existing.id, userId);
  return { ok: true };
}

export async function revokeSkillTrust(params: {
  skillId: string;
  userId: string;
}): Promise<{ ok: boolean; error?: string; skill?: SkillMetadata }> {
  const pkg = await getSkillPackage(params.skillId, { userId: params.userId });
  if (!pkg) {
    return { ok: false, error: 'Skill tidak ditemukan atau tidak dimiliki pengguna.' };
  }
  if (pkg.source === 'builtin') {
    return { ok: false, error: 'Skill bawaan CARMEN tidak dapat dicabut permanen; nonaktifkan via toggle.' };
  }
  if (pkg.ownerUserId !== params.userId) {
    return { ok: false, error: 'Akses ditolak: hanya pemilik yang dapat mencabut skill ini.' };
  }
  await asyncDb.run(
    `UPDATE skills SET trust_level = 'REVOKED', enabled = ?, updated_at = datetime('now') WHERE id = ? AND owner_user_id = ?`,
    false,
    pkg.id,
    params.userId
  );
  const updated = await getSkillPackage(pkg.id, { userId: params.userId });
  return { ok: true, skill: updated || undefined };
}

export function getSkillPermissionSummary(skill: SkillMetadata): SkillPermission[] {
  return computeEffectivePermissions(skill);
}

export async function recordSkillInstallHistory(params: {
  userId: string;
  skillId: string;
  skillSlug: string;
  skillName: string;
  action: 'install' | 'enable' | 'disable' | 'update' | 'import' | 'uninstall' | 'approve';
  version: string;
  source: string;
  detail?: string | null;
}): Promise<void> {
  try {
    const id = `shist_${crypto.randomUUID().slice(0, 12)}`;
    await asyncDb.run(
      `INSERT INTO skill_install_history (
         id, user_id, skill_id, skill_slug, skill_name, action, version, source, detail
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      params.userId,
      params.skillId,
      params.skillSlug,
      params.skillName,
      params.action,
      params.version,
      params.source,
      params.detail ?? null
    );
  } catch {
    // Never block skill operation if history table is not yet migrated in ephemeral test DB
  }
}

export async function listSkillInstallHistory(params: {
  userId: string;
  skillId?: string;
  limit?: number;
}): Promise<
  Array<{
    id: string;
    skillId: string;
    skillSlug: string;
    skillName: string;
    action: 'install' | 'enable' | 'disable' | 'update' | 'import' | 'uninstall' | 'approve';
    version: string;
    source: string;
    detail: string | null;
    createdAt: string;
  }>
> {
  const limit = Math.min(100, Math.max(1, params.limit ?? 30));
  try {
    const rows = params.skillId
      ? await asyncDb.all<Record<string, unknown>>(
          `SELECT id, skill_id, skill_slug, skill_name, action, version, source, detail, created_at
           FROM skill_install_history
           WHERE user_id = ? AND skill_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
          params.userId,
          params.skillId,
          limit
        )
      : await asyncDb.all<Record<string, unknown>>(
          `SELECT id, skill_id, skill_slug, skill_name, action, version, source, detail, created_at
           FROM skill_install_history
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
          params.userId,
          limit
        );
    return rows.map((r) => ({
      id: String(r.id),
      skillId: String(r.skill_id),
      skillSlug: String(r.skill_slug),
      skillName: String(r.skill_name),
      action: String(r.action) as 'install' | 'enable' | 'disable' | 'update' | 'import' | 'uninstall' | 'approve',
      version: String(r.version || '1.0.0'),
      source: String(r.source || 'builtin'),
      detail: r.detail ? String(r.detail) : null,
      createdAt: String(r.created_at),
    }));
  } catch {
    return [];
  }
}
