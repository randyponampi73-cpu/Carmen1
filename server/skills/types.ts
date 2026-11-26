import type { ProjectType } from '../../src/types';

export type SkillCategory =
  | 'development'
  | 'debugging'
  | 'security'
  | 'testing'
  | 'database'
  | 'devops'
  | 'architecture'
  | 'agents';

export const SKILL_CATEGORIES: readonly SkillCategory[] = [
  'development',
  'debugging',
  'security',
  'testing',
  'database',
  'devops',
  'architecture',
  'agents',
] as const;

export type SkillPermission = 'READ' | 'WRITE' | 'EXECUTE' | 'NETWORK' | 'DATABASE' | 'DEPLOY';

export const ALLOWED_SKILL_PERMISSIONS: readonly SkillPermission[] = [
  'READ',
  'WRITE',
  'EXECUTE',
  'NETWORK',
  'DATABASE',
  'DEPLOY',
] as const;

export type SkillTrustLevel = 'BUILTIN' | 'VERIFIED' | 'APPROVED' | 'DRAFT' | 'UNTRUSTED';
export type SkillSource = 'builtin' | 'created' | 'imported' | 'marketplace';
export type SkillInvocationMode = 'auto' | 'manual' | 'advanced';

export interface SkillManifest {
  category: SkillCategory;
  version: string;
  tags: string[];
  tools: string[];
  permissions: SkillPermission[];
  triggers: string[];
  dependencies: string[];
  conflicts: string[];
  executionMode: 'sequential' | 'parallel-safe';
  verification: string[];
  examples: string[];
  hasReferences: boolean;
  hasScripts: boolean;
}

export interface SkillSections {
  purpose: string;
  whenToUse: string;
  requiredContext: string;
  workflow: string;
  toolMapping: string;
  verification: string;
  failureHandling: string;
  safetyConstraints: string;
  examples: string;
}

export interface ParsedSkillMd {
  name: string;
  description: string;
  manifest: SkillManifest;
  sections: SkillSections;
  rawBody: string;
}

export interface SkillMetadata {
  id: string;
  slug: string;
  name: string;
  category: SkillCategory;
  description: string;
  source: SkillSource;
  trustLevel: SkillTrustLevel;
  enabled: boolean;
  projectEnabled?: boolean;
  approvedPermissions: SkillPermission[];
  currentVersion: string;
  manifest: SkillManifest;
  checksum: string;
  ownerUserId: string | null;
  referencePaths: string[];
  scriptPaths: string[];
  assetPaths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillPackageRecord extends SkillMetadata {
  skillMd: string;
  references: Record<string, string>;
  scripts: Record<string, string>;
  assets: Record<string, string>;
}

export interface SkillVersionRecord {
  id: string;
  skillId: string;
  version: string;
  skillMd: string;
  manifest: SkillManifest;
  checksum: string;
  changelog: string;
  createdByUserId: string | null;
  createdAt: string;
}

export interface SkillDiscoveryContext {
  prompt: string;
  mode: 'build' | 'discuss';
  projectId: string;
  userId?: string;
  projectType: ProjectType;
  stack: string;
  existingFiles: string[];
  lastError: string | null;
  skillMode?: SkillInvocationMode;
  requestedSkillNames?: string[];
  disableAllSkills?: boolean;
}

export interface SkillDiscoveryMatch {
  skill: SkillMetadata;
  confidence: number;
  reason: string;
  explicit: boolean;
  matchedTriggers: string[];
}

export interface SkillCompositionStep {
  skillName: string;
  order: number;
  parallelGroup: number;
  reason: string;
  dependsOn: string[];
}

export interface SkillCompositionPlan {
  steps: SkillCompositionStep[];
  skippedConflicts: Array<{ skillName: string; reason: string }>;
  missingDependencies: Array<{ skillName: string; missing: string }>;
  hasCycle: boolean;
}

export interface SkillExecutionAttempt {
  skillId: string;
  skillName: string;
  mode: SkillInvocationMode;
  status: 'selected' | 'skipped' | 'running' | 'success' | 'failed' | 'fallback' | 'denied';
  confidence: number;
  reason: string;
  fallbackUsed: boolean;
  toolsInvoked: string[];
  errorSummary: string | null;
  durationMs: number;
  missingPermissions?: SkillPermission[];
}

export interface SkillPreflightOutcome {
  skillSystemAvailable: boolean;
  mode: SkillInvocationMode;
  disabled: boolean;
  discoveredCount: number;
  selectedMatches: SkillDiscoveryMatch[];
  loadedSkills: SkillPackageRecord[];
  composition: SkillCompositionPlan;
  deniedSkills: Array<{
    skillName: string;
    reason: string;
    missingPermissions: SkillPermission[];
    forbidden?: boolean;
  }>;
  loadFailures: Array<{ skillName: string; error: string }>;
  promptInstructions: string;
  warnings: string[];
}

export interface SkillExecutionAnalyticsSummary {
  totalExecutions: number;
  successCount: number;
  failedCount: number;
  fallbackCount: number;
  deniedCount: number;
  avgDurationMs: number;
  topSkills: Array<{
    skillName: string;
    total: number;
    successRate: number;
    avgDurationMs: number;
  }>;
  recentExecutions: Array<{
    id: string;
    projectId: string | null;
    skillName: string;
    mode: SkillInvocationMode;
    status: string;
    confidence: number;
    reason: string;
    fallbackUsed: boolean;
    errorSummary: string | null;
    durationMs: number;
    createdAt: string;
  }>;
}
