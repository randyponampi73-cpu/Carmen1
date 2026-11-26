import type {
  ParsedSkillMd,
  SkillCategory,
  SkillManifest,
  SkillPackageRecord,
  SkillPermission,
  SkillSections,
} from './types';
import { ALLOWED_SKILL_PERMISSIONS, SKILL_CATEGORIES } from './types';

const CATEGORY_SET = new Set<string>(SKILL_CATEGORIES);
const PERMISSION_SET = new Set<string>(ALLOWED_SKILL_PERMISSIONS);

function unquoteYaml(val: string): string {
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseInlineArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((item) => unquoteYaml(item))
    .filter(Boolean);
}

export function extractFrontmatter(markdown: string): {
  rawFrontmatter: Record<string, string | string[]>;
  body: string;
} {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('SKILL.md harus diawali YAML frontmatter yang diapit tanda ---.');
  }

  const yamlText = match[1];
  const body = match[2] || '';
  const result: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;

  for (const rawLine of yamlText.split('\n')) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (currentListKey && /^\s*-\s+(.+)$/.test(line)) {
      const itemMatch = line.match(/^\s*-\s+(.+)$/);
      if (itemMatch) {
        const list = Array.isArray(result[currentListKey]) ? (result[currentListKey] as string[]) : [];
        const cleaned = unquoteYaml(itemMatch[1]);
        if (cleaned) list.push(cleaned);
        result[currentListKey] = list;
      }
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!kvMatch) {
      currentListKey = null;
      continue;
    }

    const key = kvMatch[1].trim();
    const rawVal = kvMatch[2].trim();
    if (!rawVal) {
      result[key] = [];
      currentListKey = key;
    } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      result[key] = parseInlineArray(rawVal);
      currentListKey = null;
    } else {
      result[key] = unquoteYaml(rawVal);
      currentListKey = null;
    }
  }

  return { rawFrontmatter: result, body };
}

function asStringList(val: string | string[] | undefined): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map((s) => s.trim()).filter(Boolean);
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function asCategory(val: string | string[] | undefined): SkillCategory {
  const s = Array.isArray(val) ? val[0] : val;
  const clean = (s || '').trim().toLowerCase();
  if (CATEGORY_SET.has(clean)) return clean as SkillCategory;
  return 'development';
}

export function extractMarkdownSections(body: string): SkillSections {
  const sections: Record<string, string> = {};
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let currentHeading = '';
  let buffer: string[] = [];

  const flush = () => {
    if (currentHeading) {
      sections[currentHeading] = buffer.join('\n').trim();
    }
    buffer = [];
  };

  for (const line of lines) {
    const hMatch = line.match(/^##\s+(.+?)\s*$/);
    if (hMatch) {
      flush();
      currentHeading = hMatch[1].trim().toLowerCase();
      continue;
    }
    if (currentHeading) {
      buffer.push(line);
    }
  }
  flush();

  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const hit = sections[k];
      if (hit) return hit;
    }
    return '';
  };

  return {
    purpose: pick('purpose', 'tujuan'),
    whenToUse: pick('when to use', 'kapan digunakan'),
    requiredContext: pick('required context', 'konteks yang dibutuhkan'),
    workflow: pick('workflow', 'alur kerja'),
    toolMapping: pick('tool mapping', 'pemetaan tool'),
    verification: pick('verification', 'verifikasi'),
    failureHandling: pick('failure handling', 'penanganan kegagalan'),
    safetyConstraints: pick('safety constraints', 'batasan keamanan'),
    examples: pick('examples', 'contoh'),
  };
}

