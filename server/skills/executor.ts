import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isKnownAgentTool, getRegisteredTool, validateToolArguments } from '../agent/toolRegistry';
import { asyncDb } from '../db';
import { toBooleanFlag, toIsoTimestamp } from '../db/dialect';
import { detectSandboxIsolation, spawnIsolatedProcess } from '../runtime/isolation';
import { scrubSecrets } from '../security';
import { composeSkillPlan } from './composer';
import { discoverRelevantSkills } from './discovery';
import { formatSkillsForPrompt } from './parser';
import { checkSkillExecutionPermissions } from './permissions';
import {
  getSkillPackage,
  listSkillsForContext,
  loadSkillReferences,
  verifySkillPackageIntegrity,
} from './registry';
import type {
  SkillDiscoveryContext,
  SkillExecutionAnalyticsSummary,
  SkillExecutionAttempt,
  SkillPackageRecord,
  SkillPermission,
  SkillPreflightOutcome,
  SkillWorkflowExecutionReport,
  SkillWorkflowStep,
} from './types';
import { isAllowedSkillPackageFile, scanSkillTextForThreats, validateSkillPackage } from './validator';

export interface PrepareSkillsOptions {
  ctx: SkillDiscoveryContext;
  forceEmptySkills?: boolean;
  approvedPermissionsOverride?: Record<string, SkillPermission[]>;
  loadSkillOverride?: (slug: string) => Promise<SkillPackageRecord | null>;
}

/**
 * Executes Stage 1 (Discovery), Stage 2 (On-Demand SKILL.md Activation),
 * Permission Enforcement, and Stage 3 (Composition + Lazy Reference Disclosure).
 *
 * CRITICAL INVARIANT: Never throws on missing/disabled/corrupted skills — returns a clean
 * fallback outcome so the built-in CARMEN Agent Core proceeds unobstructed.
 */
