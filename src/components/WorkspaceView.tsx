import {
  Activity,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Circle,
  Code2,
  Database,
  Download,
  Eye,
  FileText,
  History,
  KeyRound,
  Loader2,
  MessageSquare,
  PanelLeft,
  Rocket,
  Smartphone,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useViewportBreakpoints } from '../hooks/useMediaQuery';
import { COPY, formatDateTime } from '../i18n';
import { api, getAuthHeaders, loadLocalOnlyKeys, notifyUnauthorized, type WorkspacePayload } from '../lib/api';
import type {
  AgentPlanSummary,
  ApkBuildRecord,
  FallbackEvent,
  Locale,
  PreviewHealthReport,
  ProviderModel,
  SandboxIsolationStatus,
  SkillMetadataItem,
  SkillPermission,
  SkillTurnTraceItem,
  ThemeMode,
  ToolActionEvent,
} from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { ActivityPane } from './workspace/ActivityPane';
import { ChatPanel } from './workspace/ChatPanel';
import { DatabasePane } from './workspace/DatabasePane';
import { DeployModal } from './workspace/DeployModal';
import { PreviewPane } from './workspace/PreviewPane';
import { TerminalPane } from './workspace/TerminalPane';
import { ApkBuildModal, DiffModal, EnvVarsModal, ProjectRulesModal } from './workspace/WorkspaceModals';

const CodePane = lazy(() =>
  import('./workspace/CodePane').then((m) => ({ default: m.CodePane }))
);

interface WorkspaceViewProps {
  projectId: string;
  locale: Locale;
  theme: ThemeMode;
  models: ProviderModel[];
  selectedModelKey: string;
  onSelectModelKey: (k: string) => void;
  initialPromptToRun?: { prompt: string; imageBase64?: string; imageMimeType?: string } | null;
  onConsumedInitialPrompt?: () => void;
  onTrackBuild?: (build: ApkBuildRecord, projectName?: string) => void;
  onBack: () => void;
  onOpenSettings: () => void;
}

type MainTab = 'preview' | 'code' | 'terminal' | 'database' | 'activity';
type MobileTab = 'chat' | 'preview' | 'code' | 'database' | 'activity';

