export type Locale = 'id' | 'en';
export type ThemeMode = 'dark' | 'light';
export type AccentColorId = 'crimson' | 'cobalt' | 'emerald' | 'amber' | 'indigo';
export type ProjectType = 'web' | 'android';

export type BuiltInProviderId = 'anthropic' | 'openai' | 'openrouter' | 'groq' | 'gemini' | 'coarena';
export type ProviderType = BuiltInProviderId | 'custom';

export type ModelTier = 'free' | 'paid' | 'unknown';
export type TriState = 'yes' | 'no' | 'unknown';

export type ProviderErrorCode =
  | 'AUTH_INVALID'
  | 'RATE_LIMIT'
  | 'QUOTA_EXCEEDED'
  | 'MODEL_NOT_FOUND'
  | 'CONTEXT_TOO_LONG'
  | 'PROVIDER_DOWN'
  | 'UNKNOWN';

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  locale: Locale;
  theme: ThemeMode;
  defaultProviderKeyId: string | null;
  defaultModelId: string | null;
  fallbackProviderKeyId: string | null;
  fallbackModelId: string | null;
  createdAt: string;
}

export interface ProviderKeyRecord {
  id: string;
  provider: ProviderType;
  label: string;
  keyLast4: string;
  tierDeclared: ModelTier;
  baseUrl?: string | null;
  authHeader?: string | null;
  chatPath?: string | null;
  customModels?: string[];
  supportsTools: TriState;
  supportsVision: TriState;
  extraHeaderKeys?: string[];
  isServerEnv?: boolean;
  localOnly?: boolean;
  lastTestStatus?: 'ok' | 'error' | null;
  lastTestMessage?: string | null;
  createdAt: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  provider: ProviderType;
  providerKeyId: string;
  providerLabel: string;
  tier: ModelTier;
  tierNote?: string;
  toolCalling: TriState;
  vision: TriState;
  maxContext: number | 'unknown';
  maxOutput: number | 'unknown';
  promptPricePerMillion?: number | null;
  completionPricePerMillion?: number | null;
  source: string;
  lastVerified: string;
  isNonChat?: boolean;
}

