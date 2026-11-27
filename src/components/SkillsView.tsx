import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  Eye,
  FileCode2,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { COPY, formatDateTime } from '../i18n';
import { api } from '../lib/api';
import type {
  Locale,
  MarketplaceCatalogData,
  RegisteredAgentToolInfo,
  SkillAnalyticsSummary,
  SkillCategory,
  SkillMetadataItem,
  SkillPackageDetail,
  SkillPermission,
  SkillVersionItem,
} from '../types';
import { ConfirmDialog, ModalShell } from './ConfirmDialog';

interface SkillsViewProps {
  locale: Locale;
}

type SkillsTab = 'installed' | 'create' | 'marketplace' | 'analytics';

const SKILL_CATEGORY_LIST: SkillCategory[] = [
  'development',
  'debugging',
  'security',
  'testing',
  'database',
  'devops',
  'architecture',
  'agents',
];

function trustTextClass(trust: SkillMetadataItem['trustLevel']): string {
  switch (trust) {
    case 'BUILTIN':
    case 'VERIFIED':
    case 'APPROVED':
      return 'text-[var(--success-text)]';
    case 'DRAFT':
      return 'text-[var(--warning-text)]';
    case 'UNTRUSTED':
    default:
      return 'text-[var(--error-text)]';
  }
}

