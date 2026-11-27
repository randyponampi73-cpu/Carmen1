import type {
  ActivityLogEntry,
  AndroidToolchainStatus,
  ApkBuildRecord,
  ApkConfig,
  ApkSigningCredentials,
  BuildJobStatusResponse,
  ChatMessage,
  DashboardActivityItem,
  DatabaseIsolationInfo,
  DatabaseTableInfo,
  DeploymentRecord,
  DeploymentTarget,
  EnvVarItem,
  MarketplaceCatalogData,
  ModelTier,
  PreviewHealthReport,
  ProjectFile,
  ProjectSummary,
  ProjectType,
  ProjectVersion,
  ProviderKeyRecord,
  ProviderModel,
  ProviderType,
  RegisteredAgentToolInfo,
  SandboxIsolationStatus,
  SkillAnalyticsSummary,
  SkillCategory,
  SkillMetadataItem,
  SkillPackageDetail,
  SkillPermission,
  SkillVersionItem,
  TerminalLogEntry,
  TriState,
  UserProfile,
} from '../types';

let inMemorySessionToken: string | null = null;
let unauthorizedHandler: ((message: string) => void) | null = null;
let defaultUnauthorizedMessage = 'Sesi tidak ditemukan. Silakan masuk terlebih dahulu.';

export function setSessionToken(token: string | null): void {
  inMemorySessionToken = token && token.trim() ? token.trim() : null;
}

export function getSessionToken(): string | null {
  return inMemorySessionToken;
}

export function getAuthHeaders(): Record<string, string> {
  return inMemorySessionToken ? { Authorization: `Bearer ${inMemorySessionToken}` } : {};
}

export function setUnauthorizedHandler(handler: ((message: string) => void) | null): void {
  unauthorizedHandler = handler;
}

export function setDefaultUnauthorizedMessage(message: string): void {
  defaultUnauthorizedMessage = message || defaultUnauthorizedMessage;
}

export function notifyUnauthorized(message?: string): void {
  inMemorySessionToken = null;
  if (unauthorizedHandler) {
    unauthorizedHandler(message || defaultUnauthorizedMessage);
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const errPayload = data as { error?: string; message?: string; code?: string };
    const errMsg = errPayload?.error || errPayload?.message || `HTTP ${res.status}`;
    const isAuthAttempt =
      url.startsWith('/api/auth/login') ||
      url.startsWith('/api/auth/register') ||
      url.startsWith('/api/auth/magic-link');
    if (res.status === 401 && !isAuthAttempt) {
      notifyUnauthorized(errMsg);
    }
    throw new ApiError(errMsg, res.status, typeof errPayload?.code === 'string' ? errPayload.code : undefined);
  }
  return data as T;
}

export interface WorkspacePayload {
  project: ProjectSummary;
  previewToken?: string;
  previewOrigin?: string;
  runtimeStatus: 'running' | 'error';
  runtimeError: string | null;
  files: ProjectFile[];
  messages: ChatMessage[];
  versions: ProjectVersion[];
  envVars: EnvVarItem[];
  logs: TerminalLogEntry[];
  builds: ApkBuildRecord[];
  deployments?: DeploymentRecord[];
}

