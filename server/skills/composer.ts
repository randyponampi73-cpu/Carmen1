import type {
  SkillCompositionPlan,
  SkillCompositionStep,
  SkillDiscoveryMatch,
  SkillMetadata,
} from './types';

/**
 * Resolves skill conflicts, verifies declared dependencies, detects cycles,
 * and schedules parallel-safe vs sequential execution waves.
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
    let conflictedWith: string | null = null;
    for (const [chosenSlug, chosenMatch] of activeMap.entries()) {
      if (
        chosenMatch.skill.manifest.conflicts.includes(match.skill.slug) ||
        match.skill.manifest.conflicts.includes(chosenSlug)
      ) {
        conflictedWith = chosenSlug;
        break;
      }
    }
    if (conflictedWith) {
      skippedConflicts.push({
        skillName: match.skill.slug,
        reason: `Konflik dengan skill prioritas lebih tinggi (${conflictedWith}).`,
      });
      continue;
    }
    activeMap.set(match.skill.slug, match);
  }

  const availableEnabled = new Map(availableSkills.filter((s) => s.enabled).map((s) => [s.slug, s]));
  const missingDependencies: Array<{ skillName: string; missing: string }> = [];
  const edges = new Map<string, string[]>(); // slug -> dependencies inside activeMap

  for (const [slug, match] of activeMap.entries()) {
    const depsInsideActive: string[] = [];
    for (const dep of match.skill.manifest.dependencies) {
      if (activeMap.has(dep)) {
        depsInsideActive.push(dep);
      } else if (!availableEnabled.has(dep)) {
        missingDependencies.push({ skillName: slug, missing: dep });
      }
    }
    edges.set(slug, depsInsideActive);
  }

  // Kahn's topological sort with wave grouping for parallel-safe steps
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
  let ready = Array.from(activeMap.keys()).filter((s) => (inDegree.get(s) || 0) === 0);

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
    ready = nextReady;
  }

  const hasCycle = orderedSlugs.length < activeMap.size;
  if (hasCycle) {
    // Fall back safely to prioritized deterministic order while flagging cycle
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
    hasCycle,
  };
}
