import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AppHeader, type MainRoute } from './components/AppHeader';
import { AuthView, OnboardingConnectView } from './components/AuthView';
import { isModelNonChat } from './components/CustomSelect';
import { HomeView } from './components/HomeView';
import { ToastContainer } from './components/ToastContainer';
import { COPY } from './i18n';
import { api, loadLocalOnlyKeys, setDefaultUnauthorizedMessage, setUnauthorizedHandler } from './lib/api';
import { applyAccentCssVariables, getStoredAccentId, saveStoredAccentId } from './lib/theme';
import type {
  AccentColorId,
  ActivityLogEntry,
  ApkBuildRecord,
  DashboardActivityItem,
  Locale,
  ProjectSummary,
  ProjectType,
  ProviderKeyRecord,
  ProviderModel,
  ThemeMode,
  ToastNotification,
  UserProfile,
} from './types';

const WorkspaceView = lazy(() =>
  import('./components/WorkspaceView').then((m) => ({ default: m.WorkspaceView }))
);
const ProjectsView = lazy(() =>
  import('./components/ProjectsView').then((m) => ({ default: m.ProjectsView }))
);
const SettingsView = lazy(() =>
  import('./components/SettingsView').then((m) => ({ default: m.SettingsView }))
);

interface TemplateItem {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  type: ProjectType;
  stack: string;
}

function getInitialGuestTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem('carmen_theme');
    if (saved === 'light' || saved === 'dark') return saved;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
  } catch {
    // Ignore storage access restrictions
  }
  return 'dark';
}