export const api = {
  // Auth
  session: async () => {
    const res = await request<{
      user: UserProfile | null;
      sessionToken?: string | null;
      demoEnabled?: boolean;
      emailEnabled?: boolean;
    }>('/api/auth/session');
    if (res.sessionToken) setSessionToken(res.sessionToken);
    else if (!res.user) setSessionToken(null);
    return res;
  },
  me: () => request<{ user: UserProfile }>('/api/auth/me'),
  login: async (email: string, password: string) => {
    const res = await request<{ user: UserProfile; sessionToken?: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (res.sessionToken) setSessionToken(res.sessionToken);
    return res;
  },
  register: async (email: string, password: string, name: string) => {
    const res = await request<{ user: UserProfile; sessionToken?: string; isNewUser: boolean }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
    if (res.sessionToken) setSessionToken(res.sessionToken);
    return res;
  },
  magicLink: async (email: string) => {
    return await request<{ ok: boolean; requiresVerification: boolean; message: string }>('/api/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },
  verifyMagicLink: async (token: string) => {
    const res = await request<{ user: UserProfile; sessionToken?: string; isNewUser: boolean }>(
      '/api/auth/magic-link/verify',
      {
        method: 'POST',
        body: JSON.stringify({ token }),
      }
    );
    if (res.sessionToken) setSessionToken(res.sessionToken);
    return res;
  },
  loginDemo: async () => {
    const res = await request<{ user: UserProfile; sessionToken?: string }>('/api/auth/demo', { method: 'POST' });
    if (res.sessionToken) setSessionToken(res.sessionToken);
    return res;
  },
  logout: async () => {
    try {
      return await request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
    } finally {
      setSessionToken(null);
    }
  },
  updateProfile: (patch: Partial<UserProfile>) =>
    request<{ user: UserProfile }>('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteAccount: async () => {
    const res = await request<{ ok: boolean }>('/api/auth/account', { method: 'DELETE' });
    setSessionToken(null);
    return res;
  },

  // Providers & Keys
  listKeys: () => request<{ keys: ProviderKeyRecord[]; masterKeyConfigured?: boolean }>('/api/providers/keys'),
  downloadProjectZip: async (projectId: string) => {
    const res = await fetch(`/api/projects/${projectId}/export.zip`, {
      credentials: 'include',
      headers: { ...getAuthHeaders() },
    });
    if (res.status === 401) {
      notifyUnauthorized();
      throw new Error(defaultUnauthorizedMessage);
    }
    if (!res.ok) {
      throw new Error(`Gagal mengekspor ZIP (HTTP ${res.status}).`);
    }
    const blob = await res.blob();
    const disp = res.headers.get('content-disposition') || '';
    const match = disp.match(/filename="([^"]+)"/);
    const filename = match?.[1] || `${projectId}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  addKey: (body: {
    provider: ProviderType;
    label: string;
    apiKey: string;
    tierDeclared: ModelTier;
    baseUrl?: string;
    authHeader?: string;
    chatPath?: string;
    customModels?: string[];
    extraHeaders?: Record<string, string>;
    supportsTools?: TriState;
    supportsVision?: TriState;
  }) => request<{ key: ProviderKeyRecord }>('/api/providers/keys', { method: 'POST', body: JSON.stringify(body) }),
  updateKey: (
    id: string,
    body: Partial<{
      label: string;
      apiKey: string;
      tierDeclared: ModelTier;
      baseUrl: string;
      authHeader: string;
      chatPath: string;
      customModels: string[];
      supportsTools: TriState;
      supportsVision: TriState;
    }>
  ) => request<{ key: ProviderKeyRecord }>(`/api/providers/keys/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteKey: (id: string) => request<{ ok: boolean }>(`/api/providers/keys/${id}`, { method: 'DELETE' }),
  testKey: (id: string) =>
    request<{ ok: boolean; message: string; errorCode?: string }>(`/api/providers/keys/${id}/test`, {
      method: 'POST',
    }),
  testEphemeralKey: (body: {
    provider: ProviderType;
    label?: string;
    apiKey: string;
    tierDeclared?: ModelTier;
    baseUrl?: string;
    authHeader?: string;
    chatPath?: string;
    customModels?: string[];
  }) =>
    request<{ ok: boolean; message: string; errorCode?: string }>('/api/providers/test-ephemeral', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listModels: (refresh = false) =>
    request<{ models: ProviderModel[]; warnings: string[] }>(`/api/providers/models${refresh ? '?refresh=1' : ''}`),
  listEphemeralModels: (body: {
    keyId?: string;
    provider: ProviderType;
    label?: string;
    apiKey: string;
    tierDeclared?: ModelTier;
    baseUrl?: string;
    authHeader?: string;
    chatPath?: string;
    customModels?: string[];
    supportsTools?: TriState;
    supportsVision?: TriState;
  }) =>
    request<{ models: ProviderModel[]; warnings: string[] }>('/api/providers/models/ephemeral', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Projects & Templates
  listTemplates: () =>
    request<{
      templates: Array<{
        id: string;
        name: string;
        nameEn: string;
        description: string;
        descriptionEn: string;
        type: ProjectType;
        stack: string;
      }>;
    }>('/api/templates'),
  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),
  createProject: (body: { name?: string; type?: ProjectType; templateId?: string; initialPrompt?: string }) =>
    request<{ project: ProjectSummary }>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  importZipProject: (body: { name: string; type: ProjectType; zipBase64: string }) =>
    request<{ projectId: string; fileCount: number; installingDependencies?: boolean }>('/api/projects/import-zip', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProject: (id: string, body: Partial<{ name: string; archived: boolean; rules: string; apkConfig: ApkConfig }>) =>
    request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  duplicateProject: (id: string) =>
    request<{ id: string; name: string }>(`/api/projects/${id}/duplicate`, { method: 'POST' }),
  deleteProject: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  // Workspace & Activity
  getActivity: () =>
    request<{ recentActivity: DashboardActivityItem[]; activityLog: ActivityLogEntry[] }>('/api/activity'),
  getWorkspace: (id: string) => request<WorkspacePayload>(`/api/projects/${id}/workspace`),
  saveFile: (projectId: string, path: string, content: string) =>
    request<{ ok: boolean; path: string; runtimeStatus: 'running' | 'error'; runtimeError: string | null }>(
      `/api/projects/${projectId}/files`,
      { method: 'PUT', body: JSON.stringify({ path, content }) }
    ),
  deleteFile: (projectId: string, filePath: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/files?path=${encodeURIComponent(filePath)}`, {
      method: 'DELETE',
    }),
  stopChat: (projectId: string) => request<{ ok: boolean }>(`/api/projects/${projectId}/chat/stop`, { method: 'POST' }),
  restoreVersion: (projectId: string, versionId: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/versions/${versionId}/restore`, { method: 'POST' }),
  getVersionDiff: (projectId: string, versionId: string) =>
    request<{ label: string; diffs: Array<{ path: string; before: string; after: string; changed: boolean }> }>(
      `/api/projects/${projectId}/versions/${versionId}/diff`
    ),
  addEnvVar: (projectId: string, key: string, value: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/env`, {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    }),
  deleteEnvVar: (projectId: string, envId: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/env/${envId}`, { method: 'DELETE' }),
  getPreviewToken: (projectId: string) =>
    request<{ token: string; previewOrigin: string; expiresInSeconds: number }>(`/api/projects/${projectId}/preview-token`),
  runTerminalCommand: (projectId: string, cmd: string) =>
    request<{
      ok: boolean;
      output: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      durationMs?: number;
      logs: TerminalLogEntry[];
    }>(`/api/projects/${projectId}/terminal/run`, {
      method: 'POST',
      body: JSON.stringify({ cmd }),
    }),
  stopTerminalProcess: (projectId: string) =>
    request<{ ok: boolean; stopped: boolean; logs: TerminalLogEntry[] }>(`/api/projects/${projectId}/terminal/stop`, {
      method: 'POST',
    }),
  reportPreviewError: (projectId: string, message: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/preview-error`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  getPreviewHealth: (projectId: string) =>
    request<{ health: PreviewHealthReport }>(`/api/projects/${projectId}/preview-health`),
  inspectDatabase: (projectId: string) =>
    request<{ tables: DatabaseTableInfo[]; isolation?: DatabaseIsolationInfo }>(`/api/projects/${projectId}/database`),

  // Production Deployments
  listDeployments: (projectId: string) =>
    request<{ deployments: DeploymentRecord[] }>(`/api/projects/${projectId}/deployments`),
  createDeployment: async (
    projectId: string,
    body: {
      target: DeploymentTarget;
      projectName?: string;
      apiToken?: string;
      siteId?: string;
      accountId?: string;
      teamId?: string;
      production?: boolean;
    }
  ): Promise<{ deployment: DeploymentRecord; artifacts?: Record<string, string>; error?: string }> => {
    const res = await fetch(`/api/projects/${projectId}/deployments`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: { deployment?: DeploymentRecord; artifacts?: Record<string, string>; error?: string };
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (res.status === 401) {
      notifyUnauthorized(data.error || defaultUnauthorizedMessage);
      throw new Error(data.error || defaultUnauthorizedMessage);
    }
    if (!data.deployment) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return { deployment: data.deployment, artifacts: data.artifacts, error: data.error };
  },

  // System Sandbox, Provider Health & Android Toolchain / APK Builds
  getProviderHealth: () =>
    request<{ health: Array<{ key: string; consecutiveFailures: number; cooldownUntil: number; lastErrorCode?: string }> }>(
      '/api/system/provider-health'
    ),
  getSandboxStatus: () => request<{ sandbox: SandboxIsolationStatus }>('/api/system/sandbox-status'),
  getAndroidToolchain: () => request<{ toolchain: AndroidToolchainStatus }>('/api/system/android-toolchain'),
  startApkBuild: (
    projectId: string,
    config: ApkConfig,
    keystoreBase64?: string,
    signingCredentials?: ApkSigningCredentials,
    format: 'apk' | 'aab' = 'apk'
  ) =>
    request<{ build: ApkBuildRecord }>(`/api/projects/${projectId}/builds`, {
      method: 'POST',
      body: JSON.stringify({ config, keystoreBase64, signingCredentials, format }),
    }),
  getBuild: (buildId: string) => request<{ build: ApkBuildRecord }>(`/api/builds/${buildId}`),
  getBuildStatus: (buildId: string) => request<BuildJobStatusResponse>(`/api/builds/${buildId}/status`),
  cancelApkBuild: (buildId: string) =>
    request<{ build: ApkBuildRecord }>(`/api/builds/${buildId}/cancel`, { method: 'POST' }),
  downloadBuildArtifact: async (buildId: string, token: string) => {
    const res = await fetch(`/api/builds/${buildId}/download?token=${encodeURIComponent(token)}`, {
      credentials: 'include',
      headers: { ...getAuthHeaders() },
    });
    if (res.status === 401) {
      notifyUnauthorized();
      throw new Error(defaultUnauthorizedMessage);
    }
    if (!res.ok) {
      throw new Error(`Gagal mengunduh artefak build (HTTP ${res.status}).`);
    }
    const blob = await res.blob();
    const disp = res.headers.get('content-disposition') || '';
    const match = disp.match(/filename="([^"]+)"/);
    const filename = match?.[1] || `${buildId}.apk`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Dynamic Skill Intelligence System
  listSkills: (params?: {
    projectId?: string;
    category?: SkillCategory | 'all';
    search?: string;
    includeDisabled?: boolean;
  }) => {
    const q = new URLSearchParams();
    if (params?.projectId) q.set('projectId', params.projectId);
    if (params?.category && params.category !== 'all') q.set('category', params.category);
    if (params?.search?.trim()) q.set('search', params.search.trim());
    if (params?.includeDisabled === false) q.set('includeDisabled', '0');
    const qs = q.toString();
    return request<{
      skills: SkillMetadataItem[];
      tools: RegisteredAgentToolInfo[];
      analytics: SkillAnalyticsSummary;
    }>(`/api/skills${qs ? `?${qs}` : ''}`);
  },
  getSkillDetail: (id: string, projectId?: string) =>
    request<{
      skill: SkillPackageDetail;
      versions: SkillVersionItem[];
      effectivePermissions: SkillPermission[];
      validation: { valid: boolean; errors: string[]; warnings: string[] };
    }>(`/api/skills/${encodeURIComponent(id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  createSkill: (body: {
    name?: string;
    category?: SkillCategory;
    description?: string;
    tools?: string[];
    permissions?: SkillPermission[];
    triggers?: string[];
    workflowSteps?: string[];
    executionMode?: 'sequential' | 'parallel-safe';
    skillMd?: string;
  }) => request<{ skill: SkillPackageDetail; warnings?: string[] }>('/api/skills', { method: 'POST', body: JSON.stringify(body) }),
  updateSkill: (id: string, body: { skillMd: string; changelog?: string }) =>
    request<{ skill: SkillPackageDetail }>(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  validateSkill: (id: string) =>
    request<{ valid: boolean; errors: string[]; warnings: string[] }>(`/api/skills/${encodeURIComponent(id)}/validate`, {
      method: 'POST',
    }),
  rollbackSkill: (id: string, versionId: string) =>
    request<{ skill: SkillPackageDetail }>(`/api/skills/${encodeURIComponent(id)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ versionId }),
    }),
  deleteSkill: (id: string) =>
    request<{ ok: boolean }>(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  toggleUserSkill: (id: string, enabled: boolean) =>
    request<{ skill: SkillMetadataItem }>(`/api/skills/${encodeURIComponent(id)}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  toggleProjectSkill: (projectId: string, skillId: string, patch: { enabled?: boolean; approvedPermissions?: SkillPermission[] }) =>
    request<{ skill: SkillMetadataItem }>(
      `/api/projects/${encodeURIComponent(projectId)}/skills/${encodeURIComponent(skillId)}/toggle`,
      { method: 'POST', body: JSON.stringify(patch) }
    ),
  approveSkill: (id: string, body?: { permissions?: SkillPermission[]; projectId?: string; promoteTrust?: boolean }) =>
    request<{ skill: SkillMetadataItem }>(`/api/skills/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),
  importSkillZip: (zipBase64: string) =>
    request<{ skill: SkillPackageDetail; warnings?: string[] }>('/api/skills/import', {
      method: 'POST',
      body: JSON.stringify({ zipBase64 }),
    }),
  downloadSkillZip: async (id: string, slug: string) => {
    const res = await fetch(`/api/skills/${encodeURIComponent(id)}/export.zip`, {
      credentials: 'include',
      headers: { ...getAuthHeaders() },
    });
    if (res.status === 401) {
      notifyUnauthorized();
      throw new Error(defaultUnauthorizedMessage);
    }
    if (!res.ok) {
      throw new Error(`Gagal mengekspor skill ZIP (HTTP ${res.status}).`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug || 'skill'}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  getSkillMarketplace: (projectId?: string) =>
    request<MarketplaceCatalogData>(
      `/api/skills/marketplace${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`
    ),
  getSkillAnalytics: (projectId?: string) =>
    request<{ analytics: SkillAnalyticsSummary }>(
      `/api/skills/analytics${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`
    ),
};

// Local-only key storage in browser localStorage (Mode "Key hanya di perangkat" KEY-8)
const LOCAL_KEYS_STORAGE = 'carmen_local_only_keys_v1';

export interface LocalOnlyKey {
  id: string;
  provider: ProviderType;
  label: string;
  apiKey: string;
  keyLast4: string;
  tierDeclared: ModelTier;
  baseUrl?: string;
  authHeader?: string;
  chatPath?: string;
  customModels?: string[];
  supportsTools?: TriState;
  supportsVision?: TriState;
  lastTestStatus?: 'ok' | 'error' | null;
  lastTestMessage?: string | null;
  createdAt: string;
}

export function loadLocalOnlyKeys(): LocalOnlyKey[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEYS_STORAGE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is LocalOnlyKey =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        typeof item.provider === 'string' &&
        typeof item.apiKey === 'string'
    );
  } catch {
    return [];
  }
}

export function saveLocalOnlyKey(item: LocalOnlyKey): void {
  const existing = loadLocalOnlyKeys().filter((k) => k.id !== item.id);
  localStorage.setItem(LOCAL_KEYS_STORAGE, JSON.stringify([item, ...existing]));
}

export function updateLocalOnlyKey(
  id: string,
  patch: Partial<Omit<LocalOnlyKey, 'id' | 'createdAt'>>
): void {
  const updated = loadLocalOnlyKeys().map((k) => {
    if (k.id !== id) return k;
    const nextApiKey = typeof patch.apiKey === 'string' && patch.apiKey ? patch.apiKey : k.apiKey;
    return {
      ...k,
      ...patch,
      apiKey: nextApiKey,
      keyLast4: nextApiKey.slice(-4),
    };
  });
  localStorage.setItem(LOCAL_KEYS_STORAGE, JSON.stringify(updated));
}

export function removeLocalOnlyKey(id: string): void {
  const existing = loadLocalOnlyKeys().filter((k) => k.id !== id);
  localStorage.setItem(LOCAL_KEYS_STORAGE, JSON.stringify(existing));
}
