import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Container,
  Download,
  ExternalLink,
  Globe,
  Loader2,
  Rocket,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { COPY, formatDateTime } from '../../i18n';
import { api } from '../../lib/api';
import type { DeploymentRecord, DeploymentTarget, Locale } from '../../types';
import { ModalShell } from '../ConfirmDialog';

interface DeployModalProps {
  projectId: string;
  projectName: string;
  locale: Locale;
  onClose: () => void;
}

const TARGET_OPTIONS: Array<{
  id: DeploymentTarget;
  label: string;
  descId: string;
  descEn: string;
  icon: typeof Rocket;
}> = [
  {
    id: 'vercel',
    label: 'Vercel',
    descId: 'Deploy langsung via Vercel Deployments API v13.',
    descEn: 'Direct deploy via Vercel Deployments API v13.',
    icon: Rocket,
  },
  {
    id: 'netlify',
    label: 'Netlify',
    descId: 'Unggah paket ZIP proyek langsung ke Netlify Site API.',
    descEn: 'Upload clean project ZIP directly to Netlify Site API.',
    icon: Globe,
  },
  {
    id: 'cloudflare-pages',
    label: 'Cloudflare Pages',
    descId: 'Upload langsung ke Cloudflare Pages Direct Upload v4.',
    descEn: 'Direct upload via Cloudflare Pages API v4.',
    icon: Cloud,
  },
  {
    id: 'self-hosted',
    label: 'Self-Hosted',
    descId: 'Hasilkan Dockerfile + docker-compose.yml dan unduh paket ZIP.',
    descEn: 'Generate Dockerfile + docker-compose.yml and download clean ZIP.',
    icon: Container,
  },
];