function getInitialGuestLocale(): Locale {
  try {
    const saved = localStorage.getItem('carmen_locale');
    if (saved === 'id' || saved === 'en') return saved;
    if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('id')) {
      return 'id';
    }
  } catch {
    // Ignore storage access restrictions
  }
  return 'en';
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [demoEnabled, setDemoEnabled] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [guestTheme, setGuestTheme] = useState<ThemeMode>(getInitialGuestTheme);
  const [guestLocale, setGuestLocale] = useState<Locale>(getInitialGuestLocale);
  const [accentColor, setAccentColor] = useState<AccentColorId>(getStoredAccentId);

  const [route, setRoute] = useState<MainRoute>('home');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<{
    prompt: string;
    imageBase64?: string;
    imageMimeType?: string;
  } | null>(null);

  const [keys, setKeys] = useState<ProviderKeyRecord[]>([]);
  const [masterKeyConfigured, setMasterKeyConfigured] = useState<boolean>(true);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelWarnings, setModelWarnings] = useState<string[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState<string>('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [recentActivity, setRecentActivity] = useState<DashboardActivityItem[]>([]);
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const [trackedBuildIds, setTrackedBuildIds] = useState<string[]>([]);

  const userRef = useRef<UserProfile | null>(null);
  const projectsRef = useRef<ProjectSummary[]>([]);
  const toastTimersRef = useRef<Map<string, number>>(new Map());
  const trackedBuildMetaRef = useRef<Map<string, { projectId: string; projectName: string; format: 'apk' | 'aab' }>>(
    new Map()
  );

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const effectiveTheme: ThemeMode = user?.theme ?? guestTheme;
  const effectiveLocale: Locale = user?.locale ?? guestLocale;

  // Apply dark/light theme class + lang attribute and persist theme for pre-paint script
  useEffect(() => {
    document.documentElement.classList.toggle('dark', effectiveTheme === 'dark');
    document.documentElement.lang = effectiveLocale;
    try {
      localStorage.setItem('carmen_theme', effectiveTheme);
      localStorage.setItem('carmen_locale', effectiveLocale);
    } catch {
      // Ignore storage access restrictions
    }
  }, [effectiveTheme, effectiveLocale]);

  // Apply dynamic --accent CSS variables whenever accent preset or theme mode changes
  useEffect(() => {
    applyAccentCssVariables(accentColor, effectiveTheme);
    saveStoredAccentId(accentColor);
  }, [accentColor, effectiveTheme]);

  const clearAllToasts = useCallback(() => {
    for (const timerId of toastTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    toastTimersRef.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const timerId of timers.values()) {
        window.clearTimeout(timerId);
      }
      timers.clear();
    };
  }, []);

  // Keep unauthorized messages aligned with active locale
  useEffect(() => {
    const t = COPY[effectiveLocale];
    setDefaultUnauthorizedMessage(t.sessionMissing);
    setUnauthorizedHandler((msg) => {
      setUser(null);
      userRef.current = null;
      setActiveProjectId(null);
      setShowOnboarding(false);
      setKeys([]);
      setModels([]);
      setProjects([]);
      setRecentActivity([]);
      setActivityLog([]);
      setTrackedBuildIds([]);
      trackedBuildMetaRef.current.clear();
      clearAllToasts();
      setAuthNotice(msg || t.sessionExpired);
    });
    return () => setUnauthorizedHandler(null);
  }, [effectiveLocale, clearAllToasts]);

  // Dynamic document title across top-level routes (WorkspaceView manages its own title)
  useEffect(() => {
    if (activeProjectId) return;
    const t = COPY[effectiveLocale];
    if (!user) {
      document.title = t.titleAuth;
    } else if (route === 'projects') {
      document.title = t.titleProjects;
    } else if (route === 'settings') {
      document.title = t.titleSettings;
    } else {
      document.title = t.titleHome;
    }
  }, [user, route, activeProjectId, effectiveLocale]);

  const dismissToast = useCallback((id: string) => {
    const prevTimer = toastTimersRef.current.get(id);
    if (prevTimer !== undefined) {
      window.clearTimeout(prevTimer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: ToastNotification) => {
      const prevTimer = toastTimersRef.current.get(toast.id);
      if (prevTimer !== undefined) {
        window.clearTimeout(prevTimer);
      }
      setToasts((prev) => [toast, ...prev.filter((x) => x.id !== toast.id)].slice(0, 4));
      const timerId = window.setTimeout(() => {
        toastTimersRef.current.delete(toast.id);
        setToasts((prev) => prev.filter((item) => item.id !== toast.id));
      }, 9000);
      toastTimersRef.current.set(toast.id, timerId);
    },
    []
  );

  const loadKeysAndModels = useCallback(
    async (forceRefresh = false, profileOverride?: UserProfile) => {
      const localKeys = loadLocalOnlyKeys();
      const [keysRes, modelsRes, ephemeralResults] = await Promise.all([
        api.listKeys(),
        api.listModels(forceRefresh),
        localKeys.length > 0
          ? Promise.allSettled(
              localKeys.map((lk) =>
                api.listEphemeralModels({
                  keyId: lk.id,
                  provider: lk.provider,
                  label: lk.label,
                  apiKey: lk.apiKey,
                  tierDeclared: lk.tierDeclared,
                  baseUrl: lk.baseUrl,
                  authHeader: lk.authHeader,
                  chatPath: lk.chatPath,
                  customModels: lk.customModels,
                  supportsTools: lk.supportsTools ?? 'unknown',
                  supportsVision: lk.supportsVision ?? 'unknown',
                })
              )
            )
          : Promise.resolve([]),
      ]);

      const localKeyRecords: ProviderKeyRecord[] = localKeys.map((lk) => ({
        id: lk.id,
        provider: lk.provider,
        label: lk.label,
        keyLast4: lk.keyLast4 || lk.apiKey.slice(-4),
        tierDeclared: lk.tierDeclared,
        baseUrl: lk.baseUrl ?? null,
        authHeader: lk.authHeader ?? null,
        chatPath: lk.chatPath ?? null,
        customModels: lk.customModels,
        supportsTools: lk.supportsTools ?? 'unknown',
        supportsVision: lk.supportsVision ?? 'unknown',
        localOnly: true,
        lastTestStatus: lk.lastTestStatus ?? null,
        lastTestMessage: lk.lastTestMessage ?? null,
        createdAt: lk.createdAt,
      }));

      const mergedModels: ProviderModel[] = [...modelsRes.models];
      const mergedWarnings: string[] = [...(modelsRes.warnings || [])];
      const seenModelKeys = new Set(mergedModels.map((m) => `${m.providerKeyId}::${m.id}`));

      ephemeralResults.forEach((result, idx) => {
        const lk = localKeys[idx];
        if (result.status === 'fulfilled') {
          for (const model of result.value.models) {
            const composite = `${model.providerKeyId}::${model.id}`;
            if (!seenModelKeys.has(composite)) {
              seenModelKeys.add(composite);
              mergedModels.push(model);
            }
          }
          if (result.value.warnings?.length) {
            mergedWarnings.push(...result.value.warnings);
          }
        } else if (lk) {
          mergedWarnings.push(
            `${lk.label}: ${result.reason instanceof Error ? result.reason.message : 'Failed to load models'}`
          );
        }
      });

      setKeys([...localKeyRecords, ...keysRes.keys]);
      if (typeof keysRes.masterKeyConfigured === 'boolean') {
        setMasterKeyConfigured(keysRes.masterKeyConfigured);
      }
      setModels(mergedModels);
      setModelWarnings(mergedWarnings);

      const activeUser = profileOverride ?? userRef.current;
      const preferredModel = mergedModels.find((m) => !isModelNonChat(m)) ?? mergedModels[0];
      setSelectedModelKey((prev) => {
        if (prev && mergedModels.some((m) => `${m.providerKeyId}::${m.id}` === prev)) {
          return prev;
        }
        if (activeUser?.defaultProviderKeyId && activeUser?.defaultModelId) {
          const defKey = `${activeUser.defaultProviderKeyId}::${activeUser.defaultModelId}`;
          if (mergedModels.some((m) => `${m.providerKeyId}::${m.id}` === defKey)) return defKey;
        }
        return preferredModel ? `${preferredModel.providerKeyId}::${preferredModel.id}` : '';
      });
    },
    []
  );

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const res = await api.listProjects();
      setProjects(res.projects);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const res = await api.getActivity();
      setRecentActivity(res.recentActivity || []);
      setActivityLog(res.activityLog || []);
    } catch {
      // Non-fatal dashboard feed refresh failure
    } finally {
      setActivityLoading(false);
    }
  }, []);

  const handleTrackBuild = useCallback((build: ApkBuildRecord, projectName?: string) => {
    if (build.status !== 'queued' && build.status !== 'running') return;
    const knownProject =
      projectName ||
      build.config?.appName ||
      projectsRef.current.find((p) => p.id === build.projectId)?.name ||
      build.projectId;
    trackedBuildMetaRef.current.set(build.id, {
      projectId: build.projectId,
      projectName: knownProject,
      format: build.type,
    });
    setTrackedBuildIds((prev) => (prev.includes(build.id) ? prev : [...prev, build.id]));
  }, []);

  // Poll any active background APK/AAB builds and emit success/error toast on completion
  useEffect(() => {
    if (trackedBuildIds.length === 0 || !user) return;
    let cancelled = false;

    const checkBuilds = async () => {
      for (const buildId of trackedBuildIds) {
        if (cancelled) return;
        try {
          const st = await api.getBuildStatus(buildId);
          if (cancelled) return;
          if (st.buildStatus === 'success' || st.buildStatus === 'failed') {
            const meta = trackedBuildMetaRef.current.get(buildId);
            trackedBuildMetaRef.current.delete(buildId);
            setTrackedBuildIds((prev) => prev.filter((id) => id !== buildId));

            const t = COPY[userRef.current?.locale ?? effectiveLocale];
            const formatUpper = (st.type || meta?.format || 'apk').toUpperCase();
            const projName = meta?.projectName || st.projectId;
            const hasDownload = st.buildStatus === 'success' && Boolean(st.downloadToken);

            pushToast({
              id: `toast_build_${st.id}`,
              type: st.buildStatus === 'success' ? 'success' : 'error',
              title: (st.buildStatus === 'success' ? t.apkToastSuccessTitle : t.apkToastFailTitle).replace(
                '{format}',
                formatUpper
              ),
              message: (st.buildStatus === 'success' ? t.apkToastSuccessMsg : t.apkToastFailMsg).replace(
                '{name}',
                projName
              ),
              projectId: st.projectId,
              buildId: hasDownload ? st.id : undefined,
              downloadToken: hasDownload ? (st.downloadToken ?? undefined) : undefined,
              actionLabel: hasDownload ? t.apkToastDownload : undefined,
              openProjectLabel: t.apkToastOpenProject,
            });
            void loadActivity();
          }
        } catch {
          // Ignore transient polling failure
        }
      }
    };

    const timer = window.setInterval(() => {
      void checkBuilds();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [trackedBuildIds, user, effectiveLocale, pushToast, loadActivity]);

  const hydrateAuthed = useCallback(
    async (u: UserProfile) => {
      setUser(u);
      userRef.current = u;
      const [tplRes] = await Promise.all([
        api.listTemplates(),
        loadKeysAndModels(false, u),
        loadProjects(),
        loadActivity(),
      ]);
      setTemplates(tplRes.templates);
    },
    [loadKeysAndModels, loadProjects, loadActivity]
  );

  // Initial session check (supports ?autostart=1 only when server enables demo mode)
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const params = new URLSearchParams(window.location.search);
      try {
        const res = await api.session();
        if (cancelled) return;
        const isDemoEnabled = res.demoEnabled === true;
        setDemoEnabled(isDemoEnabled);
        setEmailEnabled(res.emailEnabled === true);
        if (res.user) {
          await hydrateAuthed(res.user);
        } else if (params.get('autostart') === '1' && isDemoEnabled) {
          const demo = await api.loginDemo();
          if (!cancelled) await hydrateAuthed(demo.user);
        }
      } catch {
        // Fall back to login screen
      } finally {
        if (!cancelled) setBooting(false);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [hydrateAuthed]);

  async function handleUpdateProfile(patch: Partial<UserProfile>) {
    const res = await api.updateProfile(patch);
    setUser(res.user);
  }

  async function handleLogout() {
    await api.logout();
    setUser(null);
    userRef.current = null;
    setActiveProjectId(null);
    setShowOnboarding(false);
    setKeys([]);
    setModels([]);
    setProjects([]);
    setRecentActivity([]);
    setActivityLog([]);
    setTrackedBuildIds([]);
    trackedBuildMetaRef.current.clear();
    clearAllToasts();
  }

  async function handleDeleteAccount() {
    await api.deleteAccount();
    try {
      localStorage.removeItem('carmen_last_email');
    } catch {
      // Ignore storage access restrictions
    }
    setUser(null);
    userRef.current = null;
    setActiveProjectId(null);
    setShowOnboarding(false);
    setKeys([]);
    setModels([]);
    setProjects([]);
    setRecentActivity([]);
    setActivityLog([]);
    setTrackedBuildIds([]);
    trackedBuildMetaRef.current.clear();
    clearAllToasts();
  }

  const toastPortal = (
    <ToastContainer
      toasts={toasts}
      closeLabel={COPY[effectiveLocale].close}
      onDismiss={dismissToast}
      onOpenProject={(pid) => setActiveProjectId(pid)}
      onDownloadBuild={(buildId, token) => {
        void api.downloadBuildArtifact(buildId, token).catch((err) => {
          pushToast({
            id: `toast_dl_err_${buildId}`,
            type: 'error',
            title: COPY[effectiveLocale].apkStartBuildFail,
            message: err instanceof Error ? err.message : COPY[effectiveLocale].apkStartBuildFail,
          });
        });
      }}
    />
  );

  if (booting) {
    return (
      <div className="h-dvh w-full bg-[var(--bg)] flex items-center justify-center text-[13px] text-[var(--text-muted)]">
        {COPY[effectiveLocale].loadingApp}
      </div>
    );
  }

  if (!user) {
    return (
      <AuthView
        locale={guestLocale}
        theme={guestTheme}
        demoEnabled={demoEnabled}
        emailEnabled={emailEnabled}
        initialNotice={authNotice}
        onToggleLocale={() => setGuestLocale((l) => (l === 'id' ? 'en' : 'id'))}
        onToggleTheme={() => setGuestTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onAuthenticated={async (u, isNew) => {
          setAuthNotice(null);
          await hydrateAuthed(u);
          setShowOnboarding(isNew);
        }}
      />
    );
  }

  if (showOnboarding) {
    return (
      <OnboardingConnectView
        locale={user.locale}
        onComplete={async () => {
          await loadKeysAndModels(true);
          setShowOnboarding(false);
        }}
        onSkip={() => setShowOnboarding(false)}
        onLogout={handleLogout}
      />
    );
  }

  if (activeProjectId) {
    return (
      <>
        <Suspense
          fallback={
            <div className="h-dvh w-full bg-[var(--bg)] flex flex-col">
              <div className="h-11 border-b border-[var(--border)] bg-[var(--surface)] px-4 flex items-center gap-3 animate-pulse">
                <div className="h-4 w-36 rounded bg-[var(--surface-2)]" />
                <div className="h-4 w-20 rounded bg-[var(--surface-2)]" />
              </div>
              <div className="flex-1 flex min-h-0">
                <div className="hidden sm:block w-[30%] border-r border-[var(--border)] bg-[var(--surface)] p-4 space-y-3 animate-pulse">
                  <div className="h-16 rounded bg-[var(--surface-2)]" />
                  <div className="h-24 rounded bg-[var(--surface-2)]" />
                </div>
                <div className="flex-1 bg-[var(--bg)] p-4 sm:p-6 animate-pulse">
                  <div className="h-full rounded-[8px] border border-[var(--border)] bg-[var(--surface)]" />
                </div>
              </div>
            </div>
          }
        >
          <WorkspaceView
            key={activeProjectId}
            projectId={activeProjectId}
            locale={user.locale}
            theme={user.theme}
            models={models}
            selectedModelKey={selectedModelKey}
            onSelectModelKey={setSelectedModelKey}
            initialPromptToRun={pendingPrompt}
            onConsumedInitialPrompt={() => setPendingPrompt(null)}
            onTrackBuild={handleTrackBuild}
            onBack={() => {
              setActiveProjectId(null);
              void loadProjects();
              void loadActivity();
            }}
            onOpenSettings={() => {
              setActiveProjectId(null);
              setRoute('settings');
            }}
          />
        </Suspense>
        {toastPortal}
      </>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--bg)] text-[var(--text)]">
      <AppHeader
        user={user}
        route={route}
        onNavigate={(next) => setRoute(next)}
        onToggleTheme={() => void handleUpdateProfile({ theme: user.theme === 'dark' ? 'light' : 'dark' })}
        onToggleLocale={() => void handleUpdateProfile({ locale: user.locale === 'id' ? 'en' : 'id' })}
        onLogout={() => void handleLogout()}
      />

      {route === 'home' && (
        <HomeView
          locale={user.locale}
          keys={keys}
          models={models}
          projects={projects}
          projectsLoading={projectsLoading}
          recentActivity={recentActivity}
          activityLog={activityLog}
          activityLoading={activityLoading}
          templates={templates}
          selectedModelKey={selectedModelKey}
          onSelectModelKey={setSelectedModelKey}
          onStartFromPrompt={async ({ prompt, type, imageBase64, imageMimeType }) => {
            const created = await api.createProject({ type, initialPrompt: prompt });
            await Promise.all([loadProjects(), loadActivity()]);
            setPendingPrompt({ prompt, imageBase64, imageMimeType });
            setActiveProjectId(created.project.id);
          }}
          onCreateFromTemplate={async (templateId) => {
            const created = await api.createProject({ templateId });
            await Promise.all([loadProjects(), loadActivity()]);
            setActiveProjectId(created.project.id);
          }}
          onOpenProject={(id) => setActiveProjectId(id)}
          onOpenProjects={() => setRoute('projects')}
          onOpenSettings={() => setRoute('settings')}
        />
      )}

      {route === 'projects' && (
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center p-6 text-[13px] text-[var(--text-muted)]">
              {COPY[user.locale].loadingApp}
            </div>
          }
        >
          <ProjectsView
            locale={user.locale}
            projects={projects}
            loading={projectsLoading}
            onRefresh={async () => {
              await Promise.all([loadProjects(), loadActivity()]);
            }}
            onOpenProject={(id) => setActiveProjectId(id)}
          />
        </Suspense>
      )}

      {route === 'settings' && (
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center p-6 text-[13px] text-[var(--text-muted)]">
              {COPY[user.locale].loadingApp}
            </div>
          }
        >
          <SettingsView
            user={user}
            keys={keys}
            masterKeyConfigured={masterKeyConfigured}
            models={models}
            modelWarnings={modelWarnings}
            accentColor={accentColor}
            onSelectAccentColor={setAccentColor}
            onRefreshKeysAndModels={(refresh) => loadKeysAndModels(refresh)}
            onUpdateProfile={handleUpdateProfile}
            onDeleteAccount={handleDeleteAccount}
          />
        </Suspense>
      )}

      {toastPortal}
    </div>
  );
}
