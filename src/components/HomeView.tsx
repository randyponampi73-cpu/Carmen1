import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  FolderPlus,
  GitCommitHorizontal,
  Globe,
  ImagePlus,
  Loader2,
  Lock,
  Rocket,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { COPY, PROMPT_SUGGESTIONS, formatDateTime } from '../i18n';
import type {
  ActivityLogEntry,
  DashboardActivityItem,
  Locale,
  ProjectSummary,
  ProjectType,
  ProviderKeyRecord,
  ProviderModel,
} from '../types';
import { ModelSelect } from './CustomSelect';

interface TemplateItem {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  type: ProjectType;
  stack: string;
}

interface HomeViewProps {
  locale: Locale;
  keys: ProviderKeyRecord[];
  models: ProviderModel[];
  projects: ProjectSummary[];
  projectsLoading?: boolean;
  recentActivity?: DashboardActivityItem[];
  activityLog?: ActivityLogEntry[];
  activityLoading?: boolean;
  templates: TemplateItem[];
  selectedModelKey: string; // `${providerKeyId}::${modelId}`
  onSelectModelKey: (val: string) => void;
  onStartFromPrompt: (params: {
    prompt: string;
    type: ProjectType;
    imageBase64?: string;
    imageMimeType?: string;
  }) => Promise<void>;
  onCreateFromTemplate: (templateId: string) => Promise<void>;
  onOpenProject: (projectId: string) => void;
  onOpenProjects: () => void;
  onOpenSettings: () => void;
}

