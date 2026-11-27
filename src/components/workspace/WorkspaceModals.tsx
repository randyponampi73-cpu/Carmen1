import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  Plus,
  QrCode,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { COPY } from '../../i18n';
import { api, getAuthHeaders, notifyUnauthorized } from '../../lib/api';
import type { AndroidToolchainStatus, ApkBuildRecord, ApkConfig, EnvVarItem, Locale } from '../../types';
import { ModalShell } from '../ConfirmDialog';
import { CustomSelect } from '../CustomSelect';

// ============================================================
// APK BUILD MODAL (APK-3 .. APK-7)
// ============================================================
interface ApkBuildModalProps {
  projectId: string;
  initialConfig: ApkConfig;
  existingBuilds: ApkBuildRecord[];
  locale: Locale;
  onClose: () => void;
  onFixWithAi: (err: string) => void;
  onBuildQueued?: (build: ApkBuildRecord) => void;
}

export function ApkBuildModal({
  projectId,
  initialConfig,
  existingBuilds,
  locale,
  onClose,
  onFixWithAi,
  onBuildQueued,
}: ApkBuildModalProps) {
  const t = COPY[locale];
  const titleId = useId();
  const [config, setConfig] = useState<ApkConfig>(initialConfig);
  const [format, setFormat] = useState<'apk' | 'aab'>(existingBuilds[0]?.type === 'aab' ? 'aab' : 'apk');
  const [keystoreName, setKeystoreName] = useState('');
  const [keystoreBase64, setKeystoreBase64] = useState<string | undefined>(undefined);
  const [storePassword, setStorePassword] = useState('');
  const [keyAlias, setKeyAlias] = useState('');
  const [keyPassword, setKeyPassword] = useState('');
  const [activeBuild, setActiveBuild] = useState<ApkBuildRecord | null>(existingBuilds[0] ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [downloadingArtifact, setDownloadingArtifact] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolchain, setToolchain] = useState<AndroidToolchainStatus | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    api
      .getAndroidToolchain()
      .then((res) => setToolchain(res.toolchain))
      .catch(() => {});
  }, []);

  const buildId = activeBuild?.id;
  const buildStatus = activeBuild?.status;

  useEffect(() => {
    if (!buildId || buildStatus === 'success' || buildStatus === 'failed') return;
    const controller = new AbortController();
    let pollTimer: number | null = null;

    const pollStatus = async () => {
      if (controller.signal.aborted) return;
      try {
        const st = await api.getBuildStatus(buildId);
        if (controller.signal.aborted) return;
        setActiveBuild((prev) =>
          prev && prev.id === buildId
            ? {
                ...prev,
                status: st.buildStatus,
                logs: st.logs,
                downloadToken: st.downloadToken ?? prev.downloadToken,
                artifactSizeBytes: st.artifactSizeBytes ?? prev.artifactSizeBytes,
                artifactKind: st.artifactKind ?? prev.artifactKind,
                signingVerified: st.signingVerified ?? prev.signingVerified,
              }
            : prev
        );
      } catch {
        // Ignore transient polling error
      }
    };

    pollTimer = window.setInterval(() => {
      void pollStatus();
    }, 3000);

    async function streamLogs() {
      try {
        const res = await fetch(`/api/builds/${buildId}/logs`, {
          credentials: 'include',
          headers: { ...getAuthHeaders() },
          signal: controller.signal,
        });
        if (res.status === 401) {
          notifyUnauthorized(t.sessionMissing);
          return;
        }
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const raw of lines) {
            const line = raw.trimEnd();
            if (line.startsWith('data:')) {
              const payloadStr = line.slice(5).trim();
              if (!payloadStr) continue;
              try {
                const updated = JSON.parse(payloadStr) as ApkBuildRecord;
                setActiveBuild(updated);
              } catch {
                // Ignore partial SSE lines
              }
            }
          }
        }
      } catch {
        // Ignore abort on unmount; polling fallback handles detached workers
      }
    }

    void streamLogs();
    return () => {
      controller.abort();
      if (pollTimer !== null) window.clearInterval(pollTimer);
    };
  }, [buildId, buildStatus, t.sessionMissing]);

  async function handleStartBuild(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (config.buildType === 'release' && toolchain?.readyForNativeApk) {
      if (!keystoreBase64) {
        setError(t.apkKeystoreRequired);
        return;
      }
      if (!storePassword || !keyAlias.trim() || !keyPassword) {
        setError(t.apkSigningCredsRequired);
        return;
      }
    }
    setSubmitting(true);
    try {
      const signingCredentials =
        config.buildType === 'release' && (storePassword || keyAlias || keyPassword)
          ? { storePassword, keyAlias: keyAlias.trim(), keyPassword }
          : undefined;
      const res = await api.startApkBuild(projectId, config, keystoreBase64, signingCredentials, format);
      setActiveBuild(res.build);
      onBuildQueued?.(res.build);
      setStorePassword('');
      setKeyPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t.apkStartBuildFail);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancelBuild() {
    if (!activeBuild || (activeBuild.status !== 'queued' && activeBuild.status !== 'running')) return;
    setError(null);
    setCancelling(true);
    try {
      const res = await api.cancelApkBuild(activeBuild.id);
      if (res.build) {
        setActiveBuild(res.build);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t.apkStartBuildFail);
    } finally {
      setCancelling(false);
    }
  }

  const isNativeAndroidArtifact = (kind?: ApkBuildRecord['artifactKind']) =>
    Boolean(kind && kind !== 'capacitor-source-zip');

  const downloadUrl =
    activeBuild?.status === 'success' && activeBuild.downloadToken
      ? `${window.location.origin}/api/builds/${activeBuild.id}/download?token=${activeBuild.downloadToken}`
      : null;

  return (
    <ModalShell
      open
      onClose={onClose}
      busy={submitting}
      ariaLabelledBy={titleId}
      maxWidthClass="max-w-[600px]"
      className="p-5 space-y-4"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
        <div>
          <h2 id={titleId} className="text-[16px] font-semibold text-[var(--text)]">
            {t.buildApk} (Capacitor Android)
          </h2>
          <p className="text-[12px] text-[var(--text-muted)]">{t.apkModalSubtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          aria-label={t.close}
          className="h-7 w-7 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] flex items-center justify-center cursor-pointer disabled:opacity-50"
        >
          <X className="w-4 h-4" strokeWidth={1.5} />
        </button>
      </div>

      {toolchain && toolchain.readyForNativeApk ? (
        <div className="rounded-[6px] border border-[var(--success)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--success-text)] flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
          <span>{t.apkToolchainReady}</span>
        </div>
      ) : (
        <div className="rounded-[6px] border border-[var(--warning)] bg-[var(--surface-2)] px-3 py-2.5 text-[12px] text-[var(--warning-text)] space-y-1.5">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
            <span>
              {t.apkToolchainMissing}
              {toolchain?.missing?.length ? ` (${toolchain.missing.join(', ')})` : ''}
              {t.apkToolchainMissingSuffix}
            </span>
          </div>
          {toolchain && (
            <div className="pl-6 grid grid-cols-2 sm:grid-cols-4 gap-1.5 font-mono text-[12px]">
              <span className={toolchain.jdk.available ? 'text-[var(--success-text)]' : 'text-[var(--error-text)]'}>
                JDK: {toolchain.jdk.available ? 'OK' : t.apkMissingTool}
              </span>
              <span className={toolchain.javac.available ? 'text-[var(--success-text)]' : 'text-[var(--error-text)]'}>
                javac: {toolchain.javac.available ? 'OK' : t.apkMissingTool}
              </span>
              <span className={toolchain.gradle.available ? 'text-[var(--success-text)]' : 'text-[var(--error-text)]'}>
                Gradle: {toolchain.gradle.available ? 'OK' : t.apkMissingTool}
              </span>
              <span className={toolchain.androidSdk.available ? 'text-[var(--success-text)]' : 'text-[var(--error-text)]'}>
                SDK: {toolchain.androidSdk.available ? 'OK' : t.apkMissingTool}
              </span>
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleStartBuild} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="apk-name" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
              {t.apkAppName}
            </label>
            <input
              id="apk-name"
              required
              value={config.appName}
              onChange={(e) => setConfig({ ...config, appName: e.target.value })}
              className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[13px] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </div>
          <div>
            <label htmlFor="apk-pkg" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
              Package ID
            </label>
            <input
              id="apk-pkg"
              required
              value={config.packageId}
              onChange={(e) => setConfig({ ...config, packageId: e.target.value })}
              placeholder="id.carmen.aplikasi"
              className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[13px] font-mono text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <label htmlFor="apk-ver" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
              {t.apkVersion}
            </label>
            <input
              id="apk-ver"
              value={config.versionName}
              onChange={(e) => setConfig({ ...config, versionName: e.target.value })}
              className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[13px] font-mono text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </div>
          <div>
            <label htmlFor="apk-code" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
              Version Code
            </label>
            <input
              id="apk-code"
              type="number"
              min={1}
              value={config.versionCode}
              onChange={(e) => setConfig({ ...config, versionCode: Number(e.target.value) || 1 })}
              className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[13px] font-mono tabular-nums text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </div>
          <div>
            <label htmlFor="apk-type" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
              {t.apkModeBuild}
            </label>
            <CustomSelect
              id="apk-type"
              locale={locale}
              ariaLabel={t.apkModeBuild}
              value={config.buildType}
              onChange={(val) => setConfig({ ...config, buildType: val as 'debug' | 'release' })}
              options={[
                { value: 'debug', label: 'Debug (default)' },
                { value: 'release', label: 'Release (keystore)' },
              ]}
            />
          </div>
          <div>
            <label htmlFor="apk-format" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
              {t.apkFormatLabel}
            </label>
            <CustomSelect
              id="apk-format"
              locale={locale}
              ariaLabel={t.apkFormatLabel}
              value={format}
              onChange={(val) => setFormat(val === 'aab' ? 'aab' : 'apk')}
              options={[
                { value: 'apk', label: 'APK (.apk)' },
                { value: 'aab', label: 'AAB (.aab)' },
              ]}
            />
          </div>
        </div>

        {config.buildType === 'release' && (
          <div className="space-y-2.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <div>
              <label htmlFor="apk-keystore" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                {t.apkKeystoreLabel}
              </label>
              <input
                id="apk-keystore"
                type="file"
                accept=".jks,.keystore,.p12,.pfx"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setKeystoreName(f.name);
                  setError(null);
                  const reader = new FileReader();
                  reader.onload = () => setKeystoreBase64(String(reader.result || '').split(',')[1]);
                  reader.onerror = () => {
                    setKeystoreName('');
                    setKeystoreBase64(undefined);
                    setError(t.apkKeystoreRequired);
                  };
                  reader.readAsDataURL(f);
                }}
                className="text-[12px] text-[var(--text-muted)]"
              />
              {keystoreName && <div className="mt-1 text-[12px] font-mono text-[var(--text-muted)]">{keystoreName}</div>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <label htmlFor="apk-key-alias" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                  Key Alias
                </label>
                <input
                  id="apk-key-alias"
                  value={keyAlias}
                  onChange={(e) => setKeyAlias(e.target.value)}
                  placeholder="upload-key"
                  className="w-full h-7 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] px-2 text-[12px] font-mono text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              <div>
                <label htmlFor="apk-store-pass" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                  Store Password
                </label>
                <input
                  id="apk-store-pass"
                  type="password"
                  value={storePassword}
                  onChange={(e) => setStorePassword(e.target.value)}
                  placeholder="••••••"
                  className="w-full h-7 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] px-2 text-[12px] font-mono text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              <div>
                <label htmlFor="apk-key-pass" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                  Key Password
                </label>
                <input
                  id="apk-key-pass"
                  type="password"
                  value={keyPassword}
                  onChange={(e) => setKeyPassword(e.target.value)}
                  placeholder="••••••"
                  className="w-full h-7 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] px-2 text-[12px] font-mono text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="text-[12px] text-[var(--error-text)] flex items-center gap-1.5">
            <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.5} />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {(activeBuild?.status === 'queued' || activeBuild?.status === 'running') && (
            <button
              type="button"
              disabled={cancelling}
              onClick={() => void handleCancelBuild()}
              className="h-8 px-3.5 rounded-[6px] border border-[var(--error)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[var(--error-text)] text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              {cancelling && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
              <span>{t.cancel}</span>
            </button>
          )}
          <button
            type="submit"
            disabled={submitting || activeBuild?.status === 'queued' || activeBuild?.status === 'running'}
            className="h-8 px-4 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
          >
            {(submitting || activeBuild?.status === 'queued' || activeBuild?.status === 'running') && (
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
            )}
            <span>{toolchain && !toolchain.readyForNativeApk ? t.apkPackageSourceBtn : t.apkStartBuildBtn}</span>
          </button>
        </div>
      </form>

      {activeBuild && (
        <div className="rounded-[6px] border border-[var(--border)] bg-[var(--bg)] p-3 space-y-2.5">
          <div className="flex items-center justify-between text-[12px]">
            <div className="flex items-center gap-2">
              {activeBuild.status === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-[var(--success-text)]" strokeWidth={1.5} />
              ) : activeBuild.status === 'failed' ? (
                <AlertCircle className="w-4 h-4 text-[var(--error-text)]" strokeWidth={1.5} />
              ) : (
                <Loader2 className="w-4 h-4 text-[var(--warning-text)] animate-spin" strokeWidth={1.5} />
              )}
              <span className="font-mono font-medium text-[var(--text)]">
                {activeBuild.status === 'success'
                  ? activeBuild.artifactKind === 'signed-release-apk'
                    ? t.apkSignedSuccess
                    : activeBuild.artifactKind === 'debug-apk'
                      ? t.apkDebugSuccess
                      : activeBuild.artifactKind === 'unsigned-release-apk'
                        ? t.apkUnsignedSuccess
                        : activeBuild.artifactKind === 'signed-release-aab'
                          ? t.apkSignedAabSuccess
                          : activeBuild.artifactKind === 'debug-aab'
                            ? t.apkDebugAabSuccess
                            : activeBuild.artifactKind === 'unsigned-release-aab'
                              ? t.apkUnsignedAabSuccess
                              : t.apkSourceSuccess
                  : `Status: ${activeBuild.status}`}
              </span>
            </div>
            <span className="font-mono text-[12px] text-[var(--text-muted)]">{activeBuild.id}</span>
          </div>

          <div className="max-h-40 overflow-y-auto rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-[12px] space-y-1">
            {activeBuild.logs.map((entry, idx) => (
              <div
                key={idx}
                className={
                  entry.level === 'error'
                    ? 'text-[var(--error-text)]'
                    : entry.level === 'success'
                      ? 'text-[var(--success-text)]'
                      : entry.level === 'warn'
                        ? 'text-[var(--warning-text)]'
                        : 'text-[var(--text-muted)]'
                }
              >
                <span className="tabular-nums mr-2">{entry.timestamp}</span>
                <span>{entry.message}</span>
              </div>
            ))}
          </div>

          {downloadUrl && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
                <QrCode className="w-4 h-4 text-[var(--text)]" strokeWidth={1.5} />
                <span>{t.apkLinkValidity}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    try {
                      const res = navigator.clipboard?.writeText(downloadUrl);
                      if (res && typeof res.catch === 'function') {
                        res.catch(() => {});
                      }
                    } catch {
                      // Clipboard may be unavailable in restricted contexts
                    }
                    setCopied(true);
                    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
                    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1800);
                  }}
                  className="h-8 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] text-[12px] text-[var(--text)] flex items-center gap-1.5 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" strokeWidth={1.5} />
                  <span>{copied ? t.apkCopied : t.apkCopyLink}</span>
                </button>
                <button
                  type="button"
                  disabled={downloadingArtifact}
                  onClick={() => {
                    if (!activeBuild?.downloadToken) return;
                    setError(null);
                    setDownloadingArtifact(true);
                    void api
                      .downloadBuildArtifact(activeBuild.id, activeBuild.downloadToken)
                      .catch((err) => {
                        setError(err instanceof Error ? err.message : t.apkStartBuildFail);
                      })
                      .finally(() => {
                        setDownloadingArtifact(false);
                      });
                  }}
                  className="h-8 px-3.5 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {downloadingArtifact ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                  ) : (
                    <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                  )}
                  <span>
                    {isNativeAndroidArtifact(activeBuild.artifactKind)
                      ? activeBuild.artifactKind === 'signed-release-apk'
                        ? t.apkDownloadSigned
                        : activeBuild.artifactKind === 'debug-apk'
                          ? t.apkDownloadDebug
                          : activeBuild.artifactKind === 'unsigned-release-apk'
                            ? t.apkDownloadUnsigned
                            : activeBuild.artifactKind === 'signed-release-aab'
                              ? t.apkDownloadSignedAab
                              : activeBuild.artifactKind === 'debug-aab'
                                ? t.apkDownloadDebugAab
                                : t.apkDownloadUnsignedAab
                      : t.apkDownloadSource}
                  </span>
                </button>
              </div>
            </div>
          )}

          {activeBuild.status === 'failed' && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  const lastErr = activeBuild.logs.map((l) => l.message).join('\n');
                  onFixWithAi(`${t.apkBuildFailedPrefix}${lastErr}`);
                  onClose();
                }}
                className="h-8 px-3 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <Wrench className="w-3.5 h-3.5" strokeWidth={1.5} />
                <span>{t.fixWithAi}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
}

