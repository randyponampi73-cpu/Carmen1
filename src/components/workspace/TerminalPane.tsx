import { AlertCircle, Loader2, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { COPY } from '../../i18n';
import type { Locale, SandboxIsolationStatus, TerminalLogEntry } from '../../types';

interface TerminalPaneProps {
  locale: Locale;
  logs: TerminalLogEntry[];
  sandboxStatus?: SandboxIsolationStatus | null;
  onRunCommand: (cmd: string) => Promise<{ ok?: boolean; exitCode?: number } | void>;
  onStopProcess?: () => Promise<void>;
}

const QUICK_COMMANDS = ['ls', 'db:sync', 'node -v', 'npm --version', 'npm run build', 'npm test'];

export function TerminalPane({ locale, logs, sandboxStatus, onRunCommand, onStopProcess }: TerminalPaneProps) {
  const t = COPY[locale];
  const [procFilter, setProcFilter] = useState<'all' | 'dev' | 'install' | 'build'>('all');
  const [cmd, setCmd] = useState('');
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const [running, setRunning] = useState(false);
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const visible = procFilter === 'all' ? logs : logs.filter((l) => l.process === procFilter);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [visible.length]);

  async function execute(commandText: string) {
    const clean = commandText.trim();
    if (!clean || running) return;
    setErrorMsg(null);
    setRunning(true);
    setCmdHistory((prev) => (prev[0] === clean ? prev : [clean, ...prev].slice(0, 40)));
    setHistoryIdx(-1);
    try {
      const res = await onRunCommand(clean);
      if (res && typeof res.exitCode === 'number') {
        setLastExitCode(res.exitCode);
      } else if (res && typeof res.ok === 'boolean') {
        setLastExitCode(res.ok ? 0 : 1);
      }
      setCmd('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t.terminalCmdFail);
    } finally {
      setRunning(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await execute(cmd);
  }

  async function handleStop() {
    if (!onStopProcess) return;
    setErrorMsg(null);
    try {
      await onStopProcess();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t.terminalStopFail);
    }
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (cmdHistory.length === 0) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(cmdHistory.length - 1, historyIdx + 1);
      setHistoryIdx(next);
      setCmd(cmdHistory[next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx <= 0) {
        setHistoryIdx(-1);
        setCmd('');
      } else {
        const next = historyIdx - 1;
        setHistoryIdx(next);
        setCmd(cmdHistory[next]);
      }
    }
  }

  const sandboxLabel =
    sandboxStatus?.driver === 'docker'
      ? t.sandboxDocker
      : sandboxStatus?.driver === 'podman'
        ? t.sandboxPodman
        : sandboxStatus?.driver === 'linux-namespace'
          ? t.sandboxNamespace
          : t.sandboxRestrictedHost;

  return (
    <div className="h-full flex flex-col bg-[var(--bg)]">
      <div className="h-9 px-3 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-2 shrink-0 overflow-x-auto">
        <div role="group" aria-label={t.terminalFilterAria} className="inline-flex items-center gap-1 shrink-0">
          {(['all', 'dev', 'install', 'build'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={procFilter === tab}
              onClick={() => setProcFilter(tab)}
              className={`h-7 px-2 rounded-[6px] text-[12px] font-mono cursor-pointer ${
                procFilter === tab
                  ? 'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {tab === 'all' ? t.terminalAll : tab}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {lastExitCode !== null && (
            <span
              className={`px-1.5 py-0.5 rounded-[6px] border text-[12px] font-mono tabular-nums ${
                lastExitCode === 0
                  ? 'border-[var(--success)] text-[var(--success-text)]'
                  : 'border-[var(--error)] text-[var(--error-text)]'
              }`}
            >
              exit {lastExitCode}
            </span>
          )}
          {sandboxStatus && (
            <span
              title={sandboxStatus.details}
              className={`px-1.5 py-0.5 rounded-[6px] border text-[12px] font-mono ${
                sandboxStatus.osLevelIsolation
                  ? 'border-[var(--success)] text-[var(--success-text)]'
                  : 'border-[var(--warning)] text-[var(--warning-text)]'
              }`}
            >
              {sandboxLabel}
            </span>
          )}
          <span className="text-[12px] font-mono text-[var(--text-muted)] tabular-nums">
            {visible.length} {t.terminalLines}
          </span>
        </div>
      </div>

      <div className="px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface)] flex items-center gap-1.5 overflow-x-auto shrink-0">
        {QUICK_COMMANDS.map((quick) => (
          <button
            key={quick}
            type="button"
            disabled={running}
            onClick={() => void execute(quick)}
            className="h-7 px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] font-mono text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] whitespace-nowrap disabled:opacity-40 cursor-pointer"
          >
            $ {quick}
          </button>
        ))}
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="px-3 py-1.5 border-b border-[var(--error)] bg-[var(--surface)] flex items-center gap-2 text-[12px] text-[var(--error-text)]"
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 font-mono text-[12px] space-y-1">
        {visible.length === 0 ? (
          <div className="text-[var(--text-muted)]">{t.terminalEmpty}</div>
        ) : (
          visible.map((entry) => {
            const color =
              entry.level === 'error'
                ? 'text-[var(--error-text)]'
                : entry.level === 'warn'
                  ? 'text-[var(--warning-text)]'
                  : entry.level === 'success'
                    ? 'text-[var(--success-text)]'
                    : 'text-[var(--text)]';
            return (
              <div key={entry.id} className="flex items-start gap-2.5 leading-relaxed">
                <span className="text-[var(--text-muted)] tabular-nums shrink-0">{entry.timestamp}</span>
                <span className="text-[var(--text-muted)] shrink-0">[{entry.process}]</span>
                <span className={`${color} whitespace-pre-wrap break-all`}>{entry.message}</span>
              </div>
            );
          })
        )}
        <div ref={logsEndRef} />
      </div>

      <form
        onSubmit={handleSubmit}
        className="p-2 border-t border-[var(--border)] bg-[var(--surface)] flex items-center gap-2 shrink-0 focus-within:ring-2 focus-within:ring-inset focus-within:ring-[var(--accent)]"
      >
        <span className="font-mono text-[12px] text-[var(--text-muted)] pl-1">$</span>
        <input
          type="text"
          value={cmd}
          readOnly={running}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={t.terminalInputPlaceholder}
          aria-label={t.terminalInputAria}
          className="flex-1 h-7 bg-transparent font-mono text-[12px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none read-only:opacity-55"
        />
        {running && onStopProcess ? (
          <button
            type="button"
            onClick={() => void handleStop()}
            className="h-7 px-2.5 rounded-[6px] border border-[var(--error)] text-[var(--error-text)] text-[12px] flex items-center gap-1 cursor-pointer"
          >
            <Square className="w-3 h-3 fill-current" />
            <span>{t.stop}</span>
          </button>
        ) : (
          <button
            type="submit"
            disabled={!cmd.trim() || running}
            className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[12px] text-[var(--text)] flex items-center gap-1 disabled:opacity-40 cursor-pointer"
          >
            {running ? (
              <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} />
            ) : (
              <Play className="w-3 h-3" strokeWidth={1.5} />
            )}
            <span>{t.terminalRun}</span>
          </button>
        )}
      </form>
    </div>
  );
}
