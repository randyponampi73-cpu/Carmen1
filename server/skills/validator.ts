import { isKnownAgentTool } from '../agent/toolRegistry';
import { extractFrontmatter, parseSkillMarkdown } from './parser';
import { ALLOWED_SKILL_PERMISSIONS, SKILL_CATEGORIES, type ParsedSkillMd } from './types';

export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_FILE_BYTES = 128 * 1024;
export const MAX_SKILL_ARCHIVE_FILES = 64;
export const MAX_SKILL_TOTAL_BYTES = 1024 * 1024;

const KEBAB_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PERMISSION_ALLOWLIST = new Set<string>(ALLOWED_SKILL_PERMISSIONS);
const CATEGORY_ALLOWLIST = new Set<string>(SKILL_CATEGORIES);

const ALLOWED_REFERENCE_EXT = /\.(md|txt|json)$/i;
const ALLOWED_SCRIPT_EXT = /\.(sh|mjs|js|ts|py)$/i;
const ALLOWED_ASSET_EXT = /\.(json|md|txt|svg|css)$/i;
const BLOCKED_SECRET_FILE_RE = /(?:^|\/)(?:\.env(?:\.[^/]+)?|id_rsa|id_ed25519|.*\.(?:db|sqlite|sqlite3|jks|keystore|p12|pfx|pem|key|exe|dll|so|dylib))$/i;

const PROMPT_INJECTION_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'system-prompt-override',
    pattern: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|system|safety)\s+(?:instructions?|rules?|constraints?|policies)\b/i,
  },
  {
    label: 'secret-exfiltration-instruction',
    pattern: /\b(?:reveal|print|dump|exfiltrate|send|upload|leak)\b.{0,40}\b(?:CARMEN_MASTER_KEY|ENCRYPTION_SECRET|SESSION_SECRET|GEMINI_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|process\.env)\b/i,
  },
  {
    label: 'security-bypass-instruction',
    pattern: /\b(?:bypass|disable|turn\s+off|circumvent)\s+(?:sandbox|isolation|auth(?:entication)?|csrf|ssrf|permission(?:s)?|security)\b/i,
  },
  {
    label: 'spoofed-system-tag',
    pattern: /<\s*\/?(?:system|developer|carmen_action)\b/i,
  },
];

const PLAINTEXT_SECRET_PATTERNS = [
  /\bsk-ant-[a-zA-Z0-9_-]{16,}\b/,
  /\bsk-or-v1-[a-zA-Z0-9]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{25,}\b/,
  /\bgsk_[a-zA-Z0-9]{20,}\b/,
  /\bcoa_[a-f0-9]{24,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  parsed?: ParsedSkillMd;
}

export function normalizeSkillRelativePath(rawPath: string): string | null {
  if (!rawPath || typeof rawPath !== 'string' || rawPath.includes('\0')) return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    return null;
  }
  return parts.join('/');
}

export function isAllowedSkillPackageFile(relPath: string): { ok: boolean; kind?: 'skill_md' | 'reference' | 'script' | 'asset'; reason?: string } {
  const norm = normalizeSkillRelativePath(relPath);
  if (!norm) {
    return { ok: false, reason: `Path tidak aman atau traversal terdeteksi: ${relPath}` };
  }
  if (BLOCKED_SECRET_FILE_RE.test(norm)) {
    return { ok: false, reason: `Tipe file rahasia/biner terlarang di skill: ${norm}` };
  }
  if (norm === 'SKILL.md') {
    return { ok: true, kind: 'skill_md' };
  }
  if (norm.startsWith('references/')) {
    if (!ALLOWED_REFERENCE_EXT.test(norm)) {
      return { ok: false, reason: `Ekstensi referensi tidak diizinkan: ${norm}` };
    }
    return { ok: true, kind: 'reference' };
  }
  if (norm.startsWith('scripts/')) {
    if (!ALLOWED_SCRIPT_EXT.test(norm)) {
      return { ok: false, reason: `Ekstensi script tidak diizinkan: ${norm}` };
    }
    return { ok: true, kind: 'script' };
  }
  if (norm.startsWith('assets/')) {
    if (!ALLOWED_ASSET_EXT.test(norm)) {
      return { ok: false, reason: `Ekstensi asset tidak diizinkan: ${norm}` };
    }
    return { ok: true, kind: 'asset' };
  }
  return { ok: false, reason: `File di luar struktur standar Skill (SKILL.md, references/, scripts/, assets/): ${norm}` };
}

export function scanSkillTextForThreats(relPath: string, content: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const rule of PROMPT_INJECTION_PATTERNS) {
    if (rule.pattern.test(content)) {
      errors.push(`Potensi prompt injection (${rule.label}) terdeteksi pada ${relPath}.`);
    }
  }
  for (const secRe of PLAINTEXT_SECRET_PATTERNS) {
    if (secRe.test(content)) {
      errors.push(`Potensi plaintext API key/private key terdeteksi pada ${relPath}.`);
    }
  }
  if (relPath.startsWith('scripts/') && /\b(curl|wget|nc\s+-e|eval\s*\(|rm\s+-rf\s+\/)\b/i.test(content)) {
    warnings.push(`Script ${relPath} memuat perintah jaringan/berisiko; wajib dijalankan terisolasi dan disetujui eksplisit.`);
  }
  return { errors, warnings };
}