const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function parseDateMs(raw: string): number {
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toLocalDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function HomeView({
  locale,
  keys,
  models,
  projects,
  projectsLoading = false,
  recentActivity = [],
  activityLog = [],
  activityLoading = false,
  templates,
  selectedModelKey,
  onSelectModelKey,
  onStartFromPrompt,
  onCreateFromTemplate,
  onOpenProject,
  onOpenProjects,
  onOpenSettings,
}: HomeViewProps) {
  const t = COPY[locale];
  const [homeTab, setHomeTab] = useState<'overview' | 'activity-log'>('overview');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [creatingTemplate, setCreatingTemplate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingChip, setPendingChip] = useState<{ label: string; prompt: string; type: ProjectType } | null>(null);
  const [attachedImage, setAttachedImage] = useState<{
    name: string;
    base64: string;
    mimeType: string;
    previewUrl: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const hasValidKey = keys.length > 0;
  const activeModel = useMemo(
    () => models.find((m) => `${m.providerKeyId}::${m.id}` === selectedModelKey) ?? models[0] ?? null,
    [models, selectedModelKey]
  );
  const canAttachImage = hasValidKey && activeModel?.vision === 'yes';

  const recentProjects = useMemo(() => projects.filter((p) => !p.archived).slice(0, 6), [projects]);

  const { velocityData, totalCreated14d } = useMemo(() => {
    const days = 14;
    const counts = new Map<string, number>();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const series: Array<{ dateKey: string; label: string; count: number }> = [];
    const formatter = new Intl.DateTimeFormat(locale === 'id' ? 'id-ID' : 'en-US', {
      day: 'numeric',
      month: 'short',
    });

    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = toLocalDayKey(d);
      counts.set(key, 0);
      series.push({ dateKey: key, label: formatter.format(d), count: 0 });
    }

    let total = 0;
    for (const proj of projects) {
      const ms = parseDateMs(proj.createdAt);
      if (!ms) continue;
      const key = toLocalDayKey(new Date(ms));
      if (counts.has(key)) {
        counts.set(key, (counts.get(key) || 0) + 1);
        total += 1;
      }
    }

    return {
      velocityData: series.map((pt) => ({ ...pt, count: counts.get(pt.dateKey) || 0 })),
      totalCreated14d: total,
    };
  }, [projects, locale]);

  const isMac = useMemo(
    () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent),
    []
  );

  async function handleSubmit() {
    if (!hasValidKey || !prompt.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onStartFromPrompt({
        prompt: prompt.trim(),
        type: 'web',
        imageBase64: attachedImage?.base64,
        imageMimeType: attachedImage?.mimeType,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t.startProjectFail);
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    }
  }

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);

    if (!ALLOWED_IMAGE_MIME.has(file.type)) {
      setError(t.invalidImageType);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(t.imageTooLarge);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.split(',')[1] || '';
      setAttachedImage({
        name: file.name,
        base64,
        mimeType: file.type,
        previewUrl: dataUrl,
      });
    };
    reader.onerror = () => {
      setError(t.invalidImageType);
    };
    reader.readAsDataURL(file);
  }

  function applySuggestion(chip: { label: string; prompt: string; type: ProjectType }) {
    setPrompt(chip.prompt);
    setPendingChip(null);
    requestAnimationFrame(() => promptRef.current?.focus());
  }

  async function runCreateTemplate(templateId: string) {
    if (creatingTemplate !== null) return;
    setError(null);
    setCreatingTemplate(templateId);
    try {
      await onCreateFromTemplate(templateId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.createProjectFail);
    } finally {
      setCreatingTemplate(null);
    }
  }

  return (
    <main className="flex-1 overflow-y-auto px-4 sm:px-8 py-8 sm:py-10">
      <div className="mx-auto max-w-[960px] space-y-8">
        {/* Hero heading & Home Dashboard Tabs */}
        <section>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-[20px] sm:text-[28px] font-semibold tracking-tight text-[var(--text)] leading-tight">
                {t.heroTitle}
              </h1>
              <p className="mt-1.5 text-[14px] text-[var(--text-muted)] max-w-[62ch]">{t.heroSub}</p>
            </div>

            <div
              role="tablist"
              aria-label={t.homeTabsAria}
              className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-0.5 shrink-0"
            >
              {(
                [
                  ['overview', t.homeTabOverview],
                  ['activity-log', t.homeTabActivityLog],
                ] as const
              ).map(([tabId, label]) => (
                <button
                  key={tabId}
                  role="tab"
                  type="button"
                  aria-selected={homeTab === tabId}
                  onClick={() => setHomeTab(tabId)}
                  className={`h-7 px-3 rounded-[5px] text-[12px] font-medium whitespace-nowrap cursor-pointer ${
                    homeTab === tabId
                      ? 'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {homeTab === 'overview' && (
            <>
              {!hasValidKey && (
                <div
                  role="status"
                  className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[var(--warning)] bg-[var(--surface)] px-4 py-3 text-[13px]"
                >
                  <div className="flex items-center gap-2 text-[var(--text)]">
                    <Lock className="w-4 h-4 text-[var(--warning-text)] shrink-0" strokeWidth={1.5} />
                    <span>{t.noKeyBanner}</span>
                  </div>
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="h-8 px-3 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium whitespace-nowrap cursor-pointer"
                  >
                    {t.connectProvider}
                  </button>
                </div>
              )}

              {/* Rectangular Prompt Box — 1px border, 2px accent focus ring, no glow */}
              <div className="mt-5 rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface)] focus-within:ring-2 focus-within:ring-[var(--accent)] focus-within:border-[var(--accent)]">
                <label htmlFor="home-prompt" className="sr-only">
                  {t.heroTitle}
                </label>
                <textarea
                  ref={promptRef}
                  id="home-prompt"
                  rows={4}
                  disabled={!hasValidKey || submitting}
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    if (pendingChip) setPendingChip(null);
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={t.promptPlaceholder}
                  className="w-full resize-none bg-transparent px-3.5 sm:px-4 pt-3.5 pb-2 text-[16px] sm:text-[14px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none disabled:opacity-60"
                />

                {attachedImage && (
                  <div className="px-3.5 sm:px-4 pb-2 flex items-center gap-2.5 text-[12px] text-[var(--text-muted)]">
                    <img
                      src={attachedImage.previewUrl}
                      alt={attachedImage.name}
                      className="w-8 h-8 object-cover rounded-[6px] border border-[var(--border)] shrink-0"
                    />
                    <span className="font-mono truncate max-w-[200px] sm:max-w-[260px] text-[var(--text)]">{attachedImage.name}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setAttachedImage(null);
                        if (fileInputRef.current) fileInputRef.current.value = '';
                      }}
                      aria-label={t.removeImageAria}
                      className="h-8 w-8 sm:h-7 sm:w-7 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] flex items-center justify-center cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" strokeWidth={1.5} />
                    </button>
                  </div>
                )}

                <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-2.5 sm:gap-2 border-t border-[var(--border)] px-3 py-2.5 sm:py-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    {/* Model dropdown */}
                    <div className="flex-1 min-w-[160px] sm:flex-none sm:w-[250px] max-w-full">
                      <ModelSelect
                        ariaLabel={t.selectModelLabel}
                        locale={locale}
                        models={models}
                        value={activeModel ? `${activeModel.providerKeyId}::${activeModel.id}` : ''}
                        onChange={onSelectModelKey}
                        showTierFilter
                        popoverClassName="w-[min(360px,calc(100vw-24px))]"
                      />
                    </div>

                    {/* Attach image (WS-11) */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleImageSelect}
                      className="hidden"
                    />
                    <button
                      type="button"
                      disabled={!canAttachImage || submitting}
                      onClick={() => fileInputRef.current?.click()}
                      title={
                        !hasValidKey
                          ? t.attachImageDisabledNoKey
                          : activeModel?.vision !== 'yes'
                            ? t.attachImageDisabledNoVision
                            : t.attachImage
                      }
                      aria-label={t.attachImage}
                      className="h-10 w-10 sm:h-8 sm:w-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
                    >
                      <ImagePlus className="w-4 h-4" strokeWidth={1.5} />
                    </button>
                  </div>

                  <button
                    type="button"
                    disabled={!hasValidKey || !prompt.trim() || submitting}
                    onClick={() => void handleSubmit()}
                    title={isMac ? t.shortcutHintMac : t.shortcutHintOther}
                    className="h-10 sm:h-8 w-full sm:w-auto px-4 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap cursor-pointer shrink-0"
                  >
                    {submitting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                    ) : (
                      <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.5} />
                    )}
                    <span>{t.send}</span>
                  </button>
                </div>
              </div>

              <div className="mt-1.5 flex items-center justify-between text-[12px] text-[var(--text-muted)]">
                <span>{isMac ? t.shortcutHintMac : t.shortcutHintOther}</span>
              </div>

              {error && (
                <div role="alert" className="mt-3 flex items-center gap-2 text-[13px] text-[var(--error-text)]">
                  <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.5} />
                  <span>{error}</span>
                </div>
              )}

              {pendingChip && (
                <div
                  role="status"
                  className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[12px]"
                >
                  <span className="text-[var(--text)]">{t.confirmReplacePrompt}</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setPendingChip(null)}
                      className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[12px] text-[var(--text)] cursor-pointer"
                    >
                      {t.no}
                    </button>
                    <button
                      type="button"
                      onClick={() => applySuggestion(pendingChip)}
                      className="h-7 px-2.5 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium cursor-pointer"
                    >
                      {t.yes}
                    </button>
                  </div>
                </div>
              )}

              {/* Prompt suggestion chips (TPL-2) — concrete requests */}
              <div className="mt-3 flex flex-wrap gap-2">
                {PROMPT_SUGGESTIONS[locale].map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    disabled={!hasValidKey || submitting}
                    onClick={() => {
                      if (!hasValidKey || submitting) return;
                      if (prompt.trim() && prompt.trim() !== chip.prompt.trim()) {
                        setPendingChip(chip);
                      } else {
                        applySuggestion(chip);
                      }
                    }}
                    className="h-7 px-2.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] text-left disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        {homeTab === 'overview' ? (
          <>
            {/* Recent Projects Table with conditional pulsing loader */}
            <section className="pt-2 border-t border-[var(--border)]">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[16px] font-semibold text-[var(--text)]">{t.recentProjects}</h2>
                <button
                  type="button"
                  onClick={onOpenProjects}
                  className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
                >
                  {t.viewAll}
                </button>
              </div>

              {projectsLoading ? (
                <div
                  aria-busy="true"
                  aria-label={t.recentProjects}
                  className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]"
                >
                  {[1, 2, 3].map((row) => (
                    <div key={row} className="h-[46px] px-4 flex items-center justify-between gap-4 animate-pulse">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="h-3.5 w-40 rounded-[6px] bg-[var(--surface-2)]" />
                        <div className="h-3.5 w-16 rounded-[6px] bg-[var(--surface-2)] hidden sm:block" />
                        <div className="h-3.5 w-36 rounded-[6px] bg-[var(--surface-2)] hidden md:block" />
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="h-3.5 w-8 rounded-[6px] bg-[var(--surface-2)]" />
                        <div className="h-7 w-14 rounded-[6px] bg-[var(--surface-2)]" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : recentProjects.length === 0 ? (
                <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
                  <p className="text-[13px] text-[var(--text-muted)] mb-3">{t.emptyProjects}</p>
                  <button
                    type="button"
                    disabled={templates.length === 0 || creatingTemplate !== null}
                    onClick={() => templates[0] && void runCreateTemplate(templates[0].id)}
                    className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] font-medium text-[var(--text)] disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    {creatingTemplate !== null && creatingTemplate === templates[0]?.id && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                    )}
                    <span>{t.createFirstProject}</span>
                  </button>
                </div>
              ) : (
                <>
                  {/* Mobile card list (zero horizontal table scroll on 320px-639px) */}
                  <div className="sm:hidden rounded-[8px] border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
                    {recentProjects.map((proj) => (
                      <button
                        key={proj.id}
                        type="button"
                        onClick={() => onOpenProject(proj.id)}
                        className="w-full px-3.5 py-3 flex items-center justify-between gap-3 text-left hover:bg-[var(--surface-2)] cursor-pointer min-h-[56px]"
                      >
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="text-[13px] font-semibold text-[var(--text)] truncate">{proj.name}</div>
                          <div className="text-[12px] text-[var(--text-muted)] flex items-center gap-2 font-mono tabular-nums">
                            <span className="inline-flex items-center gap-1 font-sans">
                              <Globe className="w-3 h-3" strokeWidth={1.6} />
                              <span>{t.web}</span>
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{proj.fileCount} {t.colFile.toLowerCase()}</span>
                          </div>
                        </div>
                        <span className="h-8 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[12px] font-medium text-[var(--text)] inline-flex items-center shrink-0">
                          {t.open}
                        </span>
                      </button>
                    ))}
                  </div>

                  {/* Desktop & Tablet table */}
                  <div className="hidden sm:block rounded-[8px] border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
                    <table aria-label={t.recentProjectsTableAria} className="w-full text-left border-collapse text-[13px]">
                      <thead>
                        <tr className="border-b border-[var(--border)] text-[12px] text-[var(--text-muted)]">
                          <th scope="col" className="py-2.5 px-4 font-medium">{t.colProjectName}</th>
                          <th scope="col" className="py-2.5 px-3 font-medium">{t.colType}</th>
                          <th scope="col" className="py-2.5 px-3 font-medium hidden md:table-cell">{t.colStack}</th>
                          <th scope="col" className="py-2.5 px-3 font-medium text-right tabular-nums">{t.colFile}</th>
                          <th scope="col" className="py-2.5 px-4 font-medium text-right">{t.colAction}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {recentProjects.map((proj) => (
                          <tr key={proj.id} className="hover:bg-[var(--surface-2)]">
                            <td className="py-2.5 px-4 font-medium text-[var(--text)]">
                              <button
                                type="button"
                                onClick={() => onOpenProject(proj.id)}
                                className="hover:underline text-left cursor-pointer"
                              >
                                {proj.name}
                              </button>
                            </td>
                            <td className="py-2.5 px-3 text-[var(--text-muted)] whitespace-nowrap">
                              <span className="inline-flex items-center gap-1.5">
                                <Globe className="w-3.5 h-3.5" strokeWidth={1.5} />
                                <span>{t.web}</span>
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-[var(--text-muted)] hidden md:table-cell truncate max-w-[260px]">
                              {proj.stack}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono text-[12px] text-[var(--text-muted)] tabular-nums">
                              {proj.fileCount}
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => onOpenProject(proj.id)}
                                className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] hover:border-[var(--text-muted)] text-[12px] font-medium text-[var(--text)] cursor-pointer"
                              >
                                {t.open}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>

            {/* Velocity Chart (Recharts) & Recent Activity Panel */}
            <section className="pt-2 border-t border-[var(--border)] grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
              {/* Project Creation Velocity Widget */}
              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col justify-between gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="text-[15px] font-semibold text-[var(--text)]">{t.velocityTitle}</h2>
                    <p className="text-[12px] text-[var(--text-muted)]">{t.velocitySubtitle}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-[20px] font-semibold font-mono tabular-nums text-[var(--text)]">
                      {totalCreated14d}
                    </span>
                    <div className="text-[11px] text-[var(--text-muted)]">{t.velocityProjectsCreated}</div>
                  </div>
                </div>

                {projectsLoading ? (
                  <div className="h-[190px] w-full rounded-[6px] bg-[var(--surface-2)] animate-pulse" />
                ) : totalCreated14d === 0 ? (
                  <div className="h-[190px] w-full flex items-center justify-center text-center text-[13px] text-[var(--text-muted)] px-4">
                    {t.velocityEmpty}
                  </div>
                ) : (
                  <div className="h-[190px] w-full min-w-0">
                    <ResponsiveContainer width="100%" height={190} minWidth={0}>
                      <AreaChart data={velocityData} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
                        <defs>
                          <linearGradient id="carmenVelocityFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.28} />
                            <stop offset="95%" stopColor="var(--accent)" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                        <XAxis
                          dataKey="label"
                          tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                          tickLine={false}
                          axisLine={{ stroke: 'var(--border)' }}
                          minTickGap={24}
                        />
                        <YAxis
                          allowDecimals={false}
                          tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip
                          cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
                          content={({ active, payload }) => {
                            if (!active || !payload || payload.length === 0) return null;
                            const pt = payload[0].payload as { label: string; count: number };
                            return (
                              <div className="rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 py-1.5 text-[12px]">
                                <div className="text-[var(--text-muted)]">{pt.label}</div>
                                <div className="font-mono font-semibold tabular-nums text-[var(--text)]">
                                  {pt.count} {t.velocityProjectsCreated.toLowerCase()}
                                </div>
                              </div>
                            );
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="count"
                          stroke="var(--accent)"
                          strokeWidth={2}
                          fill="url(#carmenVelocityFill)"
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              {/* Recent Activity Panel */}
              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <h2 className="text-[15px] font-semibold text-[var(--text)] flex items-center gap-2">
                    <Activity className="w-4 h-4 text-[var(--accent-text)]" strokeWidth={1.5} />
                    <span>{t.recentActivityTitle}</span>
                  </h2>
                  <button
                    type="button"
                    onClick={() => setHomeTab('activity-log')}
                    className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
                  >
                    {t.homeTabActivityLog}
                  </button>
                </div>

                {activityLoading ? (
                  <div className="divide-y divide-[var(--border)] flex-1">
                    {[1, 2, 3, 4].map((i) => (
                      <div key={i} className="py-2.5 flex items-center justify-between gap-3 animate-pulse">
                        <div className="h-3.5 w-44 rounded-[6px] bg-[var(--surface-2)]" />
                        <div className="h-3.5 w-16 rounded-[6px] bg-[var(--surface-2)]" />
                      </div>
                    ))}
                  </div>
                ) : recentActivity.length === 0 ? (
                  <div className="flex-1 min-h-[150px] flex items-center justify-center text-center text-[13px] text-[var(--text-muted)] px-4">
                    {t.recentActivityEmpty}
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--border)] max-h-[220px] overflow-y-auto -mx-1 px-1">
                    {recentActivity.slice(0, 8).map((item) => {
                      const Icon =
                        item.kind === 'deployment' ? Rocket : GitCommitHorizontal;
                      const kindText =
                        item.kind === 'deployment'
                          ? t.activityKindDeployment
                          : t.activityKindEdit;

                      return (
                        <div key={item.id} className="py-2 flex items-start justify-between gap-3 text-[12px]">
                          <div className="flex items-start gap-2.5 min-w-0">
                            <Icon className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 mt-0.5" strokeWidth={1.5} />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <button
                                  type="button"
                                  onClick={() => onOpenProject(item.projectId)}
                                  className="font-medium text-[var(--text)] hover:underline truncate cursor-pointer text-left"
                                >
                                  {item.projectName}
                                </button>
                                <span className="text-[var(--text-muted)] shrink-0">· {kindText}</span>
                              </div>
                              <div className="text-[var(--text-muted)] truncate flex items-center gap-1 mt-0.5">
                                {item.status === 'success' && (
                                  <CheckCircle2 className="w-3 h-3 text-[var(--success-text)] shrink-0" strokeWidth={1.75} />
                                )}
                                {item.status === 'failed' && (
                                  <AlertCircle className="w-3 h-3 text-[var(--error-text)] shrink-0" strokeWidth={1.75} />
                                )}
                                {item.status === 'running' && (
                                  <Loader2 className="w-3 h-3 animate-spin text-[var(--accent-text)] shrink-0" strokeWidth={1.75} />
                                )}
                                <span className="truncate">{item.title}</span>
                              </div>
                            </div>
                          </div>
                          <time
                            dateTime={item.createdAt}
                            className="font-mono text-[11px] text-[var(--text-muted)] tabular-nums whitespace-nowrap shrink-0"
                          >
                            {formatDateTime(item.createdAt, locale)}
                          </time>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {/* Starter Templates (TPL-1) */}
            <section className="pt-2 border-t border-[var(--border)]">
              <h2 className="text-[16px] font-semibold text-[var(--text)] mb-3">{t.templates}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {templates.map((tpl) => (
                  <div
                    key={tpl.id}
                    className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col justify-between gap-3"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2 text-[12px] text-[var(--text-muted)] mb-1">
                        <span>Web · Fullstack</span>
                      </div>
                      <h3 className="text-[14px] font-semibold text-[var(--text)]">
                        {locale === 'id' ? tpl.name : tpl.nameEn}
                      </h3>
                      <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                        {locale === 'id' ? tpl.description : tpl.descriptionEn}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={creatingTemplate !== null}
                      onClick={() => void runCreateTemplate(tpl.id)}
                      className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[12px] font-medium text-[var(--text)] self-start flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {creatingTemplate === tpl.id && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
                      <span>{t.useTemplate}</span>
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : (
          /* Lightweight Activity Log Tab */
          <section className="pt-2 border-t border-[var(--border)] space-y-3">
            <h2 className="text-[16px] font-semibold text-[var(--text)]">{t.activityLogTitle}</h2>

            {activityLoading ? (
              <div
                aria-busy="true"
                className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]"
              >
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-11 px-4 flex items-center justify-between gap-4 animate-pulse">
                    <div className="h-3.5 w-36 rounded-[6px] bg-[var(--surface-2)]" />
                    <div className="h-3.5 w-24 rounded-[6px] bg-[var(--surface-2)]" />
                  </div>
                ))}
              </div>
            ) : activityLog.length === 0 ? (
              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-6 text-center text-[13px] text-[var(--text-muted)]">
                {t.activityLogEmpty}
              </div>
            ) : (
              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
                <table aria-label={t.activityLogTitle} className="w-full text-left border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[12px] text-[var(--text-muted)]">
                      <th scope="col" className="py-2.5 px-4 font-medium">{t.colActivityType}</th>
                      <th scope="col" className="py-2.5 px-3 font-medium">{t.colProject}</th>
                      <th scope="col" className="py-2.5 px-3 font-medium">{t.colStatus}</th>
                      <th scope="col" className="py-2.5 px-4 font-medium text-right">{t.colTimestamp}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {activityLog.map((entry) => {
                      const statusLabel =
                        entry.status === 'success'
                          ? t.statusSuccess
                          : entry.status === 'failed'
                            ? t.statusFailed
                            : entry.status === 'running'
                              ? t.statusRunning
                              : t.statusInfo;
                      return (
                        <tr key={entry.id} className="hover:bg-[var(--surface-2)]">
                          <td className="py-2.5 px-4 whitespace-nowrap text-[var(--text)]">
                            <span className="inline-flex items-center gap-2">
                              <FolderPlus className="w-3.5 h-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
                              <span>{t.activityTypeProjectCreated}</span>
                            </span>
                          </td>
                          <td className="py-2.5 px-3">
                            <button
                              type="button"
                              onClick={() => onOpenProject(entry.projectId)}
                              className="font-medium text-[var(--text)] hover:underline text-left cursor-pointer"
                            >
                              {entry.projectName}
                            </button>
                            <div className="text-[12px] text-[var(--text-muted)] truncate max-w-[260px]">
                              {entry.detail}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap text-[12px]">
                            <span className="inline-flex items-center gap-1.5">
                              {entry.status === 'success' && (
                                <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success-text)]" strokeWidth={1.75} />
                              )}
                              {entry.status === 'failed' && (
                                <AlertCircle className="w-3.5 h-3.5 text-[var(--error-text)]" strokeWidth={1.75} />
                              )}
                              {entry.status === 'running' && (
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent-text)]" strokeWidth={1.75} />
                              )}
                              <span
                                className={
                                  entry.status === 'success'
                                    ? 'text-[var(--success-text)]'
                                    : entry.status === 'failed'
                                      ? 'text-[var(--error-text)]'
                                      : 'text-[var(--text-muted)]'
                                }
                              >
                                {statusLabel}
                              </span>
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono text-[12px] text-[var(--text-muted)] tabular-nums whitespace-nowrap">
                            {formatDateTime(entry.createdAt, locale)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
