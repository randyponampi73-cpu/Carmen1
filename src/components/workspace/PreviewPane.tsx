import { AlertCircle, ExternalLink, Loader2, Monitor, RefreshCw, ShieldCheck, Smartphone, Tablet, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { COPY } from '../../i18n';
import { api } from '../../lib/api';
import {
  classifyPreviewHttpResponse,
  createPreviewRequestId,
  logPreviewDiagnostic,
  resolvePreviewFetchCredentials,
  scrubClientPreviewMessage,
  type PreviewLifecycleStage,
} from '../../lib/previewState';
import type { Locale } from '../../types';

interface PreviewPaneProps {
  projectId: string;
  locale: Locale;
  reloadKey: number;
  previewToken?: string;
  previewOrigin?: string;
  runtimeError: string | null;
  isEmptyApp?: boolean;
  isAiWorking?: boolean;
  installingDependencies?: boolean;
  installPackageManager?: 'npm' | 'bun';
  missingPackages?: string[];
  lifecycleState?: 'active' | 'sleeping' | 'waking';
  onRefresh: () => void;
  onFixWithAi: (errorText: string) => void;
  onTokenExpired?: () => Promise<string | null | void> | string | null | void;
  onPreviewStatusChange?: (status: 'ready' | 'error' | 'installing', errorMessage?: string) => void;
}

type ViewportPreset = 'desktop' | 'tablet' | 'mobile';

const PREVIEW_HTML_TIMEOUT_MS = 15_000;
const PREVIEW_IFRAME_LOAD_TIMEOUT_MS = 10_000;
const PREVIEW_BRIDGE_HANDSHAKE_TIMEOUT_MS = 6_000;
const SAFE_REQ_ID_REGEX = /^[a-zA-Z0-9_-]{4,64}$/;

function generateBridgeNonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function PreviewPane({
  projectId,
  locale,
  reloadKey,
  previewToken,
  previewOrigin = '',
  runtimeError,
  isEmptyApp = false,
  isAiWorking = false,
  installingDependencies = false,
  installPackageManager = 'npm',
  missingPackages = [],
  lifecycleState = 'active',
  onRefresh,
  onFixWithAi,
  onTokenExpired,
  onPreviewStatusChange,
}: PreviewPaneProps) {
  const t = COPY[locale];
  const [viewport, setViewport] = useState<ViewportPreset>('desktop');
  const [stage, setStage] = useState<PreviewLifecycleStage>(
    isEmptyApp ? 'empty' : installingDependencies ? 'installing' : 'loading_html'
  );
  const [iframeError, setIframeError] = useState<string | null>(null);
  const [errorStatusCode, setErrorStatusCode] = useState<number | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [srcDocHtml, setSrcDocHtml] = useState<string | null>(null);
  const [renderNonce, setRenderNonce] = useState<string>('');
  const [localInstallMeta, setLocalInstallMeta] = useState<{
    packageManager?: 'npm' | 'bun';
    missingPackages?: string[];
  } | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeNonceRef = useRef<string>('');
  const previewRequestIdRef = useRef<string>('');
  const runCounterRef = useRef<number>(0);
  const loadStartMsRef = useRef<number>(0);
  const readyNotifiedRef = useRef<boolean>(false);

  // Keep volatile token/callbacks in refs so background token rotation or workspace reloads
  // never tear down an already-rendered preview iframe.
  const previewTokenRef = useRef<string | undefined>(previewToken);
  const onTokenExpiredRef = useRef(onTokenExpired);
  const onPreviewStatusChangeRef = useRef(onPreviewStatusChange);
  const lifecycleStateRef = useRef(lifecycleState);
  const copyRef = useRef(t);

  useEffect(() => {
    previewTokenRef.current = previewToken;
  }, [previewToken]);

  useEffect(() => {
    onTokenExpiredRef.current = onTokenExpired;
  }, [onTokenExpired]);

  useEffect(() => {
    onPreviewStatusChangeRef.current = onPreviewStatusChange;
  }, [onPreviewStatusChange]);

  useEffect(() => {
    lifecycleStateRef.current = lifecycleState;
  }, [lifecycleState]);

  useEffect(() => {
    copyRef.current = t;
  }, [t]);

  const normalizedOrigin = previewOrigin ? previewOrigin.replace(/\/+$/, '') : '';
  const previewBasePath = `${normalizedOrigin}/preview/${projectId}/`;

  useEffect(() => {
    const runId = ++runCounterRef.current;
    let cancelled = false;
    const controller = new AbortController();
    const isStale = () => cancelled || runCounterRef.current !== runId;

    if (isEmptyApp) {
      queueMicrotask(() => {
        if (isStale()) return;
        setStage('empty');
        setSrcDocHtml(null);
        setIframeError(null);
        setErrorStatusCode(null);
        setIframeLoaded(false);
        setLocalInstallMeta(null);
        readyNotifiedRef.current = false;
      });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    if (installingDependencies) {
      queueMicrotask(() => {
        if (isStale()) return;
        setStage('installing');
        setSrcDocHtml(null);
        setIframeError(null);
        setErrorStatusCode(null);
        setIframeLoaded(false);
        readyNotifiedRef.current = false;
      });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const nonce = generateBridgeNonce();
    const reqId = createPreviewRequestId();
    bridgeNonceRef.current = nonce;
    previewRequestIdRef.current = reqId;
    loadStartMsRef.current = Date.now();
    readyNotifiedRef.current = false;

    queueMicrotask(() => {
      if (isStale()) return;
      setRenderNonce(nonce);
      setStage('loading_html');
      setSrcDocHtml(null);
      setIframeError(null);
      setErrorStatusCode(null);
      setIframeLoaded(false);
      setLocalInstallMeta(null);
    });

    const fetchCredentials = resolvePreviewFetchCredentials(normalizedOrigin, window.location.origin);

    const fetchPreviewOnce = async (tokenOverride?: string): Promise<Response> => {
      const activeToken = tokenOverride ?? previewTokenRef.current;
      const headers: Record<string, string> = {
        'X-Carmen-Preview-Bridge-Nonce': nonce,
        'X-Carmen-Preview-Parent-Origin': window.location.origin,
        'X-Carmen-Preview-Request-Id': reqId,
      };
      if (activeToken) {
        headers['X-Carmen-Preview-Token'] = activeToken;
      }

      const timeoutHandle = window.setTimeout(() => controller.abort(), PREVIEW_HTML_TIMEOUT_MS);
      try {
        return await fetch(`${previewBasePath}?v=${reloadKey}`, {
          method: 'GET',
          headers,
          credentials: fetchCredentials,
          cache: 'no-store',
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeoutHandle);
      }
    };

    const failWithError = (message: string, statusCode: number | null, reason: string) => {
      if (isStale()) return;
      const clean = scrubClientPreviewMessage(message).slice(0, 400);
      setStage('error');
      setSrcDocHtml(null);
      setIframeLoaded(false);
      setIframeError(clean);
      setErrorStatusCode(statusCode);
      logPreviewDiagnostic({
        projectId,
        previewRequestId: reqId,
        stage: 'error',
        event: 'html_load_failed',
        status: statusCode ?? undefined,
        durationMs: Date.now() - loadStartMsRef.current,
        lifecycleState: lifecycleStateRef.current,
        reason,
      });
      onPreviewStatusChangeRef.current?.('error', clean);
    };

    const loadPreviewHtml = async () => {
      logPreviewDiagnostic({
        projectId,
        previewRequestId: reqId,
        stage: 'loading_html',
        event: 'html_fetch_start',
        lifecycleState: lifecycleStateRef.current,
      });

      try {
        let resp = await fetchPreviewOnce();
        if (isStale()) return;

        let body = await resp.text();
        if (isStale()) return;

        let classified = classifyPreviewHttpResponse({
          status: resp.status,
          redirected: resp.redirected,
          url: resp.url,
          contentType: resp.headers.get('content-type') || '',
          body,
          installingHeader: resp.headers.get('x-carmen-preview-installing'),
          previewBasePath,
        });

        // Bounded 1-shot inline token recovery for 401/403 — never triggers an infinite reloadKey loop
        if (classified.kind === 'auth_failed' && onTokenExpiredRef.current) {
          logPreviewDiagnostic({
            projectId,
            previewRequestId: reqId,
            stage: 'loading_html',
            event: 'token_recovery_attempt',
            status: classified.status,
            durationMs: Date.now() - loadStartMsRef.current,
            reason: classified.code,
          });
          const refreshed = await onTokenExpiredRef.current();
          if (isStale()) return;
          if (typeof refreshed === 'string' && refreshed.trim()) {
            previewTokenRef.current = refreshed.trim();
            resp = await fetchPreviewOnce(refreshed.trim());
            if (isStale()) return;
            body = await resp.text();
            if (isStale()) return;
            classified = classifyPreviewHttpResponse({
              status: resp.status,
              redirected: resp.redirected,
              url: resp.url,
              contentType: resp.headers.get('content-type') || '',
              body,
              installingHeader: resp.headers.get('x-carmen-preview-installing'),
              previewBasePath,
            });
          }
        }

        if (classified.kind === 'installing') {
          setStage('installing');
          setSrcDocHtml(null);
          setIframeError(null);
          setErrorStatusCode(null);
          setLocalInstallMeta({
            packageManager: classified.packageManager,
            missingPackages: classified.missingPackages,
          });
          logPreviewDiagnostic({
            projectId,
            previewRequestId: reqId,
            stage: 'installing',
            event: 'deps_installing_202',
            status: classified.status,
            durationMs: Date.now() - loadStartMsRef.current,
            installStatus: 'installing',
          });
          onPreviewStatusChangeRef.current?.('installing');
          return;
        }

        if (classified.kind === 'auth_failed') {
          failWithError(classified.message, classified.status, `auth_failed:${classified.code}`);
          return;
        }

        if (classified.kind === 'proxy_redirect') {
          failWithError(classified.message, classified.status, 'proxy_redirect');
          return;
        }

        if (classified.kind === 'non_html_error') {
          failWithError(classified.message, classified.status, `http_${classified.status}`);
          return;
        }

        if (classified.kind === 'html_error') {
          failWithError(classified.fallbackMessage, classified.status, `html_error_${classified.status}`);
          return;
        }

        logPreviewDiagnostic({
          projectId,
          previewRequestId: reqId,
          stage: 'mounting_iframe',
          event: 'html_fetch_ok',
          status: classified.status,
          durationMs: Date.now() - loadStartMsRef.current,
          lifecycleState: resp.headers.get('x-carmen-preview-state') || lifecycleStateRef.current,
        });

        setStage('mounting_iframe');
        setSrcDocHtml(classified.html);

        // Sync path-scoped HttpOnly preview cookie silently for new-tab launch (never exposed in URL)
        const activeToken = previewTokenRef.current;
        void fetch(`${previewBasePath}session`, {
          method: 'POST',
          credentials: 'include',
          headers: activeToken ? { 'X-Carmen-Preview-Token': activeToken } : undefined,
        }).catch(() => {});
      } catch (err) {
        if (isStale()) return;
        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        if (isAbort && cancelled) return;
        const msg = isAbort
          ? copyRef.current.previewHtmlTimeout
          : err instanceof Error
            ? err.message
            : copyRef.current.previewLoadTimeout;
        failWithError(msg, null, isAbort ? 'html_fetch_timeout' : 'html_fetch_network_error');
      }
    };

    void loadPreviewHtml();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadKey, projectId, previewBasePath, normalizedOrigin, isEmptyApp, installingDependencies]);

  // Deterministic bounded mount/bridge timeouts: never leave an indefinite spinner or trigger infinite reloads
  useEffect(() => {
    if (stage !== 'mounting_iframe') return;
    const timeoutMs = iframeLoaded ? PREVIEW_BRIDGE_HANDSHAKE_TIMEOUT_MS : PREVIEW_IFRAME_LOAD_TIMEOUT_MS;
    const timeoutMessage = iframeLoaded ? copyRef.current.previewBridgeTimeout : copyRef.current.previewLoadTimeout;
    const timeoutReason = iframeLoaded ? 'bridge_handshake_timeout' : 'iframe_onload_timeout';

    const timer = window.setTimeout(() => {
      setStage('error');
      setIframeError((prev) => prev || timeoutMessage);
      logPreviewDiagnostic({
        projectId,
        previewRequestId: previewRequestIdRef.current,
        stage: 'error',
        event: 'preview_timeout',
        durationMs: Date.now() - loadStartMsRef.current,
        lifecycleState: lifecycleStateRef.current,
        reason: timeoutReason,
      });
      onPreviewStatusChangeRef.current?.('error', timeoutMessage);
    }, timeoutMs);

    return () => window.clearTimeout(timer);
  }, [stage, iframeLoaded, projectId]);

  useEffect(() => {
    const fetchCredentials = resolvePreviewFetchCredentials(normalizedOrigin, window.location.origin);

    function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const expectedOrigins = new Set<string>(['null', window.location.origin]);
      if (normalizedOrigin) expectedOrigins.add(normalizedOrigin);
      if (!expectedOrigins.has(event.origin)) return;

      const data = event.data as
        | {
            type?: string;
            projectId?: string;
            bridgeNonce?: string;
            message?: string;
            status?: number;
            code?: string;
            reqId?: string;
            apiPath?: string;
            assetPath?: string;
            method?: string;
            body?: string;
            mountTimeMs?: number;
          }
        | null
        | undefined;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.projectId !== projectId) return;

      const activeNonce = bridgeNonceRef.current;
      if (activeNonce && data.bridgeNonce !== activeNonce) return;

      const replyOrigin = event.origin !== 'null' ? event.origin : '*';
      const replyBase = { projectId, bridgeNonce: activeNonce };
      const activeToken = previewTokenRef.current;

      if (data.type === 'carmen-preview-asset' && typeof data.reqId === 'string' && typeof data.assetPath === 'string') {
        const reqId = data.reqId;
        if (!SAFE_REQ_ID_REGEX.test(reqId)) return;
        const assetPath = data.assetPath.replace(/^\/+/, '').trim();
        const safeAssetPath =
          Boolean(assetPath) &&
          !assetPath.includes('..') &&
          !assetPath.includes('\\') &&
          /^[a-zA-Z0-9._/@-]+$/.test(assetPath);
        const replyTarget = iframeRef.current?.contentWindow;
        if (!safeAssetPath) {
          replyTarget?.postMessage({ ...replyBase, type: 'carmen-preview-asset-result', reqId, ok: false, status: 400 }, replyOrigin);
          return;
        }
        const headers: Record<string, string> = {};
        if (activeToken) headers['X-Carmen-Preview-Token'] = activeToken;
        void fetch(`${previewBasePath}${assetPath}`, {
          headers,
          credentials: fetchCredentials,
        })
          .then(async (resp) => {
            const ct = resp.headers.get('content-type') || '';
            if (!resp.ok || !ct.startsWith('image/')) {
              iframeRef.current?.contentWindow?.postMessage(
                { ...replyBase, type: 'carmen-preview-asset-result', reqId, ok: false, status: resp.status },
                replyOrigin
              );
              return;
            }
            const blob = await resp.blob();
            if (blob.size > 1024 * 1024) {
              iframeRef.current?.contentWindow?.postMessage(
                { ...replyBase, type: 'carmen-preview-asset-result', reqId, ok: false, status: 413 },
                replyOrigin
              );
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              iframeRef.current?.contentWindow?.postMessage(
                {
                  ...replyBase,
                  type: 'carmen-preview-asset-result',
                  reqId,
                  ok: true,
                  status: resp.status,
                  dataUrl: typeof reader.result === 'string' ? reader.result : '',
                },
                replyOrigin
              );
            };
            reader.onerror = () => {
              iframeRef.current?.contentWindow?.postMessage(
                { ...replyBase, type: 'carmen-preview-asset-result', reqId, ok: false, status: 500 },
                replyOrigin
              );
            };
            reader.readAsDataURL(blob);
          })
          .catch(() => {
            iframeRef.current?.contentWindow?.postMessage(
              { ...replyBase, type: 'carmen-preview-asset-result', reqId, ok: false },
              replyOrigin
            );
          });
        return;
      }

      if (data.type === 'carmen-preview-fetch' && typeof data.reqId === 'string' && typeof data.apiPath === 'string') {
        const reqId = data.reqId;
        if (!SAFE_REQ_ID_REGEX.test(reqId)) return;
        const apiPath = data.apiPath.trim();
        const method = String(data.method || 'GET').toUpperCase();
        const safeApiPath =
          !apiPath.includes('..') &&
          /^api\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*(?:\?[a-zA-Z0-9_.~%&=-]*)?$/.test(apiPath);
        const safeMethod = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method);
        const replyTarget = iframeRef.current?.contentWindow;
        if (!safeApiPath || !safeMethod) {
          replyTarget?.postMessage(
            { ...replyBase, type: 'carmen-preview-fetch-result', reqId, error: 'Path atau metode API pratinjau tidak diizinkan.' },
            replyOrigin
          );
          return;
        }
        const targetUrl = `${previewBasePath}${apiPath}`;
        const hasBody = typeof data.body === 'string' && method !== 'GET' && method !== 'HEAD';
        const headers: Record<string, string> = {};
        if (activeToken) headers['X-Carmen-Preview-Token'] = activeToken;
        if (hasBody) headers['Content-Type'] = 'application/json';
        void fetch(targetUrl, {
          method,
          credentials: fetchCredentials,
          headers,
          body: hasBody ? data.body : undefined,
        })
          .then(async (resp) => {
            const text = await resp.text();
            iframeRef.current?.contentWindow?.postMessage(
              {
                ...replyBase,
                type: 'carmen-preview-fetch-result',
                reqId,
                status: resp.status,
                contentType: resp.headers.get('content-type') || 'application/json',
                body: text,
              },
              replyOrigin
            );
          })
          .catch((err) => {
            iframeRef.current?.contentWindow?.postMessage(
              {
                ...replyBase,
                type: 'carmen-preview-fetch-result',
                reqId,
                error: err instanceof Error ? scrubClientPreviewMessage(err.message) : 'Preview API fetch failed',
              },
              replyOrigin
            );
          });
        return;
      }

      if (data.type === 'carmen-preview-ready') {
        setStage('ready');
        logPreviewDiagnostic({
          projectId,
          previewRequestId: previewRequestIdRef.current,
          stage: 'ready',
          event: 'bridge_ready',
          durationMs: Date.now() - loadStartMsRef.current,
          lifecycleState: lifecycleStateRef.current,
        });
        if (!readyNotifiedRef.current) {
          readyNotifiedRef.current = true;
          onPreviewStatusChangeRef.current?.('ready');
        }
        return;
      }

      if (data.type !== 'carmen-preview-error') return;

      if (typeof data.message === 'string' && data.message.trim()) {
        const clean = scrubClientPreviewMessage(data.message.trim()).slice(0, 400);
        const statusNum = typeof data.status === 'number' ? data.status : null;
        setStage('error');
        setIframeError(clean);
        setErrorStatusCode(statusNum);
        logPreviewDiagnostic({
          projectId,
          previewRequestId: previewRequestIdRef.current,
          stage: 'error',
          event: 'bridge_error',
          status: statusNum ?? undefined,
          durationMs: Date.now() - loadStartMsRef.current,
          lifecycleState: lifecycleStateRef.current,
          reason: data.code || clean,
        });
        void api.reportPreviewError(projectId, clean).catch(() => {});
        onPreviewStatusChangeRef.current?.('error', clean);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [projectId, normalizedOrigin, previewBasePath]);

  const effectiveInstalling = installingDependencies || stage === 'installing';
  const effectivePackageManager = localInstallMeta?.packageManager ?? installPackageManager;
  const effectiveMissingPackages =
    localInstallMeta?.missingPackages && localInstallMeta.missingPackages.length > 0
      ? localInstallMeta.missingPackages
      : missingPackages;
  const isLoadingOverlayVisible =
    !isEmptyApp &&
    !effectiveInstalling &&
    (stage === 'loading_html' || (stage === 'mounting_iframe' && !iframeLoaded));
  const activeError = iframeError || runtimeError;
  const showFullErrorStage = Boolean(
    activeError && !effectiveInstalling && !isEmptyApp && stage !== 'ready' && !isLoadingOverlayVisible
  );

  const frameClass =
    viewport === 'mobile'
      ? 'w-[390px] max-w-full h-[760px] max-h-full rounded-[8px] border border-[var(--border)] bg-[var(--bg)]'
      : viewport === 'tablet'
        ? 'w-[768px] max-w-full h-full rounded-[8px] border border-[var(--border)] bg-[var(--bg)]'
        : 'w-full h-full bg-[var(--bg)]';

  return (
    <div data-preview-state={effectiveInstalling ? 'installing' : isEmptyApp ? 'empty' : stage} className="h-full flex flex-col bg-[var(--bg)]">
      {/* Preview Toolbar */}
      <div className="h-10 sm:h-9 px-2.5 sm:px-3 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={onRefresh}
            aria-label={t.refreshPreviewAria}
            title={t.refreshPreviewTitle}
            className="h-8 w-8 sm:h-7 sm:w-7 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] flex items-center justify-center shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
          </button>
          <div
            title={t.previewIsolationTooltip}
            className="h-7 px-2 sm:px-2.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] text-[12px] font-mono text-[var(--text-muted)] flex items-center gap-1.5 truncate max-w-[200px] sm:max-w-[320px]"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-[var(--success-text)] shrink-0" strokeWidth={1.5} />
            <span className="truncate">/preview/{projectId}/</span>
          </div>
          {lifecycleState === 'sleeping' && (
            <span className="hidden md:inline-flex h-6 px-2 items-center rounded-[4px] border border-[var(--border)] bg-[var(--surface-2)] text-[11px] text-[var(--text-muted)]">
              {t.previewSleepingBadge}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <div
            role="group"
            aria-label={t.previewViewportAria}
            className="hidden sm:inline-flex items-center rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] p-0.5"
          >
            {(
              [
                ['desktop', Monitor, 'Desktop'],
                ['tablet', Tablet, 'Tablet'],
                ['mobile', Smartphone, 'Mobile'],
              ] as const
            ).map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={viewport === id}
                onClick={() => setViewport(id)}
                className={`h-7 w-7 rounded-[6px] flex items-center justify-center cursor-pointer ${
                  viewport === id
                    ? 'bg-[var(--surface)] text-[var(--text)] border border-[var(--border)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" strokeWidth={1.5} />
              </button>
            ))}
          </div>

          <a
            href={previewBasePath}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              const activeToken = previewTokenRef.current;
              if (activeToken) {
                void fetch(`${previewBasePath}session`, {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'X-Carmen-Preview-Token': activeToken },
                }).catch(() => {});
              }
            }}
            aria-label={t.openPreviewNewTabAria}
            title={t.openPreviewNewTabTitle}
            className="h-8 w-8 sm:h-7 sm:w-7 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] flex items-center justify-center"
          >
            <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.5} />
          </a>
        </div>
      </div>

      {/* Auto-fix Error Banner (WS-9) — shown only when live preview is visible alongside an error */}
      {activeError && !effectiveInstalling && !isEmptyApp && !showFullErrorStage && (
        <div
          role="alert"
          className="px-3 py-2 border-b border-[var(--error)] bg-[var(--surface)] flex flex-wrap items-center justify-between gap-2 text-[12px]"
        >
          <div className="flex items-center gap-2 text-[var(--error-text)] min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.5} />
            <span className="font-mono truncate">{activeError}</span>
          </div>
          <button
            type="button"
            onClick={() => onFixWithAi(activeError)}
            className="h-7 px-2.5 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium flex items-center gap-1.5 shrink-0 cursor-pointer"
          >
            <Wrench className="w-3.5 h-3.5" strokeWidth={1.5} />
            <span>{t.fixWithAi}</span>
          </button>
        </div>
      )}

      {/* Sandboxed opaque-origin iframe stage or Empty State */}
      <div className={`flex-1 overflow-auto flex justify-center ${viewport === 'desktop' ? '' : 'p-4 items-start'}`}>
        <div className={`${frameClass} flex flex-col overflow-hidden relative`}>
          {viewport === 'mobile' && (
            <div className="h-7 border-b border-[var(--border)] bg-[var(--surface)] px-3 flex items-center justify-between text-[12px] font-mono text-[var(--text-muted)] shrink-0">
              <span>Mobile · 390px</span>
            </div>
          )}
          {isEmptyApp ? (
            <div
              data-testid="preview-empty-state"
              className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-[var(--bg)] text-[var(--text)]"
            >
              {isAiWorking ? (
                <>
                  <Loader2 className="w-6 h-6 text-[var(--accent-text)] animate-spin mb-3" strokeWidth={1.75} />
                  <p className="text-[14px] font-medium text-[var(--text)]">{t.previewEmptyAiWorkingTitle}</p>
                  <p className="text-[12px] text-[var(--text-muted)] mt-1 max-w-sm">{t.previewEmptyAiWorkingSub}</p>
                </>
              ) : (
                <>
                  <p className="text-[14px] font-medium text-[var(--text)]">{t.previewEmptyIdleTitle}</p>
                  <p className="text-[12px] text-[var(--text-muted)] mt-1 max-w-sm">{t.previewEmptyIdleSub}</p>
                </>
              )}
            </div>
          ) : effectiveInstalling ? (
            <div
              data-testid="preview-installing-state"
              className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-[var(--bg)] text-[var(--text)]"
            >
              <Loader2 className="w-6 h-6 text-[var(--accent-text)] animate-spin mb-3" strokeWidth={1.75} />
              <p className="text-[14px] font-medium text-[var(--text)]">{t.previewInstallingDeps}</p>
              <p className="text-[12px] text-[var(--text-muted)] mt-1 max-w-md">{t.previewInstallingDepsSub}</p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 max-w-md">
                <span className="px-2 py-0.5 rounded-[4px] border border-[var(--border-strong)] bg-[var(--surface)] font-mono text-[11px] text-[var(--text)]">
                  {effectivePackageManager} install
                </span>
                {effectiveMissingPackages.slice(0, 6).map((pkg) => (
                  <span
                    key={pkg}
                    className="px-2 py-0.5 rounded-[4px] border border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]"
                  >
                    {pkg}
                  </span>
                ))}
                {effectiveMissingPackages.length > 6 && (
                  <span className="px-1.5 py-0.5 text-[11px] font-mono text-[var(--text-muted)]">
                    +{effectiveMissingPackages.length - 6}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="relative flex-1 flex flex-col min-h-0">
              {isLoadingOverlayVisible && (
                <div
                  data-testid="preview-loading-overlay"
                  className="absolute inset-0 z-10 bg-[var(--bg)] flex flex-col items-center justify-center gap-2 text-[12px] text-[var(--text-muted)] animate-pulse"
                >
                  <Loader2 className="w-5 h-5 animate-spin text-[var(--accent-text)]" strokeWidth={1.5} />
                  <span>{lifecycleState === 'sleeping' || lifecycleState === 'waking' ? t.previewWaking : t.previewLoading}</span>
                </div>
              )}
              {showFullErrorStage && (
                <div
                  data-testid="preview-error-stage"
                  className="absolute inset-0 z-20 bg-[var(--bg)] flex items-center justify-center p-6"
                >
                  <div className="max-w-lg w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--error-text)]">
                        <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.6} />
                        <span>{t.previewErrorTitle}</span>
                      </div>
                      {errorStatusCode !== null && (
                        <span className="px-2 py-0.5 rounded-[4px] border border-[var(--border-strong)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]">
                          HTTP {errorStatusCode}
                        </span>
                      )}
                    </div>
                    <pre className="p-3 rounded-[6px] border border-[var(--border)] bg-[var(--bg)] text-[12px] font-mono text-[var(--text)] whitespace-pre-wrap break-words max-h-48 overflow-auto">
                      {activeError}
                    </pre>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={onRefresh}
                        className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:bg-[var(--surface)] text-[12px] text-[var(--text)] flex items-center gap-1.5 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
                        <span>{t.previewRetryButton}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onFixWithAi(activeError || '')}
                        className="h-8 px-3 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium flex items-center gap-1.5 cursor-pointer"
                      >
                        <Wrench className="w-3.5 h-3.5" strokeWidth={1.5} />
                        <span>{t.fixWithAi}</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {srcDocHtml !== null && (
                <iframe
                  ref={iframeRef}
                  key={`${reloadKey}-${renderNonce}`}
                  srcDoc={srcDocHtml}
                  onLoad={() => {
                    setIframeLoaded(true);
                    logPreviewDiagnostic({
                      projectId,
                      previewRequestId: previewRequestIdRef.current,
                      stage: 'mounting_iframe',
                      event: 'iframe_onload',
                      durationMs: Date.now() - loadStartMsRef.current,
                      lifecycleState: lifecycleStateRef.current,
                    });
                  }}
                  title={t.preview}
                  sandbox="allow-scripts allow-forms allow-downloads"
                  referrerPolicy="no-referrer"
                  className="w-full flex-1 border-0 bg-[var(--bg)]"
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