export function validateSkillPackage(input: {
  expectedFolderName?: string;
  skillMd: string;
  references?: Record<string, string>;
  scripts?: Record<string, string>;
  assets?: Record<string, string>;
}): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.skillMd || typeof input.skillMd !== 'string') {
    return { valid: false, errors: ['File SKILL.md wajib ada dan tidak boleh kosong.'], warnings };
  }

  if (Buffer.byteLength(input.skillMd, 'utf8') > MAX_SKILL_FILE_BYTES) {
    errors.push(`SKILL.md melebihi batas ukuran ${MAX_SKILL_FILE_BYTES} byte.`);
  }

  let rawFm: Record<string, string | string[]>;
  try {
    rawFm = extractFrontmatter(input.skillMd).rawFrontmatter;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'YAML frontmatter SKILL.md tidak valid.');
    return { valid: false, errors, warnings };
  }

  // Reject explicit ADMIN or invalid permission declarations in raw frontmatter before normalization
  const rawPermList = Array.isArray(rawFm.permissions)
    ? rawFm.permissions
    : typeof rawFm.permissions === 'string' && rawFm.permissions.trim()
      ? rawFm.permissions.split(',').map((s) => s.trim())
      : [];
  for (const p of rawPermList) {
    const upper = p.toUpperCase();
    if (upper === 'ADMIN') {
      errors.push('Izin ADMIN dilarang keras untuk seluruh Skill.');
    } else if (!PERMISSION_ALLOWLIST.has(upper)) {
      errors.push(`Izin permission tidak dikenal pada SKILL.md: ${p}`);
    }
  }

  if (rawFm.category !== undefined) {
    const rawCat = (Array.isArray(rawFm.category) ? rawFm.category[0] : rawFm.category || '').trim().toLowerCase();
    if (rawCat && !CATEGORY_ALLOWLIST.has(rawCat)) {
      errors.push(`Kategori skill tidak valid: ${rawCat}`);
    }
  }

  const parsed = parseSkillMarkdown(input.skillMd, {
    hasReferences: Object.keys(input.references || {}).length > 0,
    hasScripts: Object.keys(input.scripts || {}).length > 0,
  });

  if (!parsed.name) {
    errors.push('Frontmatter `name` wajib diisi.');
  } else {
    if (parsed.name.length < 2 || parsed.name.length > MAX_SKILL_NAME_LENGTH) {
      errors.push(`Nama skill harus 2-${MAX_SKILL_NAME_LENGTH} karakter.`);
    }
    if (!KEBAB_NAME_RE.test(parsed.name)) {
      errors.push(`Nama skill "${parsed.name}" harus berformat kebab-case (huruf kecil, angka, tanda hubung).`);
    }
    if (input.expectedFolderName && input.expectedFolderName !== parsed.name) {
      errors.push(`Nama folder "${input.expectedFolderName}" harus sama dengan frontmatter name "${parsed.name}".`);
    }
  }

  if (!parsed.description) {
    errors.push('Frontmatter `description` wajib diisi.');
  } else if (parsed.description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    errors.push(`Deskripsi skill melebihi ${MAX_SKILL_DESCRIPTION_LENGTH} karakter.`);
  }

  const requiredSections: Array<[keyof typeof parsed.sections, string]> = [
    ['purpose', 'Purpose'],
    ['whenToUse', 'When to use'],
    ['requiredContext', 'Required context'],
    ['workflow', 'Workflow'],
    ['toolMapping', 'Tool mapping'],
    ['verification', 'Verification'],
    ['failureHandling', 'Failure handling'],
    ['safetyConstraints', 'Safety constraints'],
    ['examples', 'Examples'],
  ];
  for (const [key, label] of requiredSections) {
    if (!parsed.sections[key]) {
      errors.push(`Bagian wajib "## ${label}" hilang atau kosong pada SKILL.md.`);
    }
  }

  for (const tool of parsed.manifest.tools) {
    if (!isKnownAgentTool(tool)) {
      errors.push(`Tool tidak terdaftar di AGENT_TOOLS pada SKILL.md: ${tool}`);
    }
  }

  let totalBytes = Buffer.byteLength(input.skillMd, 'utf8');
  let totalFiles = 1;

  const inspectBucket = (map: Record<string, string> | undefined, prefix: 'references/' | 'scripts/' | 'assets/') => {
    if (!map) return;
    for (const [rawKey, content] of Object.entries(map)) {
      totalFiles += 1;
      const candidatePath = rawKey.startsWith(prefix) ? rawKey : `${prefix}${rawKey}`;
      const allowed = isAllowedSkillPackageFile(candidatePath);
      if (!allowed.ok) {
        errors.push(allowed.reason || `File tidak diizinkan: ${candidatePath}`);
        continue;
      }
      const size = Buffer.byteLength(content, 'utf8');
      totalBytes += size;
      if (size > MAX_SKILL_FILE_BYTES) {
        errors.push(`File ${candidatePath} melebihi batas ${MAX_SKILL_FILE_BYTES} byte.`);
      }
      const threatScan = scanSkillTextForThreats(candidatePath, content);
      errors.push(...threatScan.errors);
      warnings.push(...threatScan.warnings);
    }
  };

  const mdScan = scanSkillTextForThreats('SKILL.md', input.skillMd);
  errors.push(...mdScan.errors);
  warnings.push(...mdScan.warnings);

  inspectBucket(input.references, 'references/');
  inspectBucket(input.scripts, 'scripts/');
  inspectBucket(input.assets, 'assets/');

  if (totalFiles > MAX_SKILL_ARCHIVE_FILES) {
    errors.push(`Jumlah file skill (${totalFiles}) melebihi batas maksimal ${MAX_SKILL_ARCHIVE_FILES}.`);
  }
  if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
    errors.push(`Total ukuran paket skill (${totalBytes} byte) melebihi batas maksimal ${MAX_SKILL_TOTAL_BYTES} byte.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    parsed,
  };
}
