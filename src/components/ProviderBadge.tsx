import { useId, useState } from 'react';
import { FREE_TIER_TOOLTIP, formatTierLabel } from '../i18n';
import type { Locale, ModelTier, ProviderType } from '../types';
import { ProviderLogo } from './ModelIdentityBadge';

const PROVIDER_DISPLAY_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  gemini: 'Gemini',
  coarena: 'Coarena AI',
  custom: 'Custom',
};

interface ProviderBadgeProps {
  provider: ProviderType;
  label?: string;
  customLogoUrl?: string | null;
}

export function ProviderBadge({ provider, label, customLogoUrl }: ProviderBadgeProps) {
  const text = label || PROVIDER_DISPLAY_NAMES[provider] || provider;

  return (
    <span className="inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--border)] px-1.5 py-0.5 text-[12px] leading-[16px] font-mono font-medium text-[var(--text-muted)] whitespace-nowrap shrink-0">
      <ProviderLogo provider={provider} customLogoUrl={customLogoUrl} size={13} />
      <span>{text}</span>
    </span>
  );
}

interface TierBadgeProps {
  tier: ModelTier;
  locale: Locale;
  note?: string;
}

/**
 * Subtle 12px bordered tier label per PRD Section 6.8.4 #6 & Section 5.4:
 * - Free uses semantic success border/text + keyboard/touch-accessible tooltip
 * - Paid / Unknown uses neutral muted border/text (no loud fills)
 */
export function TierBadge({ tier, locale, note }: TierBadgeProps) {
  const [showTip, setShowTip] = useState(false);
  const tipId = useId();
  const label = formatTierLabel(tier, locale);
  const title =
    tier === 'free'
      ? note
        ? `${FREE_TIER_TOOLTIP[locale]} ${note}`
        : FREE_TIER_TOOLTIP[locale]
      : note || undefined;

  const colorClass =
    tier === 'free'
      ? 'border-[var(--success)] text-[var(--success-text)]'
      : 'border-[var(--border)] text-[var(--text-muted)]';

  if (!title) {
    return (
      <span
        className={`inline-flex items-center rounded-[6px] border px-1.5 py-0 text-[12px] leading-[18px] font-medium whitespace-nowrap shrink-0 ${colorClass}`}
      >
        {label}
      </span>
    );
  }

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => setShowTip(false)}
    >
      <span
        role="button"
        tabIndex={0}
        aria-describedby={showTip ? tipId : undefined}
        title={title}
        onFocus={() => setShowTip(true)}
        onBlur={() => setShowTip(false)}
        onClick={(e) => {
          e.stopPropagation();
          setShowTip((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            setShowTip((v) => !v);
          } else if (e.key === 'Escape') {
            setShowTip(false);
          }
        }}
        className={`inline-flex items-center rounded-[6px] border px-1.5 py-0 text-[12px] leading-[18px] font-medium whitespace-nowrap shrink-0 cursor-help ${colorClass}`}
      >
        {label}
      </span>
      {showTip && (
        <span
          id={tipId}
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 w-56 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[12px] font-normal text-[var(--text)] leading-snug pointer-events-none"
          style={{ boxShadow: 'var(--shadow-float)' }}
        >
          {title}
        </span>
      )}
    </span>
  );
}