export function WorkspaceView({
  projectId,
  locale,
  theme,
  models,
  selectedModelKey,
  onSelectModelKey,
  initialPromptToRun,
  onConsumedInitialPrompt,
  onTrackBuild,
  onBack,
  onOpenSettings,
}: WorkspaceViewProps) {
  const t = COPY[locale];
  const { isMobile } = useViewportBreakpoints();

  const [data, setData] = useState<WorkspacePayload | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxIsolationStatus | null>(null);
  const [previewHealth, setPreviewHealth] = useState<PreviewHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<MainTab>('preview');
  const [mobileTab, setMobileTab] = useState<MobileTab>('preview');
  const [mobileCodeSubtab, setMobileCodeSubtab] = useState<'code' | 'terminal'>('code');
  const [codeMounted, setCodeMounted] = useState(false);

  const [tabletChatOpen, setTabletChatOpen] = useState(false);
  const [desktopChatOpen, setDesktopChatOpen] = useState(true);
  const [chatWidthPct, setChatWidthPct] = useState(30);
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false);
  const draggingRef = useRef(false);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const renameSubmittingRef = useRef(false);

  const [versionsOpen, setVersionsOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const versionsMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  const [pendingRestoreVersionId, setPendingRestoreVersionId] = useState<string | null>(null);
  const [restoringVersion, setRestoringVersion] = useState(false);
  const [restoreVersionError, setRestoreVersionError] = useState<string | null>(null);

  const [hasUnsavedFiles, setHasUnsavedFiles] = useState(false);
  const [confirmExitOpen, setConfirmExitOpen] = useState(false);

  const [modal, setModal] = useState<'none' | 'apk' | 'env' | 'rules' | 'deploy'>('none');
  const [diffVersionId, setDiffVersionId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(1);

  // Streaming chat state
  const [chatInput, setChatInput] = useState('');
  const [mode, setMode] = useState<'build' | 'discuss'>('build');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingActions, setStreamingActions] = useState<ToolActionEvent[]>([]);
  const [streamingPlan, setStreamingPlan] = useState<AgentPlanSummary | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<FallbackEvent | null>(null);
  const [streamWarning, setStreamWarning] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<{
    prompt: string;
    imageBase64?: string;
    imageMimeType?: string;
  } | null>(null);
  const [availableSkills, setAvailableSkills] = useState<SkillMetadataItem[]>([]);
  const [skillModeOption, setSkillModeOption] = useState<'auto' | 'manual' | 'builtin'>('auto');
  const [streamingSkillTrace, setStreamingSkillTrace] = useState<SkillTurnTraceItem[]>([]);
  const [lastTurnSkillTrace, setLastTurnSkillTrace] = useState<SkillTurnTraceItem[]>([]);
  const [builtinOnlyTurnNotice, setBuiltinOnlyTurnNotice] = useState(false);

  const autoRanRef = useRef(false);
  const chatAbortRef = useRef<AbortController | null>(null);
  const userStoppedRef = useRef(false);
  const previewTokenIssuedAtRef = useRef<number>(0);
  const fileSyncTimerRef = useRef<number | null>(null);
  const previewReloadTimerRef = useRef<number | null>(null);

  const isCodeTabActive = isMobile
    ? mobileTab === 'code' && mobileCodeSubtab === 'code'
    : activeTab === 'code';
  const isCodeRendered = codeMounted || isCodeTabActive;

  useEffect(() => {
    if (!isCodeTabActive || codeMounted) return;
    const frame = requestAnimationFrame(() => setCodeMounted(true));
    return () => cancelAnimationFrame(frame);
  }, [isCodeTabActive, codeMounted]);

  // Dynamic workspace page title
  useEffect(() => {
    if (data?.project?.name) {
      document.title = `${data.project.name} — CARMEN`;
    }
  }, [data?.project?.name]);

  // Warn browser tab close/reload if Monaco has unsaved drafts
  useEffect(() => {
    if (!hasUnsavedFiles) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedFiles]);

  const loadWorkspace = useCallback(async () => {
    try {
      const ws = await api.getWorkspace(projectId);
      setData(ws);
      setNameDraft(ws.project.name);
      previewTokenIssuedAtRef.current = Date.now();
      setLoadError(null);
      if (onTrackBuild) {
        for (const b of ws.builds) {
          if (b.status === 'queued' || b.status === 'running') {
            onTrackBuild(b, ws.project.name);
          }
        }
      }
      api
        .getPreviewHealth(projectId)
        .then((res) => setPreviewHealth(res.health))
        .catch(() => {});
      api
        .listSkills({ projectId, includeDisabled: false })
        .then((res) => setAvailableSkills(res.skills))
        .catch(() => {});
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t.workspaceLoadFail);
    } finally {
      setLoading(false);
    }
  }, [projectId, t.workspaceLoadFail, onTrackBuild]);

  const refreshPreviewTokenIfNeeded = useCallback(async (force = false) => {
    if (!force && Date.now() - previewTokenIssuedAtRef.current <= 55 * 60_000) return;
    try {
      const tok = await api.getPreviewToken(projectId);
      previewTokenIssuedAtRef.current = Date.now();
      setData((prev) =>
        prev
          ? {
              ...prev,
              previewToken: tok.token,
              previewOrigin: tok.previewOrigin,
            }
          : prev
      );
    } catch {
      // Non-fatal; existing reload proceeds or session handler handles 401
    }
  }, [projectId]);

  const handleRefreshPreview = useCallback(
    async (forceToken = false) => {
      await refreshPreviewTokenIfNeeded(forceToken);
      api
        .getPreviewHealth(projectId)
        .then((res) => setPreviewHealth(res.health))
        .catch(() => {});
      setReloadKey((k) => k + 1);
    },
    [projectId, refreshPreviewTokenIfNeeded]
  );

  const handleTokenExpired = useCallback(async () => {
    await refreshPreviewTokenIfNeeded(true);
    setReloadKey((k) => k + 1);
  }, [refreshPreviewTokenIfNeeded]);

  const handlePreviewStatusChange = useCallback(
    (status: 'ready' | 'error', errorMessage?: string) => {
      if (status === 'error' && errorMessage) {
        setPreviewHealth((prev) =>
          prev
            ? { ...prev, healthy: false, status: 'error', lastError: errorMessage }
            : {
                healthy: false,
                status: 'error',
                hasIndexHtml: true,
                isStarterTemplate: false,
                schemaSynced: true,
                tableCount: 0,
                lastError: errorMessage,
                checkedAt: new Date().toISOString(),
              }
        );
      } else if (status === 'ready') {
        api
          .getPreviewHealth(projectId)
          .then((res) => setPreviewHealth(res.health))
          .catch(() => {});
      }
    },
    [projectId]
  );

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      void loadWorkspace();
      api
        .getSandboxStatus()
        .then((res) => {
          if (!cancelled) setSandboxStatus(res.sandbox);
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [loadWorkspace]);

  // Periodic background preview token renewal (every 10 minutes checks 55 min threshold)
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshPreviewTokenIfNeeded();
    }, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [refreshPreviewTokenIfNeeded]);

  const isInstallingDeps = Boolean(
    previewHealth?.installingDependencies || previewHealth?.status === 'installing'
  );
  const wasInstallingDepsRef = useRef(false);

  // Poll preview health every 1.5s while automatic dependency installation is running, then reload preview
  useEffect(() => {
    if (!isInstallingDeps) {
      if (wasInstallingDepsRef.current) {
        wasInstallingDepsRef.current = false;
        void handleRefreshPreview();
      }
      return;
    }
    wasInstallingDepsRef.current = true;
    const timer = window.setInterval(() => {
      api
        .getPreviewHealth(projectId)
        .then((res) => setPreviewHealth(res.health))
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [isInstallingDeps, projectId, handleRefreshPreview]);

  // Close topbar dropdown menus on outside click or Escape
  useEffect(() => {
    if (!versionsOpen && !projectMenuOpen) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (versionsOpen && versionsMenuRef.current && !versionsMenuRef.current.contains(target)) {
        setVersionsOpen(false);
      }
      if (projectMenuOpen && projectMenuRef.current && !projectMenuRef.current.contains(target)) {
        setProjectMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setVersionsOpen(false);
        setProjectMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [versionsOpen, projectMenuOpen]);

  // Workspace keyboard shortcuts: Ctrl/Cmd+1..4 switch tabs, Ctrl/Cmd+B toggles chat panel
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const targetEl = e.target as HTMLElement | null;
      const inEditable =
        targetEl &&
        (targetEl.tagName === 'INPUT' || targetEl.tagName === 'TEXTAREA' || targetEl.isContentEditable);
      if (e.key === '1' && !inEditable) {
        e.preventDefault();
        setActiveTab('preview');
      } else if (e.key === '2' && !inEditable) {
        e.preventDefault();
        setActiveTab('code');
      } else if (e.key === '3' && !inEditable) {
        e.preventDefault();
        setActiveTab('terminal');
      } else if (e.key === '4' && !inEditable) {
        e.preventDefault();
        setActiveTab('database');
      } else if (e.key === '5' && !inEditable) {
        e.preventDefault();
        setActiveTab('activity');
      } else if (e.key.toLowerCase() === 'b' && !inEditable) {
        e.preventDefault();
        setTabletChatOpen((o) => !o);
        setDesktopChatOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Resizable desktop divider pointer drag
  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      if (!draggingRef.current) return;
      const pct = (e.clientX / window.innerWidth) * 100;
      setChatWidthPct(Math.max(22, Math.min(48, pct)));
    }
    function onPointerUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setIsDraggingSplitter(false);
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);

  const clearDebounceTimers = useCallback(() => {
    if (fileSyncTimerRef.current !== null) {
      window.clearTimeout(fileSyncTimerRef.current);
      fileSyncTimerRef.current = null;
    }
    if (previewReloadTimerRef.current !== null) {
      window.clearTimeout(previewReloadTimerRef.current);
      previewReloadTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      chatAbortRef.current?.abort();
      clearDebounceTimers();
    };
  }, [clearDebounceTimers]);

  const handleSendPrompt = useCallback(
    async (promptText: string, img?: { base64?: string; mimeType?: string }) => {
      const activeModel =
        models.find((m) => `${m.providerKeyId}::${m.id}` === selectedModelKey) ?? models[0] ?? null;

      if (!activeModel) {
        setStreamError(
          locale === 'id'
            ? 'Belum ada provider/model yang aktif. Tambahkan API key di Pengaturan > Provider.'
            : 'No active provider/model. Add an API key in Settings > Providers.'
        );
        return;
      }

      setLastPrompt({ prompt: promptText, imageBase64: img?.base64, imageMimeType: img?.mimeType });
      setStreaming(true);
      setStreamingText('');
      setStreamingActions([]);
      setStreamingPlan(null);
      setFallbackNotice(null);
      setStreamWarning(null);
      setStreamError(null);
      setStreamingSkillTrace([]);
      setLastTurnSkillTrace([]);
      setBuiltinOnlyTurnNotice(false);

      // Optimistically append user message
      setData((prev) =>
        prev
          ? {
              ...prev,
              messages: [
                ...prev.messages,
                {
                  id: `temp_${Date.now()}`,
                  projectId,
                  role: 'user',
                  content: promptText,
                  mode,
                  toolEvents: [],
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : prev
      );

      chatAbortRef.current?.abort();
      clearDebounceTimers();
      const abortController = new AbortController();
      chatAbortRef.current = abortController;
      userStoppedRef.current = false;

      let timedOut = false;
      let idleTimeoutId: number | null = null;
      let pendingFilesMutated = false;

      const resetIdleTimeout = () => {
        if (idleTimeoutId !== null) window.clearTimeout(idleTimeoutId);
        idleTimeoutId = window.setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, 120_000);
      };

      const scheduleFilesSync = () => {
        if (fileSyncTimerRef.current !== null) return;
        fileSyncTimerRef.current = window.setTimeout(() => {
          fileSyncTimerRef.current = null;
          void api
            .getWorkspace(projectId)
            .then((ws) => {
              previewTokenIssuedAtRef.current = Date.now();
              setData((prev) => (prev ? { ...prev, files: ws.files } : ws));
            })
            .catch(() => {});
        }, 800);
      };

      const schedulePreviewReload = () => {
        if (previewReloadTimerRef.current !== null) {
          window.clearTimeout(previewReloadTimerRef.current);
        }
        previewReloadTimerRef.current = window.setTimeout(() => {
          previewReloadTimerRef.current = null;
          void handleRefreshPreview();
        }, 1500);
      };

      resetIdleTimeout();

      try {
        const localKey = loadLocalOnlyKeys().find((k) => k.id === activeModel.providerKeyId);
        const res = await fetch(`/api/projects/${projectId}/chat`, {
          method: 'POST',
          credentials: 'include',
          signal: abortController.signal,
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            prompt: promptText,
            mode,
            providerKeyId: activeModel.providerKeyId,
            modelId: activeModel.id,
            imageBase64: img?.base64,
            imageMimeType: img?.mimeType,
            skillMode: skillModeOption === 'manual' ? 'manual' : 'auto',
            disableAllSkills: skillModeOption === 'builtin',
            ...(localKey
              ? {
                  localProviderConfig: {
                    provider: localKey.provider,
                    label: localKey.label,
                    apiKey: localKey.apiKey,
                    tierDeclared: localKey.tierDeclared,
                    baseUrl: localKey.baseUrl,
                    authHeader: localKey.authHeader,
                    chatPath: localKey.chatPath,
                    customModels: localKey.customModels,
                    supportsTools: localKey.supportsTools,
                    supportsVision: localKey.supportsVision,
                  },
                }
              : {}),
          }),
        });

        resetIdleTimeout();

        if (!res.ok || !res.body) {
          const errText = await res.text();
          let msg = errText;
          try {
            msg = JSON.parse(errText).error || msg;
          } catch {
            // Keep raw text
          }
          if (res.status === 401) {
            notifyUnauthorized(msg || t.sessionMissing);
          }
          setStreamError(
            msg || (locale === 'id' ? 'Permintaan AI gagal.' : 'AI request failed.')
          );
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          resetIdleTimeout();

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            const line = rawLine.trimEnd();
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              const payloadStr = line.slice(5).trim();
              if (!payloadStr) continue;
              try {
                const payload = JSON.parse(payloadStr);
                if (currentEvent === 'text_delta' && payload.text) {
                  setStreamingText((prev) => prev + payload.text);
                } else if (currentEvent === 'plan' && payload.steps) {
                  setStreamingPlan(payload as AgentPlanSummary);
                } else if (currentEvent === 'fallback' && payload.toModel) {
                  setStreamingText('');
                  setFallbackNotice(payload as FallbackEvent);
                } else if (currentEvent === 'tool_event') {
                  const act = payload as ToolActionEvent;
                  setStreamingActions((prev) => {
                    const idx = prev.findIndex((x) => x.id === act.id);
                    if (idx >= 0) {
                      const next = [...prev];
                      next[idx] = act;
                      return next;
                    }
                    return [...prev, act];
                  });
                  if ((act.tool === 'write_file' || act.tool === 'edit_file') && act.status === 'success') {
                    pendingFilesMutated = true;
                    scheduleFilesSync();
                    schedulePreviewReload();
                  }
                } else if (currentEvent === 'skill_discovery') {
                  if (payload.disabled || payload.selectedCount === 0) {
                    setBuiltinOnlyTurnNotice(true);
                  }
                } else if (currentEvent === 'skill_selected' && payload.skillName) {
                  const nextItem: SkillTurnTraceItem = {
                    skillName: String(payload.skillName),
                    reason: String(payload.reason || ''),
                    confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined,
                    explicit: Boolean(payload.explicit),
                    status: 'running',
                  };
                  setStreamingSkillTrace((prev) => {
                    const exists = prev.some((x) => x.skillName === nextItem.skillName);
                    return exists
                      ? prev.map((x) => (x.skillName === nextItem.skillName ? nextItem : x))
                      : [...prev, nextItem];
                  });
                } else if (currentEvent === 'skill_permission_required' && payload.skillName) {
                  const deniedItem: SkillTurnTraceItem = {
                    skillName: String(payload.skillName),
                    reason: String(payload.reason || ''),
                    status: 'denied',
                    missingPermissions: Array.isArray(payload.missingPermissions)
                      ? (payload.missingPermissions as SkillPermission[])
                      : [],
                  };
                  setStreamingSkillTrace((prev) => {
                    const exists = prev.some((x) => x.skillName === deniedItem.skillName);
                    return exists
                      ? prev.map((x) => (x.skillName === deniedItem.skillName ? deniedItem : x))
                      : [...prev, deniedItem];
                  });
                } else if (currentEvent === 'skill_execution' && payload.skillName) {
                  const status: SkillTurnTraceItem['status'] =
                    payload.status === 'success'
                      ? 'success'
                      : payload.status === 'denied'
                        ? 'denied'
                        : payload.status === 'fallback' || payload.fallbackUsed
                          ? 'fallback'
                          : 'running';
                  const execItem: SkillTurnTraceItem = {
                    skillName: String(payload.skillName),
                    reason: String(payload.reason || ''),
                    status,
                    fallbackUsed: Boolean(payload.fallbackUsed),
                  };
                  setStreamingSkillTrace((prev) => {
                    const exists = prev.some((x) => x.skillName === execItem.skillName);
                    return exists
                      ? prev.map((x) => (x.skillName === execItem.skillName ? { ...x, ...execItem } : x))
                      : [...prev, execItem];
                  });
                  setLastTurnSkillTrace((prev) => {
                    const exists = prev.some((x) => x.skillName === execItem.skillName);
                    return exists
                      ? prev.map((x) => (x.skillName === execItem.skillName ? { ...x, ...execItem } : x))
                      : [...prev, execItem];
                  });
                } else if (currentEvent === 'status' && payload.warning) {
                  setStreamWarning(payload.warning);
                } else if (currentEvent === 'error' && payload.message) {
                  setStreamError(payload.message);
                } else if (currentEvent === 'done') {
                  if (payload.filesMutated) {
                    pendingFilesMutated = true;
                  }
                }
              } catch {
                // Ignore incomplete SSE chunks
              }
            }
          }
        }
      } catch (err) {
        if (timedOut) {
          setStreamError(
            locale === 'id'
              ? 'Tidak ada respons dari model AI selama 120 detik. Coba lagi atau ganti model.'
              : 'No response from AI model for 120 seconds. Try again or switch models.'
          );
        } else if (userStoppedRef.current || (err instanceof DOMException && err.name === 'AbortError')) {
          // User explicitly clicked Stop
        } else {
          setStreamError(
            err instanceof Error
              ? err.message
              : locale === 'id'
                ? 'Koneksi terputus saat streaming.'
                : 'Connection dropped while streaming.'
          );
        }
      } finally {
        if (idleTimeoutId !== null) window.clearTimeout(idleTimeoutId);
        clearDebounceTimers();
        if (chatAbortRef.current === abortController) {
          chatAbortRef.current = null;
        }
        await loadWorkspace();
        if (pendingFilesMutated) {
          void handleRefreshPreview();
        }
        setStreaming(false);
        setStreamingText('');
        setStreamingActions([]);
        setStreamingPlan(null);
        setFallbackNotice(null);
      }
    },
    [models, selectedModelKey, projectId, mode, skillModeOption, locale, t.sessionMissing, clearDebounceTimers, handleRefreshPreview, loadWorkspace]
  );

  const handleStopStream = useCallback(() => {
    userStoppedRef.current = true;
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    setStreaming(false);
    void api.stopChat(projectId).catch(() => {});
  }, [projectId]);

  // Auto-run prompt if navigated directly from Home prompt box
  useEffect(() => {
    if (!loading && data && initialPromptToRun && !autoRanRef.current) {
      autoRanRef.current = true;
      onConsumedInitialPrompt?.();
      void handleSendPrompt(initialPromptToRun.prompt, {
        base64: initialPromptToRun.imageBase64,
        mimeType: initialPromptToRun.imageMimeType,
      });
    }
  }, [loading, data, initialPromptToRun, onConsumedInitialPrompt, handleSendPrompt]);

  async function handleRenameSave() {
    if (renameSubmittingRef.current) return;
    renameSubmittingRef.current = true;
    const trimmed = nameDraft.trim();
    setEditingName(false);
    try {
      if (!data || !trimmed || trimmed === data.project.name) {
        if (data) setNameDraft(data.project.name);
        return;
      }
      setActionError(null);
      await api.updateProject(projectId, { name: trimmed });
      await loadWorkspace();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t.renameWorkspaceFail);
      if (data) setNameDraft(data.project.name);
    } finally {
      renameSubmittingRef.current = false;
    }
  }

  async function confirmRestoreVersion() {
    if (!pendingRestoreVersionId || restoringVersion) return;
    setRestoringVersion(true);
    setRestoreVersionError(null);
    try {
      await api.restoreVersion(projectId, pendingRestoreVersionId);
      setPendingRestoreVersionId(null);
      setVersionsOpen(false);
      await loadWorkspace();
      await handleRefreshPreview();
    } catch (err) {
      setRestoreVersionError(err instanceof Error ? err.message : t.restoreVersionFail);
    } finally {
      setRestoringVersion(false);
    }
  }

  async function handleExportZip() {
    setProjectMenuOpen(false);
    setActionError(null);
    try {
      await api.downloadProjectZip(projectId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t.exportZipFail);
    }
  }

  function handleBackClick() {
    if (hasUnsavedFiles) {
      setConfirmExitOpen(true);
    } else {
      onBack();
    }
  }

  if (loading) {
    return (
      <div className="h-dvh w-full bg-[var(--bg)] flex flex-col">
        <div className="h-11 border-b border-[var(--border)] bg-[var(--surface)] px-4 flex items-center gap-3 animate-pulse">
          <div className="h-4 w-36 rounded bg-[var(--surface-2)]" />
          <div className="h-4 w-20 rounded bg-[var(--surface-2)]" />
        </div>
        <div className="flex-1 flex min-h-0">
          {!isMobile && (
            <div className="w-[30%] border-r border-[var(--border)] bg-[var(--surface)] p-4 space-y-3 animate-pulse">
              <div className="h-16 rounded bg-[var(--surface-2)]" />
              <div className="h-24 rounded bg-[var(--surface-2)]" />
            </div>
          )}
          <div className="flex-1 bg-[var(--bg)] p-4 sm:p-6 animate-pulse">
            <div className="h-full rounded-[8px] border border-[var(--border)] bg-[var(--surface)]" />
          </div>
        </div>
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="h-dvh bg-[var(--bg)] flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div role="alert" className="text-[14px] font-semibold text-[var(--error-text)] flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.6} />
            <span>{loadError || t.projectNotFound}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void loadWorkspace();
              }}
              className="h-8 px-3 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium cursor-pointer"
            >
              {t.retry}
            </button>
            <button
              type="button"
              onClick={onBack}
              className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] text-[var(--text)] cursor-pointer"
            >
              {t.backToProjects}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const indexFile = data.files.find((f) => f.path === 'index.html');
  const isEmptyApp = previewHealth
    ? previewHealth.isStarterTemplate || !previewHealth.hasIndexHtml
    : !indexFile || indexFile.content.includes('<!-- carmen:blank-starter -->');
  const effectiveStatus: 'error' | 'empty' | 'installing' | 'running' =
    isInstallingDeps
      ? 'installing'
      : data.runtimeStatus === 'error' || previewHealth?.status === 'error'
        ? 'error'
        : isEmptyApp
          ? 'empty'
          : 'running';
  const runtimeLabel =
    effectiveStatus === 'installing'
      ? t.runtimeInstalling
      : effectiveStatus === 'error'
        ? t.runtimeError
        : effectiveStatus === 'empty'
          ? t.runtimeReadyToBuild
          : t.runtimeRunning;

  const pendingVersion = data.versions.find((v) => v.id === pendingRestoreVersionId);

  const chatPanelElement = (
    <ChatPanel
      locale={locale}
      messages={data.messages}
      streaming={streaming}
      streamingText={streamingText}
      streamingActions={streamingActions}
      streamingPlan={streamingPlan}
      fallbackNotice={fallbackNotice}
      streamWarning={streamWarning}
      streamError={streamError}
      mode={mode}
      onModeChange={setMode}
      models={models}
      selectedModelKey={selectedModelKey}
      onSelectModelKey={onSelectModelKey}
      inputValue={chatInput}
      onInputChange={setChatInput}
      canRetry={Boolean(lastPrompt)}
      onRetry={() =>
        lastPrompt &&
        void handleSendPrompt(lastPrompt.prompt, {
          base64: lastPrompt.imageBase64,
          mimeType: lastPrompt.imageMimeType,
        })
      }
      onSend={(p) => void handleSendPrompt(p)}
      onStop={handleStopStream}
      onRestoreVersion={(vid) => {
        setRestoreVersionError(null);
        setPendingRestoreVersionId(vid);
      }}
      onOpenDiff={(vid) => setDiffVersionId(vid)}
      onOpenSettings={onOpenSettings}
      availableSkills={availableSkills}
      skillModeOption={skillModeOption}
      onSkillModeOptionChange={setSkillModeOption}
      streamingSkillTrace={streamingSkillTrace}
      lastTurnSkillTrace={lastTurnSkillTrace}
      builtinOnlyTurnNotice={builtinOnlyTurnNotice}
    />
  );

  const previewPaneElement = (
    <PreviewPane
      projectId={projectId}
      projectType={data.project.type}
      locale={locale}
      reloadKey={reloadKey}
      previewToken={data.previewToken}
      previewOrigin={data.previewOrigin}
      runtimeError={previewHealth?.lastError ?? data.runtimeError}
      isEmptyApp={isEmptyApp}
      isAiWorking={streaming}
      installingDependencies={isInstallingDeps}
      installPackageManager={previewHealth?.installPackageManager}
      missingPackages={previewHealth?.missingPackages}
      lifecycleState={previewHealth?.lifecycleState}
      onRefresh={() => void handleRefreshPreview()}
      onTokenExpired={handleTokenExpired}
      onPreviewStatusChange={handlePreviewStatusChange}
      onFixWithAi={(err) => {
        if (isMobile) setMobileTab('chat');
        void handleSendPrompt(`${t.fixWithAiPromptPrefix}${err}`);
      }}
    />
  );

  const codePaneElement = isCodeRendered ? (
    <Suspense
      fallback={
        <div className="h-full w-full flex items-center justify-center text-[13px] text-[var(--text-muted)]">
          {t.editorLoading}
        </div>
      }
    >
      <CodePane
        locale={locale}
        theme={theme}
        files={data.files}
        onSaveFile={async (filePath, content) => {
          await api.saveFile(projectId, filePath, content);
          await loadWorkspace();
          await handleRefreshPreview();
        }}
        onDeleteFile={async (filePath) => {
          await api.deleteFile(projectId, filePath);
          await loadWorkspace();
        }}
        onDirtyChange={setHasUnsavedFiles}
        onOpenMobileTerminal={isMobile ? () => setMobileCodeSubtab('terminal') : undefined}
      />
    </Suspense>
  ) : null;

  const terminalPaneElement = (
    <TerminalPane
      locale={locale}
      logs={data.logs}
      sandboxStatus={sandboxStatus}
      onRunCommand={async (cmd) => {
        const res = await api.runTerminalCommand(projectId, cmd);
        setData((prev) => (prev ? { ...prev, logs: res.logs } : prev));
        return { ok: res.ok, exitCode: res.exitCode };
      }}
      onStopProcess={async () => {
        const res = await api.stopTerminalProcess(projectId);
        setData((prev) => (prev ? { ...prev, logs: res.logs } : prev));
      }}
    />
  );

  return (
    <div className="h-dvh w-full flex flex-col bg-[var(--bg)] text-[var(--text)] overflow-hidden">
      {/* WORKSPACE TOP BAR */}
      <header className="min-h-11 pt-safe px-2 sm:px-3 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-1.5 sm:gap-3 shrink-0">
        <div className="flex items-center gap-1 sm:gap-2 min-w-0">
          <button
            type="button"
            onClick={handleBackClick}
            aria-label={t.backToProjectsAria}
            className="h-8 w-8 sm:h-7 sm:w-7 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] flex items-center justify-center shrink-0 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" strokeWidth={1.5} />
          </button>

          {!isMobile && (
            <button
              type="button"
              onClick={() => {
                setTabletChatOpen((o) => !o);
                setDesktopChatOpen((o) => !o);
              }}
              title={t.toggleChatAria}
              aria-label={t.toggleChatAria}
              className="h-7 w-7 rounded-[6px] border border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center justify-center shrink-0 cursor-pointer"
            >
              <PanelLeft className="w-4 h-4" strokeWidth={1.5} />
            </button>
          )}

          {editingName ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleRenameSave();
              }}
            >
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    renameSubmittingRef.current = true;
                    setNameDraft(data.project.name);
                    setEditingName(false);
                    window.setTimeout(() => {
                      renameSubmittingRef.current = false;
                    }, 0);
                  }
                }}
                onBlur={() => {
                  if (!renameSubmittingRef.current) {
                    void handleRenameSave();
                  }
                }}
                aria-label={t.editProjectNameAria}
                className="h-7 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2 text-[13px] font-medium text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              />
            </form>
          ) : (
            <button
              type="button"
              onClick={() => {
                setNameDraft(data.project.name);
                setEditingName(true);
              }}
              title={t.clickToRenameProject}
              className="text-[13px] font-semibold text-[var(--text)] hover:underline truncate max-w-[84px] min-[360px]:max-w-[116px] min-[412px]:max-w-[148px] sm:max-w-[240px] cursor-pointer"
            >
              {data.project.name}
            </button>
          )}

          {/* Version History Dropdown (accessible on mobile + desktop) */}
          <div className="relative shrink-0" ref={versionsMenuRef}>
            <button
              type="button"
              onClick={() => {
                setProjectMenuOpen(false);
                setVersionsOpen((o) => !o);
              }}
              aria-expanded={versionsOpen}
              aria-haspopup="menu"
              aria-label={t.versionsButtonAria}
              className="h-8 sm:h-7 px-1.5 sm:px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1 whitespace-nowrap cursor-pointer"
            >
              <History className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span className="font-mono tabular-nums">v{data.versions.length}</span>
              <ChevronDown className="w-3 h-3 hidden min-[375px]:inline" strokeWidth={1.5} />
            </button>

            {versionsOpen && (
              <div
                role="menu"
                aria-label={t.versions}
                className="absolute left-0 top-9 z-40 w-[min(300px,calc(100vw-24px))] rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-1.5 space-y-0.5"
                style={{ boxShadow: 'var(--shadow-float)' }}
              >
                <div className="px-2 py-1 text-[12px] font-medium text-[var(--text-muted)]">{t.versions}</div>
                <div className="max-h-60 overflow-y-auto">
                  {data.versions.map((ver) => (
                    <div
                      key={ver.id}
                      className="px-2 py-1.5 rounded-[6px] hover:bg-[var(--surface-2)] flex items-center justify-between gap-2 text-[12px]"
                    >
                      <div className="min-w-0">
                        <div className="text-[var(--text)] truncate">{ver.label}</div>
                        <div className="text-[12px] font-mono text-[var(--text-muted)] tabular-nums">
                          {formatDateTime(ver.createdAt, locale)} · {ver.fileCount} file
                        </div>
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setVersionsOpen(false);
                          setRestoreVersionError(null);
                          setPendingRestoreVersionId(ver.id);
                        }}
                        className="h-7 px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] text-[12px] text-[var(--text)] shrink-0 cursor-pointer"
                      >
                        {t.restoreConfirmButton}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Runtime status indicator */}
          <div className="hidden md:flex items-center gap-1.5 text-[12px] pl-1 shrink-0">
            {effectiveStatus === 'installing' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent-text)]" strokeWidth={1.5} />
            ) : effectiveStatus === 'error' ? (
              <AlertCircle className="w-3.5 h-3.5 text-[var(--error-text)]" strokeWidth={1.5} />
            ) : effectiveStatus === 'empty' ? (
              <Circle className="w-3.5 h-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success-text)]" strokeWidth={1.5} />
            )}
            <span className={effectiveStatus === 'error' ? 'text-[var(--error-text)]' : 'text-[var(--text-muted)]'}>
              {runtimeLabel}
            </span>
          </div>
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <div className="relative" ref={projectMenuRef}>
            <button
              type="button"
              onClick={() => {
                setVersionsOpen(false);
                setProjectMenuOpen((o) => !o);
              }}
              aria-expanded={projectMenuOpen}
              aria-haspopup="menu"
              className="h-8 sm:h-7 px-2 sm:px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[12px] font-medium text-[var(--text)] flex items-center gap-1 whitespace-nowrap cursor-pointer"
            >
              <span>{t.projectMenu}</span>
              <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
            </button>

            {projectMenuOpen && (
              <div
                role="menu"
                aria-label={t.projectMenu}
                className="absolute right-0 top-9 z-40 w-[220px] rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-1 space-y-0.5 text-[12px]"
                style={{ boxShadow: 'var(--shadow-float)' }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleExportZip()}
                  className="w-full px-2.5 h-8 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--text)] flex items-center gap-2 text-left cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
                  <span>{t.exportZip}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setProjectMenuOpen(false);
                    setModal('env');
                  }}
                  className="w-full px-2.5 h-8 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--text)] flex items-center gap-2 text-left cursor-pointer"
                >
                  <KeyRound className="w-3.5 h-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
                  <span>
                    {t.envVars} ({data.envVars.length})
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setProjectMenuOpen(false);
                    setModal('rules');
                  }}
                  className="w-full px-2.5 h-8 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--text)] flex items-center gap-2 text-left cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
                  <span>{t.projectRules}</span>
                </button>
              </div>
            )}
          </div>

          {data.project.type === 'android' ? (
            <button
              type="button"
              onClick={() => setModal('apk')}
              className="h-8 sm:h-7 px-2 sm:px-3 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium flex items-center gap-1 sm:gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Smartphone className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span className="hidden sm:inline">{t.buildApk}</span>
              <span className="sm:hidden">APK</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setModal('deploy')}
              className="h-8 sm:h-7 px-2 sm:px-3 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium flex items-center gap-1 sm:gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Rocket className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span>{t.deploy}</span>
            </button>
          )}
        </div>
      </header>

      {actionError && (
        <div
          role="alert"
          className="px-3 py-2 border-b border-[var(--error)] bg-[var(--surface-2)] text-[12px] text-[var(--error-text)] flex items-center justify-between gap-2 shrink-0"
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" strokeWidth={1.6} />
            <span className="truncate">{actionError}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label={t.close}
            className="h-7 w-7 rounded-[6px] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" strokeWidth={1.6} />
          </button>
        </div>
      )}

      {/* BODY: render strictly ONE viewport layout (Desktop/Tablet OR Mobile) */}
      {!isMobile ? (
        <div className="flex-1 flex min-h-0 relative overflow-hidden">
          {isDraggingSplitter && (
            <div className="fixed inset-0 z-20 cursor-col-resize select-none" aria-hidden="true" />
          )}

          {desktopChatOpen && (
            <>
              <div
                className="hidden lg:block h-full shrink-0 border-r border-[var(--border)]"
                style={{ width: `${chatWidthPct}%` }}
              >
                {chatPanelElement}
              </div>

              {/* 12px accessible splitter target over 1px visual divider */}
              <div
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label={t.splitterAria}
                aria-valuenow={Math.round(chatWidthPct)}
                aria-valuemin={22}
                aria-valuemax={48}
                onPointerDown={(e) => {
                  e.preventDefault();
                  draggingRef.current = true;
                  setIsDraggingSplitter(true);
                }}
                onDoubleClick={() => setChatWidthPct(30)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    setChatWidthPct((w) => Math.max(22, w - 2));
                  } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    setChatWidthPct((w) => Math.min(48, w + 2));
                  }
                }}
                className="hidden lg:flex items-center justify-center w-3 -ml-1.5 cursor-col-resize group z-10 shrink-0 focus:outline-none focus-visible:bg-[var(--accent)]/20"
              >
                <div className="w-px h-full bg-[var(--border)] group-hover:w-0.5 group-hover:bg-[var(--accent)] transition-colors" />
              </div>
            </>
          )}

          {tabletChatOpen && (
            <div className="lg:hidden absolute inset-y-0 left-0 z-30 w-[340px] max-w-[85vw] border-r border-[var(--border)] bg-[var(--surface)]">
              {chatPanelElement}
            </div>
          )}

          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div
              role="tablist"
              aria-label={t.workspaceTabsAria}
              className="h-9 px-3 border-b border-[var(--border)] bg-[var(--surface)] flex items-center gap-1 shrink-0"
            >
              {(
                [
                  ['preview', Eye, t.preview],
                  ['code', Code2, t.code],
                  ['terminal', TerminalIcon, t.terminal],
                  ['database', Database, t.database],
                  ['activity', Activity, t.activity],
                ] as const
              ).map(([id, Icon, label]) => (
                <button
                  key={id}
                  role="tab"
                  type="button"
                  aria-selected={activeTab === id}
                  onClick={() => setActiveTab(id)}
                  className={`h-7 px-2.5 rounded-[6px] text-[12px] font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                    activeTab === id
                      ? 'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" strokeWidth={1.5} />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            <div className="flex-1 min-h-0 overflow-hidden relative">
              <div className={activeTab === 'preview' ? 'h-full' : 'hidden'} aria-hidden={activeTab !== 'preview'}>
                {previewPaneElement}
              </div>
              {isCodeRendered && (
                <div className={activeTab === 'code' ? 'h-full' : 'hidden'} aria-hidden={activeTab !== 'code'}>
                  {codePaneElement}
                </div>
              )}
              <div className={activeTab === 'terminal' ? 'h-full' : 'hidden'} aria-hidden={activeTab !== 'terminal'}>
                {terminalPaneElement}
              </div>
              <div className={activeTab === 'database' ? 'h-full' : 'hidden'} aria-hidden={activeTab !== 'database'}>
                <DatabasePane projectId={projectId} locale={locale} reloadKey={reloadKey} />
              </div>
              <div className={activeTab === 'activity' ? 'h-full' : 'hidden'} aria-hidden={activeTab !== 'activity'}>
                <ActivityPane
                  locale={locale}
                  project={data.project}
                  files={data.files}
                  versions={data.versions}
                  messages={data.messages}
                  builds={data.builds}
                  deployments={data.deployments ?? []}
                  onOpenDiff={(vid) => setDiffVersionId(vid)}
                  onOpenCodeTab={() => setActiveTab('code')}
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {mobileTab === 'code' && (
            <div
              role="tablist"
              aria-label={t.workspaceTabsAria}
              className="h-9 px-2.5 border-b border-[var(--border)] bg-[var(--surface)] flex items-center gap-1.5 shrink-0"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mobileCodeSubtab === 'code'}
                onClick={() => setMobileCodeSubtab('code')}
                className={`h-7 px-2.5 rounded-[6px] text-[12px] font-medium flex items-center gap-1.5 cursor-pointer ${
                  mobileCodeSubtab === 'code'
                    ? 'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                <Code2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                <span>{t.code}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mobileCodeSubtab === 'terminal'}
                onClick={() => setMobileCodeSubtab('terminal')}
                className={`h-7 px-2.5 rounded-[6px] text-[12px] font-medium flex items-center gap-1.5 cursor-pointer ${
                  mobileCodeSubtab === 'terminal'
                    ? 'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                <TerminalIcon className="w-3.5 h-3.5" strokeWidth={1.5} />
                <span>{t.terminal}</span>
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-hidden relative">
            <div className={mobileTab === 'chat' ? 'h-full' : 'hidden'} aria-hidden={mobileTab !== 'chat'}>
              {chatPanelElement}
            </div>
            <div className={mobileTab === 'preview' ? 'h-full' : 'hidden'} aria-hidden={mobileTab !== 'preview'}>
              {previewPaneElement}
            </div>
            <div
              className={mobileTab === 'code' && mobileCodeSubtab === 'code' ? 'h-full' : 'hidden'}
              aria-hidden={!(mobileTab === 'code' && mobileCodeSubtab === 'code')}
            >
              {isCodeRendered && codePaneElement}
            </div>
            <div
              className={mobileTab === 'code' && mobileCodeSubtab === 'terminal' ? 'h-full' : 'hidden'}
              aria-hidden={!(mobileTab === 'code' && mobileCodeSubtab === 'terminal')}
            >
              {terminalPaneElement}
            </div>
            <div className={mobileTab === 'database' ? 'h-full' : 'hidden'} aria-hidden={mobileTab !== 'database'}>
              <DatabasePane projectId={projectId} locale={locale} reloadKey={reloadKey} />
            </div>
            <div className={mobileTab === 'activity' ? 'h-full' : 'hidden'} aria-hidden={mobileTab !== 'activity'}>
              <ActivityPane
                locale={locale}
                project={data.project}
                files={data.files}
                versions={data.versions}
                messages={data.messages}
                builds={data.builds}
                deployments={data.deployments ?? []}
                onOpenDiff={(vid) => setDiffVersionId(vid)}
                onOpenCodeTab={() => {
                  setMobileTab('code');
                  setMobileCodeSubtab('code');
                }}
              />
            </div>
          </div>

          <nav
            aria-label={t.mobileNavAria}
            className="border-t border-[var(--border)] bg-[var(--surface)] grid grid-cols-5 shrink-0 pb-safe"
          >
            {(
              [
                ['chat', MessageSquare, 'Chat'],
                ['preview', Eye, t.preview],
                ['code', Code2, t.code],
                ['database', Database, 'Data'],
                ['activity', Activity, t.activity],
              ] as const
            ).map(([id, Icon, label]) => {
              const active = mobileTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setMobileTab(id);
                  }}
                  aria-current={active ? 'page' : undefined}
                  className={`min-h-[50px] px-1 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium border-t-2 cursor-pointer transition-colors ${
                    active
                      ? 'border-t-[var(--accent)] text-[var(--accent-text)]'
                      : 'border-t-transparent text-[var(--text-muted)]'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" strokeWidth={active ? 1.85 : 1.5} />
                  <span className="truncate max-w-full">{label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      )}

      {/* MODALS */}
      {modal === 'apk' && (
        <ApkBuildModal
          projectId={projectId}
          initialConfig={data.project.apkConfig}
          existingBuilds={data.builds}
          locale={locale}
          onBuildQueued={(build) => onTrackBuild?.(build, data.project.name)}
          onClose={() => {
            setModal('none');
            void loadWorkspace();
          }}
          onFixWithAi={(err) => {
            if (isMobile) setMobileTab('chat');
            void handleSendPrompt(err);
          }}
        />
      )}

      {modal === 'env' && (
        <EnvVarsModal
          projectId={projectId}
          envVars={data.envVars}
          locale={locale}
          onRefresh={loadWorkspace}
          onClose={() => setModal('none')}
        />
      )}

      {modal === 'rules' && (
        <ProjectRulesModal
          projectId={projectId}
          initialRules={data.project.rules}
          locale={locale}
          onSaved={loadWorkspace}
          onClose={() => setModal('none')}
        />
      )}

      {diffVersionId && (
        <DiffModal
          projectId={projectId}
          versionId={diffVersionId}
          locale={locale}
          onClose={() => setDiffVersionId(null)}
        />
      )}

      {modal === 'deploy' && (
        <DeployModal
          projectId={projectId}
          projectName={data.project.name}
          locale={locale}
          onClose={() => setModal('none')}
        />
      )}

      <ConfirmDialog
        open={Boolean(pendingRestoreVersionId)}
        locale={locale}
        title={t.restoreConfirmTitle}
        description={t.restoreConfirmBody.replace('{label}', pendingVersion?.label || pendingRestoreVersionId || '')}
        confirmLabel={t.restoreConfirmButton}
        busy={restoringVersion}
        error={restoreVersionError}
        onConfirm={() => void confirmRestoreVersion()}
        onClose={() => {
          if (!restoringVersion) {
            setPendingRestoreVersionId(null);
            setRestoreVersionError(null);
          }
        }}
      />

      <ConfirmDialog
        open={confirmExitOpen}
        locale={locale}
        title={t.unsavedExitTitle}
        description={t.unsavedExitBody}
        confirmLabel={t.unsavedExitButton}
        danger
        onConfirm={() => {
          setConfirmExitOpen(false);
          onBack();
        }}
        onClose={() => setConfirmExitOpen(false)}
      />
    </div>
  );
}
