import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitCompare,
  History,
  ListChecks,
  Loader2,
  RefreshCw,
  Square,
  Wrench,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { COPY, formatActionVerb } from '../../i18n';
import type {
  AgentPlanSummary,
  ChatMessage,
  FallbackEvent,
  Locale,
  ProviderModel,
  ToolActionEvent,
} from '../../types';
import { ModelSelect } from '../CustomSelect';
import { TierBadge } from '../ProviderBadge';

// Matches the server notice emitted when a turn stops because the per-turn step budget ran out.
const STEP_LIMIT_NOTICE_PATTERN = /Batas \d+ langkah per giliran tercapai/;

interface ChatPanelProps {
  locale: Locale;
  messages: ChatMessage[];
  streaming: boolean;
  streamingText: string;
  streamingActions: ToolActionEvent[];
  streamingPlan?: AgentPlanSummary | null;
  fallbackNotice?: FallbackEvent | null;
  streamWarning: string | null;
  streamError: string | null;
  mode: 'build' | 'discuss';
  onModeChange: (m: 'build' | 'discuss') => void;
  models: ProviderModel[];
  selectedModelKey: string;
  onSelectModelKey: (k: string) => void;
  inputValue: string;
  onInputChange: (val: string) => void;
  canRetry?: boolean;
  onRetry?: () => void;
  onSend: (prompt: string) => void;
  onStop: () => void;
  onRestoreVersion: (versionId: string) => void;
  onOpenDiff: (versionId: string) => void;
  onOpenSettings: () => void;
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={idx}
          className="px-1 py-0.5 rounded-[6px] bg-[var(--surface-2)] border border-[var(--border)] font-mono text-[12px]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={idx} className="font-semibold text-[var(--text)]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

function SafeMarkdownContent({ content }: { content: string }) {
  const segments = useMemo(() => {
    const out: Array<{ type: 'text' | 'code'; content: string; lang?: string }> = [];
    const fenceRe = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = fenceRe.exec(content)) !== null) {
      if (match.index > lastIndex) {
        out.push({ type: 'text', content: content.slice(lastIndex, match.index) });
      }
      out.push({ type: 'code', lang: match[1] || undefined, content: match[2] });
      lastIndex = fenceRe.lastIndex;
    }
    if (lastIndex < content.length) {
      out.push({ type: 'text', content: content.slice(lastIndex) });
    }
    return out;
  }, [content]);

  return (
    <div className="text-[13px] leading-relaxed text-[var(--text)] space-y-2 break-words">
      {segments.map((seg, sIdx) => {
        if (seg.type === 'code') {
          return (
            <pre
              key={sIdx}
              className="rounded-[6px] border border-[var(--border)] bg-[var(--bg)] p-2.5 overflow-x-auto font-mono text-[12px] leading-relaxed text-[var(--text)]"
            >
              <code>{seg.content.replace(/\n$/, '')}</code>
            </pre>
          );
        }

        const blocks = seg.content.split(/\n{2,}/);
        return blocks.map((block, bIdx) => {
          const trimmed = block.trim();
          if (!trimmed) return null;
          const lines = trimmed.split('\n');
          const isUnorderedList = lines.every((l) => /^\s*[-*]\s+/.test(l));
          const isOrderedList = lines.every((l) => /^\s*\d+\.\s+/.test(l));

          if (isUnorderedList) {
            return (
              <ul key={`${sIdx}-${bIdx}`} className="list-disc pl-5 space-y-1">
                {lines.map((l, i) => (
                  <li key={i}>{renderInlineMarkdown(l.replace(/^\s*[-*]\s+/, ''))}</li>
                ))}
              </ul>
            );
          }

          if (isOrderedList) {
            return (
              <ol key={`${sIdx}-${bIdx}`} className="list-decimal pl-5 space-y-1">
                {lines.map((l, i) => (
                  <li key={i}>{renderInlineMarkdown(l.replace(/^\s*\d+\.\s+/, ''))}</li>
                ))}
              </ol>
            );
          }

          return (
            <p key={`${sIdx}-${bIdx}`} className="whitespace-pre-wrap">
              {lines.map((line, lIdx) => (
                <Fragment key={lIdx}>
                  {lIdx > 0 && <br />}
                  {renderInlineMarkdown(line)}
                </Fragment>
              ))}
            </p>
          );
        });
      })}
    </div>
  );
}

