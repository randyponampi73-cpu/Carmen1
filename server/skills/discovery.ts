import { classifyAgentIntent } from '../agent/planner';
import type { SkillDiscoveryContext, SkillDiscoveryMatch, SkillMetadata } from './types';

export const AUTO_DISCOVERY_THRESHOLD = 0.36;
export const MAX_AUTO_SKILLS_PER_TURN = 3;

const SLASH_COMMAND_RE = /(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s,.;:!?])/g;

export function parseSkillSlashCommands(prompt: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const text = prompt || '';
  let match: RegExpExecArray | null;
  SLASH_COMMAND_RE.lastIndex = 0;
  while ((match = SLASH_COMMAND_RE.exec(text)) !== null) {
    const slug = match[1].toLowerCase();
    if (!seen.has(slug)) {
      seen.add(slug);
      found.push(slug);
    }
  }
  return found;
}

function tokenizePrompt(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  );
}

function scoreAutoSkill(
  skill: SkillMetadata,
  ctx: SkillDiscoveryContext,
  intent: ReturnType<typeof classifyAgentIntent>['intent'],
  promptLower: string,
  tokens: Set<string>
): { confidence: number; matchedTriggers: string[]; reasons: string[] } {
  let score = 0;
  const matchedTriggers: string[] = [];
  const reasons: string[] = [];

  for (const trigger of skill.manifest.triggers) {
    const trigLower = trigger.trim().toLowerCase();
    if (!trigLower) continue;
    const hit = trigLower.includes(' ')
      ? promptLower.includes(trigLower)
      : tokens.has(trigLower) || promptLower.includes(trigLower);
    if (hit) {
      matchedTriggers.push(trigger);
      score += 0.36;
    }
  }
  if (matchedTriggers.length > 0) {
    score = Math.min(0.68, score);
    reasons.push(`Cocok pemicu: ${matchedTriggers.slice(0, 3).join(', ')}`);
  }

  let tagHits = 0;
  for (const tag of skill.manifest.tags) {
    const t = tag.toLowerCase();
    if (tokens.has(t) || (t.includes('-') && promptLower.includes(t))) {
      tagHits += 1;
    }
  }
  if (tagHits > 0) {
    score += Math.min(0.24, tagHits * 0.12);
    reasons.push(`${tagHits} tag relevan`);
  }

  const slugParts = skill.slug.split('-').filter((w) => w.length >= 3);
  const slugHits = slugParts.filter((w) => tokens.has(w)).length;
  if (slugHits >= 2 || (slugParts.length === 1 && slugHits === 1)) {
    score += 0.22;
  }

  // Domain & intent contextual boosts
  const filesLower = ctx.existingFiles.map((f) => f.toLowerCase());
  const hasSchema = filesLower.some((f) => f === 'schema.sql' || f.endsWith('.sql'));
  const hasDockerfile = filesLower.some((f) => f.includes('dockerfile') || f.includes('docker-compose'));
  const hasTests = filesLower.some((f) => /test|spec/.test(f));

  if (skill.category === 'agents') {
    const asksSkillWork = /\b(skill|skill\.md|buat skill|validasi skill|create skill)\b/i.test(promptLower);
    if (!asksSkillWork) {
      // Never activate meta-agent skill authoring skills during ordinary app building
      score = Math.min(score, 0.2);
    } else {
      score += 0.4;
      reasons.push('Permintaan terkait authoring/validasi Skill');
    }
  } else if (skill.category === 'debugging') {
    if (intent === 'bug_repair' || Boolean(ctx.lastError)) {
      score += ctx.lastError ? 0.42 : 0.34;
      reasons.push(ctx.lastError ? 'Error runtime/build terdeteksi' : 'Intent perbaikan bug');
    }
  } else if (skill.category === 'database') {
    if (/\b(sql|database|tabel|table|schema|migrasi|migration|sqlite|postgres|indeks|index|query)\b/i.test(promptLower)) {
      score += 0.36;
      reasons.push('Konteks skema/database');
    } else if (hasSchema && intent === 'fullstack_feature') {
      score += 0.2;
    }
  } else if (skill.category === 'security') {
    if (
      /\b(security|keamanan|audit|vulnerab|kerentanan|xss|sqli|sql injection|ssrf|csrf|secret|api key|auth|owasp|token|encrypt)\b/i.test(
        promptLower
      )
    ) {
      score += 0.42;
      reasons.push('Permintaan keamanan/audit');
    }
  } else if (skill.category === 'testing') {
    if (/\b(test|uji|pengujian|playwright|e2e|unit test|integration test|spec|coverage)\b/i.test(promptLower)) {
      score += 0.38;
      reasons.push('Permintaan pengujian otomatis');
    } else if (hasTests && intent === 'bug_repair') {
      score += 0.16;
    }
  } else if (skill.category === 'devops') {
    if (
      /\b(docker|container|deploy|deployment|ci|cd|github actions|env|environment|cloud run|caddy|nginx)\b/i.test(
        promptLower
      ) ||
      (hasDockerfile && /\b(build|run|deploy|container)\b/i.test(promptLower))
    ) {
      score += 0.38;
      reasons.push('Konteks DevOps/container/deployment');
    }
  } else if (skill.category === 'architecture') {
    if (
      ctx.mode === 'discuss' ||
      /\b(arsitektur|architecture|system design|desain sistem|api design|openapi|rest api|dokumentasi|readme)\b/i.test(
        promptLower
      )
    ) {
      score += 0.35;
      reasons.push(ctx.mode === 'discuss' ? 'Mode Diskusi arsitektur' : 'Konteks desain/arsitektur');
    }
  } else if (skill.category === 'development') {
    if (intent === 'new_app' || intent === 'fullstack_feature') {
      if (skill.slug === 'fullstack-development' && /\b(fullstack|full-stack|api|schema|database|backend)\b/i.test(promptLower)) {
        score += 0.4;
        reasons.push('Pengembangan fullstack');
      } else if (skill.slug === 'frontend-design' && /\b(ui|ux|desain|tampilan|landing|dashboard|responsif|css|tailwind|halaman)\b/i.test(promptLower)) {
        score += 0.38;
        reasons.push('Desain antarmuka frontend');
      } else if (skill.slug === 'backend-development' && /\b(backend|express|endpoint|route|middleware|server|rest|api)\b/i.test(promptLower)) {
        score += 0.38;
        reasons.push('Pengembangan backend API');
      } else if (skill.slug === 'code-generation' && intent === 'new_app') {
        score += 0.36;
        reasons.push('Pembuatan aplikasi baru');
      } else if (skill.slug === 'refactoring' && /\b(refactor|rapikan|bersihkan|modular|struktur ulang)\b/i.test(promptLower)) {
        score += 0.4;
        reasons.push('Permintaan refactoring');
      } else if (skill.slug === 'code-review' && /\b(review|tinjau|periksa kode)\b/i.test(promptLower)) {
        score += 0.4;
        reasons.push('Permintaan code review');
      }
    } else if (intent === 'simple_edit' && skill.slug === 'frontend-design' && /\b(ui|warna|layout|css|tampilan)\b/i.test(promptLower)) {
      score += 0.3;
    }
  }

  return {
    confidence: Number(Math.min(0.99, Math.max(0, score)).toFixed(2)),
    matchedTriggers,
    reasons,
  };
}

