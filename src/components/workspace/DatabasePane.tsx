import { Database, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { COPY } from '../../i18n';
import { api } from '../../lib/api';
import type { DatabaseIsolationInfo, DatabaseTableInfo, Locale } from '../../types';

interface DatabasePaneProps {
  projectId: string;
  locale: Locale;
  reloadKey: number;
}

export function DatabasePane({ projectId, locale, reloadKey }: DatabasePaneProps) {
  const t = COPY[locale];
  const [tables, setTables] = useState<DatabaseTableInfo[]>([]);
  const [isolation, setIsolation] = useState<DatabaseIsolationInfo | null>(null);
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const loadTables = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.inspectDatabase(projectId);
      if (seq !== requestSeqRef.current) return;
      setTables(res.tables);
      setIsolation(res.isolation ?? null);
      setSelectedTable((prev) =>
        res.tables.length === 0 ? '' : res.tables.some((tbl) => tbl.name === prev) ? prev : res.tables[0].name
      );
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError(err instanceof Error ? err.message : t.dbLoadFail);
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [projectId, t.dbLoadFail]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) void loadTables();
    });
    return () => {
      cancelled = true;
      requestSeqRef.current += 1;
    };
  }, [loadTables, reloadKey]);

  const active = tables.find((tbl) => tbl.name === selectedTable) ?? tables[0] ?? null;

  return (
    <div className="h-full flex flex-col sm:flex-row bg-[var(--bg)] min-w-0">
      <aside className="w-full sm:w-[190px] max-h-36 sm:max-h-none border-b sm:border-b-0 sm:border-r border-[var(--border)] bg-[var(--surface)] flex flex-col shrink-0">
        <div className="h-9 px-3 border-b border-[var(--border)] flex items-center justify-between">
          <span className="text-[12px] font-medium text-[var(--text-muted)]">SQLite</span>
          <button
            type="button"
            onClick={() => void loadTables()}
            aria-label={t.dbRefreshAria}
            className="h-8 w-8 sm:h-7 sm:w-7 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] flex items-center justify-center cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="px-3 py-2 space-y-2 animate-pulse">
              <div className="h-5 rounded-[6px] bg-[var(--surface-2)]" />
              <div className="h-5 rounded-[6px] bg-[var(--surface-2)]" />
            </div>
          ) : tables.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-[var(--text-muted)]">{t.dbEmptyTables}</div>
          ) : (
            tables.map((tbl) => (
              <button
                key={tbl.name}
                type="button"
                onClick={() => setSelectedTable(tbl.name)}
                className={`w-full min-h-[36px] sm:min-h-0 sm:h-8 px-3 flex items-center justify-between text-[12px] font-mono cursor-pointer ${
                  active?.name === tbl.name
                    ? 'bg-[var(--surface-2)] text-[var(--text)] font-medium'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <span className="flex items-center gap-1.5 truncate">
                  <Database className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
                  <span className="truncate">{tbl.name}</span>
                </span>
                <span className="text-[12px] tabular-nums">{tbl.rowCount}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="h-9 px-3 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-2 text-[12px] shrink-0">
          <span className="font-mono text-[var(--text)] truncate">
            {active ? `${active.name} (${active.rowCount} ${t.dbRows})` : 'SQLite Inspector'}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {isolation?.tenantSchema && (
              <span
                title={t.dbIsolatedSchema}
                className="px-2 py-0.5 rounded-[4px] border border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)] truncate max-w-[200px]"
              >
                {isolation.tenantSchema}
              </span>
            )}
            <span className="text-[var(--text-muted)] hidden md:inline">{t.dbSourceBadge}</span>
          </div>
        </div>

        {error ? (
          <div role="alert" className="p-4 text-[13px] text-[var(--error-text)]">
            {error}
          </div>
        ) : loading ? (
          <div className="p-4 space-y-2 animate-pulse">
            <div className="h-8 rounded-[6px] bg-[var(--surface)] border border-[var(--border)]" />
            <div className="h-8 rounded-[6px] bg-[var(--surface)] border border-[var(--border)]" />
            <div className="h-8 rounded-[6px] bg-[var(--surface)] border border-[var(--border)]" />
          </div>
        ) : !active ? (
          <div className="p-6 text-[13px] text-[var(--text-muted)]">{t.dbSchemaHint}</div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table aria-label={t.dbTableAria.replace('{name}', active.name)} className="w-full text-left border-collapse text-[12px] font-mono">
              <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  {active.columns.map((col) => (
                    <th key={col} scope="col" className="py-2 px-3 font-medium whitespace-nowrap">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {active.rows.length === 0 ? (
                  <tr>
                    <td colSpan={Math.max(1, active.columns.length)} className="py-6 px-3 text-[var(--text-muted)]">
                      {t.dbEmptyRows}
                    </td>
                  </tr>
                ) : (
                  active.rows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-[var(--surface-2)]">
                      {active.columns.map((col) => {
                        const rawVal = row[col];
                        const isNull = rawVal === null || rawVal === undefined;
                        const displayVal = isNull ? 'NULL' : String(rawVal);
                        return (
                          <td
                            key={col}
                            title={displayVal}
                            className={`py-1.5 px-3 tabular-nums whitespace-nowrap max-w-[320px] truncate ${
                              isNull ? 'text-[var(--text-muted)] italic' : 'text-[var(--text)]'
                            }`}
                          >
                            {displayVal}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
