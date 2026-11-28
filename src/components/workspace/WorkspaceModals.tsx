import {
  AlertCircle,
  Loader2,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { COPY } from '../../i18n';
import { api } from '../../lib/api';
import type { EnvVarItem, Locale } from '../../types';
import { ModalShell } from '../ConfirmDialog';

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
