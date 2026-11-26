import { computeEffectivePermissions } from './permissions';
import type {
  SkillCompositionPlan,
  SkillCompositionStep,
  SkillDiscoveryMatch,
  SkillMetadata,
  SkillPermission,
} from './types';

function conflictsWithActive(
  candidate: SkillMetadata,
  activeMap: Map<string, SkillDiscoveryMatch>
): string | null {
  for (const [chosenSlug, chosenMatch] of activeMap.entries()) {
    if (
      chosenMatch.skill.manifest.conflicts.includes(candidate.slug) ||
      candidate.manifest.conflicts.includes(chosenSlug)
    ) {
      return chosenSlug;
    }
  }
  return null;
}

/**
 * Resolves skill conflicts, recursively pulls active enabled dependencies into the DAG,
 * propagates effective permissions, detects cycles, and schedules parallel-safe vs sequential waves.
 */
export function composeSkillPlan(
  matches: SkillDiscoveryMatch[],
  availableSkills: SkillMetadata[]
): SkillCompositionPlan {
  if (matches.length === 0) {
    return {
      steps: [],
      skippedConflicts: [],
      missingDependencies: [],
      resolvedDependencies: [],
      requiredPermissions: [],
      hasCycle: false,
    };
  }

  // Sort higher-priority / explicit / higher-confidence matches first for deterministic conflict winner selection
  const prioritized = [...matches].sort((a, b) => {
    if (a.explicit !== b.explicit) return a.explicit ? -1 : 1;
    return b.confidence - a.confidence || a.skill.slug.localeCompare(b.skill.slug);
  });

  const activeMap = new Map<string, SkillDiscoveryMatch>();
  const skippedConflicts: Array<{ skillName: string; reason: string }> = [];

  for (const match of prioritized) {
    const conflictedWith = conflictsWithActive(match.skill, activeMap);
    if (conflictedWith) {
      skippedConflicts.push({
        skillName: match.skill.slug,
        reason: `Konflik dengan skill prioritas lebih tinggi (${conflictedWith}).`,
      });
      continue;
    }
    activeMap.set(match.skill.slug, match);
  }

  const availableEnabled = new Map(
    availableSkills
      .filter((s) => s.enabled && s.trustLevel !== 'REVOKED')
      .map((s) => [s.slug, s])
  );
  const missingDependencies: Array<{ skillName: string; missing: string }> = [];
  const resolvedDependencies: string[] = [];

  // Recursively expand enabled, non-conflicting transitive dependencies into activeMap
  const expansionQueue = Array.from(activeMap.keys());
  const visitedExpansion = new Set<string>();
  while (expansionQueue.length > 0) {
    const parentSlug = expansionQueue.shift()!;
    if (visitedExpansion.has(parentSlug)) continue;
    visitedExpansion.add(parentSlug);

    const parentMatch = activeMap.get(parentSlug);
    if (!parentMatch) continue;

    for (const depSlug of parentMatch.skill.manifest.dependencies) {
      if (activeMap.has(depSlug)) continue;
      const depMeta = availableEnabled.get(depSlug);
      if (!depMeta) {
        missingDependencies.push({ skillName: parentSlug, missing: depSlug });
        continue;
      }
      if (depMeta.trustLevel === 'UNTRUSTED' || depMeta.trustLevel === 'DRAFT') {
        missingDependencies.push({ skillName: parentSlug, missing: depSlug });
        continue;
      }
      const depConflict = conflictsWithActive(depMeta, activeMap);
      if (depConflict) {
        skippedConflicts.push({
          skillName: depSlug,
          reason: `Dependensi dari "${parentSlug}" konflik dengan skill aktif (${depConflict}).`,
        });
        missingDependencies.push({ skillName: parentSlug, missing: depSlug });
        continue;
      }
      activeMap.set(depSlug, {
        skill: depMeta,
        confidence: parentMatch.confidence,
        reason: `Dependensi otomatis dari "${parentSlug}".`,
        explicit: parentMatch.explicit,
        matchedTriggers: [],
      });
      resolvedDependencies.push(depSlug);
      expansionQueue.push(depSlug);
    }
  }

  const edges = new Map<string, string[]>(); // slug -> dependencies inside activeMap
  for (const [slug, match] of activeMap.entries()) {
    const depsInsideActive: string[] = [];
    for (const dep of match.skill.manifest.dependencies) {
      if (activeMap.has(dep)) {
        depsInsideActive.push(dep);
      } else if (!missingDependencies.some((m) => m.skillName === slug && m.missing === dep)) {
        missingDependencies.push({ skillName: slug, missing: dep });
      }
    }
    edges.set(slug, depsInsideActive);
  }

  // Propagate effective permissions across all active + resolved skills
  const requiredPermSet = new Set<SkillPermission>();
  for (const match of activeMap.values()) {
    for (const perm of computeEffectivePermissions(match.skill)) {
      requiredPermSet.add(perm);
    }
  }

  // Kahn's topological sort with deterministic wave grouping
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const slug of activeMap.keys()) {
    inDegree.set(slug, 0);
    dependents.set(slug, []);
  }
  for (const [slug, deps] of edges.entries()) {
    inDegree.set(slug, deps.length);
    for (const d of deps) {
      dependents.get(d)?.push(slug);
    }
  }

  const orderedSlugs: string[] = [];
  const waves: string[][] = [];
  let ready = Array.from(activeMap.keys())
    .filter((s) => (inDegree.get(s) || 0) === 0)
    .sort((a, b) => a.localeCompare(b));

  while (ready.length > 0) {
    waves.push(ready);
    const nextReady: string[] = [];
    for (const node of ready) {
      orderedSlugs.push(node);
      for (const child of dependents.get(node) || []) {
        const nextDeg = (inDegree.get(child) || 0) - 1;
        inDegree.set(child, nextDeg);
        if (nextDeg === 0) nextReady.push(child);
      }
    }
    ready = nextReady.sort((a, b) => a.localeCompare(b));
  }

  const hasCycle = orderedSlugs.length < activeMap.size;
  if (hasCycle) {
    const remaining = Array.from(activeMap.keys()).filter((s) => !orderedSlugs.includes(s));
    waves.push(remaining);
    orderedSlugs.push(...remaining);
  }

  const steps: SkillCompositionStep[] = [];
  let orderCounter = 1;
  let groupCounter = 1;

  for (const wave of waves) {
    const parallelSafeNodes = wave.filter(
      (slug) => activeMap.get(slug)?.skill.manifest.executionMode === 'parallel-safe'
    );
    const sequentialNodes = wave.filter(
      (slug) => activeMap.get(slug)?.skill.manifest.executionMode !== 'parallel-safe'
    );

    if (parallelSafeNodes.length > 0) {
      const sharedGroup = groupCounter;
      for (const slug of parallelSafeNodes) {
        const match = activeMap.get(slug)!;
        steps.push({
          skillName: slug,
          order: orderCounter++,
          parallelGroup: sharedGroup,
          reason: match.reason,
          dependsOn: edges.get(slug) || [],
        });
      }
      groupCounter += 1;
    }

    for (const slug of sequentialNodes) {
      const match = activeMap.get(slug)!;
      steps.push({
        skillName: slug,
        order: orderCounter++,
        parallelGroup: groupCounter++,
        reason: match.reason,
        dependsOn: edges.get(slug) || [],
      });
    }
  }

  return {
    steps,
    skippedConflicts,
    missingDependencies,
    resolvedDependencies,
    requiredPermissions: Array.from(requiredPermSet),
    hasCycle,
  };
}
