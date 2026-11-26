import { AlertCircle, ExternalLink, Loader2, Monitor, RefreshCw, ShieldCheck, Smartphone, Tablet, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { COPY } from '../../i18n';
import { api } from '../../lib/api';
import type { Locale, ProjectType } from '../../types';

interface PreviewPaneProps {
  projectId: string;
  projectType: ProjectType;
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
  onTokenExpired?: () => Promise<void> | void;
  onPreviewStatusChange?: (status: 'ready' | 'error', errorMessage?: string) => void;
}

type ViewportPreset = 'desktop' | 'tablet' | 'mobile';

const PREVIEW_LOAD_TIMEOUT_MS = 12_000;
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

function scrubClientPreviewMessage(text: string): string {
  return text
    .replace(/(\/preview\/[^/\s?#]+\/t\/)[A-Za-z0-9._-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/([?&]pt=)[A-Za-z0-9._-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]');
}

export function PreviewPane({
  projectId,
  projectType,
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
  const [viewport, setViewport] = useState<ViewportPreset>(projectType === 'android' ? 'mobile' : 'desktop');
  const [iframeError, setIframeError] = useState<string | null>(null);
  const [errorStatusCode, setErrorStatusCode] = useState<number | null>(null);
  const [iframeLoading, setIframeLoading] = useState(!isEmptyApp);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [srcDocHtml, setSrcDocHtml] = useState<string | null>(null);
  const [renderNonce, setRenderNonce] = useState<string>('');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeNonceRef = useRef<string>('');
  const tokenRecoveryAttemptedRef = useRef(false);
  const readyNotifiedRef = useRef(false);

  const normalizedOrigin = previewOrigin ? previewOrigin.replace(/\/+$/, '') : '';
  const previewBasePath = `${normalizedOrigin}/preview/${projectId}/`;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    if (isEmptyApp || installingDependencies) {
      queueMicrotask(() => {
        if (cancelled) return;
        setSrcDocHtml(null);
        setIframeError(null);
        setErrorStatusCode(null);
        setPreviewReady(false);
        setIframeLoaded(false);
        setIframeLoading(false);
        readyNotifiedRef.current = false;
        tokenRecoveryAttemptedRef.current = false;
      });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const nonce = generateBridgeNonce();
    bridgeNonceRef.current = nonce;

    queueMicrotask(() => {
      if (cancelled) return;
      setRenderNonce(nonce);
      setSrcDocHtml(null);
      setIframeError(null);
      setErrorStatusCode(null);
      setPreviewReady(false);
      setIframeLoaded(false);
      setIframeLoading(true);
      readyNotifiedRef.current = false;
      tokenRecoveryAttemptedRef.current = false;
    });

    const loadPreviewHtml = async () => {
      try {
        const headers: Record<string, string> = {
          'X-Carmen-Preview-Bridge-Nonce': nonce,
          'X-Carmen-Preview-Parent-Origin': window.location.origin,
        };
        if (previewToken) {
          headers['X-Carmen-Preview-Token'] = previewToken;
        }

        const resp = await fetch(`${previewBasePath}?v=${reloadKey}`, {
          method: 'GET',
          headers,
          credentials: previewToken ? 'omit' : 'include',
          cache: 'no-store',
          signal: controller.signal,
        });

        if (cancelled) return;

        if ((resp.status === 401 || resp.status === 403) && onTokenExpired && !tokenRecoveryAttemptedRef.current) {
          tokenRecoveryAttemptedRef.current = true;
          void onTokenExpired();
          return;
        }

        const html = await resp.text();
        if (cancelled) return;

        setSrcDocHtml(html);

        // Sync path-scoped HttpOnly preview cookie silently for new-tab launch (never exposed in URL)
        void fetch(`${previewBasePath}session`, {
          method: 'POST',
          credentials: 'include',
          headers: previewToken ? { 'X-Carmen-Preview-Token': previewToken } : undefined,
        }).catch(() => {});
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        const rawMsg = err instanceof Error ? err.message : t.previewLoadTimeout;
        const msg = scrubClientPreviewMessage(rawMsg);
        setIframeLoading(false);
        setIframeError(msg);
        onPreviewStatusChange?.('error', msg);
      }
    };

    void loadPreviewHtml();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    reloadKey,
    projectId,
    previewToken,
    previewBasePath,
    isEmptyApp,
    installingDependencies,
    t.previewLoadTimeout,
    onTokenExpired,
    onPreviewStatusChange,
  ]);

  useEffect(() => {
    if (isEmptyApp || previewReady || iframeError || installingDependencies) return;
    const timeoutMs = iframeLoaded ? 3_500 : PREVIEW_LOAD_TIMEOUT_MS;
    const timer = window.setTimeout(() => {
      if (iframeLoaded && !tokenRecoveryAttemptedRef.current && onTokenExpired) {
        tokenRecoveryAttemptedRef.current = true;
        void onTokenExpired();
        return;
      }
      setIframeLoading(false);
      setIframeError((prev) => prev || t.previewLoadTimeout);
      onPreviewStatusChange?.('error', t.previewLoadTimeout);
    }, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [
    isEmptyApp,
    installingDependencies,
    iframeLoaded,
    previewReady,
    iframeError,
    reloadKey,
    projectId,
    previewToken,
    t.previewLoadTimeout,
    onTokenExpired,
    onPreviewStatusChange,
  ]);

  useEffect(() => {
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
          }
        | null
        | undefined;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.projectId !== projectId) return;

      const activeNonce = bridgeNonceRef.current;
      if (activeNonce && data.bridgeNonce !== activeNonce) return;

      const replyOrigin = event.origin !== 'null' ? event.origin : '*';
      const replyBase = { projectId, bridgeNonce: activeNonce };

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
        if (previewToken) headers['X-Carmen-Preview-Token'] = previewToken;
        void fetch(`${previewBasePath}${assetPath}`, {
          headers,
          credentials: previewToken ? 'omit' : 'include',
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
        if (previewToken) headers['X-Carmen-Preview-Token'] = previewToken;
        if (hasBody) headers['Content-Type'] = 'application/json';
        void fetch(targetUrl, {
          method,
          credentials: previewToken ? 'omit' : 'include',
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
        setIframeLoading(false);
        setPreviewReady(true);
        if (!readyNotifiedRef.current) {
          readyNotifiedRef.current = true;
          onPreviewStatusChange?.('ready');
        }
        return;
      }

      if (data.type !== 'carmen-preview-error') return;

      setIframeLoading(false);
      if (data.code === 'INVALID_TOKEN' && onTokenExpired && !tokenRecoveryAttemptedRef.current) {
        tokenRecoveryAttemptedRef.current = true;
        void onTokenExpired();
        return;
      }

      if (typeof data.message === 'string' && data.message.trim()) {
        const clean = scrubClientPreviewMessage(data.message.trim()).slice(0, 400);
        setIframeError(clean);
        setErrorStatusCode(typeof data.status === 'number' ? data.status : null);
        void api.reportPreviewError(projectId, clean).catch(() => {});
        onPreviewStatusChange?.('error', clean);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [projectId, normalizedOrigin, previewBasePath, previewToken, onTokenExpired, onPreviewStatusChange]);

  const activeError = iframeError || runtimeError;
  const showFullErrorStage = Boolean(activeError && !previewReady && !installingDependencies);

  const frameClass =
    viewport === 'mobile'
      ? 'w-[390px] max-w-full h-[760px] max-h-full rounded-[8px] border border-[var(--border)] bg-[var(--bg)]'
      : viewport === 'tablet'
        ? 'w-[768px] max-w-full h-full rounded-[8px] border border-[var(--border)] bg-[var(--bg)]'
        : 'w-full h-full bg-[var(--bg)]';

  return (
    <div className="h-full flex flex-col bg-[var(--bg)]">
      {/* Preview Toolbar */}
      <div className="h-9 px-3 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={onRefresh}
            aria-label={t.refreshPreviewAria}
            title={t.refreshPreviewTitle}
            className="h-7 w-7 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] flex items-center justify-center cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
          </button>
          <div
            title={t.previewIsolationTooltip}
            className="h-7 px-2.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] text-[12px] font-mono text-[var(--text-muted)] flex items-center gap-1.5 truncate max-w-[320px]"
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
            className="inline-flex items-center rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] p-0.5"
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
              if (previewToken) {
                void fetch(`${previewBasePath}session`, {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'X-Carmen-Preview-Token': previewToken },
                }).catch(() => {});
              }
            }}
            aria-label={t.openPreviewNewTabAria}
            title={t.openPreviewNewTabTitle}
            className="h-7 w-7 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] flex items-center justify-center"
          >
            <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.5} />
          </a>
        </div>
      </div>

      {/* Auto-fix Error Banner (WS-9) */}
      {activeError && !installingDependencies && (
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
              <span>{projectType === 'android' ? 'Android · 390×760' : 'Mobile · 390px'}</span>
              {projectType === 'android' && <span>Capacitor</span>}
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
          ) : installingDependencies ? (
            <div
              data-testid="preview-installing-state"
              className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-[var(--bg)] text-[var(--text)]"
            >
              <Loader2 className="w-6 h-6 text-[var(--accent-text)] animate-spin mb-3" strokeWidth={1.75} />
              <p className="text-[14px] font-medium text-[var(--text)]">{t.previewInstallingDeps}</p>
              <p className="text-[12px] text-[var(--text-muted)] mt-1 max-w-md">{t.previewInstallingDepsSub}</p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 max-w-md">
                <span className="px-2 py-0.5 rounded-[4px] border border-[var(--border-strong)] bg-[var(--surface)] font-mono text-[11px] text-[var(--text)]">
                  {installPackageManager} install
                </span>
                {missingPackages.slice(0, 6).map((pkg) => (
                  <span
                    key={pkg}
                    className="px-2 py-0.5 rounded-[4px] border border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]"
                  >
                    {pkg}
                  </span>
                ))}
                {missingPackages.length > 6 && (
                  <span className="px-1.5 py-0.5 text-[11px] font-mono text-[var(--text-muted)]">
                    +{missingPackages.length - 6}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="relative flex-1 flex flex-col min-h-0">
              {iframeLoading && (
                <div className="absolute inset-0 z-10 bg-[var(--bg)] flex flex-col items-center justify-center gap-2 text-[12px] text-[var(--text-muted)] animate-pulse">
                  <Loader2 className="w-5 h-5 animate-spin text-[var(--accent-text)]" strokeWidth={1.5} />
                  <span>{lifecycleState === 'sleeping' || lifecycleState === 'waking' ? t.previewWaking : t.previewLoading}</span>
                </div>
              )}
              {showFullErrorStage && !iframeLoading && (
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
                    setIframeLoading(false);
                    setIframeLoaded(true);
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
