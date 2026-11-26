import { getRequiredPermissionsForTools } from '../agent/toolRegistry';
import { saveUserSkillPackage } from './registry';
import type { SkillCategory, SkillPackageRecord, SkillPermission } from './types';
import { validateSkillPackage } from './validator';

export interface CreateSkillDraftInput {
  userId: string;
  name: string;
  category: SkillCategory;
  description: string;
  tags?: string[];
  tools?: string[];
  permissions?: SkillPermission[];
  triggers?: string[];
  executionMode?: 'sequential' | 'parallel-safe';
  purpose?: string;
  whenToUse?: string;
  requiredContext?: string;
  workflowSteps?: string[];
  verificationCriteria?: string[];
  failureHandling?: string;
  safetyConstraints?: string;
  examples?: string[];
  references?: Record<string, string>;
}

export function renderSkillMarkdownTemplate(input: Omit<CreateSkillDraftInput, 'userId' | 'references'>): string {
  const cleanName = input.name.trim().toLowerCase();
  const tools = input.tools && input.tools.length > 0 ? input.tools : ['list_files', 'read_file', 'validate_project'];
  const derivedPerms = getRequiredPermissionsForTools(tools);
  const perms = Array.from(
    new Set([...(input.permissions || []), ...derivedPerms])
  ).filter((p) => String(p).toUpperCase() !== 'ADMIN');
  const tags = (input.tags && input.tags.length > 0 ? input.tags : [input.category, cleanName]).slice(0, 8);
  const triggers = (input.triggers && input.triggers.length > 0 ? input.triggers : [cleanName]).slice(0, 8);
  const workflowLines =
    input.workflowSteps && input.workflowSteps.length > 0
      ? input.workflowSteps.map((s, idx) => `${idx + 1}. ${s}`).join('\n')
      : '1. Inspeksi file dan struktur proyek terkait menggunakan `list_files` dan `read_file`.\n2. Terapkan perubahan secara terukur dan minimal.\n3. Validasi integritas proyek serta hasil pengujian sebelum selesai.';
  const verifLines =
    input.verificationCriteria && input.verificationCriteria.length > 0
      ? input.verificationCriteria.map((v) => `- ${v}`).join('\n')
      : '- Jalankan `validate_project` untuk memastikan tidak ada regresi atau kebocoran secret.';
  const exampleLines =
    input.examples && input.examples.length > 0
      ? input.examples.map((ex) => `- ${ex}`).join('\n')
      : `- "/${cleanName} Terapkan pemeriksaan standar pada modul aktif"`;

  return `---
name: ${cleanName}
description: ${input.description.trim()}
category: ${input.category}
version: 1.0.0
tags: [${tags.join(', ')}]
tools: [${tools.join(', ')}]
permissions: [${perms.join(', ')}]
triggers: [${triggers.join(', ')}]
dependencies: []
conflicts: []
execution_mode: ${input.executionMode === 'parallel-safe' ? 'parallel-safe' : 'sequential'}
verification:
  - validate_project
---

## Purpose
${(input.purpose || input.description).trim()}

## When to use
${(input.whenToUse || `Gunakan skill ini saat pengguna meminta tugas terkait ${input.category} (${cleanName}).`).trim()}

## Required context
${(input.requiredContext || '- Daftar file proyek dan ringkasan error terakhir bila ada.').trim()}

## Workflow
${workflowLines}

## Tool mapping
${tools.map((t) => `- \`${t}\`: Eksekusi langkah tervalidasi di dalam sandbox proyek CARMEN.`).join('\n')}

## Verification
${verifLines}

## Failure handling
${(input.failureHandling || '- Jika tool gagal atau skill tidak relevan, hentikan langkah berisiko dan kembali ke kemampuan agen bawaan CARMEN.').trim()}

## Safety constraints
${(input.safetyConstraints || '- Dilarang menulis secret/API key ke file proyek, mengeksekusi perintah di luar sandbox, atau meminta izin ADMIN.').trim()}

## Examples
${exampleLines}
`;
}

export async function createSkillDraft(input: CreateSkillDraftInput): Promise<{
  ok: boolean;
  error?: string;
  warnings?: string[];
  skill?: SkillPackageRecord;
}> {
  const skillMd = renderSkillMarkdownTemplate(input);
  const check = validateSkillPackage({
    skillMd,
    references: input.references || {},
  });
  if (!check.valid) {
    return {
      ok: false,
      error: check.errors.join('; '),
      warnings: check.warnings,
    };
  }

  const saved = await saveUserSkillPackage({
    userId: input.userId,
    skillMd,
    references: input.references || {},
    source: 'created',
    trustLevel: 'DRAFT',
    enabled: false,
    changelog: 'Draft skill baru dibuat via Skill Creator',
  });

  if (!saved.ok || !saved.skill) {
    return { ok: false, error: saved.error || 'Gagal menyimpan draft skill.' };
  }

  return {
    ok: true,
    warnings: check.warnings,
    skill: saved.skill,
  };
}
