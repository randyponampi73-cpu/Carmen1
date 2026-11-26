import JSZip from 'jszip';
import { scrubSecrets } from '../security';
import { saveUserSkillPackage } from './registry';
import type { SkillPackageRecord } from './types';
import {
  isAllowedSkillPackageFile,
  MAX_SKILL_ARCHIVE_FILES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_TOTAL_BYTES,
  normalizeSkillRelativePath,
  validateSkillPackage,
} from './validator';

export const MAX_SKILL_IMPORT_ZIP_BYTES = 2 * 1024 * 1024;

function isZipEntrySymlink(entry: JSZip.JSZipObject): boolean {
  const unixPerms = (entry as unknown as { unixPermissions?: number | null }).unixPermissions;
  if (
    typeof unixPerms === 'number' &&
    ((unixPerms & 0o170000) === 0o120000 || ((unixPerms >>> 16) & 0o170000) === 0o120000)
  ) {
    return true;
  }
  return false;
}

export async function exportSkillPackageZip(skill: SkillPackageRecord): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('SKILL.md', scrubSecrets(skill.skillMd));

  for (const [relPath, content] of Object.entries(skill.references)) {
    const clean = normalizeSkillRelativePath(relPath);
    if (clean) zip.file(clean, scrubSecrets(content));
  }
  for (const [relPath, content] of Object.entries(skill.scripts)) {
    const clean = normalizeSkillRelativePath(relPath);
    if (clean) zip.file(clean, scrubSecrets(content));
  }
  for (const [relPath, content] of Object.entries(skill.assets)) {
    const clean = normalizeSkillRelativePath(relPath);
    if (clean) zip.file(clean, scrubSecrets(content));
  }

  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export async function inspectAndImportSkillZip(params: {
  userId: string;
  zipBuffer: Buffer;
}): Promise<{ ok: boolean; error?: string; warnings?: string[]; skill?: SkillPackageRecord }> {
  const { userId, zipBuffer } = params;

  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.byteLength === 0) {
    return { ok: false, error: 'Arsip ZIP skill kosong atau tidak valid.' };
  }
  if (zipBuffer.byteLength > MAX_SKILL_IMPORT_ZIP_BYTES) {
    return { ok: false, error: `Ukuran file ZIP melebihi batas maksimal ${MAX_SKILL_IMPORT_ZIP_BYTES} byte.` };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch {
    return { ok: false, error: 'Gagal membaca arsip ZIP; pastikan format arsip valid dan tidak korup.' };
  }

  const allEntries = Object.values(zip.files);
  if (allEntries.length === 0) {
    return { ok: false, error: 'Arsip ZIP tidak berisi file apa pun.' };
  }
  if (allEntries.length > MAX_SKILL_ARCHIVE_FILES * 2) {
    return { ok: false, error: 'Jumlah entri arsip ZIP melebihi batas aman.' };
  }

  const rawFileEntries: Array<{ rawName: string; entry: JSZip.JSZipObject }> = [];
  for (const entry of allEntries) {
    if (isZipEntrySymlink(entry)) {
      return { ok: false, error: `Arsip ditolak: symlink terdeteksi pada entri "${entry.name}".` };
    }
    const unsafeName = (entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName;
    const namesToCheck = unsafeName && unsafeName !== entry.name ? [unsafeName, entry.name] : [entry.name];
    for (const candidateName of namesToCheck) {
      if (candidateName.includes('\0') || candidateName.includes('..') || candidateName.includes('\\')) {
        return { ok: false, error: `Arsip ditolak: potensi ZIP Slip/path traversal pada "${candidateName}".` };
      }
      if (/^(?:\/|[a-zA-Z]:)/.test(candidateName)) {
        return { ok: false, error: `Arsip ditolak: path absolut tidak diizinkan ("${candidateName}").` };
      }
    }
    if (!entry.dir) {
      rawFileEntries.push({ rawName: entry.name, entry });
    }
  }

  if (rawFileEntries.length === 0) {
    return { ok: false, error: 'Tidak ada file di dalam arsip ZIP.' };
  }
  if (rawFileEntries.length > MAX_SKILL_ARCHIVE_FILES) {
    return {
      ok: false,
      error: `Jumlah file dalam paket skill (${rawFileEntries.length}) melebihi batas ${MAX_SKILL_ARCHIVE_FILES}.`,
    };
  }

  // Detect optional single wrapper directory (e.g. my-skill/SKILL.md)
  let wrapperFolder: string | undefined;
  const hasRootSkillMd = rawFileEntries.some((f) => f.rawName === 'SKILL.md');
  if (!hasRootSkillMd) {
    const firstParts = new Set(rawFileEntries.map((f) => f.rawName.split('/')[0]).filter(Boolean));
    if (firstParts.size === 1) {
      const candidate = Array.from(firstParts)[0];
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate)) {
        wrapperFolder = candidate;
      }
    }
  }

  let skillMd = '';
  const references: Record<string, string> = {};
  const scripts: Record<string, string> = {};
  const assets: Record<string, string> = {};
  let totalUncompressedBytes = 0;

  for (const { rawName, entry } of rawFileEntries) {
    const stripped = wrapperFolder && rawName.startsWith(`${wrapperFolder}/`)
      ? rawName.slice(wrapperFolder.length + 1)
      : rawName;

    const allowed = isAllowedSkillPackageFile(stripped);
    if (!allowed.ok || !allowed.kind) {
      return { ok: false, error: allowed.reason || `File tidak diizinkan dalam arsip: ${stripped}` };
    }

    const buf = await entry.async('nodebuffer');
    if (buf.byteLength > MAX_SKILL_FILE_BYTES) {
      return {
        ok: false,
        error: `Ukuran file "${stripped}" (${buf.byteLength} byte) melebihi batas ${MAX_SKILL_FILE_BYTES} byte.`,
      };
    }
    totalUncompressedBytes += buf.byteLength;
    if (totalUncompressedBytes > MAX_SKILL_TOTAL_BYTES) {
      return {
        ok: false,
        error: `Total ukuran terdekompresi arsip melebihi batas ${MAX_SKILL_TOTAL_BYTES} byte (perlindungan ZIP bomb).`,
      };
    }

    const text = buf.toString('utf8');
    if (allowed.kind === 'skill_md') {
      skillMd = text;
    } else if (allowed.kind === 'reference') {
      references[stripped] = text;
    } else if (allowed.kind === 'script') {
      scripts[stripped] = text;
    } else if (allowed.kind === 'asset') {
      assets[stripped] = text;
    }
  }

  if (!skillMd) {
    return { ok: false, error: 'File wajib SKILL.md tidak ditemukan di root paket skill.' };
  }

  const validation = validateSkillPackage({
    expectedFolderName: wrapperFolder,
    skillMd,
    references,
    scripts,
    assets,
  });
  if (!validation.valid) {
    return { ok: false, error: validation.errors.join('; '), warnings: validation.warnings };
  }

  // Imported skills MUST start UNTRUSTED and disabled until the user explicitly inspects & approves permissions.
  // Scripts are NEVER auto-executed on import.
  const saved = await saveUserSkillPackage({
    userId,
    skillMd,
    references,
    scripts,
    assets,
    source: 'imported',
    trustLevel: 'UNTRUSTED',
    enabled: false,
    changelog: 'Diimpor dari arsip ZIP (menunggu persetujuan keamanan)',
  });

  if (!saved.ok || !saved.skill) {
    return { ok: false, error: saved.error || 'Gagal menyimpan skill impor.' };
  }

  return { ok: true, warnings: validation.warnings, skill: saved.skill };
}
