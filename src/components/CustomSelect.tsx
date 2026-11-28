import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { resolveModelIdentity } from '../../shared/modelIdentity';
import { COPY } from '../i18n';
import type { Locale, ModelTier, ProviderModel, ProviderType } from '../types';
import { ModelCreatorLogo, ProviderLogo } from './ModelIdentityBadge';
import { TierBadge } from './ProviderBadge';

export interface SelectOption {
  value: string;
  label: string;
  sublabel?: string;
  sublabelNode?: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  searchKeywords?: string;
  disabled?: boolean;
}

interface CustomSelectProps {
  id?: string;
  locale?: Locale;
  ariaLabel?: string;
  value: string;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  placement?: 'bottom' | 'top';
  align?: 'left' | 'right';
  triggerClassName?: string;
  popoverClassName?: string;
  headerSlot?: React.ReactNode;
  footerSlot?: React.ReactNode;
  renderTriggerValue?: (selected: SelectOption | undefined) => React.ReactNode;
  onChange: (value: string) => void;
}

export function CustomSelect({
  id,
  locale = 'id',
  ariaLabel,
  value,
  options,
  placeholder,
  disabled = false,
  searchable,
  searchPlaceholder,
  emptyText,
  placement = 'bottom',
  align = 'left',
  triggerClassName = '',
  popoverClassName = '',
  headerSlot,
  footerSlot,
  renderTriggerValue,
  onChange,
}: CustomSelectProps) {
  const t = COPY[locale];
  const resolvedPlaceholder = placeholder ?? t.selectPlaceholder;
  const resolvedSearchPlaceholder = searchPlaceholder ?? t.searchPlaceholder;
  const resolvedEmptyText = emptyText ?? t.emptySelectText;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const showSearch = searchable ?? options.length > 6;

  const selectedOption = useMemo(() => options.find((o) => o.value === value), [options, value]);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.sublabel && o.sublabel.toLowerCase().includes(q)) ||
        (o.searchKeywords && o.searchKeywords.toLowerCase().includes(q)) ||
        o.value.toLowerCase().includes(q)
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) {
      const frame = requestAnimationFrame(() => setQuery(''));
      return () => cancelAnimationFrame(frame);
    }
    const selIdx = filteredOptions.findIndex((o) => o.value === value && !o.disabled);
    const frame = requestAnimationFrame(() => {
      setActiveIndex(selIdx >= 0 ? selIdx : 0);
      if (showSearch) {
        searchInputRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
    // Intentionally sync selection index and focus when dropdown opens/closes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showSearch]);

  const safeActiveIndex = Math.min(activeIndex, Math.max(0, filteredOptions.length - 1));

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [open]);

  function selectOption(opt: SelectOption) {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveActive(delta: number) {
    if (filteredOptions.length === 0) return;
    let next = safeActiveIndex;
    for (let step = 0; step < filteredOptions.length; step += 1) {
      next = (next + delta + filteredOptions.length) % filteredOptions.length;
      if (!filteredOptions[next].disabled) {
        setActiveIndex(next);
        const itemEl = listRef.current?.querySelector(`[data-opt-idx="${next}"]`) as HTMLElement | null;
        itemEl?.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
  }

  function handleKeyNavigation(e: React.KeyboardEvent) {
    const inSearchInput = document.activeElement === searchInputRef.current;

    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === 'Home' && !inSearchInput) {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End' && !inSearchInput) {
      e.preventDefault();
      setActiveIndex(Math.max(0, filteredOptions.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filteredOptions[safeActiveIndex];
      if (target) selectOption(target);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  const posClass = placement === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5';
  const alignClass = align === 'right' ? 'right-0' : 'left-0';
  const activeOptionId =
    open && filteredOptions[safeActiveIndex] ? `${listboxId}-opt-${safeActiveIndex}` : undefined;
  const computedAriaLabel = ariaLabel
    ? selectedOption
      ? `${ariaLabel}: ${selectedOption.label}`
      : ariaLabel
    : undefined;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={computedAriaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={handleKeyNavigation}
        className={`w-full h-10 sm:h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] px-2.5 text-[13px] text-[var(--text)] flex items-center justify-between gap-2 text-left cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${triggerClassName}`}
      >
        <div className="min-w-0 flex-1 flex items-center gap-1.5 truncate">
          {renderTriggerValue ? (
            renderTriggerValue(selectedOption)
          ) : (
            <span className={`truncate ${selectedOption ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>
              {selectedOption ? selectedOption.label : resolvedPlaceholder}
            </span>
          )}
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          strokeWidth={1.5}
        />
      </button>

      {open && (
        <div
          className={`absolute ${posClass} ${alignClass} z-50 min-w-full w-max max-w-[min(360px,calc(100vw-24px))] rounded-[8px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] overflow-hidden ${popoverClassName}`}
          style={{ boxShadow: 'var(--shadow-float)' }}
          onKeyDown={handleKeyNavigation}
        >
          {showSearch && (
            <div className="p-2 border-b border-[var(--border)]">
              <div className="relative flex items-center">
                <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 pointer-events-none" strokeWidth={1.5} />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActiveIndex(0);
                  }}
                  placeholder={resolvedSearchPlaceholder}
                  aria-label={resolvedSearchPlaceholder}
                  className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] pl-8 pr-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
              </div>
            </div>
          )}

          {headerSlot && (
            <div className="px-2 py-1.5 border-b border-[var(--border)] bg-[var(--surface)]">{headerSlot}</div>
          )}

          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-[320px] overflow-y-auto p-1 space-y-0.5"
          >
            {filteredOptions.length === 0 ? (
              <div className="px-2.5 py-4 text-[13px] text-[var(--text-muted)] text-center">{resolvedEmptyText}</div>
            ) : (
              filteredOptions.map((opt, idx) => {
                const isSelected = opt.value === value;
                const isActive = idx === safeActiveIndex;
                return (
                  <button
                    key={opt.value}
                    id={`${listboxId}-opt-${idx}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={isSelected}
                    disabled={opt.disabled}
                    data-opt-idx={idx}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => selectOption(opt)}
                    className={`w-full min-h-[40px] sm:min-h-[32px] px-2.5 sm:px-2 py-2 sm:py-1.5 rounded-[6px] text-[13px] flex items-center justify-between gap-2 text-left cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                      isSelected || isActive
                        ? 'bg-[var(--surface-2)] text-[var(--text)]'
                        : 'text-[var(--text)] hover:bg-[var(--surface-2)]'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                        {isSelected && <Check className="w-3.5 h-3.5 text-[var(--accent-text)]" strokeWidth={2} />}
                      </span>
                      {opt.icon && <span className="shrink-0 flex items-center justify-center">{opt.icon}</span>}
                      <div className="min-w-0 flex-1">
                        <div className={`truncate leading-tight ${isSelected ? 'font-medium' : ''}`}>{opt.label}</div>
                        {opt.sublabelNode ? (
                          <div className="mt-0.5 min-w-0">{opt.sublabelNode}</div>
                        ) : opt.sublabel ? (
                          <div className="text-[12px] text-[var(--text-muted)] font-mono truncate leading-tight mt-0.5">
                            {opt.sublabel}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {opt.badge && <div className="shrink-0">{opt.badge}</div>}
                  </button>
                );
              })
            )}
          </div>

          {footerSlot && (
            <div className="px-2.5 py-2 border-t border-[var(--border)] bg-[var(--surface)]">{footerSlot}</div>
          )}
        </div>
      )}
    </div>
  );
}

const CLIENT_NON_CHAT_RE =
  /(?:^|[-_./:\s])(image|imagen|nano-banana|tts|transcribe|embedding|embed|aqa|veo|live|lyria|whisper|dall-e|moderation|sora|audio|speech|realtime|rerank)(?:$|[-_./:\s0-9])|nano-banana|imagen|embedding|transcribe/i;

export function isModelNonChat(model: ProviderModel): boolean {
  if (typeof model.isNonChat === 'boolean') return model.isNonChat;
  return CLIENT_NON_CHAT_RE.test(`${model.id} ${model.name}`);
}

export function prepareModelList(
  models: ProviderModel[],
  opts: { showAllModels: boolean; tierFilter?: 'all' | 'free' | 'paid' }
): { visible: ProviderModel[]; hiddenNonChatCount: number } {
  const deduped: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    const key = `${m.providerKeyId}::${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }

  let hiddenNonChatCount = 0;
  const visible: ProviderModel[] = [];
  for (const m of deduped) {
    const nonChat = isModelNonChat(m);
    if (nonChat && !opts.showAllModels) {
      hiddenNonChatCount += 1;
      continue;
    }
    if (opts.tierFilter === 'free' && m.tier !== 'free') continue;
    if (opts.tierFilter === 'paid' && m.tier !== 'paid') continue;
    visible.push(m);
  }
  return { visible, hiddenNonChatCount };
}

interface ModelSelectProps {
  id?: string;
  ariaLabel?: string;
  locale: Locale;
  models: ProviderModel[];
  value: string;
  onChange: (value: string) => void;
  allowEmptyLabel?: string;
  placement?: 'bottom' | 'top';
  align?: 'left' | 'right';
  compact?: boolean;
  triggerClassName?: string;
  popoverClassName?: string;
  showTierFilter?: boolean;
}

export function ModelSelect({
  id,
  ariaLabel,
  locale,
  models,
  value,
  onChange,
  allowEmptyLabel,
  placement = 'bottom',
  align = 'left',
  compact = false,
  triggerClassName = '',
  popoverClassName = 'w-[min(340px,calc(100vw-24px))]',
  showTierFilter = false,
}: ModelSelectProps) {
  const t = COPY[locale];
  const [showAllModels, setShowAllModels] = useState(false);
  const [tierFilter, setTierFilter] = useState<'all' | 'free' | 'paid'>('all');
  const [providerFilter, setProviderFilter] = useState<'all' | ProviderType>('all');

  const availableProviders = useMemo(() => {
    const seen = new Set<ProviderType>();
    for (const m of models) seen.add(m.provider);
    return Array.from(seen);
  }, [models]);

  const { visible, hiddenNonChatCount } = useMemo(() => {
    const base = prepareModelList(models, { showAllModels, tierFilter: showTierFilter ? tierFilter : 'all' });
    if (providerFilter === 'all') return base;
    return {
      visible: base.visible.filter((m) => m.provider === providerFilter),
      hiddenNonChatCount: base.hiddenNonChatCount,
    };
  }, [models, showAllModels, showTierFilter, tierFilter, providerFilter]);

  // Always keep currently selected model selectable even if it was hidden
  const effectiveModels = useMemo(() => {
    if (!value) return visible;
    if (visible.some((m) => `${m.providerKeyId}::${m.id}` === value)) return visible;
    const selected = models.find((m) => `${m.providerKeyId}::${m.id}` === value);
    return selected ? [selected, ...visible] : visible;
  }, [visible, models, value]);

  const options = useMemo<SelectOption[]>(() => {
    const list: SelectOption[] = [];
    if (allowEmptyLabel) {
      list.push({ value: '', label: allowEmptyLabel });
    }
    for (const m of effectiveModels) {
      const identity =
        m.identity ??
        resolveModelIdentity({
          provider: m.provider,
          modelId: m.id,
          modelName: m.name,
        });
      const contextShort =
        typeof m.maxContext === 'number' && m.maxContext > 0
          ? m.maxContext >= 1_000_000
            ? `${(m.maxContext / 1_000_000).toFixed(m.maxContext % 1_000_000 === 0 ? 0 : 1)}M ctx`
            : `${Math.round(m.maxContext / 1000)}k ctx`
          : null;

      list.push({
        value: `${m.providerKeyId}::${m.id}`,
        label: m.name,
        sublabel: `${identity.modelCreatorName} · ${m.providerLabel} · ${m.id}`,
        searchKeywords: `${identity.modelCreatorName} ${identity.modelFamily} ${identity.providerName} ${m.providerLabel} ${m.provider} ${m.id}`,
        icon: <ModelCreatorLogo identity={identity} size={16} />,
        sublabelNode: (
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] leading-tight truncate">
            <span className="truncate">{identity.modelCreatorName}</span>
            {identity.isAggregated && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 shrink-0">
                  <ProviderLogo provider={m.provider} size={11} />
                  <span className="truncate max-w-[84px]">{m.providerLabel}</span>
                </span>
              </>
            )}
            {contextShort && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums shrink-0">{contextShort}</span>
              </>
            )}
          </div>
        ),
        badge: <TierBadge tier={m.tier as ModelTier} locale={locale} note={m.tierNote} />,
      });
    }
    return list;
  }, [effectiveModels, allowEmptyLabel, locale]);

  const activeModel = useMemo(
    () => models.find((m) => `${m.providerKeyId}::${m.id}` === value) ?? null,
    [models, value]
  );

  const activeIdentity = useMemo(
    () =>
      activeModel
        ? activeModel.identity ??
          resolveModelIdentity({
            provider: activeModel.provider,
            modelId: activeModel.id,
            modelName: activeModel.name,
          })
        : null,
    [activeModel]
  );

  const hasAnyNonChat = hiddenNonChatCount > 0 || showAllModels;
  const showHeaderFilters = showTierFilter || availableProviders.length > 1;

  return (
    <CustomSelect
      id={id}
      locale={locale}
      ariaLabel={ariaLabel || t.selectModelLabel}
      value={value}
      options={options}
      searchable
      searchPlaceholder={t.searchModelsPlaceholder}
      emptyText={t.noMatchingModels}
      placeholder={allowEmptyLabel || t.noModelLabel}
      placement={placement}
      align={align}
      triggerClassName={
        compact
          ? `h-7 px-2 text-[12px] bg-[var(--surface)] border-[var(--border-strong)] ${triggerClassName}`
          : triggerClassName
      }
      popoverClassName={popoverClassName}
      onChange={onChange}
      renderTriggerValue={() =>
        activeModel && activeIdentity ? (
          <span className="flex items-center gap-1.5 min-w-0 flex-1">
            <ModelCreatorLogo identity={activeIdentity} size={compact ? 14 : 15} />
            <span className="truncate font-medium text-[var(--text)]">{activeModel.name}</span>
            {activeIdentity.isAggregated && !compact && (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] shrink-0"
                title={`Routed via ${activeModel.providerLabel}`}
              >
                <ProviderLogo provider={activeModel.provider} size={12} />
              </span>
            )}
            {!compact && <TierBadge tier={activeModel.tier} locale={locale} note={activeModel.tierNote} />}
          </span>
        ) : (
          <span className="truncate text-[var(--text-muted)]">{allowEmptyLabel || t.noModelLabel}</span>
        )
      }
      headerSlot={
        showHeaderFilters ? (
          <div className="space-y-1.5">
            {showTierFilter && (
              <div className="flex items-center gap-1">
                {(['all', 'free', 'paid'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setTierFilter(f)}
                    className={`h-6 px-2 rounded-[5px] text-[11px] font-medium cursor-pointer ${
                      tierFilter === f
                        ? 'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                    }`}
                  >
                    {f === 'all' ? t.filterAll : f === 'free' ? t.filterFree : t.filterPaid}
                  </button>
                ))}
              </div>
            )}
            {availableProviders.length > 1 && (
              <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
                <button
                  type="button"
                  onClick={() => setProviderFilter('all')}
                  className={`h-6 px-2 rounded-[5px] text-[11px] font-medium whitespace-nowrap cursor-pointer ${
                    providerFilter === 'all'
                      ? 'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {t.filterAll}
                </button>
                {availableProviders.map((prov) => (
                  <button
                    key={prov}
                    type="button"
                    onClick={() => setProviderFilter(prov)}
                    className={`h-6 px-2 rounded-[5px] text-[11px] font-medium whitespace-nowrap inline-flex items-center gap-1 cursor-pointer ${
                      providerFilter === prov
                        ? 'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                    }`}
                  >
                    <ProviderLogo provider={prov} size={12} />
                    <span className="capitalize">{prov}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : undefined
      }
      footerSlot={
        hasAnyNonChat ? (
          <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer select-none">
            <span className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showAllModels}
                onChange={(e) => setShowAllModels(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span>{t.showAllModels}</span>
            </span>
            {!showAllModels && hiddenNonChatCount > 0 && (
              <span className="text-[12px] font-mono tabular-nums text-[var(--text-muted)]">
                +{hiddenNonChatCount}
              </span>
            )}
          </label>
        ) : undefined
      }
    />
  );
}