export function SkillsView({ locale }: SkillsViewProps) {
  const t = COPY[locale];
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inspectTitleId = useId();
  const permTitleId = useId();

  const [tab, setTab] = useState<SkillsTab>('installed');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [skills, setSkills] = useState<SkillMetadataItem[]>([]);
  const [tools, setTools] = useState<RegisteredAgentToolInfo[]>([]);
  const [analytics, setAnalytics] = useState<SkillAnalyticsSummary | null>(null);
  const [marketplace, setMarketplace] = useState<MarketplaceCatalogData | null>(null);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<SkillCategory | 'all'>('all');
  const [busySkillId, setBusySkillId] = useState<string | null>(null);

  // Inspect & Edit Modal
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectDetail, setInspectDetail] = useState<SkillPackageDetail | null>(null);
  const [inspectVersions, setInspectVersions] = useState<SkillVersionItem[]>([]);
  const [inspectValidation, setInspectValidation] = useState<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  } | null>(null);
  const [editMdDraft, setEditMdDraft] = useState('');
  const [editingMd, setEditingMd] = useState(false);
  const [savingMd, setSavingMd] = useState(false);

  // Permission Approval Modal
  const [permModalSkill, setPermModalSkill] = useState<SkillMetadataItem | null>(null);
  const [permSelection, setPermSelection] = useState<SkillPermission[]>([]);
  const [approvingPerm, setApprovingPerm] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<SkillMetadataItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Create Skill form state
  const [createName, setCreateName] = useState('');
  const [createCategory, setCreateCategory] = useState<SkillCategory>('development');
  const [createDesc, setCreateDesc] = useState('');
  const [createTools, setCreateTools] = useState<string[]>(['list_files', 'read_file', 'validate_project']);
  const [createWorkflowText, setCreateWorkflowText] = useState(
    'Inspeksi struktur proyek dan file terkait menggunakan list_files dan read_file.\nTerapkan perbaikan minimal sesuai standar proyek.\nVerifikasi hasil dengan validate_project.'
  );
  const [createExecutionMode, setCreateExecutionMode] = useState<'sequential' | 'parallel-safe'>('sequential');
  const [creating, setCreating] = useState(false);

  const loadSkillsData = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listSkills({ includeDisabled: true });
      setSkills(res.skills);
      setTools(res.tools);
      setAnalytics(res.analytics);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat daftar skill.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    api
      .listSkills({ includeDisabled: true })
      .then((res) => {
        if (!active) return;
        setError(null);
        setSkills(res.skills);
        setTools(res.tools);
        setAnalytics(res.analytics);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Gagal memuat daftar skill.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (tab === 'marketplace' && !marketplace) {
      api
        .getSkillMarketplace()
        .then(setMarketplace)
        .catch((err) => setError(err instanceof Error ? err.message : 'Gagal memuat katalog skill.'));
    } else if (tab === 'analytics') {
      api
        .getSkillAnalytics()
        .then((res) => setAnalytics(res.analytics))
        .catch(() => {});
    }
  }, [tab, marketplace]);

  const filteredSkills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skills.filter((s) => {
      if (categoryFilter !== 'all' && s.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        s.slug.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.manifest.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [skills, search, categoryFilter]);

  const enabledCount = useMemo(() => skills.filter((s) => s.enabled).length, [skills]);

  async function handleToggleEnabled(skill: SkillMetadataItem) {
    setBusySkillId(skill.id);
    setError(null);
    setNotice(null);
    try {
      await api.toggleUserSkill(skill.id, !skill.enabled);
      await loadSkillsData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengubah status skill.');
    } finally {
      setBusySkillId(null);
    }
  }

  async function handleInspect(skillIdOrSlug: string) {
    setInspectOpen(true);
    setInspectLoading(true);
    setEditingMd(false);
    setError(null);
    try {
      const detail = await api.getSkillDetail(skillIdOrSlug);
      setInspectDetail(detail.skill);
      setInspectVersions(detail.versions);
      setInspectValidation(detail.validation);
      setEditMdDraft(detail.skill.skillMd);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat detail skill.');
      setInspectOpen(false);
    } finally {
      setInspectLoading(false);
    }
  }

  async function handleSaveSkillMdEdit() {
    if (!inspectDetail || !editMdDraft.trim()) return;
    setSavingMd(true);
    setError(null);
    try {
      const res = await api.updateSkill(inspectDetail.id, {
        skillMd: editMdDraft,
        changelog: 'Pembaruan melalui UI Inspeksi Skill',
      });
      setInspectDetail(res.skill);
      setEditingMd(false);
      await handleInspect(res.skill.id);
      await loadSkillsData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan pembaruan SKILL.md.');
    } finally {
      setSavingMd(false);
    }
  }

  async function handleRollback(versionId: string) {
    if (!inspectDetail) return;
    setInspectLoading(true);
    setError(null);
    try {
      const res = await api.rollbackSkill(inspectDetail.id, versionId);
      setInspectDetail(res.skill);
      setEditMdDraft(res.skill.skillMd);
      await handleInspect(res.skill.id);
      await loadSkillsData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memulihkan versi skill.');
    } finally {
      setInspectLoading(false);
    }
  }

  function openPermissionModal(skill: SkillMetadataItem) {
    setPermModalSkill(skill);
    setPermSelection(
      skill.manifest.permissions.length > 0 ? [...skill.manifest.permissions] : ['READ']
    );
  }

  async function handleApprovePermissions() {
    if (!permModalSkill) return;
    setApprovingPerm(true);
    setError(null);
    setNotice(null);
    try {
      await api.approveSkill(permModalSkill.id, {
        permissions: permSelection,
        promoteTrust: true,
      });
      setPermModalSkill(null);
      await loadSkillsData();
      setNotice(
        locale === 'id'
          ? `Permission skill "${permModalSkill.slug}" disetujui dan diaktifkan.`
          : `Permissions approved and "${permModalSkill.slug}" enabled.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyetujui permission skill.');
    } finally {
      setApprovingPerm(false);
    }
  }

  async function handleImportZipFile(file: File) {
    setError(null);
    setNotice(null);
    const maxZipBytes = 5 * 1024 * 1024;
    if (file.size > maxZipBytes) {
      setError(
        locale === 'id'
          ? 'Ukuran file ZIP skill melebihi batas maksimal 5 MB.'
          : 'Skill ZIP file exceeds the 5 MB maximum size limit.'
      );
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const chunks: string[] = [];
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
      }
      const zipBase64 = btoa(chunks.join(''));
      const res = await api.importSkillZip(zipBase64);
      await loadSkillsData();
      setNotice(
        locale === 'id'
          ? `Skill "${res.skill.slug}" diimpor sebagai UNTRUSTED (nonaktif). Tinjau & setujui izin sebelum mengaktifkannya.`
          : `Skill "${res.skill.slug}" imported as UNTRUSTED (disabled). Review and approve permissions before enabling.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengimpor paket ZIP skill.');
    }
  }

  async function handleCreateDraft(e: React.FormEvent) {
    e.preventDefault();
    if (!createName.trim() || !createDesc.trim()) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const workflowSteps = createWorkflowText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api.createSkill({
        name: createName.trim().toLowerCase(),
        category: createCategory,
        description: createDesc.trim(),
        tools: createTools,
        workflowSteps,
        executionMode: createExecutionMode,
      });
      setCreateName('');
      setCreateDesc('');
      await loadSkillsData();
      setTab('installed');
      setNotice(t.skillsCreatorSuccess);
      openPermissionModal(res.skill);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuat skill baru.');
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteSkill(deleteTarget.id);
      setDeleteTarget(null);
      await loadSkillsData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus skill.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main className="flex-1 w-full max-w-[1200px] mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Top Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-[var(--border)] pb-4">
        <div className="space-y-1 min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight text-[var(--text)]">{t.skillsTitle}</h1>
          <p className="text-[13px] text-[var(--text-muted)]">{t.skillsSubtitle}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleImportZipFile(file);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="h-10 sm:h-8 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[13px] font-medium text-[var(--text)] flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" strokeWidth={1.5} />
            <span>{t.skillsImportZip}</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('create')}
            className="h-10 sm:h-8 px-3 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={1.6} />
            <span>{t.skillsCreateBtn}</span>
          </button>
        </div>
      </div>

      {/* Concise Metric Strip */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-2.5 sm:px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-baseline justify-between gap-0.5 sm:gap-2 min-w-0">
          <span className="text-[11px] sm:text-[12px] text-[var(--text-muted)] capitalize truncate">{t.skillsRegisteredCount}</span>
          <span className="text-[17px] sm:text-[18px] font-semibold font-mono tabular-nums text-[var(--text)]">{skills.length}</span>
        </div>
        <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-2.5 sm:px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-baseline justify-between gap-0.5 sm:gap-2 min-w-0">
          <span className="text-[11px] sm:text-[12px] text-[var(--text-muted)] capitalize truncate">{t.skillsEnabledCount}</span>
          <span className="text-[17px] sm:text-[18px] font-semibold font-mono tabular-nums text-[var(--success-text)]">{enabledCount}</span>
        </div>
        <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-2.5 sm:px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-baseline justify-between gap-0.5 sm:gap-2 min-w-0">
          <span className="text-[11px] sm:text-[12px] text-[var(--text-muted)] capitalize truncate">{t.skillsToolsCount}</span>
          <span className="text-[17px] sm:text-[18px] font-semibold font-mono tabular-nums text-[var(--text)]">{tools.length}</span>
        </div>
      </div>

      {/* Primary Section Tabs */}
      <div role="tablist" aria-label={t.skillsTitle} className="flex items-center gap-1 sm:gap-2 border-b border-[var(--border)] overflow-x-auto no-scrollbar">
        {(
          [
            ['installed', t.skillsTabInstalled],
            ['create', t.skillsTabCreate],
            ['marketplace', t.skillsTabMarketplace],
            ['analytics', t.skillsTabAnalytics],
          ] as Array<[SkillsTab, string]>
        ).map(([id, label]) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(id)}
              className={`h-10 sm:h-9 px-3 border-b-2 text-[13px] font-medium whitespace-nowrap cursor-pointer ${
                active
                  ? 'border-[var(--accent)] text-[var(--text)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-[8px] border border-[var(--error)] bg-[var(--surface)] px-3.5 py-2.5 text-[13px] text-[var(--error-text)] flex items-start gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.6} />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="rounded-[8px] border border-[var(--success)] bg-[var(--surface)] px-3.5 py-2.5 text-[13px] text-[var(--success-text)] flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.6} />
          <span>{notice}</span>
        </div>
      )}

      {/* TAB 1: INSTALLED SKILLS */}
      {tab === 'installed' && (
        <div className="space-y-4">
          <div className="flex flex-col md:flex-row gap-3 md:items-center justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 text-[var(--text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2" strokeWidth={1.5} />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t.skillsSearchPlaceholder}
                aria-label={t.skillsSearchPlaceholder}
                className="w-full h-10 sm:h-9 pl-8 pr-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] text-[16px] sm:text-[13px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              />
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
              <button
                type="button"
                onClick={() => setCategoryFilter('all')}
                className={`h-8 sm:h-7 px-2.5 rounded-[6px] text-[12px] font-medium whitespace-nowrap cursor-pointer border ${
                  categoryFilter === 'all'
                    ? 'border-[var(--accent)] bg-[var(--surface-2)] text-[var(--text)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                {t.skillsCategoryAll}
              </button>
              {SKILL_CATEGORY_LIST.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  className={`h-8 sm:h-7 px-2.5 rounded-[6px] text-[12px] font-medium capitalize whitespace-nowrap cursor-pointer border ${
                    categoryFilter === cat
                      ? 'border-[var(--accent)] bg-[var(--surface-2)] text-[var(--text)]'
                      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <div className="text-[12px] text-[var(--text-muted)] flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
            <span>{t.skillsImportSecurityHint}</span>
          </div>

          {loading ? (
            <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)] animate-pulse">
              {[1, 2, 3, 4].map((row) => (
                <div key={row} className="p-4 flex items-center justify-between gap-4">
                  <div className="space-y-2 flex-1">
                    <div className="h-4 w-44 rounded bg-[var(--surface-2)]" />
                    <div className="h-3 w-3/4 rounded bg-[var(--surface-2)]" />
                  </div>
                  <div className="h-7 w-24 rounded bg-[var(--surface-2)]" />
                </div>
              ))}
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-8 text-center space-y-2">
              <div className="text-[14px] font-medium text-[var(--text)]">{t.skillsEmptyTitle}</div>
              <div className="text-[13px] text-[var(--text-muted)]">{t.skillsEmptyBody}</div>
            </div>
          ) : (
            <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
              {filteredSkills.map((skill) => {
                const needsApproval = skill.trustLevel === 'UNTRUSTED' || skill.trustLevel === 'DRAFT';
                return (
                  <div
                    key={skill.id}
                    className="p-3.5 sm:px-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3 hover:bg-[var(--surface-2)]/50"
                  >
                    <div className="min-w-0 space-y-1 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="font-mono text-[13px] font-semibold text-[var(--text)]">
                          /{skill.slug}
                        </span>
                        <span className="text-[12px] text-[var(--text-muted)] capitalize">
                          {skill.category}
                        </span>
                        <span className="text-[12px] font-mono tabular-nums text-[var(--text-muted)]">
                          v{skill.currentVersion}
                        </span>
                        <span className={`text-[12px] font-medium ${trustTextClass(skill.trustLevel)}`}>
                          {skill.trustLevel}
                        </span>
                        <span className="text-[12px] font-mono text-[var(--text-muted)]">
                          {skill.manifest.permissions.join(' · ') || 'READ'}
                        </span>
                      </div>
                      <p className="text-[13px] text-[var(--text-muted)] line-clamp-2">{skill.description}</p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 flex-wrap">
                      {needsApproval && (
                        <button
                          type="button"
                          onClick={() => openPermissionModal(skill)}
                          className="h-7 px-2.5 rounded-[6px] border border-[var(--warning)] bg-[var(--surface-2)] text-[12px] font-medium text-[var(--warning-text)] flex items-center gap-1 cursor-pointer"
                        >
                          <ShieldAlert className="w-3.5 h-3.5" strokeWidth={1.5} />
                          <span>{t.skillsApproveBtn}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleInspect(skill.id)}
                        className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[12px] text-[var(--text)] flex items-center gap-1 cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" strokeWidth={1.5} />
                        <span>{t.skillsInspectBtn}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setError(null);
                          void api
                            .downloadSkillZip(skill.id, skill.slug)
                            .catch((err) =>
                              setError(err instanceof Error ? err.message : 'Gagal mengekspor paket ZIP skill.')
                            );
                        }}
                        aria-label={`${t.skillsExportBtn} ${skill.slug}`}
                        title={t.skillsExportBtn}
                        className="h-7 px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                      </button>
                      {skill.source !== 'builtin' && (
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(skill)}
                          aria-label={`${t.delete} ${skill.slug}`}
                          title={t.delete}
                          className="h-7 px-2 rounded-[6px] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--error-text)] hover:border-[var(--error)] flex items-center cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busySkillId === skill.id}
                        onClick={() => void handleToggleEnabled(skill)}
                        className={`h-7 px-2.5 rounded-[6px] text-[12px] font-medium min-w-[84px] flex items-center justify-center cursor-pointer border ${
                          skill.enabled
                            ? 'border-[var(--success)] bg-[var(--surface-2)] text-[var(--success-text)]'
                            : 'border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
                        }`}
                      >
                        {busySkillId === skill.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : skill.enabled ? (
                          t.skillsDisableBtn
                        ) : (
                          t.skillsEnableBtn
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: CREATE SKILL */}
      {tab === 'create' && (
        <form
          onSubmit={(e) => void handleCreateDraft(e)}
          className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4 max-w-3xl"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="skill-create-name" className="block text-[12px] font-medium text-[var(--text)]">
                {t.skillsCreateNameLabel}
              </label>
              <input
                id="skill-create-name"
                required
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={t.skillsCreateNamePlaceholder}
                className="w-full h-9 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] font-mono text-[13px] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="skill-create-category" className="block text-[12px] font-medium text-[var(--text)]">
                {t.skillsCreateCategoryLabel}
              </label>
              <select
                id="skill-create-category"
                value={createCategory}
                onChange={(e) => setCreateCategory(e.target.value as SkillCategory)}
                className="w-full h-9 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] text-[var(--text)]"
              >
                {SKILL_CATEGORY_LIST.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="skill-create-desc" className="block text-[12px] font-medium text-[var(--text)]">
              {t.skillsCreateDescLabel}
            </label>
            <input
              id="skill-create-desc"
              required
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              placeholder={t.skillsCreateDescPlaceholder}
              className="w-full h-9 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-[12px] font-medium text-[var(--text)]">{t.skillsCreateToolsLabel}</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {tools.map((tool) => {
                const selected = createTools.includes(tool.name);
                return (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() =>
                      setCreateTools((prev) =>
                        prev.includes(tool.name) ? prev.filter((x) => x !== tool.name) : [...prev, tool.name]
                      )
                    }
                    className={`h-8 px-2.5 rounded-[6px] border text-left font-mono text-[12px] flex items-center justify-between gap-1.5 cursor-pointer ${
                      selected
                        ? 'border-[var(--accent)] bg-[var(--surface-2)] text-[var(--text)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    <span className="truncate">{tool.name}</span>
                    {selected && <Check className="w-3.5 h-3.5 text-[var(--accent-text)] shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="skill-create-workflow" className="block text-[12px] font-medium text-[var(--text)]">
              {t.skillsCreateWorkflowLabel}
            </label>
            <textarea
              id="skill-create-workflow"
              rows={4}
              value={createWorkflowText}
              onChange={(e) => setCreateWorkflowText(e.target.value)}
              className="w-full p-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="text-[var(--text-muted)]">{t.skillsCreateModeLabel}:</span>
              <select
                value={createExecutionMode}
                onChange={(e) =>
                  setCreateExecutionMode(e.target.value === 'parallel-safe' ? 'parallel-safe' : 'sequential')
                }
                className="h-8 px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[12px] text-[var(--text)]"
              >
                <option value="sequential">sequential</option>
                <option value="parallel-safe">parallel-safe</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={creating}
              className="h-9 px-4 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{t.skillsCreateSubmit}</span>
            </button>
          </div>
        </form>
      )}

      {/* TAB 3: CURATED CATALOG / MARKETPLACE */}
      {tab === 'marketplace' && (
        <div className="space-y-3">
          {marketplace && (
            <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-[12px] text-[var(--text-muted)] flex items-center justify-between gap-2">
              <span>{marketplace.remoteNotice}</span>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setMarketplace(null);
                  void api
                    .getSkillMarketplace()
                    .then(setMarketplace)
                    .catch((err) =>
                      setError(err instanceof Error ? err.message : 'Gagal memuat katalog marketplace skill.')
                    );
                }}
                className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text)] flex items-center gap-1 cursor-pointer shrink-0"
              >
                <RefreshCw className="w-3 h-3" />
                <span>{t.refreshModels}</span>
              </button>
            </div>
          )}

          <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[12px] text-[var(--text-muted)]">
                  <th className="py-2.5 px-3.5 font-medium">Skill</th>
                  <th className="py-2.5 px-3.5 font-medium">{t.skillsCreateCategoryLabel}</th>
                  <th className="py-2.5 px-3.5 font-medium">Trust</th>
                  <th className="py-2.5 px-3.5 font-medium">Permissions</th>
                  <th className="py-2.5 px-3.5 font-medium text-right">{t.colAction}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(marketplace?.items || []).map((item) => (
                  <tr key={item.slug} className="hover:bg-[var(--surface-2)]/50">
                    <td className="py-2.5 px-3.5">
                      <div className="font-mono text-[12px] font-semibold text-[var(--text)]">{item.slug}</div>
                      <div className="text-[12px] text-[var(--text-muted)] line-clamp-1">{item.description}</div>
                    </td>
                    <td className="py-2.5 px-3.5 capitalize text-[12px] text-[var(--text-muted)]">{item.category}</td>
                    <td className="py-2.5 px-3.5 font-mono text-[12px] text-[var(--success-text)]">{item.trustBadge}</td>
                    <td className="py-2.5 px-3.5 font-mono text-[12px] text-[var(--text-muted)]">
                      {item.permissions.join(', ') || 'READ'}
                    </td>
                    <td className="py-2.5 px-3.5 text-right">
                      {item.installed ? (
                        <button
                          type="button"
                          onClick={() => void handleInspect(item.slug)}
                          className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[12px] text-[var(--text)] cursor-pointer"
                        >
                          {t.skillsInspectBtn}
                        </button>
                      ) : (
                        <span className="text-[12px] text-[var(--text-muted)]">ZIP import required</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: ANALYTICS */}
      {tab === 'analytics' && (
        <div className="space-y-4">
          {!analytics || analytics.totalExecutions === 0 ? (
            <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-[13px] text-[var(--text-muted)]">
              {t.skillsAnalyticsEmpty}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-3">
                  <div className="text-[12px] text-[var(--text-muted)]">{t.skillsAnalyticsTotal}</div>
                  <div className="text-[18px] font-semibold font-mono tabular-nums text-[var(--text)]">
                    {analytics.totalExecutions}
                  </div>
                </div>
                <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-3">
                  <div className="text-[12px] text-[var(--text-muted)]">{t.skillsAnalyticsSuccess}</div>
                  <div className="text-[18px] font-semibold font-mono tabular-nums text-[var(--success-text)]">
                    {analytics.successCount}
                  </div>
                </div>
                <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-3">
                  <div className="text-[12px] text-[var(--text-muted)]">{t.skillsAnalyticsFallback}</div>
                  <div className="text-[18px] font-semibold font-mono tabular-nums text-[var(--warning-text)]">
                    {analytics.fallbackCount}
                  </div>
                </div>
                <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-3">
                  <div className="text-[12px] text-[var(--text-muted)]">{t.skillsAnalyticsDenied}</div>
                  <div className="text-[18px] font-semibold font-mono tabular-nums text-[var(--error-text)]">
                    {analytics.deniedCount}
                  </div>
                </div>
                <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-3">
                  <div className="text-[12px] text-[var(--text-muted)]">{t.skillsAnalyticsAvgDuration}</div>
                  <div className="text-[18px] font-semibold font-mono tabular-nums text-[var(--text)]">
                    {analytics.avgDurationMs}ms
                  </div>
                </div>
              </div>

              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
                <div className="px-3.5 py-2.5 border-b border-[var(--border)] text-[13px] font-semibold text-[var(--text)]">
                  {t.skillsAnalyticsRecentTitle}
                </div>
                <table className="w-full text-left border-collapse text-[12px]">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                      <th className="py-2 px-3.5 font-medium">Skill</th>
                      <th className="py-2 px-3.5 font-medium">Mode</th>
                      <th className="py-2 px-3.5 font-medium">Status</th>
                      <th className="py-2 px-3.5 font-medium">Reason</th>
                      <th className="py-2 px-3.5 font-medium text-right">Duration</th>
                      <th className="py-2 px-3.5 font-medium text-right">{t.colTimestamp}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {analytics.recentExecutions.map((row) => (
                      <tr key={row.id}>
                        <td className="py-2 px-3.5 font-mono text-[var(--text)]">{row.skillName}</td>
                        <td className="py-2 px-3.5 font-mono text-[var(--text-muted)]">{row.mode}</td>
                        <td className="py-2 px-3.5 font-mono text-[var(--text)]">{row.status}</td>
                        <td className="py-2 px-3.5 text-[var(--text-muted)] max-w-xs truncate">{row.reason}</td>
                        <td className="py-2 px-3.5 text-right font-mono tabular-nums text-[var(--text-muted)]">
                          {row.durationMs}ms
                        </td>
                        <td className="py-2 px-3.5 text-right font-mono tabular-nums text-[var(--text-muted)]">
                          {formatDateTime(row.createdAt, locale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* INSPECT / VERSION / EDIT MODAL */}
      <ModalShell
        open={inspectOpen}
        onClose={() => setInspectOpen(false)}
        ariaLabelledBy={inspectTitleId}
        maxWidthClass="max-w-3xl"
        className="p-5 space-y-4 max-h-[88dvh] overflow-y-auto"
      >
        {inspectLoading || !inspectDetail ? (
          <div className="py-8 flex items-center justify-center gap-2 text-[13px] text-[var(--text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{t.loadingApp}</span>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] pb-3">
              <div>
                <h2 id={inspectTitleId} className="text-[16px] font-semibold font-mono text-[var(--text)]">
                  /{inspectDetail.slug}
                </h2>
                <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
                  {inspectDetail.category} · v{inspectDetail.currentVersion} · {inspectDetail.trustLevel} ·{' '}
                  {inspectDetail.manifest.permissions.join(', ') || 'READ'}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {inspectDetail.ownerUserId && (
                  <button
                    type="button"
                    onClick={() => setEditingMd((e) => !e)}
                    className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[12px] text-[var(--text)] cursor-pointer"
                  >
                    {editingMd ? t.cancel : 'Edit SKILL.md'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setInspectOpen(false)}
                  className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[12px] text-[var(--text)] cursor-pointer"
                >
                  {t.close}
                </button>
              </div>
            </div>

            {inspectValidation && !inspectValidation.valid && (
              <div role="alert" className="rounded-[6px] border border-[var(--error)] bg-[var(--surface-2)] p-2.5 text-[12px] text-[var(--error-text)]">
                {inspectValidation.errors.join('; ')}
              </div>
            )}

            {editingMd ? (
              <div className="space-y-2">
                <textarea
                  rows={14}
                  value={editMdDraft}
                  onChange={(e) => setEditMdDraft(e.target.value)}
                  className="w-full p-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] font-mono text-[12px] text-[var(--text)]"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={savingMd}
                    onClick={() => void handleSaveSkillMdEdit()}
                    className="h-8 px-3 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium cursor-pointer"
                  >
                    {savingMd ? t.saving : t.save}
                  </button>
                </div>
              </div>
            ) : (
              <pre className="rounded-[6px] border border-[var(--border)] bg-[var(--bg)] p-3 overflow-x-auto font-mono text-[12px] text-[var(--text)] max-h-[340px] overflow-y-auto whitespace-pre-wrap">
                {inspectDetail.skillMd}
              </pre>
            )}

            {inspectDetail.referencePaths.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[12px] font-semibold text-[var(--text)] flex items-center gap-1.5">
                  <FileCode2 className="w-3.5 h-3.5" />
                  <span>References ({inspectDetail.referencePaths.length})</span>
                </div>
                <div className="text-[12px] font-mono text-[var(--text-muted)]">
                  {inspectDetail.referencePaths.join(', ')}
                </div>
              </div>
            )}

            {inspectDetail.scriptPaths.length > 0 && (
              <div className="rounded-[6px] border border-[var(--warning)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--warning-text)]">
                Scripts ({inspectDetail.scriptPaths.join(', ')}): sandbox isolation required; never auto-executed.
              </div>
            )}

            <div className="space-y-2 border-t border-[var(--border)] pt-3">
              <div className="text-[12px] font-semibold text-[var(--text)] flex items-center gap-1.5">
                <History className="w-3.5 h-3.5" />
                <span>{t.skillsVersionHistoryTitle}</span>
              </div>
              {inspectVersions.length === 0 ? (
                <div className="text-[12px] text-[var(--text-muted)]">{t.skillsNoVersions}</div>
              ) : (
                <div className="divide-y divide-[var(--border)] rounded-[6px] border border-[var(--border)]">
                  {inspectVersions.map((ver) => (
                    <div key={ver.id} className="px-3 py-2 flex items-center justify-between gap-2 text-[12px]">
                      <div className="min-w-0">
                        <span className="font-mono font-medium text-[var(--text)]">v{ver.version}</span>
                        <span className="text-[var(--text-muted)] ml-2">{ver.changelog}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono tabular-nums text-[var(--text-muted)]">
                          {formatDateTime(ver.createdAt, locale)}
                        </span>
                        {inspectDetail.ownerUserId && (
                          <button
                            type="button"
                            onClick={() => void handleRollback(ver.id)}
                            className="h-6 px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[11px] text-[var(--text)] cursor-pointer"
                          >
                            {t.skillsRollbackBtn}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </ModalShell>

      {/* PERMISSION APPROVAL MODAL */}
      <ModalShell
        open={Boolean(permModalSkill)}
        onClose={() => !approvingPerm && setPermModalSkill(null)}
        busy={approvingPerm}
        ariaLabelledBy={permTitleId}
        maxWidthClass="max-w-md"
        className="p-5 space-y-4"
      >
        {permModalSkill && (
          <>
            <div className="space-y-1">
              <h2 id={permTitleId} className="text-[16px] font-semibold text-[var(--text)]">
                {t.skillsPermissionModalTitle}
              </h2>
              <p className="text-[13px] text-[var(--text-muted)]">{t.skillsPermissionModalBody}</p>
            </div>

            <div className="rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 font-mono text-[12px] text-[var(--text)]">
              /{permModalSkill.slug} ({permModalSkill.trustLevel})
            </div>

            <div className="space-y-1.5">
              {(['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DATABASE', 'DEPLOY'] as SkillPermission[]).map((perm) => {
                const checked = permSelection.includes(perm);
                return (
                  <label
                    key={perm}
                    className="flex items-center justify-between px-3 py-2 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] text-[12px] cursor-pointer"
                  >
                    <span className="font-mono text-[var(--text)]">{perm}</span>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        setPermSelection((prev) =>
                          e.target.checked ? [...prev, perm] : prev.filter((x) => x !== perm)
                        )
                      }
                    />
                  </label>
                );
              })}
            </div>

            <div className="text-[12px] text-[var(--text-muted)]">{t.skillsAdminBlockedNote}</div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={approvingPerm}
                onClick={() => setPermModalSkill(null)}
                className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] text-[var(--text)] cursor-pointer"
              >
                {t.cancel}
              </button>
              <button
                type="button"
                disabled={approvingPerm}
                onClick={() => void handleApprovePermissions()}
                className="h-8 px-4 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium flex items-center gap-1.5 cursor-pointer"
              >
                {approvingPerm && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{t.skillsApproveBtn}</span>
              </button>
            </div>
          </>
        )}
      </ModalShell>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        locale={locale}
        title={t.skillsDeleteConfirmTitle}
        description={t.skillsDeleteConfirmBody.replace('{name}', deleteTarget?.slug || '')}
        confirmLabel={t.deleteConfirmButton}
        danger
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </main>
  );
}