function ActionRow({ action, locale }: { action: ToolActionEvent; locale: Locale }) {
  const t = COPY[locale];
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] text-[12px]">
      <button
        type="button"
        onClick={() => action.detail && setExpanded((e) => !e)}
        aria-expanded={action.detail ? expanded : undefined}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left cursor-pointer"
      >
        {action.status === 'running' ? (
          <Loader2
            aria-label={t.statusRunningAria}
            className="w-4 h-4 text-[var(--warning-text)] animate-spin shrink-0"
            strokeWidth={1.5}
          />
        ) : action.status === 'error' ? (
          <AlertCircle
            aria-label={t.statusErrorAria}
            className="w-4 h-4 text-[var(--error-text)] shrink-0"
            strokeWidth={1.5}
          />
        ) : (
          <CheckCircle2
            aria-label={t.statusSuccessAria}
            className="w-4 h-4 text-[var(--success-text)] shrink-0"
            strokeWidth={1.5}
          />
        )}
        <span className="text-[var(--text-muted)] shrink-0">{formatActionVerb(action.tool, locale)}</span>
        <span className="font-mono text-[var(--text)] truncate flex-1">{action.target}</span>
        {action.detail &&
          (expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" strokeWidth={1.5} />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" strokeWidth={1.5} />
          ))}
      </button>
      {expanded && action.detail && (
        <div className="border-t border-[var(--border)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--text-muted)] whitespace-pre-wrap break-all">
          {action.detail}
        </div>
      )}
    </div>
  );
}