// ============================================================
// ENV VARS MODAL (WEB-5)
// ============================================================
interface EnvVarsModalProps {
  projectId: string;
  envVars: EnvVarItem[];
  locale: Locale;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}

export function EnvVarsModal({ projectId, envVars, locale, onRefresh, onClose }: EnvVarsModalProps) {
  const t = COPY[locale];
  const titleId = useId();
  const [keyName, setKeyName] = useState('');
  const [val, setVal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.addEnvVar(projectId, keyName, val);
      setKeyName('');
      setVal('');
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.envVarSaveFail);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item: EnvVarItem) {
    setError(null);
    setDeletingId(item.id);
    try {
      await api.deleteEnvVar(projectId, item.id);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.envVarDeleteFail);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      busy={saving || Boolean(deletingId)}
      ariaLabelledBy={titleId}
      maxWidthClass="max-w-[520px]"
      className="p-5 space-y-4"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
        <h2 id={titleId} className="text-[16px] font-semibold text-[var(--text)]">
          {t.envVars}
        </h2>
        <button
          type="button"
          onClick={onClose}
          disabled={saving || Boolean(deletingId)}
          aria-label={t.close}
          className="h-7 w-7 rounded-[6px] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] cursor-pointer disabled:opacity-50"
        >
          <X className="w-4 h-4" strokeWidth={1.5} />
        </button>
      </div>

      <p className="text-[12px] text-[var(--text-muted)]">{t.envVarsDesc}</p>

      <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
        <input
          required
          value={keyName}
          onChange={(e) => setKeyName(e.target.value)}
          placeholder={t.envVarKeyPlaceholder}
          aria-label={t.envVarKeyPlaceholder}
          className="h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[12px] font-mono text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
        <input
          required
          type="password"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder={t.envVarValPlaceholder}
          aria-label={t.envVarValPlaceholder}
          className="h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[12px] font-mono text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={saving}
          className="h-8 px-3 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} /> : <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />}
          <span>{t.save}</span>
        </button>
      </form>

      {error && (
        <div role="alert" className="text-[12px] text-[var(--error-text)] flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.5} />
          <span>{error}</span>
        </div>
      )}

      <div className="rounded-[6px] border border-[var(--border)] divide-y divide-[var(--border)] max-h-52 overflow-y-auto">
        {envVars.length === 0 ? (
          <div className="p-4 text-[12px] text-[var(--text-muted)] text-center">{t.envVarsEmpty}</div>
        ) : (
          envVars.map((item) => (
            <div key={item.id} className="px-3 py-2 flex items-center justify-between text-[12px] font-mono">
              <span className="text-[var(--text)] truncate mr-2">{item.key}</span>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-[var(--text-muted)]">{item.maskedValue}</span>
                <button
                  type="button"
                  disabled={deletingId === item.id}
                  aria-label={`${t.delete} ${item.key}`}
                  onClick={() => void handleDelete(item)}
                  className="text-[var(--text-muted)] hover:text-[var(--error-text)] cursor-pointer disabled:opacity-50"
                >
                  {deletingId === item.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                  )}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </ModalShell>
  );
}

// ============================================================
// PROJECT RULES MODAL (WS-12)
// ============================================================
interface ProjectRulesModalProps {
  projectId: string;
  initialRules: string;
  locale: Locale;
  onSaved: () => Promise<void>;
  onClose: () => void;
}

export function ProjectRulesModal({ projectId, initialRules, locale, onSaved, onClose }: ProjectRulesModalProps) {
  const t = COPY[locale];
  const titleId = useId();
  const [rules, setRules] = useState(initialRules);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.updateProject(projectId, { rules });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projectRulesSaveFail);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      busy={saving}
      ariaLabelledBy={titleId}
      maxWidthClass="max-w-[520px]"
      className="p-5 space-y-4"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
        <h2 id={titleId} className="text-[16px] font-semibold text-[var(--text)]">
          {t.projectRules}
        </h2>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          aria-label={t.close}
          className="h-7 w-7 rounded-[6px] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] cursor-pointer disabled:opacity-50"
        >
          <X className="w-4 h-4" strokeWidth={1.5} />
        </button>
      </div>
      <p className="text-[12px] text-[var(--text-muted)]">{t.projectRulesDesc}</p>
      <form onSubmit={handleSave} className="space-y-3">
        <textarea
          rows={6}
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          placeholder={t.projectRulesPlaceholder}
          aria-label={t.projectRules}
          className="w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] p-3 text-[13px] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
        {error && (
          <div role="alert" className="text-[12px] text-[var(--error-text)] flex items-center gap-1.5">
            <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.5} />
            <span>{error}</span>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] text-[13px] text-[var(--text)] hover:bg-[var(--surface-2)] cursor-pointer disabled:opacity-50"
          >
            {t.cancel}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-8 px-4 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
            <span>{t.save}</span>
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ============================================================
// DIFF VIEWER MODAL (WS-8)
// ============================================================
interface DiffModalProps {
  projectId: string;
  versionId: string;
  locale: Locale;
  onClose: () => void;
}

export function DiffModal({ projectId, versionId, locale, onClose }: DiffModalProps) {
  const t = COPY[locale];
  const titleId = useId();
  const [label, setLabel] = useState('');
  const [diffs, setDiffs] = useState<Array<{ path: string; before: string; after: string; changed: boolean }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      api
        .getVersionDiff(projectId, versionId)
        .then((res) => {
          if (!cancelled) {
            setLabel(res.label);
            setDiffs(res.diffs);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : t.diffLoadFail);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, versionId, t.diffLoadFail]);

  return (
    <ModalShell
      open
      onClose={onClose}
      ariaLabelledBy={titleId}
      maxWidthClass="max-w-[760px]"
      className="max-h-[80vh] flex flex-col overflow-hidden"
    >
      <div className="px-5 py-3 border-b border-[var(--border)] flex items-center justify-between shrink-0">
        <h2 id={titleId} className="text-[16px] font-semibold text-[var(--text)]">
          Diff · {label || versionId}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.close}
          className="h-7 w-7 rounded-[6px] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] cursor-pointer"
        >
          <X className="w-4 h-4" strokeWidth={1.5} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading ? (
          <div className="text-[13px] text-[var(--text-muted)]">{t.diffLoading}</div>
        ) : error ? (
          <div role="alert" className="text-[12px] text-[var(--error-text)] flex items-center gap-1.5">
            <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.5} />
            <span>{error}</span>
          </div>
        ) : (
          diffs.map((item) => (
            <div key={item.path} className="rounded-[6px] border border-[var(--border)] overflow-hidden">
              <div className="px-3 py-1.5 bg-[var(--surface-2)] border-b border-[var(--border)] flex items-center justify-between text-[12px] font-mono">
                <span className="text-[var(--text)]">{item.path}</span>
                <span className={item.changed ? 'text-[var(--warning-text)]' : 'text-[var(--text-muted)]'}>
                  {item.changed ? t.diffChanged : t.diffUnchanged}
                </span>
              </div>
              {item.changed && (
                <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[var(--border)] text-[12px] font-mono">
                  <pre className="p-2.5 overflow-x-auto max-h-48 text-[var(--text-muted)] whitespace-pre-wrap">
                    {item.before || (locale === 'id' ? '(file baru)' : '(new file)')}
                  </pre>
                  <pre className="p-2.5 overflow-x-auto max-h-48 text-[var(--text)] whitespace-pre-wrap">
                    {item.after || (locale === 'id' ? '(dihapus)' : '(deleted)')}
                  </pre>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </ModalShell>
  );
}