export interface ApkConfig {
  appName: string;
  packageId: string;
  versionName: string;
  versionCode: number;
  iconColor: string;
  buildType: 'debug' | 'release';
  hasKeystore?: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  type: ProjectType;
  stack: string;
  archived: boolean;
  rules: string;
  apkConfig: ApkConfig;
  fileCount: number;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFile {
  id: string;
  projectId: string;
  path: string;
  content: string;
  hash: string;
  updatedAt: string;
}

export interface ProjectVersion {
  id: string;
  projectId: string;
  messageId: string | null;
  label: string;
  fileCount: number;
  createdAt: string;
}

export interface ToolActionEvent {
  id: string;
  tool:
    | 'write_file'
    | 'edit_file'
    | 'read_file'
    | 'delete_file'
    | 'list_files'
    | 'search_files'
    | 'google_search'
    | 'create_directory'
    | 'inspect_dependencies'
    | 'workspace_diff'
    | 'update_project_memory'
    | 'rollback_checkpoint'
    | 'run_command'
    | 'install_dependencies'
    | 'run_tests'
    | 'build_project'
    | 'validate_project'
    | 'read_logs';
  target: string;
  status: 'running' | 'success' | 'error';
  detail?: string;
}

export interface AgentPlanStep {
  id: string;
  phase: 'inspect' | 'design' | 'implement' | 'verify' | 'repair';
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
}

export interface AgentPlanSummary {
  intent: 'new_app' | 'fullstack_feature' | 'bug_repair' | 'simple_edit' | 'architecture_discuss';
  complexity: 'low' | 'medium' | 'high';
  objective: string;
  requiresHeavyPlanning: boolean;
  steps: AgentPlanStep[];
}

export interface FallbackEvent {
  fromProvider: ProviderType;
  fromModel: string;
  toProvider: ProviderType;
  toModel: string;
  errorCode: ProviderErrorCode;
  reason: string;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  role: 'user' | 'assistant';
  content: string;
  mode?: 'build' | 'discuss';
  plan?: string | null;
  toolEvents: ToolActionEvent[];
  provider?: string | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  estimatedCostUsd?: number | null;
  versionId?: string | null;
  createdAt: string;
}

export interface EnvVarItem {
  id: string;
  key: string;
  maskedValue: string;
  updatedAt: string;
}

export interface BuildLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface ApkSigningCredentials {
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
}

export type ApkArtifactKind =
  | 'capacitor-source-zip'
  | 'debug-apk'
  | 'signed-release-apk'
  | 'unsigned-release-apk'
  | 'debug-aab'
  | 'signed-release-aab'
  | 'unsigned-release-aab';

export interface ApkBuildRecord {
  id: string;
  projectId: string;
  type: 'apk' | 'aab';
  status: 'queued' | 'running' | 'success' | 'failed';
  config: ApkConfig;
  logs: BuildLogEntry[];
  downloadToken?: string | null;
  artifactSizeBytes?: number | null;
  artifactKind?: ApkArtifactKind;
  signingVerified?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface BuildJobStatusResponse {
  id: string;
  projectId: string;
  type: 'apk' | 'aab';
  status: 'queued' | 'building' | 'completed' | 'failed';
  buildStatus: ApkBuildRecord['status'];
  queueMode: 'bullmq' | 'local-async';
  logsCount: number;
  logs: BuildLogEntry[];
  downloadToken?: string | null;
  artifactSizeBytes?: number | null;
  artifactKind?: ApkArtifactKind;
  signingVerified?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface AndroidToolchainStatus {
  readyForNativeApk: boolean;
  jdk: { available: boolean; version?: string };
  javac: { available: boolean; version?: string };
  gradle: { available: boolean; version?: string };
  androidSdk: { available: boolean; path?: string };
  apksigner?: { available: boolean; path?: string };
  jarsigner?: { available: boolean; version?: string };
  keytool?: { available: boolean; version?: string };
  missing: string[];
  installInstructions: string[];
}

export interface SandboxIsolationStatus {
  driver: 'docker' | 'podman' | 'linux-namespace' | 'restricted-host';
  osLevelIsolation: boolean;
  filesystemIsolated: boolean;
  pidIsolated: boolean;
  pidLimitEnforced: boolean;
  privilegeDropped: boolean;
  networkIsolated: boolean;
  resourceQuotasEnforced: boolean;
  details: string;
}

export interface TerminalLogEntry {
  id: string;
  process: 'dev' | 'install' | 'build';
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface DatabaseTableInfo {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface DatabaseIsolationInfo {
  engine: 'sqlite-isolated-file' | 'postgres-tenant-schema';
  tenantSchema: string;
  isolated: boolean;
  coreTablesSeparated: boolean;
}

export interface ProjectArchitectureInfo {
  stackKind: 'static' | 'sqlite-crud' | 'modular-spa' | 'fullstack-custom-backend';
  hasFrontend: boolean;
  frontendEntry: string | null;
  hasSchemaSql: boolean;
  hasCustomBackend: boolean;
  backendEntry: string | null;
}

export interface BackendRuntimeStatus {
  projectId: string;
  status: 'stopped' | 'starting' | 'running' | 'error';
  pid: number | null;
  port: number | null;
  entryPoint: string | null;
  healthy: boolean;
  driver: string | null;
  startedAt: string | null;
  lastHealthCheckAt: string | null;
  restartCount: number;
  lastError: string | null;
}

export interface PreviewHealthReport {
  healthy: boolean;
  status: 'running' | 'empty' | 'error' | 'installing';
  hasIndexHtml: boolean;
  isStarterTemplate: boolean;
  schemaSynced: boolean;
  tableCount: number;
  lastError: string | null;
  checkedAt: string;
  lifecycleState?: 'active' | 'sleeping' | 'waking';
  lastActivityAt?: string;
  idleTimeoutMs?: number;
  installingDependencies?: boolean;
  installStatus?: 'idle' | 'installing' | 'ready' | 'error';
  installPackageManager?: 'npm' | 'bun';
  missingPackages?: string[];
  architecture?: ProjectArchitectureInfo;
  backend?: BackendRuntimeStatus | null;
}

export type DeploymentTarget = 'vercel' | 'netlify' | 'cloudflare-pages' | 'self-hosted';

export interface DeploymentRecord {
  id: string;
  projectId: string;
  target: DeploymentTarget;
  status: 'pending' | 'ready' | 'failed';
  deploymentUrl: string | null;
  externalId: string | null;
  logs: BuildLogEntry[];
  projectName: string;
  createdAt: string;
}

export interface ToastNotification {
  id: string;
  type: 'success' | 'error';
  title: string;
  message: string;
  projectId?: string;
  buildId?: string;
  downloadToken?: string;
  downloadUrl?: string;
  actionLabel?: string;
  openProjectLabel?: string;
}

export interface DashboardActivityItem {
  id: string;
  kind: 'edit' | 'build' | 'deployment';
  projectId: string;
  projectName: string;
  projectType: ProjectType;
  title: string;
  detail: string;
  status: 'success' | 'failed' | 'running' | 'info';
  createdAt: string;
}

export interface ActivityLogEntry {
  id: string;
  kind: 'project' | 'build';
  projectId: string;
  projectName: string;
  projectType: ProjectType;
  detail: string;
  status: 'success' | 'failed' | 'running' | 'info';
  createdAt: string;
}

export type SkillCategory =
  | 'development'
  | 'debugging'
  | 'security'
  | 'testing'
  | 'database'
  | 'devops'
  | 'architecture'
  | 'agents';

export type SkillPermission = 'READ' | 'WRITE' | 'EXECUTE' | 'NETWORK' | 'DATABASE' | 'DEPLOY';
export type SkillTrustLevel = 'BUILTIN' | 'VERIFIED' | 'APPROVED' | 'DRAFT' | 'UNTRUSTED';
export type SkillSource = 'builtin' | 'created' | 'imported' | 'marketplace';
export type SkillInvocationMode = 'auto' | 'manual' | 'advanced';

export interface SkillManifestSummary {
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

export interface SkillMetadataItem {
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
  manifest: SkillManifestSummary;
  checksum: string;
  ownerUserId: string | null;
  referencePaths: string[];
  scriptPaths: string[];
  assetPaths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillPackageDetail extends SkillMetadataItem {
  skillMd: string;
  references: Record<string, string>;
  scripts: Record<string, string>;
  assets: Record<string, string>;
}

export interface SkillVersionItem {
  id: string;
  skillId: string;
  version: string;
  skillMd: string;
  manifest: SkillManifestSummary;
  checksum: string;
  changelog: string;
  createdByUserId: string | null;
  createdAt: string;
}

export interface RegisteredAgentToolInfo {
  name: string;
  category: string;
  requiredPermission: SkillPermission;
  mutating: boolean;
  description: string;
}

export interface SkillAnalyticsSummary {
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

export interface MarketplaceSkillItem {
  slug: string;
  name: string;
  category: SkillCategory;
  description: string;
  version: string;
  sourceType: 'curated-builtin' | 'remote';
  installed: boolean;
  enabled: boolean;
  trustBadge: string;
  permissions: SkillPermission[];
}

export interface MarketplaceCatalogData {
  items: MarketplaceSkillItem[];
  remoteConfigured: boolean;
  remoteAvailable: boolean;
  remoteNotice: string;
}

export interface SkillTurnTraceItem {
  skillName: string;
  reason: string;
  confidence?: number;
  explicit?: boolean;
  status: 'selected' | 'running' | 'success' | 'fallback' | 'denied';
  fallbackUsed?: boolean;
  missingPermissions?: SkillPermission[];
}

export type AgentTaskState =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface VerificationGateSummary {
  status: 'verified_pass' | 'verified_fail' | 'not_verified' | 'not_required';
  passedChecks: string[];
  failedChecks: string[];
}