export function ChatPanel({
  locale,
  messages,
  streaming,
  streamingText,
  streamingActions,
  streamingPlan,
  fallbackNotice,
  streamWarning,
  streamError,
  mode,
  onModeChange,
  models,
  selectedModelKey,
  onSelectModelKey,
  inputValue,
  onInputChange,
  canRetry = false,
  onRetry,
  onSend,
  onStop,
  onRestoreVersion,
  onOpenDiff,
  onOpenSettings,
}: ChatPanelProps) {
  const t = COPY[locale];
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wasStreamingRef = useRef(streaming);
  const [isNearBottom, setIsNearBottom] = useState(true);

  const activeModel = models.find((m) => `${m.providerKeyId}::${m.id}` === selectedModelKey) ?? models[0] ?? null;

  const isMac = useMemo(
    () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent),
    []
  );

  // Session token estimate (KEY-7)
  const sessionTokens = messages.reduce((acc, m) => acc + (m.tokensIn || 0) + (m.tokensOut || 0), 0);

  // Smart auto-scroll only while user stays near bottom
  useEffect(() => {
    if (isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages.length, streamingText, streamingActions.length, isNearBottom]);

  // Refocus textarea automatically once streaming finishes
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    wasStreamingRef.current = streaming;
  }, [streaming]);

  // Auto-grow textarea cleanly up to ~8 rows
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 52), 184)}px`;
  }, [inputValue]);

  function handleScroll() {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsNearBottom(distance <= 80);
  }

  function scrollToBottom() {
    setIsNearBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  const lastMessage = messages[messages.length - 1];
  const showContinue =
    !streaming && !!lastMessage && lastMessage.role === 'assistant' && STEP_LIMIT_NOTICE_PATTERN.test(lastMessage.content);

  function submit() {
    if (!inputValue.trim() || streaming) return;
    const text = inputValue.trim();
    onInputChange('');
    setIsNearBottom(true);
    onSend(text);
  }

  const isAuthOrKeyError = Boolean(
    streamError && /api key|kunci|pengaturan|unauthorized|invalid.*key|not configured|belum ada|401/i.test(streamError)
  );

  return (
    <section aria-label={t.chatPanelAria} className="h-full flex flex-col bg-[var(--surface)] min-w-0 relative">
      {/* Mode bar (Build vs Discuss — WS-10) */}
      <div className="h-9 px-3 border-b border-[var(--border)] flex items-center justify-between gap-2 shrink-0">
        <div
          role="group"
          aria-label={t.agentModeAria}
          className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] p-0.5"
        >
          <button
            type="button"
            onClick={() => onModeChange('build')}
            aria-pressed={mode === 'build'}
            className={`h-7 px-2.5 rounded-[6px] text-[12px] font-medium cursor-pointer ${
              mode === 'build'
                ? 'bg-[var(--surface)] text-[var(--text)] border border-[var(--border)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            {t.modeBuild}
          </button>
          <button
            type="button"
            onClick={() => onModeChange('discuss')}
            aria-pressed={mode === 'discuss'}
            className={`h-7 px-2.5 rounded-[6px] text-[12px] font-medium cursor-pointer ${
              mode === 'discuss'
                ? 'bg-[var(--surface)] text-[var(--text)] border border-[var(--border)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            {t.modeDiscuss}
          </button>
        </div>
        {sessionTokens > 0 && (
          <span
            title={t.estimateNote}
            className="text-[12px] font-mono text-[var(--text-muted)] tabular-nums truncate"
          >
            ~{sessionTokens.toLocaleString(locale === 'id' ? 'id-ID' : 'en-US')} tok
          </span>
        )}
      </div>

      {/* Message history */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label={t.chatLogAria}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-4 relative"
      >
        {messages.length === 0 && !streaming && (
          <div className="py-6 text-[13px] text-[var(--text-muted)]">{t.chatEmptyState}</div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-[12px] text-[var(--text-muted)]">
              <span className="font-medium text-[var(--text)]">
                {msg.role === 'user' ? t.chatRoleYou : msg.model || 'Model'}
              </span>
              {msg.mode === 'discuss' && msg.role === 'assistant' && <span>{t.modeDiscuss}</span>}
            </div>

            {msg.plan && (
              <div className="rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-[12px] text-[var(--text-muted)] whitespace-pre-line">
                {msg.plan}
              </div>
            )}

            {msg.toolEvents && msg.toolEvents.length > 0 && (
              <div className="space-y-1.5">
                {msg.toolEvents.map((act) => (
                  <ActionRow key={act.id} action={act} locale={locale} />
                ))}
              </div>
            )}

            {msg.role === 'user' ? (
              <div className="text-[13px] leading-relaxed whitespace-pre-wrap break-words rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[var(--text)]">
                {msg.content}
              </div>
            ) : (
              <SafeMarkdownContent content={msg.content} />
            )}

            {msg.versionId && (
              <div className="flex items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={() => onRestoreVersion(msg.versionId!)}
                  className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] inline-flex items-center gap-1 cursor-pointer"
                >
                  <History className="w-3 h-3" strokeWidth={1.5} />
                  <span>{t.restoreToVersion}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenDiff(msg.versionId!)}
                  className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] inline-flex items-center gap-1 cursor-pointer"
                >
                  <GitCompare className="w-3 h-3" strokeWidth={1.5} />
                  <span>Diff</span>
                </button>
              </div>
            )}
          </div>
        ))}

        {showContinue && (
          <div className="flex justify-start">
            <button
              type="button"
              onClick={() => onSend('lanjutkan')}
              className="h-7 px-3 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[12px] font-medium text-white cursor-pointer"
            >
              {t.continueWork}
            </button>
          </div>
        )}

        {/* Active streaming state */}
        {streaming && (
          <div className="space-y-2 border-t border-[var(--border)] pt-3">
            <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent-text)]" strokeWidth={1.5} />
              <span>{fallbackNotice ? fallbackNotice.toModel : activeModel?.name || 'Model'}</span>
            </div>
            {fallbackNotice && (
              <div className="rounded-[6px] border border-[var(--warning)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[12px] text-[var(--warning-text)] flex items-start gap-2">
                <RefreshCw className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={1.6} />
                <span>
                  {fallbackNotice.fromProvider}/{fallbackNotice.fromModel} → {fallbackNotice.toProvider}/{fallbackNotice.toModel} ({fallbackNotice.reason})
                </span>
              </div>
            )}
            {streamingPlan && streamingPlan.steps.length > 0 && (
              <div className="rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 space-y-1.5">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text)]">
                  <ListChecks className="w-3.5 h-3.5 text-[var(--accent-text)]" strokeWidth={1.6} />
                  <span>{t.executionPlan}</span>
                </div>
                <div className="space-y-1">
                  {streamingPlan.steps.map((step) => (
                    <div key={step.id} className="flex items-center gap-2 text-[12px]">
                      {step.status === 'done' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success-text)] shrink-0" strokeWidth={1.6} />
                      ) : step.status === 'running' ? (
                        <Loader2 className="w-3.5 h-3.5 text-[var(--accent-text)] animate-spin shrink-0" strokeWidth={1.6} />
                      ) : step.status === 'failed' ? (
                        <AlertCircle className="w-3.5 h-3.5 text-[var(--error-text)] shrink-0" strokeWidth={1.6} />
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border border-[var(--border-strong)] shrink-0 inline-block" />
                      )}
                      <span
                        className={
                          step.status === 'done'
                            ? 'text-[var(--text-muted)] line-through'
                            : step.status === 'running'
                              ? 'text-[var(--text)] font-medium'
                              : 'text-[var(--text-muted)]'
                        }
                      >
                        {step.title}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {streamWarning && (
              <div className="rounded-[6px] border border-[var(--warning)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[12px] text-[var(--warning-text)]">
                {streamWarning}
              </div>
            )}
            {streamingActions.length > 0 && (
              <div className="space-y-1.5">
                {streamingActions.map((act) => (
                  <ActionRow key={act.id} action={act} locale={locale} />
                ))}
              </div>
            )}
            {streamingText && <SafeMarkdownContent content={streamingText} />}
          </div>
        )}

        {streamError && (
          <div role="alert" className="rounded-[6px] border border-[var(--error)] bg-[var(--surface-2)] p-2.5 text-[12px] text-[var(--error-text)] space-y-2">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              <span>{streamError}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canRetry && onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] text-[12px] font-medium inline-flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" strokeWidth={1.5} />
                  <span>{t.retry}</span>
                </button>
              )}
              {(isAuthOrKeyError || !canRetry) && (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] text-[12px] font-medium cursor-pointer"
                >
                  {t.openSettingsProvider}
                </button>
              )}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {!isNearBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label={t.scrollToBottom}
          className="absolute right-4 bottom-28 z-10 h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[12px] font-medium text-[var(--text)] flex items-center gap-1 cursor-pointer"
          style={{ boxShadow: 'var(--shadow-float)' }}
        >
          <ArrowDown className="w-3.5 h-3.5" strokeWidth={1.5} />
          <span>{t.scrollToBottom}</span>
        </button>
      )}

      {/* Bottom prompt box */}
      <div className="p-2.5 border-t border-[var(--border)] bg-[var(--surface)] space-y-1.5 shrink-0">
        {mode === 'discuss' && (
          <div className="text-[12px] text-[var(--text-muted)] px-0.5">{t.promptDiscussHint}</div>
        )}
        <div className="rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] focus-within:ring-2 focus-within:ring-[var(--accent)] focus-within:border-[var(--accent)]">
          <label htmlFor="workspace-chat-input" className="sr-only">
            {t.promptForAiAria}
          </label>
          <textarea
            ref={textareaRef}
            id="workspace-chat-input"
            rows={2}
            readOnly={streaming}
            value={inputValue}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={isMac ? t.promptChatMacPlaceholder : t.promptChatOtherPlaceholder}
            className="w-full resize-none bg-transparent px-2.5 pt-2 pb-1 text-[13px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none read-only:opacity-65"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <Wrench className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" strokeWidth={1.5} />
              <div className="min-w-0 flex-1 max-w-[230px]">
                <ModelSelect
                  ariaLabel={t.activeModelAria}
                  locale={locale}
                  models={models}
                  value={activeModel ? `${activeModel.providerKeyId}::${activeModel.id}` : ''}
                  onChange={onSelectModelKey}
                  placement="top"
                  compact
                  showTierFilter
                  popoverClassName="w-[340px]"
                />
              </div>
              {activeModel && <TierBadge tier={activeModel.tier} locale={locale} note={activeModel.tierNote} />}
            </div>

            {streaming ? (
              <button
                type="button"
                onClick={onStop}
                className="h-7 px-2.5 rounded-[6px] border border-[var(--error)] text-[var(--error-text)] text-[12px] font-medium flex items-center gap-1 shrink-0 cursor-pointer"
              >
                <Square className="w-3 h-3 fill-current" />
                <span>{t.stop}</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={!inputValue.trim() || models.length === 0}
                onClick={submit}
                aria-label={t.send}
                title={isMac ? 'Cmd+Enter' : 'Ctrl+Enter'}
                className="h-7 w-7 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed shrink-0 cursor-pointer"
              >
                <ArrowUp className="w-4 h-4" strokeWidth={1.5} />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
