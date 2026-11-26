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
export const MAX_SKILL_ZIP_COMPRESSION_RATIO = 40;

function isZipMagicHeader(buf: Buffer): boolean {
  if (buf.byteLength < 4) return false;
  // Local file header PK\x03\x04 or empty EOCD PK\x05\x06
  return (
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    ((buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06))
  );
}

function isDisallowedSpecialZipEntry(entry: JSZip.JSZipObject): { disallowed: boolean; reason?: string } {
  const unixPerms = (entry as unknown as { unixPermissions?: number | null }).unixPermissions;
  if (typeof unixPerms === 'number' && unixPerms !== 0) {
    const modeHi = (unixPerms >>> 16) & 0o170000;
    const modeLo = unixPerms & 0o170000;
    const fileType = modeHi || modeLo;
    if (fileType === 0o120000) {
      return { disallowed: true, reason: `symlink terdeteksi pada entri "${entry.name}"` };
    }
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
      return { disallowed: true, reason: `entri file khusus Unix tidak diizinkan pada "${entry.name}"` };
    }
  }
  const dosPerms = (entry as unknown as { dosPermissions?: number | null }).dosPermissions;
  if (typeof dosPerms === 'number' && (dosPerms & 0x08) !== 0) {
    // DOS volume label attribute
    return { disallowed: true, reason: `entri volume label DOS tidak diizinkan pada "${entry.name}"` };
  }
  return { disallowed: false };
}

function hasEmbeddedArchiveSignature(buf: Buffer): boolean {
  if (buf.byteLength >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return true; // Nested ZIP signature
  }
  if (buf.byteLength >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return true; // GZIP signature
  }
  return false;
}

async function readSkillZipEntryStreaming(params: {
  entry: JSZip.JSZipObject;
  displayName: string;
  remainingTotalBytes: number;
  zipCompressedBytes: number;
  totalDecompressedSoFar: number;
}): Promise<Buffer> {
  const { entry, displayName, remainingTotalBytes, zipCompressedBytes, totalDecompressedSoFar } = params;
  // Do NOT trust declared uncompressedSize as safe — only use it for early rejection if obviously oversized,
  // and ALWAYS enforce strict byte-counting during streaming decompression!
  const internalData = (entry as unknown as {
    _data?: { uncompressedSize?: number; compressedSize?: number };
  })._data;
  const declaredUncompressed = internalData?.uncompressedSize;
  if (typeof declaredUncompressed === 'number' && Number.isFinite(declaredUncompressed)) {
    if (declaredUncompressed > MAX_SKILL_FILE_BYTES) {
      throw new Error(`Ukuran file "${displayName}" melebihi batas ${MAX_SKILL_FILE_BYTES} byte.`);
    }
    if (declaredUncompressed > remainingTotalBytes) {
      throw new Error(
        `Total ukuran terdekompresi arsip melebihi batas ${MAX_SKILL_TOTAL_BYTES} byte (perlindungan ZIP bomb).`
      );
    }
  }

  const entryCompressedSize =
    typeof internalData?.compressedSize === 'number' && internalData.compressedSize > 0
      ? internalData.compressedSize
      : 0;

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    let settled = false;
    const stream = entry.nodeStream('nodebuffer');

    const abort = (err: Error) => {
      if (settled) return;
      settled = true;
      const destroyable = stream as unknown as { destroy?: () => void };
      if (typeof destroyable.destroy === 'function') {
        destroyable.destroy();
      }
      reject(err);
    };

    stream.on('data', (chunk: Buffer | Uint8Array | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (chunks.length === 0 && hasEmbeddedArchiveSignature(buf)) {
        abort(new Error(`Arsip bersarang (nested archive) terdeteksi pada isi "${displayName}".`));
        return;
      }
      entryBytes += buf.byteLength;
      if (entryBytes > MAX_SKILL_FILE_BYTES) {
        abort(
          new Error(`Ukuran file "${displayName}" melebihi batas ${MAX_SKILL_FILE_BYTES} byte (perlindungan ZIP bomb).`)
        );
        return;
      }
      if (entryBytes > remainingTotalBytes) {
        abort(
          new Error(
            `Total ukuran terdekompresi arsip melebihi batas ${MAX_SKILL_TOTAL_BYTES} byte (perlindungan ZIP bomb).`
          )
        );
        return;
      }
      if (entryCompressedSize > 0 && entryBytes > 16 * 1024) {
        const entryRatio = entryBytes / entryCompressedSize;
        if (entryRatio > MAX_SKILL_ZIP_COMPRESSION_RATIO) {
          abort(
            new Error(
              `Rasio kompresi mencurigakan (${Math.round(entryRatio)}:1 > ${MAX_SKILL_ZIP_COMPRESSION_RATIO}:1) pada "${displayName}" (perlindungan ZIP bomb).`
            )
          );
          return;
        }
      }
      const nextTotal = totalDecompressedSoFar + entryBytes;
      if (nextTotal > 32 * 1024 && zipCompressedBytes > 0) {
        const totalRatio = nextTotal / zipCompressedBytes;
        if (totalRatio > MAX_SKILL_ZIP_COMPRESSION_RATIO) {
          abort(
            new Error(
              `Rasio dekompresi total arsip melebihi batas ${MAX_SKILL_ZIP_COMPRESSION_RATIO}:1 (perlindungan ZIP bomb).`
            )
          );
          return;
        }
      }
      chunks.push(buf);
    });

    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, entryBytes));
    });

    stream.on('error', (err: unknown) => {
      abort(err instanceof Error ? err : new Error('Gagal mendekompression entri arsip ZIP.'));
    });
  });
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
  if (!isZipMagicHeader(zipBuffer)) {
    return { ok: false, error: 'Header file bukan arsip ZIP yang valid.' };
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
    const specialCheck = isDisallowedSpecialZipEntry(entry);
    if (specialCheck.disallowed) {
      return { ok: false, error: `Arsip ditolak: ${specialCheck.reason}.` };
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

    let buf: Buffer;
    try {
      buf = await readSkillZipEntryStreaming({
        entry,
        displayName: stripped,
        remainingTotalBytes: MAX_SKILL_TOTAL_BYTES - totalUncompressedBytes,
        zipCompressedBytes: zipBuffer.byteLength,
        totalDecompressedSoFar: totalUncompressedBytes,
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : `Gagal memproses entri "${stripped}".`,
      };
    }

    totalUncompressedBytes += buf.byteLength;
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