export interface DiscoveryOutcome {
  matches: SkillDiscoveryMatch[];
  discoveredCount: number;
  warnings: string[];
}

export function discoverRelevantSkills(
  ctx: SkillDiscoveryContext,
  availableSkills: SkillMetadata[]
): DiscoveryOutcome {
  const warnings: string[] = [];
  const discoveredCount = availableSkills.length;

  if (ctx.disableAllSkills) {
    return { matches: [], discoveredCount, warnings };
  }

  const enabledSkills = availableSkills.filter((s) => s.enabled);
  const slashSlugs = parseSkillSlashCommands(ctx.prompt);
  const explicitSlugs = Array.from(
    new Set([
      ...slashSlugs,
      ...(ctx.requestedSkillNames || []).map((s) => s.trim().toLowerCase()).filter(Boolean),
    ])
  );

  const bySlug = new Map<string, SkillMetadata>();
  for (const s of enabledSkills) {
    bySlug.set(s.slug.toLowerCase(), s);
  }
  const allBySlug = new Map<string, SkillMetadata>();
  for (const s of availableSkills) {
    allBySlug.set(s.slug.toLowerCase(), s);
  }

  const selected = new Map<string, SkillDiscoveryMatch>();

  for (const reqSlug of explicitSlugs) {
    const active = bySlug.get(reqSlug);
    if (active) {
      selected.set(active.slug, {
        skill: active,
        confidence: 1,
        reason: `Dipilih eksplisit oleh pengguna (/${active.slug}).`,
        explicit: true,
        matchedTriggers: [`/${active.slug}`],
      });
    } else {
      const disabledMatch = allBySlug.get(reqSlug);
      warnings.push(
        disabledMatch
          ? `Skill "/${reqSlug}" sedang dinonaktifkan; melanjutkan dengan kemampuan agent bawaan.`
          : `Skill "/${reqSlug}" tidak ditemukan; melanjutkan dengan kemampuan agent bawaan.`
      );
    }
  }

  const skillMode = ctx.skillMode || 'auto';
  if (skillMode === 'manual') {
    return {
      matches: Array.from(selected.values()),
      discoveredCount,
      warnings,
    };
  }

  // Auto / Advanced discovery scoring
  const promptLower = ctx.prompt.toLowerCase();
  const tokens = tokenizePrompt(ctx.prompt);
  const { intent } = classifyAgentIntent({
    prompt: ctx.prompt,
    mode: ctx.mode,
    existingFiles: ctx.existingFiles,
    hasRuntimeError: Boolean(ctx.lastError),
    isBlankStarter: ctx.existingFiles.length <= 1,
  });

  const minScore = intent === 'simple_edit' ? 0.42 : AUTO_DISCOVERY_THRESHOLD;
  const autoCandidates: SkillDiscoveryMatch[] = [];
  for (const skill of enabledSkills) {
    if (selected.has(skill.slug)) continue;
    // Never auto-activate untrusted, draft, or revoked skills unless explicitly requested by slash command
    if (skill.trustLevel === 'UNTRUSTED' || skill.trustLevel === 'DRAFT' || skill.trustLevel === 'REVOKED') {
      continue;
    }
    const { confidence, matchedTriggers, reasons } = scoreAutoSkill(
      skill,
      ctx,
      intent,
      promptLower,
      tokens
    );
    if (confidence >= minScore) {
      autoCandidates.push({
        skill,
        confidence,
        reason: reasons.join('; ') || `Relevan untuk intent ${intent}`,
        explicit: false,
        matchedTriggers,
      });
    }
  }

  autoCandidates.sort((a, b) => b.confidence - a.confidence || a.skill.slug.localeCompare(b.skill.slug));

  const remainingSlots = Math.max(0, MAX_AUTO_SKILLS_PER_TURN - selected.size);
  for (const cand of autoCandidates.slice(0, remainingSlots)) {
    selected.set(cand.skill.slug, cand);
  }

  return {
    matches: Array.from(selected.values()),
    discoveredCount,
    warnings,
  };
}
