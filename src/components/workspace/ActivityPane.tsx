import {
  Activity as ActivityIcon,
  AlertCircle,
  CheckCircle2,
  Code2,
  GitCommitHorizontal,
  Loader2,
  MessageSquare,
  Rocket,
  Search,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { COPY, formatDateTime } from '../../i18n';
import type {
  ChatMessage,
  DeploymentRecord,
  Locale,
  ProjectFile,
  ProjectSummary,
  ProjectVersion,
} from '../../types';

interface ActivityPaneProps {
  locale: Locale;
  project: ProjectSummary;
  files: ProjectFile[];
  versions: ProjectVersion[];
  messages: ChatMessage[];
  deployments: DeploymentRecord[];
  onOpenDiff: (versionId: string) => void;
  onOpenCodeTab: () => void;
}

type ActivityFilter = 'all' | 'changes' | 'deployments' | 'prompts';

interface ProjectActivityItem {
  id: string;
  category: 'changes' | 'deployments' | 'prompts';
  kind: 'version' | 'file' | 'deployment' | 'prompt';
  title: string;
  detail: string;
  status?: 'success' | 'failed' | 'running' | 'info';
  createdAt: string;
  versionId?: string;
}

function parseTimestampMs(ts: string): number {
  const normalized = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function ActivityPane({
  locale,
  project,
  files,
  versions,
  messages,
  deployments,
  onOpenDiff,
  onOpenCodeTab,
}: ActivityPaneProps) {
  const t = COPY[locale];
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [search, setSearch] = useState('');

  const allItems = useMemo(() => {
    const items: ProjectActivityItem[] = [];

    for (const m of messages) {
      if (m.role !== 'user') continue;
      items.push({
        id: `prompt_${m.id}`,
        category: 'prompts',
        kind: 'prompt',
        title: m.content.trim() || '—',
        detail: m.mode === 'discuss' ? t.modeDiscuss : t.modeBuild,
        status: 'info',
        createdAt: m.createdAt,
      });
    }

    const versionTimes = versions.map((v) => parseTimestampMs(v.createdAt));
    for (const v of versions) {
      items.push({
        id: `ver_${v.id}`,
        category: 'changes',
        kind: 'version',
        title: v.label,
        detail: `${v.fileCount} ${t.colFile.toLowerCase()}`,
        status: 'info',
        createdAt: v.createdAt,
        versionId: v.id,
      });
    }

    const projectCreatedMs = parseTimestampMs(project.createdAt);
    for (const f of files) {
      const fMs = parseTimestampMs(f.updatedAt);
      const nearVersion = versionTimes.some((vt) => Math.abs(vt - fMs) <= 2500);
      const nearInit = Math.abs(projectCreatedMs - fMs) <= 2500;
      if (!nearVersion && !nearInit) {
        items.push({
          id: `file_${f.id}_${f.updatedAt}`,
          category: 'changes',
          kind: 'file',
          title: f.path,
          detail: t.activityChangeLabel,
          status: 'info',
          createdAt: f.updatedAt,
        });
      }
    }

    for (const d of deployments) {
      const status: ProjectActivityItem['status'] =
        d.status === 'ready' ? 'success' : d.status === 'failed' ? 'failed' : 'running';
      const statusText =
        d.status === 'ready' ? t.statusSuccess : d.status === 'failed' ? t.statusFailed : t.statusRunning;
      items.push({
        id: `dep_${d.id}`,
        category: 'deployments',
        kind: 'deployment',
        title: `${t.activityDeployLabel} · ${d.target}`,
        detail: d.deploymentUrl ? `${statusText} · ${d.deploymentUrl}` : statusText,
        status,
        createdAt: d.createdAt,
      });
    }

    return items.sort((a, b) => parseTimestampMs(b.createdAt) - parseTimestampMs(a.createdAt));
  }, [
    deployments,
    files,
    messages,
    project.createdAt,
    t.activityChangeLabel,
    t.activityDeployLabel,
    t.colFile,
    t.modeBuild,
    t.modeDiscuss,
    t.statusFailed,
    t.statusRunning,
    t.statusSuccess,
    versions,
  ]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allItems.filter((item) => {
      if (filter !== 'all' && item.category !== filter) return false;
      if (q && !item.title.toLowerCase().includes(q) && !item.detail.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allItems, filter, search]);

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] p-4 sm:p-5">
      <div className="mx-auto max-w-[920px] space-y-4">
        {/* Header & project metadata summary */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--border)]">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--text)] flex items-center gap-2">
              <ActivityIcon className="w-4 h-4 text-[var(--accent-text)]" strokeWidth={1.6} />
              <span>{t.activityTabTitle}</span>
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--text-muted)] font-mono tabular-nums">
              {project.name} · {files.length} {t.colFile.toLowerCase()} · {versions.length} {t.colVersions.toLowerCase()} ·{' '}
              {deployments.length} {t.activityDeployLabel.toLowerCase()}
            </p>
          </div>

          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 w-full sm:w-auto">
            <div className="relative w-full sm:w-[220px]">
              <Search
                className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                strokeWidth={1.5}
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t.activitySearchPlaceholder}
                aria-label={t.activitySearchPlaceholder}
                className="w-full h-9 sm:h-7 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] pl-8 pr-2.5 text-[16px] sm:text-[12px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>

            <div
              role="group"
              aria-label={t.activityTabTitle}
              className="inline-flex items-center gap-0.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-0.5 max-w-full overflow-x-auto no-scrollbar"
            >
              {(
                [
                  ['all', t.activityFilterAll],
                  ['changes', t.activityFilterChanges],
                  ['deployments', t.activityFilterDeployments],
                  ['prompts', t.activityFilterPrompts],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                  className={`h-7 sm:h-6 px-2.5 sm:px-2 rounded-[5px] text-[12px] font-medium whitespace-nowrap cursor-pointer ${
                    filter === id
                      ? 'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Chronological list */}
        {filteredItems.length === 0 ? (
          <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-[13px] text-[var(--text-muted)]">
            {t.activityEmpty}
          </div>
        ) : (
          <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {filteredItems.map((item) => {
              const Icon =
                item.kind === 'prompt'
                  ? MessageSquare
                  : item.kind === 'deployment'
                    ? Rocket
                    : item.kind === 'file'
                      ? Code2
                      : GitCommitHorizontal;

              const kindLabel =
                item.kind === 'prompt'
                  ? t.activityPromptLabel
                  : item.kind === 'deployment'
                    ? t.activityDeployLabel
                    : t.activityChangeLabel;

              return (
                <div
                  key={item.id}
                  className="px-3.5 sm:px-4 py-3 flex flex-col sm:flex-row sm:items-start justify-between gap-2.5 sm:gap-3 hover:bg-[var(--surface-2)] transition-colors"
                >
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="mt-0.5 h-7 w-7 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] flex items-center justify-center shrink-0 text-[var(--text-muted)]">
                      <Icon className="w-3.5 h-3.5" strokeWidth={1.5} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-[var(--text)] break-words line-clamp-2">
                        {item.title}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--text-muted)]">
                        <span>{kindLabel}</span>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1">
                          {item.status === 'success' && (
                            <CheckCircle2 className="w-3 h-3 text-[var(--success-text)]" strokeWidth={1.75} />
                          )}
                          {item.status === 'failed' && (
                            <AlertCircle className="w-3 h-3 text-[var(--error-text)]" strokeWidth={1.75} />
                          )}
                          {item.status === 'running' && (
                            <Loader2 className="w-3 h-3 animate-spin text-[var(--accent-text)]" strokeWidth={1.75} />
                          )}
                          <span
                            className={
                              item.status === 'success'
                                ? 'text-[var(--success-text)]'
                                : item.status === 'failed'
                                  ? 'text-[var(--error-text)]'
                                  : ''
                            }
                          >
                            {item.detail}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {item.versionId && (
                      <button
                        type="button"
                        onClick={() => onOpenDiff(item.versionId!)}
                        className="h-7 px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] hover:border-[var(--text-muted)] text-[12px] text-[var(--text)] cursor-pointer"
                      >
                        {t.viewDiff}
                      </button>
                    )}
                    {item.kind === 'file' && (
                      <button
                        type="button"
                        onClick={onOpenCodeTab}
                        className="h-7 px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] hover:border-[var(--text-muted)] text-[12px] text-[var(--text)] cursor-pointer"
                      >
                        {t.openFile}
                      </button>
                    )}
                    <time
                      dateTime={item.createdAt}
                      className="text-[12px] font-mono text-[var(--text-muted)] tabular-nums whitespace-nowrap"
                    >
                      {formatDateTime(item.createdAt, locale)}
                    </time>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