export function parseSkillMarkdown(
  skillMd: string,
  options?: { hasReferences?: boolean; hasScripts?: boolean }
): ParsedSkillMd {
  const { rawFrontmatter, body } = extractFrontmatter(skillMd);
  const nameRaw = Array.isArray(rawFrontmatter.name) ? rawFrontmatter.name[0] : rawFrontmatter.name;
  const descRaw = Array.isArray(rawFrontmatter.description)
    ? rawFrontmatter.description[0]
    : rawFrontmatter.description;
  const versionRaw = Array.isArray(rawFrontmatter.version) ? rawFrontmatter.version[0] : rawFrontmatter.version;
  const execModeRaw = Array.isArray(rawFrontmatter.execution_mode)
    ? rawFrontmatter.execution_mode[0]
    : rawFrontmatter.execution_mode;

  const rawPerms = asStringList(rawFrontmatter.permissions).map((p) => p.toUpperCase());
  const validPerms = rawPerms.filter((p): p is SkillPermission => PERMISSION_SET.has(p));

  const sections = extractMarkdownSections(body);
  const manifest: SkillManifest = {
    category: asCategory(rawFrontmatter.category),
    version: (versionRaw || '1.0.0').trim(),
    tags: asStringList(rawFrontmatter.tags).map((t) => t.toLowerCase()),
    tools: asStringList(rawFrontmatter.tools),
    permissions: validPerms,
    triggers: asStringList(rawFrontmatter.triggers).map((t) => t.toLowerCase()),
    dependencies: asStringList(rawFrontmatter.dependencies),
    conflicts: asStringList(rawFrontmatter.conflicts),
    executionMode: execModeRaw === 'parallel-safe' ? 'parallel-safe' : 'sequential',
    verification: asStringList(rawFrontmatter.verification),
    examples: asStringList(rawFrontmatter.examples),
    hasReferences: Boolean(options?.hasReferences),
    hasScripts: Boolean(options?.hasScripts),
  };

  return {
    name: (nameRaw || '').trim(),
    description: (descRaw || '').trim(),
    manifest,
    sections,
    rawBody: body.trim(),
  };
}

export function formatSkillsForPrompt(
  skills: SkillPackageRecord[],
  loadedRefs: Map<string, Record<string, string>> = new Map()
): string {
  if (skills.length === 0) return '';

  const blocks = skills.map((skill) => {
    let sections: SkillSections;
    try {
      sections = extractMarkdownSections(extractFrontmatter(skill.skillMd).body);
    } catch {
      sections = {
        purpose: skill.description,
        whenToUse: '',
        requiredContext: '',
        workflow: skill.skillMd.slice(0, 1200),
        toolMapping: skill.manifest.tools.join(', '),
        verification: skill.manifest.verification.join('; '),
        failureHandling: '',
        safetyConstraints: '',
        examples: '',
      };
    }

    const refsForSkill = loadedRefs.get(skill.slug);
    const refText = refsForSkill
      ? Object.entries(refsForSkill)
          .slice(0, 2)
          .map(([p, c]) => `[Ref: ${p}]\n${c.slice(0, 800)}`)
          .join('\n')
      : '';

    return [
      `<skill_playbook name="${skill.slug}" category="${skill.category}" version="${skill.currentVersion}">`,
      `Tujuan: ${sections.purpose || skill.description}`,
      sections.workflow ? `Alur Kerja:\n${sections.workflow.slice(0, 1200)}` : '',
      sections.toolMapping ? `Tool Terkait: ${sections.toolMapping.slice(0, 500)}` : '',
      sections.verification ? `Kriteria Verifikasi:\n${sections.verification.slice(0, 500)}` : '',
      sections.failureHandling ? `Penanganan Kegagalan:\n${sections.failureHandling.slice(0, 400)}` : '',
      sections.safetyConstraints ? `Batasan Keamanan:\n${sections.safetyConstraints.slice(0, 400)}` : '',
      refText,
      `</skill_playbook>`,
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    'PANDUAN SKILL OPSIONAL AKTIF (instruksi tambahan bersifat advisory — gunakan hanya tool CARMEN yang diizinkan dan tetap ikuti seluruh aturan keamanan sistem):',
    ...blocks,
  ].join('\n\n');
}
