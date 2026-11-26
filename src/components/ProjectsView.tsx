import {
  Archive,
  Copy,
  Edit3,
  Globe,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Smartphone,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { COPY, formatDateTime } from '../i18n';
import { api } from '../lib/api';
import type { Locale, ProjectSummary, ProjectType } from '../types';
import { ConfirmDialog, ModalShell } from './ConfirmDialog';

interface ProjectsViewProps {
  locale: Locale;
  projects: ProjectSummary[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onOpenProject: (id: string) => void;
}

export function ProjectsView({ locale, projects, loading, onRefresh, onOpenProject }: ProjectsViewProps) {
  const t = COPY[locale];
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'web' | 'android' | 'archived'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<ProjectType>('web');
  const [createError, setCreateError] = useState<string | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameSubmittingRef = useRef(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [mobileMenuRowId, setMobileMenuRowId] = useState<string | null>(null);

  const zipInputRef = useRef<HTMLInputElement>(null);
  const createTitleId = useId();

  useEffect(() => {
    if (!mobileMenuRowId) return;
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target && !target.closest('[data-project-row-menu]')) {
        setMobileMenuRowId(null);
      }
    }
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setMobileMenuRowId(null);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [mobileMenuRowId]);

  const activeProjectsCount = useMemo(() => projects.filter((p) => !p.archived).length, [projects]);
  const archivedProjectsCount = useMemo(() => projects.filter((p) => p.archived).length, [projects]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (filter === 'archived' && !p.archived) return false;
      if (filter !== 'archived' && p.archived) return false;
      if (filter === 'web' && p.type !== 'web') return false;
      if (filter === 'android' && p.type !== 'android') return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.stack.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [projects, search, filter]);

  const hasActiveFilter = search.trim().length > 0 || filter !== 'all';
  const baseBucketEmpty = filter === 'archived' ? archivedProjectsCount === 0 : activeProjectsCount === 0;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || busyId === 'create') return;
    setCreateError(null);
    setBusyId('create');
    try {
      const res = await api.createProject({ name: newName.trim(), type: newType });
      setCreateOpen(false);
      setNewName('');
      await onRefresh();
      onOpenProject(res.project.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t.createProjectFail);
    } finally {
      setBusyId(null);
    }
  }

  async function handleImportZip(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      setError(t.zipTooLarge);
      if (zipInputRef.current) zipInputRef.current.value = '';
      return;
    }
    setError(null);
    setBusyId('import');
    const reader = new FileReader();
    reader.onerror = () => {
      setError(t.importZipFail);
      setBusyId(null);
      if (zipInputRef.current) zipInputRef.current.value = '';
    };
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result || '');
        const base64 = dataUrl.split(',')[1] || '';
        const res = await api.importZipProject({
          name: file.name.replace(/\.zip$/i, ''),
          type: 'web',
          zipBase64: base64,
        });
        await onRefresh();
        onOpenProject(res.projectId);
      } catch (err) {
        setError(err instanceof Error ? err.message : t.importZipFail);
      } finally {
        setBusyId(null);
        if (zipInputRef.current) zipInputRef.current.value = '';
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleRenameSubmit(id: string) {
    if (renameSubmittingRef.current) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    renameSubmittingRef.current = true;
    setError(null);
    setBusyId(id);
    try {
      await api.updateProject(id, { name: trimmed });
      setRenamingId(null);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.renameProjectFail);
    } finally {
      setBusyId(null);
      renameSubmittingRef.current = false;
    }
  }

  async function handleDuplicate(proj: ProjectSummary) {
    if (busyId) return;
    setError(null);
    setBusyId(proj.id);
    try {
      await api.duplicateProject(proj.id);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.duplicateProjectFail);
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleArchive(proj: ProjectSummary) {
    if (busyId) return;
    setError(null);
    setBusyId(proj.id);
    try {
      await api.updateProject(proj.id, { archived: !proj.archived });
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.archiveProjectFail);
    } finally {
      setBusyId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget || busyId) return;
    setDeleteError(null);
    setBusyId(deleteTarget.id);
    try {
      await api.deleteProject(deleteTarget.id);
      setDeleteTarget(null);
      await onRefresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t.deleteProjectFail);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 sm:py-8">
      <div className="mx-auto max-w-[1080px] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-semibold text-[var(--text)]">{t.projectsTitle}</h1>
            <p className="text-[13px] text-[var(--text-muted)] tabular-nums">
              {filter === 'archived'
                ? `${archivedProjectsCount} ${t.archivedProjectsCount}`
                : `${activeProjectsCount} ${t.savedProjectsCount}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input ref={zipInputRef} type="file" accept=".zip" onChange={handleImportZip} className="hidden" />
            <button
              type="button"
              onClick={() => zipInputRef.current?.click()}
              disabled={busyId === 'import'}
              className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[13px] font-medium text-[var(--text)] flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 cursor-pointer"
            >
              {busyId === 'import' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
              ) : (
                <Upload className="w-3.5 h-3.5" strokeWidth={1.5} />
              )}
              <span>{t.importZip}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setCreateError(null);
                setNewName('');
                setNewType('web');
                setCreateOpen(true);
              }}
              className="h-8 px-3.5 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Plus className="w-4 h-4" strokeWidth={1.5} />
              <span>{t.newProject}</span>
            </button>
          </div>
        </div>

        {/* Search & segmented filter bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-[360px]">
            <Search
              className="w-4 h-4 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              strokeWidth={1.5}
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.searchProjects}
              aria-label={t.searchProjects}
              className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] pl-9 pr-3 text-[13px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
            />
          </div>

          <div
            role="group"
            aria-label={t.filterProjectsAria}
            className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-0.5 overflow-x-auto max-w-full"
          >
            {(
              [
                ['all', t.filterAll],
                ['web', t.web],
                ['android', t.android],
                ['archived', t.filterArchived],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
                className={`h-7 px-2.5 rounded-[6px] text-[12px] font-medium whitespace-nowrap cursor-pointer ${
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

        {error && (
          <div role="alert" className="rounded-[6px] border border-[var(--error)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--error-text)]">
            {error}
          </div>
        )}

        {loading ? (
          <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {[1, 2, 3].map((row) => (
              <div key={row} className="h-12 px-4 flex items-center justify-between animate-pulse">
                <div className="h-3.5 w-48 rounded-[6px] bg-[var(--surface-2)]" />
                <div className="h-3.5 w-24 rounded-[6px] bg-[var(--surface-2)]" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
            <p className="text-[13px] text-[var(--text-muted)] mb-3">
              {baseBucketEmpty && !search.trim() ? t.emptyProjects : t.emptyFilteredProjects}
            </p>
            {!baseBucketEmpty && hasActiveFilter ? (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setFilter('all');
                }}
                className="h-8 px-3.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[13px] font-medium text-[var(--text)] cursor-pointer"
              >
                {t.clearFilters}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setCreateError(null);
                  setCreateOpen(true);
                }}
                className="h-8 px-3.5 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium cursor-pointer"
              >
                {t.newProject}
              </button>
            )}
          </div>
        ) : (
          <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
            <table aria-label={t.projectsTableAria} className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[12px] text-[var(--text-muted)]">
                  <th scope="col" className="py-2.5 px-4 font-medium">{t.colName}</th>
                  <th scope="col" className="py-2.5 px-3 font-medium hidden sm:table-cell">{t.colType}</th>
                  <th scope="col" className="py-2.5 px-3 font-medium hidden md:table-cell">{t.colStack}</th>
                  <th scope="col" className="py-2.5 px-3 font-medium text-right tabular-nums">{t.colVersions}</th>
                  <th scope="col" className="py-2.5 px-3 font-medium hidden sm:table-cell tabular-nums">{t.colUpdated}</th>
                  <th scope="col" className="py-2.5 px-4 font-medium text-right">{t.colActions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {filtered.map((proj) => {
                  const rowBusy = busyId === proj.id;
                  return (
                    <tr key={proj.id} className="hover:bg-[var(--surface-2)] group">
                      <td className="py-2.5 px-4 font-medium text-[var(--text)] max-w-[200px] sm:max-w-[320px]">
                        {renamingId === proj.id ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              void handleRenameSubmit(proj.id);
                            }}
                            className="flex items-center gap-1.5"
                          >
                            <input
                              autoFocus
                              value={renameValue}
                              aria-label={t.projectNameLabel}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.preventDefault();
                                  renameSubmittingRef.current = true;
                                  setRenamingId(null);
                                  requestAnimationFrame(() => {
                                    renameSubmittingRef.current = false;
                                  });
                                }
                              }}
                              onBlur={() => void handleRenameSubmit(proj.id)}
                              className="h-7 w-full rounded-[6px] border border-[var(--accent)] bg-[var(--bg)] px-2 text-[13px] text-[var(--text)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                            />
                          </form>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onOpenProject(proj.id)}
                            title={proj.name}
                            className="hover:underline text-left truncate max-w-full block cursor-pointer"
                          >
                            {proj.name}
                          </button>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-[var(--text-muted)] whitespace-nowrap hidden sm:table-cell">
                        <span className="inline-flex items-center gap-1.5">
                          {proj.type === 'android' ? (
                            <Smartphone className="w-3.5 h-3.5" strokeWidth={1.5} />
                          ) : (
                            <Globe className="w-3.5 h-3.5" strokeWidth={1.5} />
                          )}
                          <span>{proj.type === 'android' ? t.android : t.web}</span>
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-[var(--text-muted)] hidden md:table-cell truncate max-w-[260px]">
                        {proj.stack}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-[12px] text-[var(--text-muted)] tabular-nums">
                        v{proj.versionCount}
                      </td>
                      <td className="py-2.5 px-3 text-[12px] text-[var(--text-muted)] hidden sm:table-cell tabular-nums whitespace-nowrap">
                        {formatDateTime(proj.updatedAt, locale)}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        {/* Desktop & Tablet inline row actions */}
                        <div className="hidden sm:inline-flex items-center justify-end gap-1">
                          {rowBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-muted)] mr-1" strokeWidth={1.5} />}
                          <button
                            type="button"
                            disabled={rowBusy}
                            onClick={() => onOpenProject(proj.id)}
                            className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] hover:border-[var(--text-muted)] text-[12px] font-medium text-[var(--text)] disabled:opacity-50 cursor-pointer"
                          >
                            {t.open}
                          </button>
                          <button
                            type="button"
                            disabled={rowBusy}
                            aria-label={`${t.rename} ${proj.name}`}
                            title={t.rename}
                            onClick={() => {
                              setRenamingId(proj.id);
                              setRenameValue(proj.name);
                            }}
                            className="h-8 w-8 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)] disabled:opacity-50 flex items-center justify-center cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" strokeWidth={1.5} />
                          </button>
                          <button
                            type="button"
                            disabled={rowBusy}
                            aria-label={`${t.duplicate} ${proj.name}`}
                            title={t.duplicate}
                            onClick={() => void handleDuplicate(proj)}
                            className="h-8 w-8 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)] disabled:opacity-50 flex items-center justify-center cursor-pointer"
                          >
                            <Copy className="w-3.5 h-3.5" strokeWidth={1.5} />
                          </button>
                          <button
                            type="button"
                            disabled={rowBusy}
                            aria-label={`${proj.archived ? t.unarchive : t.archive} ${proj.name}`}
                            title={proj.archived ? t.unarchive : t.archive}
                            onClick={() => void handleToggleArchive(proj)}
                            className="h-8 w-8 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)] disabled:opacity-50 flex items-center justify-center cursor-pointer"
                          >
                            <Archive className="w-3.5 h-3.5" strokeWidth={1.5} />
                          </button>
                          <button
                            type="button"
                            disabled={rowBusy}
                            aria-label={`${t.delete} ${proj.name}`}
                            title={t.delete}
                            onClick={() => {
                              setDeleteError(null);
                              setDeleteTarget(proj);
                            }}
                            className="h-8 w-8 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--error-text)] hover:bg-[var(--surface)] disabled:opacity-50 flex items-center justify-center cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                          </button>
                        </div>

                        {/* Mobile compact row menu */}
                        <div data-project-row-menu className="relative inline-flex sm:hidden">
                          <button
                            type="button"
                            disabled={rowBusy}
                            aria-label={`${t.colActions} ${proj.name}`}
                            aria-haspopup="menu"
                            aria-expanded={mobileMenuRowId === proj.id}
                            onClick={() => setMobileMenuRowId((cur) => (cur === proj.id ? null : proj.id))}
                            className="min-h-[40px] min-w-[40px] rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] flex items-center justify-center cursor-pointer"
                          >
                            {rowBusy ? (
                              <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />
                            ) : (
                              <MoreHorizontal className="w-4 h-4" strokeWidth={1.5} />
                            )}
                          </button>
                          {mobileMenuRowId === proj.id && (
                            <div
                              role="menu"
                              className="absolute right-0 top-11 z-40 w-44 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-1 text-left space-y-0.5 text-[13px]"
                              style={{ boxShadow: 'var(--shadow-float)' }}
                            >
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMobileMenuRowId(null);
                                  onOpenProject(proj.id);
                                }}
                                className="w-full h-8 px-2.5 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--text)] text-left cursor-pointer"
                              >
                                {t.open}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMobileMenuRowId(null);
                                  setRenamingId(proj.id);
                                  setRenameValue(proj.name);
                                }}
                                className="w-full h-8 px-2.5 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--text)] text-left cursor-pointer"
                              >
                                {t.rename}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMobileMenuRowId(null);
                                  void handleDuplicate(proj);
                                }}
                                className="w-full h-8 px-2.5 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--text)] text-left cursor-pointer"
                              >
                                {t.duplicate}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMobileMenuRowId(null);
                                  void handleToggleArchive(proj);
                                }}
                                className="w-full h-8 px-2.5 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--text)] text-left cursor-pointer"
                              >
                                {proj.archived ? t.unarchive : t.archive}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMobileMenuRowId(null);
                                  setDeleteError(null);
                                  setDeleteTarget(proj);
                                }}
                                className="w-full h-8 px-2.5 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--error-text)] text-left cursor-pointer"
                              >
                                {t.delete}
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Project Dialog */}
      <ModalShell
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        busy={busyId === 'create'}
        ariaLabelledBy={createTitleId}
        maxWidthClass="max-w-[440px]"
        className="p-5"
      >
        <h2 id={createTitleId} className="text-[16px] font-semibold text-[var(--text)] mb-4">
          {t.newProject}
        </h2>
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label htmlFor="new-proj-name" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
              {t.projectNameLabel}
            </label>
            <input
              id="new-proj-name"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t.projectNamePlaceholder}
              className="w-full h-9 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px] text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
            />
          </div>
          <div>
            <span className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
              {t.targetPlatform}
            </span>
            <div className="grid grid-cols-2 gap-2">
              {(['web', 'android'] as const).map((typeOpt) => (
                <button
                  key={typeOpt}
                  type="button"
                  aria-pressed={newType === typeOpt}
                  onClick={() => setNewType(typeOpt)}
                  className={`h-9 rounded-[6px] border text-[13px] font-medium flex items-center justify-center gap-2 cursor-pointer ${
                    newType === typeOpt
                      ? 'border-[var(--accent)] bg-[var(--surface-2)] text-[var(--text)]'
                      : 'border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-muted)]'
                  }`}
                >
                  {typeOpt === 'android' ? (
                    <Smartphone className="w-4 h-4" strokeWidth={1.5} />
                  ) : (
                    <Globe className="w-4 h-4" strokeWidth={1.5} />
                  )}
                  <span>{typeOpt === 'android' ? 'Android (APK)' : 'Web Fullstack'}</span>
                </button>
              ))}
            </div>
          </div>

          {createError && (
            <div
              role="alert"
              className="rounded-[6px] border border-[var(--error)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--error-text)]"
            >
              {createError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={busyId === 'create'}
              onClick={() => setCreateOpen(false)}
              className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] text-[13px] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50 cursor-pointer"
            >
              {t.cancel}
            </button>
            <button
              type="submit"
              disabled={busyId === 'create' || !newName.trim()}
              className="h-8 px-4 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {busyId === 'create' && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
              <span>{t.newProject}</span>
            </button>
          </div>
        </form>
      </ModalShell>

      {/* Delete Project Confirmation */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        locale={locale}
        title={t.confirmDeleteProjectTitle}
        description={t.confirmDeleteProjectBody.replace('{name}', deleteTarget?.name || '')}
        confirmLabel={t.confirmDeleteProjectButton}
        danger
        busy={Boolean(deleteTarget && busyId === deleteTarget.id)}
        error={deleteError}
        onConfirm={() => void handleConfirmDelete()}
        onClose={() => {
          setDeleteError(null);
          setDeleteTarget(null);
        }}
      />
    </main>
  );
}
