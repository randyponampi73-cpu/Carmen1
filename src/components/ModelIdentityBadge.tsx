import { useState } from 'react';
import {
  getProviderBrand,
  resolveModelIdentity,
  validateSafeLogoUrl,
  type ModelIdentity,
} from '../../shared/modelIdentity';
import type { ProviderType } from '../types';

interface BrandLogoProps {
  src: string;
  alt: string;
  monochrome?: boolean;
  fallbackMonogram: string;
  accentColor?: string;
  size?: number;
  className?: string;
}

/**
 * Renders a verified local SVG brand mark with automatic dark-mode contrast handling
 * for monochrome marks and a deterministic monogram fallback if an image fails to load.
 */
export function BrandLogo({
  src,
  alt,
  monochrome = false,
  fallbackMonogram,
  accentColor = '#64748B',
  size = 16,
  className = '',
}: BrandLogoProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;

  if (failed || !src) {
    return (
      <span
        role="img"
        aria-label={alt}
        title={alt}
        style={{
          width: size,
          height: size,
          fontSize: Math.max(8, Math.round(size * 0.52)),
          borderColor: accentColor,
          color: accentColor,
        }}
        className={`inline-flex items-center justify-center rounded-[4px] border font-mono font-semibold leading-none shrink-0 select-none ${className}`}
      >
        {fallbackMonogram.slice(0, 2)}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      title={alt}
      width={size}
      height={size}
      decoding="sync"
      onError={() => setFailedSrc(src)}
      style={{ width: size, height: size }}
      className={`inline-block shrink-0 object-contain select-none ${
        monochrome ? 'dark:invert opacity-90' : ''
      } ${className}`}
    />
  );
}

interface ProviderLogoProps {
  provider: ProviderType | string;
  customLogoUrl?: string | null;
  size?: number;
  className?: string;
}

export function ProviderLogo({ provider, customLogoUrl, size = 16, className = '' }: ProviderLogoProps) {
  const brand = getProviderBrand(provider);
  const safeCustom = provider === 'custom' ? validateSafeLogoUrl(customLogoUrl) : null;
  const src = safeCustom || brand.logoPath;
  const monochrome = safeCustom ? false : brand.monochrome;

  return (
    <BrandLogo
      src={src}
      alt={`${brand.displayName} logo`}
      monochrome={monochrome}
      fallbackMonogram={brand.fallbackMonogram}
      accentColor={brand.accentColor}
      size={size}
      className={className}
    />
  );
}

interface ModelCreatorLogoProps {
  identity?: ModelIdentity | null;
  provider?: ProviderType | string;
  modelId?: string;
  modelName?: string;
  customLogoUrl?: string | null;
  size?: number;
  className?: string;
}

export function ModelCreatorLogo({
  identity,
  provider = 'custom',
  modelId = '',
  modelName,
  customLogoUrl,
  size = 16,
  className = '',
}: ModelCreatorLogoProps) {
  const resolved =
    identity ??
    resolveModelIdentity({
      provider,
      modelId,
      modelName,
      customLogoUrl,
    });

  return (
    <BrandLogo
      src={resolved.modelCreatorLogo}
      alt={`${resolved.modelCreatorName} (${resolved.modelFamily}) logo`}
      monochrome={resolved.modelCreatorMonochrome}
      fallbackMonogram={resolved.modelCreatorMonogram}
      accentColor={resolved.modelCreatorAccent}
      size={size}
      className={className}
    />
  );
}

interface ModelIdentityInlineProps {
  identity?: ModelIdentity | null;
  provider: ProviderType | string;
  modelId: string;
  modelName?: string;
  providerLabel?: string;
  size?: number;
  showProviderRoute?: boolean;
  showModelId?: boolean;
  className?: string;
}

/**
 * Clean inline identity display showing:
 * - Creator Logo + Model Name (or ID)
 * - Optional subtle route indicator (`via ProviderLogo ProviderName`) when routed via an aggregator (OpenRouter, Groq, Custom)
 */
export function ModelIdentityInline({
  identity,
  provider,
  modelId,
  modelName,
  providerLabel,
  size = 15,
  showProviderRoute = true,
  showModelId = false,
  className = '',
}: ModelIdentityInlineProps) {
  const resolved =
    identity ??
    resolveModelIdentity({
      provider,
      modelId,
      modelName,
    });

  return (
    <span className={`inline-flex items-center gap-1.5 min-w-0 ${className}`}>
      <ModelCreatorLogo identity={resolved} size={size} />
      <span className="truncate font-medium text-[var(--text)]">
        {modelName || resolved.modelName || modelId}
      </span>
      {showModelId && modelName && modelName !== modelId && (
        <span className="truncate font-mono text-[11px] text-[var(--text-muted)]">{modelId}</span>
      )}
      {showProviderRoute && resolved.isAggregated && (
        <span
          className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] whitespace-nowrap shrink-0"
          title={`Model by ${resolved.modelCreatorName} · Routed via ${providerLabel || resolved.providerName}`}
        >
          <span aria-hidden="true">·</span>
          <ProviderLogo provider={resolved.provider} size={Math.max(11, size - 3)} />
          <span className="truncate max-w-[96px]">{providerLabel || resolved.providerName}</span>
        </span>
      )}
    </span>
  );
}