export async function prepareSkillsForAgentTurn(
  options: PrepareSkillsOptions
): Promise<SkillPreflightOutcome> {
  const { ctx, forceEmptySkills, approvedPermissionsOverride, loadSkillOverride } = options;
  const skillMode = ctx.skillMode || 'auto';

  if (ctx.disableAllSkills) {
    return {
      skillSystemAvailable: true,
      mode: skillMode,
      disabled: true,
      discoveredCount: 0,
      selectedMatches: [],
      loadedSkills: [],
      composition: { steps: [], skippedConflicts: [], missingDependencies: [], hasCycle: false },
      deniedSkills: [],
      loadFailures: [],
      promptInstructions: '',
      warnings: [],
    };
  }

  let availableSkills;
  try {
    availableSkills = await listSkillsForContext({
      userId: ctx.userId,
      projectId: ctx.projectId,
      includeDisabled: true,
      forceEmpty: forceEmptySkills,
    });
  } catch (err) {
    return {
      skillSystemAvailable: false,
      mode: skillMode,
      disabled: false,
      discoveredCount: 0,
      selectedMatches: [],
      loadedSkills: [],
      composition: { steps: [], skippedConflicts: [], missingDependencies: [], hasCycle: false },
      deniedSkills: [],
      loadFailures: [
        {
          skillName: 'registry',
          error: err instanceof Error ? err.message : 'Gagal membaca daftar skill.',
        },
      ],
      promptInstructions: '',
      warnings: ['Sistem Skill tidak tersedia; menggunakan kemampuan agen bawaan CARMEN.'],
    };
  }

  const discovery = discoverRelevantSkills(ctx, availableSkills);
  const warnings = [...discovery.warnings];
  const loadFailures: Array<{ skillName: string; error: string }> = [];
  const deniedSkills: SkillPreflightOutcome['deniedSkills'] = [];
  const permittedMatches = [];
  const loadedPackages: SkillPackageRecord[] = [];
  const loadedRefs = new Map<string, Record<string, string>>();

  for (const match of discovery.matches) {
    const extraApproved = approvedPermissionsOverride?.[match.skill.slug] || [];
    const permCheck = checkSkillExecutionPermissions({
      skill: match.skill,
      approvedPermissions: extraApproved,
      hasScriptExecution: false,
    });

    if (!permCheck.allowed) {
      deniedSkills.push({
        skillName: match.skill.slug,
        reason: permCheck.reason,
        missingPermissions: permCheck.missingPermissions,
        forbidden: permCheck.forbidden,
      });
      warnings.push(permCheck.reason);
      continue;
    }

    try {
      const pkg = loadSkillOverride
        ? await loadSkillOverride(match.skill.slug)
        : await getSkillPackage(match.skill.id, { userId: ctx.userId, projectId: ctx.projectId });

      if (!pkg) {
        loadFailures.push({
          skillName: match.skill.slug,
          error: 'Paket SKILL.md gagal dimuat dari penyimpanan.',
        });
        warnings.push(`Skill "${match.skill.slug}" gagal dimuat; melanjutkan dengan kemampuan bawaan.`);
        continue;
      }

      const integrity = verifySkillPackageIntegrity(pkg);
      if (!integrity.valid) {
        loadFailures.push({
          skillName: match.skill.slug,
          error: `Integritas checksum paket skill tidak cocok (expected=${integrity.expectedChecksum}, actual=${integrity.actualChecksum}).`,
        });
        warnings.push(`Skill "${match.skill.slug}" gagal verifikasi integritas; dilewati dengan aman.`);
        continue;
      }

      const validation = validateSkillPackage({
        expectedFolderName: pkg.slug,
        skillMd: pkg.skillMd,
        references: pkg.references,
        scripts: pkg.scripts,
        assets: pkg.assets,
      });
      if (!validation.valid) {
        loadFailures.push({
          skillName: match.skill.slug,
          error: validation.errors.join('; '),
        });
        warnings.push(`Skill "${match.skill.slug}" rusak atau tidak valid; dilewati dengan aman.`);
        continue;
      }

      permittedMatches.push(match);
      loadedPackages.push({ ...pkg, integrityVerified: true });

      // Stage 3 lazy disclosure: attach up to 2 concise references when present
      if (pkg.referencePaths.length > 0 && !loadSkillOverride) {
        const refs = await loadSkillReferences(pkg.id, pkg.referencePaths.slice(0, 2), {
          userId: ctx.userId,
          projectId: ctx.projectId,
        });
        if (Object.keys(refs).length > 0) {
          loadedRefs.set(pkg.slug, refs);
        }
      } else if (Object.keys(pkg.references).length > 0) {
        const subset: Record<string, string> = {};
        for (const k of Object.keys(pkg.references).slice(0, 2)) {
          subset[k] = pkg.references[k];
        }
        loadedRefs.set(pkg.slug, subset);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadFailures.push({ skillName: match.skill.slug, error: msg });
      warnings.push(`Gagal memuat skill "${match.skill.slug}" (${msg}); melanjutkan dengan agen bawaan.`);
    }
  }

  const composition = composeSkillPlan(permittedMatches, availableSkills);
  // Load any transitive dependencies pulled in by composeSkillPlan after validating trust & integrity
  for (const depSlug of composition.resolvedDependencies || []) {
    if (loadedPackages.some((p) => p.slug === depSlug)) continue;
    const depMeta = availableSkills.find((s) => s.slug === depSlug);
    if (!depMeta) continue;
    const depPerm = checkSkillExecutionPermissions({
      skill: depMeta,
      approvedPermissions: approvedPermissionsOverride?.[depSlug] || [],
      hasScriptExecution: false,
    });
    if (!depPerm.allowed) {
      deniedSkills.push({
        skillName: depSlug,
        reason: depPerm.reason,
        missingPermissions: depPerm.missingPermissions,
        forbidden: depPerm.forbidden,
      });
      warnings.push(depPerm.reason);
      continue;
    }
    try {
      const depPkg = loadSkillOverride
        ? await loadSkillOverride(depSlug)
        : await getSkillPackage(depMeta.id, { userId: ctx.userId, projectId: ctx.projectId });
      if (!depPkg || !verifySkillPackageIntegrity(depPkg).valid) {
        loadFailures.push({ skillName: depSlug, error: 'Dependensi skill gagal verifikasi integritas.' });
        continue;
      }
      const depValidation = validateSkillPackage({
        expectedFolderName: depPkg.slug,
        skillMd: depPkg.skillMd,
        references: depPkg.references,
        scripts: depPkg.scripts,
        assets: depPkg.assets,
      });
      if (!depValidation.valid) {
        loadFailures.push({ skillName: depSlug, error: depValidation.errors.join('; ') });
        continue;
      }
      loadedPackages.push({ ...depPkg, integrityVerified: true });
      permittedMatches.push({
        skill: depMeta,
        confidence: 0.75,
        reason: `Dependensi otomatis terverifikasi (${depSlug}).`,
        explicit: false,
        matchedTriggers: [],
      });
    } catch {
      loadFailures.push({ skillName: depSlug, error: 'Gagal memuat dependensi skill.' });
    }
  }

  for (const skipped of composition.skippedConflicts) {
    warnings.push(`Skill "${skipped.skillName}" dilewati: ${skipped.reason}`);
  }
  for (const dep of composition.missingDependencies) {
    warnings.push(`Dependensi skill "${dep.missing}" untuk "${dep.skillName}" tidak aktif.`);
  }
  if (composition.hasCycle) {
    warnings.push('Siklus dependensi skill terdeteksi; menjalankan fallback urutan prioritas.');
  }

  const activeSlugsInOrder = composition.steps.map((s) => s.skillName);
  const pkgBySlug = new Map(loadedPackages.map((p) => [p.slug, p]));
  const orderedPackages = activeSlugsInOrder
    .map((slug) => pkgBySlug.get(slug))
    .filter((p): p is SkillPackageRecord => Boolean(p));

  const promptInstructions = formatSkillsForPrompt(orderedPackages, loadedRefs);

  return {
    skillSystemAvailable: true,
    mode: skillMode,
    disabled: false,
    discoveredCount: discovery.discoveredCount,
    selectedMatches: permittedMatches,
    loadedSkills: orderedPackages,
    composition,
    deniedSkills,
    loadFailures,
    promptInstructions,
    warnings,
  };
}

/**
 * Executes an explicit helper script bundled in a skill package strictly inside OS-level sandbox isolation.
 * Imported/DRAFT/unapproved scripts are ALWAYS blocked. Fail-closed if isolation driver unavailable.
 */
export async function runSkillSandboxScript(params: {
  projectId: string;
  skill: SkillPackageRecord;
  scriptPath: string;
  approvedPermissions?: SkillPermission[];
  timeoutMs?: number;
  requireOsIsolation?: boolean;
}): Promise<{ ok: boolean; exitCode: number; output: string; isolated: boolean; driver?: string }> {
  const {
    projectId,
    skill,
    scriptPath,
    approvedPermissions = [],
    timeoutMs = 15_000,
    requireOsIsolation = true,
  } = params;

  const integrity = verifySkillPackageIntegrity(skill);
  if (!integrity.valid) {
    return {
      ok: false,
      exitCode: -1,
      output: `Integritas checksum paket skill "${skill.slug}" gagal diverifikasi (diharapkan ${integrity.expectedChecksum.slice(0, 12)}, aktual ${integrity.actualChecksum.slice(0, 12)}).`,
      isolated: false,
    };
  }

  const permCheck = checkSkillExecutionPermissions({
    skill,
    approvedPermissions,
    hasScriptExecution: true,
  });
  if (!permCheck.allowed) {
    return {
      ok: false,
      exitCode: -1,
      output: permCheck.reason,
      isolated: false,
    };
  }

  if (requireOsIsolation) {
    const iso = detectSandboxIsolation();
    if (!iso.osLevelIsolation) {
      return {
        ok: false,
        exitCode: -1,
        output: `Fail-closed: driver isolasi OS tidak tersedia (${iso.driver}) untuk menjalankan script skill tidak tepercaya.`,
        isolated: false,
        driver: iso.driver,
      };
    }
  }

  const fileCheck = isAllowedSkillPackageFile(scriptPath);
  if (!fileCheck.ok || fileCheck.kind !== 'script') {
    return {
      ok: false,
      exitCode: -1,
      output: fileCheck.reason || 'Path script skill tidak valid.',
      isolated: false,
    };
  }

  const scriptBody = skill.scripts[scriptPath];
  if (typeof scriptBody !== 'string') {
    return {
      ok: false,
      exitCode: -1,
      output: `Script "${scriptPath}" tidak ditemukan pada paket skill "${skill.slug}".`,
      isolated: false,
    };
  }

  const threatScan = scanSkillTextForThreats(scriptPath, scriptBody);
  if (threatScan.errors.length > 0) {
    return {
      ok: false,
      exitCode: -1,
      output: `Script diblokir keamanan: ${threatScan.errors.join('; ')}`,
      isolated: false,
    };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-skill-run-'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-skill-tmp-'));
  const ext = path.extname(scriptPath).toLowerCase();
  const scriptFilename = `skill-script${ext}`;
  const scriptFile = path.join(workDir, scriptFilename);

  try {
    fs.writeFileSync(scriptFile, scriptBody, 'utf8');
    const bin = ext === '.py' ? 'python3' : ext === '.sh' ? 'sh' : 'node';
    const args = [`./${scriptFilename}`];

    const handle = spawnIsolatedProcess({
      projectId,
      bin,
      args,
      workspaceDir: workDir,
      tmpDir,
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
      timeoutMs,
      allowNetwork: false,
      label: `skill:${skill.slug}:${scriptPath}`,
    });

    const outputChunks: string[] = [];
    handle.child.stdout?.on('data', (d) => outputChunks.push(String(d)));
    handle.child.stderr?.on('data', (d) => outputChunks.push(String(d)));

    const exitCode = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        handle.terminate('Timeout script skill');
        resolve(-1);
      }, timeoutMs);
      handle.child.once('close', (code) => {
        clearTimeout(timer);
        resolve(typeof code === 'number' ? code : -1);
      });
      handle.child.once('error', () => {
        clearTimeout(timer);
        resolve(-1);
      });
    });

    const cleanedOutput = scrubSecrets(outputChunks.join('').slice(0, 8000));
    return {
      ok: exitCode === 0,
      exitCode,
      output: cleanedOutput || (exitCode === 0 ? 'Script selesai.' : 'Script gagal.'),
      isolated: true,
    };
  } catch (err) {
    return {
      ok: false,
      exitCode: -1,
      output: err instanceof Error ? err.message : String(err),
      isolated: false,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function recordSkillExecutionResult(params: {
  projectId: string | null;
  userId: string | null;
  attempt: SkillExecutionAttempt;
  activeSecrets?: string[];
}): Promise<void> {
  const { projectId, userId, attempt, activeSecrets = [] } = params;
  try {
    await asyncDb.run(
      `INSERT INTO skill_executions (
        id, project_id, user_id, skill_id, skill_name, mode, status,
        confidence, reason, fallback_used, tools_invoked_json, error_summary, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `ske_${crypto.randomUUID().slice(0, 12)}`,
      projectId,
      userId,
      attempt.skillId || null,
      attempt.skillName,
      attempt.mode,
      attempt.status,
      attempt.confidence,
      scrubSecrets(attempt.reason, activeSecrets).slice(0, 300),
      Boolean(attempt.fallbackUsed),
      JSON.stringify(attempt.toolsInvoked || []),
      attempt.errorSummary ? scrubSecrets(attempt.errorSummary, activeSecrets).slice(0, 500) : null,
      Math.max(0, Math.round(attempt.durationMs || 0))
    );
  } catch {
    // Non-fatal: analytics persistence failure must never crash agent turns
  }
}

export async function getSkillAnalytics(params: {
  userId: string;
  projectId?: string;
}): Promise<SkillExecutionAnalyticsSummary> {
  const { userId, projectId } = params;
  const rows = await asyncDb.all<{
    id: string;
    project_id: string | null;
    skill_name: string;
    mode: string;
    status: string;
    confidence: number;
    reason: string;
    fallback_used: unknown;
    error_summary: string | null;
    duration_ms: number;
    created_at: unknown;
  }>(
    projectId
      ? `SELECT id, project_id, skill_name, mode, status, confidence, reason, fallback_used, error_summary, duration_ms, created_at
         FROM skill_executions WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 200`
      : `SELECT id, project_id, skill_name, mode, status, confidence, reason, fallback_used, error_summary, duration_ms, created_at
         FROM skill_executions WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`,
    ...(projectId ? [userId, projectId] : [userId])
  );

  let successCount = 0;
  let failedCount = 0;
  let fallbackCount = 0;
  let deniedCount = 0;
  let totalDuration = 0;

  const bySkill = new Map<string, { total: number; success: number; duration: number }>();

  for (const r of rows) {
    if (r.status === 'success') successCount += 1;
    else if (r.status === 'failed') failedCount += 1;
    else if (r.status === 'denied') deniedCount += 1;
    if (toBooleanFlag(r.fallback_used) || r.status === 'fallback') fallbackCount += 1;
    totalDuration += Number(r.duration_ms || 0);

    const cur = bySkill.get(r.skill_name) || { total: 0, success: 0, duration: 0 };
    cur.total += 1;
    if (r.status === 'success') cur.success += 1;
    cur.duration += Number(r.duration_ms || 0);
    bySkill.set(r.skill_name, cur);
  }

  const topSkills = Array.from(bySkill.entries())
    .map(([skillName, agg]) => ({
      skillName,
      total: agg.total,
      successRate: agg.total > 0 ? Math.round((agg.success / agg.total) * 100) : 0,
      avgDurationMs: agg.total > 0 ? Math.round(agg.duration / agg.total) : 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return {
    totalExecutions: rows.length,
    successCount,
    failedCount,
    fallbackCount,
    deniedCount,
    avgDurationMs: rows.length > 0 ? Math.round(totalDuration / rows.length) : 0,
    topSkills,
    recentExecutions: rows.slice(0, 20).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      skillName: r.skill_name,
      mode: (r.mode as SkillExecutionAnalyticsSummary['recentExecutions'][0]['mode']) || 'auto',
      status: r.status,
      confidence: Number(r.confidence || 0),
      reason: r.reason || '',
      fallbackUsed: toBooleanFlag(r.fallback_used),
      errorSummary: r.error_summary,
      durationMs: Number(r.duration_ms || 0),
      createdAt: toIsoTimestamp(r.created_at),
    })),
  };
}

/**
 * Executes a structured Skill workflow manifest strictly through canonical AGENT_TOOLS
 * or user-approved sandboxed skill scripts, grouping consecutive parallel-safe read-only
 * steps concurrently while keeping mutating steps strictly serialized.
 */
export async function executeComposedSkillWorkflow(params: {
  projectId: string;
  skill: SkillPackageRecord;
  steps: SkillWorkflowStep[];
  approvedPermissions?: SkillPermission[];
  executeToolFn: (
    toolName: string,
    args: Record<string, unknown>
  ) => Promise<{ ok: boolean; result: string; mutated: boolean }>;
}): Promise<SkillWorkflowExecutionReport> {
  const { projectId, skill, steps, approvedPermissions = [], executeToolFn } = params;
  const skippedPreconditions: string[] = [];
  const results: SkillWorkflowExecutionReport['stepsExecuted'] = [];

  const integrity = verifySkillPackageIntegrity(skill);
  if (!integrity.valid) {
    return {
      ok: false,
      stepsExecuted: [
        {
          id: 'integrity-gate',
          tool: 'policy',
          ok: false,
          attempts: 1,
          durationMs: 0,
          parallelBatch: 0,
          errorClass: 'permission',
          outputSummary: `Integritas paket skill "${skill.slug}" gagal diverifikasi (checksum tidak cocok).`,
        },
      ],
      skippedPreconditions: [],
    };
  }

  const permCheck = checkSkillExecutionPermissions({
    skill,
    approvedPermissions,
    hasScriptExecution: steps.some((s) => Boolean(s.scriptPath)),
  });
  if (!permCheck.allowed) {
    return {
      ok: false,
      stepsExecuted: [
        {
          id: 'permission-gate',
          tool: 'policy',
          ok: false,
          attempts: 1,
          durationMs: 0,
          parallelBatch: 0,
          errorClass: 'permission',
          outputSummary: permCheck.reason,
        },
      ],
      skippedPreconditions: [],
    };
  }

  let batchCounter = 1;
  let i = 0;

  const runSingleStep = async (step: SkillWorkflowStep, batchId: number) => {
    const startMs = Date.now();
    if (step.precondition) {
      const proceed = await step.precondition();
      if (!proceed) {
        skippedPreconditions.push(step.id);
        return null;
      }
    }

    if (step.scriptPath) {
      const scriptRes = await runSkillSandboxScript({
        projectId,
        skill,
        scriptPath: step.scriptPath,
        approvedPermissions,
        timeoutMs: step.timeoutMs,
        requireOsIsolation: true,
      });
      return {
        id: step.id,
        tool: `script:${step.scriptPath}`,
        ok: scriptRes.ok,
        attempts: 1,
        durationMs: Date.now() - startMs,
        parallelBatch: batchId,
        ...(scriptRes.ok ? {} : { errorClass: 'permission' as const }),
        outputSummary: scriptRes.output.slice(0, 500),
      };
    }

    if (!isKnownAgentTool(step.tool) || !skill.manifest.tools.includes(step.tool)) {
      return {
        id: step.id,
        tool: step.tool,
        ok: false,
        attempts: 1,
        durationMs: Date.now() - startMs,
        parallelBatch: batchId,
        errorClass: 'permission' as const,
        outputSummary: `Tool "${step.tool}" tidak terdaftar di AGENT_TOOLS atau tidak dideklarasikan oleh skill "${skill.slug}".`,
      };
    }

    const argValidation = validateToolArguments(step.tool, step.args);
    if (!argValidation.valid) {
      return {
        id: step.id,
        tool: step.tool,
        ok: false,
        attempts: 1,
        durationMs: Date.now() - startMs,
        parallelBatch: batchId,
        errorClass: 'validation' as const,
        outputSummary: argValidation.error || 'Argumen tool tidak valid.',
      };
    }

    const retries = Math.min(2, Math.max(0, Math.floor(step.maxRetries ?? 0)));
    let attempts = 0;
    let lastOut = { ok: false, result: 'Belum dijalankan.' };
    while (attempts <= retries) {
      attempts += 1;
      try {
        lastOut = await executeToolFn(step.tool, step.args);
        if (lastOut.ok) break;
      } catch (err) {
        lastOut = { ok: false, result: err instanceof Error ? err.message : String(err) };
      }
    }

    return {
      id: step.id,
      tool: step.tool,
      ok: lastOut.ok,
      attempts,
      durationMs: Date.now() - startMs,
      parallelBatch: batchId,
      ...(lastOut.ok ? {} : { errorClass: 'transient' as const }),
      outputSummary: lastOut.result.slice(0, 500),
    };
  };

  while (i < steps.length) {
    const canParallelize = (st: SkillWorkflowStep) => {
      if (st.scriptPath || !st.parallelSafe) return false;
      const spec = getRegisteredTool(st.tool);
      return Boolean(spec && !spec.mutating && spec.parallelSafe);
    };

    if (canParallelize(steps[i])) {
      const parallelBatch: SkillWorkflowStep[] = [];
      while (i < steps.length && canParallelize(steps[i])) {
        parallelBatch.push(steps[i]);
        i += 1;
      }
      const batchId = batchCounter++;
      const batchOut = await Promise.all(parallelBatch.map((s) => runSingleStep(s, batchId)));
      for (const item of batchOut) {
        if (item) results.push(item);
      }
      continue;
    }

    const batchId = batchCounter++;
    const item = await runSingleStep(steps[i], batchId);
    if (item) results.push(item);
    i += 1;
  }

  return {
    ok: results.every((r) => r.ok),
    stepsExecuted: results,
    skippedPreconditions,
  };
}