export function DeployModal({ projectId, projectName, locale, onClose }: DeployModalProps) {
  const t = COPY[locale];
  const isId = locale === 'id';
  const titleId = useId();

  const [target, setTarget] = useState<DeploymentTarget>('self-hosted');
  const [deployName, setDeployName] = useState(projectName);
  const [apiToken, setApiToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [production, setProduction] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [latestDeployment, setLatestDeployment] = useState<DeploymentRecord | null>(null);
  const [selfHostedArtifacts, setSelfHostedArtifacts] = useState<Record<string, string> | null>(null);
  const [history, setHistory] = useState<DeploymentRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api.listDeployments(projectId);
      setHistory(res.deployments);
    } catch {
      // Ignore transient load errors
    } finally {
      setLoadingHistory(false);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) void loadHistory();
    });
    return () => {
      cancelled = true;
    };
  }, [loadHistory]);

  async function handleDeploy(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    setSelfHostedArtifacts(null);

    try {
      const res = await api.createDeployment(projectId, {
        target,
        projectName: deployName.trim() || projectName,
        apiToken: apiToken.trim() || undefined,
        teamId: teamId.trim() || undefined,
        siteId: siteId.trim() || undefined,
        accountId: accountId.trim() || undefined,
        production,
      });
      setLatestDeployment(res.deployment);
      if (res.artifacts) {
        setSelfHostedArtifacts(res.artifacts);
      }
      if (res.deployment.status === 'failed') {
        const lastErr = [...res.deployment.logs].reverse().find((l) => l.level === 'error');
        setErrorMsg(lastErr?.message || t.deployFailedFallback);
      }
      await loadHistory();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t.deployStartFail);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDownloadZip() {
    if (downloadingZip) return;
    setErrorMsg(null);
    setDownloadingZip(true);
    try {
      await api.downloadProjectZip(projectId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t.exportZipFail);
    } finally {
      setDownloadingZip(false);
    }
  }

  const selectedTargetLabel = TARGET_OPTIONS.find((o) => o.id === target)?.label ?? target;

  return (
    <ModalShell
      open
      onClose={onClose}
      busy={submitting}
      ariaLabelledBy={titleId}
      maxWidthClass="max-w-[680px]"
      className="max-h-[88vh] flex flex-col overflow-hidden"
    >
      <div className="h-11 px-4 border-b border-[var(--border)] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Rocket className="w-4 h-4 text-[var(--accent-text)]" strokeWidth={1.6} />
          <h2 id={titleId} className="text-[14px] font-semibold text-[var(--text)]">
            {t.deployModalTitle}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          aria-label={t.close}
          className="h-7 w-7 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] flex items-center justify-center cursor-pointer disabled:opacity-50"
        >
          <X className="w-4 h-4" strokeWidth={1.6} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup" aria-label={t.deployTargetAria}>
          {TARGET_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const selected = target === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  setTarget(opt.id);
                  setErrorMsg(null);
                }}
                className={`p-2.5 rounded-[6px] border text-left transition-colors cursor-pointer ${
                  selected
                    ? 'border-[var(--accent)] bg-[var(--surface-2)] text-[var(--text)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)]'
                }`}
              >
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text)]">
                  <Icon className="w-3.5 h-3.5 text-[var(--accent-text)] shrink-0" strokeWidth={1.6} />
                  <span className="truncate">{opt.label}</span>
                </div>
                <p className="mt-1 text-[12px] leading-snug text-[var(--text-muted)]">
                  {isId ? opt.descId : opt.descEn}
                </p>
              </button>
            );
          })}
        </div>

        <form onSubmit={(e) => void handleDeploy(e)} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-[12px] font-medium text-[var(--text)]">{t.deployNameLabel}</span>
              <input
                type="text"
                value={deployName}
                onChange={(e) => setDeployName(e.target.value)}
                placeholder="my-carmen-app"
                className="w-full h-8 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              />
            </label>

            {target !== 'self-hosted' && (
              <label className="block space-y-1">
                <span className="text-[12px] font-medium text-[var(--text)]">
                  {target === 'vercel'
                    ? 'Vercel API Token'
                    : target === 'netlify'
                      ? 'Netlify Personal Access Token'
                      : 'Cloudflare API Token'}
                </span>
                <input
                  type="password"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  placeholder={t.deployTokenPlaceholder}
                  className="w-full h-8 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] font-mono text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </label>
            )}
          </div>

          {target === 'vercel' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <label className="block space-y-1">
                <span className="text-[12px] font-medium text-[var(--text)]">
                  Team ID <span className="text-[var(--text-muted)] font-normal">({t.deployOptional})</span>
                </span>
                <input
                  type="text"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  placeholder="team_..."
                  className="w-full h-8 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] font-mono text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </label>
              <label className="flex items-center gap-2 h-8 text-[12px] text-[var(--text)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={production}
                  onChange={(e) => setProduction(e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                <span>{t.deployProductionTarget}</span>
              </label>
            </div>
          )}

          {target === 'netlify' && (
            <label className="block space-y-1">
              <span className="text-[12px] font-medium text-[var(--text)]">Netlify Site ID</span>
              <input
                type="text"
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="w-full h-8 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] font-mono text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              />
            </label>
          )}

          {target === 'cloudflare-pages' && (
            <label className="block space-y-1">
              <span className="text-[12px] font-medium text-[var(--text)]">Cloudflare Account ID</span>
              <input
                type="text"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="32-char Cloudflare Account ID"
                className="w-full h-8 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] font-mono text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              />
            </label>
          )}

          {target === 'self-hosted' && (
            <p className="text-[12px] text-[var(--text-muted)]">{t.deploySelfHostedDesc}</p>
          )}

          {errorMsg && (
            <div
              role="alert"
              className="rounded-[6px] border border-[var(--error)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--error-text)] flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.6} />
              <span className="break-words">{errorMsg}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <button
              type="button"
              disabled={downloadingZip}
              onClick={() => void handleDownloadZip()}
              className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[12px] text-[var(--text)] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {downloadingZip ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.6} />
              ) : (
                <Download className="w-3.5 h-3.5" strokeWidth={1.6} />
              )}
              <span>{t.deployDownloadCleanZip}</span>
            </button>

            <button
              type="submit"
              disabled={submitting}
              className="h-8 px-4 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              {submitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.8} />
              ) : (
                <Rocket className="w-3.5 h-3.5" strokeWidth={1.6} />
              )}
              <span>
                {submitting
                  ? t.deploySubmitting
                  : target === 'self-hosted'
                    ? t.deployGenerateSelfHosted
                    : t.deployToTarget.replace('{target}', selectedTargetLabel)}
              </span>
            </button>
          </div>
        </form>

        {latestDeployment && (
          <div className="rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text)]">
                {latestDeployment.status === 'failed' ? (
                  <AlertCircle className="w-4 h-4 text-[var(--error-text)]" strokeWidth={1.6} />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-[var(--success-text)]" strokeWidth={1.6} />
                )}
                <span>
                  {latestDeployment.target} · {latestDeployment.status.toUpperCase()}
                </span>
              </div>
              {latestDeployment.deploymentUrl && (
                <a
                  href={latestDeployment.deploymentUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] text-[var(--accent-text)] hover:underline inline-flex items-center gap-1 font-mono"
                >
                  <span>{latestDeployment.deploymentUrl}</span>
                  <ExternalLink className="w-3 h-3" strokeWidth={1.6} />
                </a>
              )}
            </div>

            <div className="max-h-36 overflow-y-auto rounded-[6px] border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[12px] space-y-1">
              {latestDeployment.logs.map((l, idx) => (
                <div
                  key={`${l.timestamp}-${idx}`}
                  className={
                    l.level === 'error'
                      ? 'text-[var(--error-text)]'
                      : l.level === 'success'
                        ? 'text-[var(--success-text)]'
                        : 'text-[var(--text-muted)]'
                  }
                >
                  [{l.level}] {l.message}
                </div>
              ))}
            </div>

            {selfHostedArtifacts && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                {Object.entries(selfHostedArtifacts).map(([file, content]) => (
                  <div key={file} className="rounded-[6px] border border-[var(--border)] bg-[var(--bg)] p-2">
                    <div className="text-[12px] font-mono font-semibold text-[var(--text)] mb-1">{file}</div>
                    <pre className="text-[12px] font-mono text-[var(--text-muted)] whitespace-pre-wrap overflow-x-auto">
                      {content.trim()}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <div className="text-[12px] font-semibold text-[var(--text)]">{t.deployHistoryTitle}</div>
          {loadingHistory ? (
            <div className="text-[12px] text-[var(--text-muted)]">{t.deployLoadingHistory}</div>
          ) : history.length === 0 ? (
            <div className="text-[12px] text-[var(--text-muted)]">{t.deployNoHistory}</div>
          ) : (
            <div className="divide-y divide-[var(--border)] rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)]">
              {history.slice(0, 8).map((item) => (
                <div key={item.id} className="px-3 py-2 flex items-center justify-between gap-2 text-[12px]">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[var(--text)]">{item.target}</span>
                      <span
                        className={`font-mono text-[12px] ${
                          item.status === 'failed'
                            ? 'text-[var(--error-text)]'
                            : item.status === 'ready'
                              ? 'text-[var(--success-text)]'
                              : 'text-[var(--warning-text)]'
                        }`}
                      >
                        {item.status}
                      </span>
                    </div>
                    <div className="text-[12px] font-mono text-[var(--text-muted)] truncate">
                      {formatDateTime(item.createdAt, locale)} · {item.projectName}
                    </div>
                  </div>
                  {item.deploymentUrl ? (
                    <a
                      href={item.deploymentUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[12px] font-mono text-[var(--accent-text)] hover:underline shrink-0 inline-flex items-center gap-1"
                    >
                      <span>{t.open}</span>
                      <ExternalLink className="w-3 h-3" strokeWidth={1.6} />
                    </a>
                  ) : (
                    <span className="text-[12px] font-mono text-[var(--text-muted)] shrink-0">
                      {item.externalId || item.id}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
