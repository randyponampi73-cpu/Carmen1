import type { BuiltInProviderId, ProviderType } from '../../src/types';
import { maskSecretLast4 } from '../security';
import { AnthropicAdapter } from './anthropic';
import { CoarenaAdapter } from './coarena';
import { GeminiAdapter } from './gemini';
import { OpenAICompatibleAdapter } from './openaiCompatible';
import type { ProviderAdapter, ProviderAdapterConfig } from './types';

const adapters: Record<ProviderType, ProviderAdapter> = {
  anthropic: new AnthropicAdapter(),
  openai: new OpenAICompatibleAdapter('openai'),
  openrouter: new OpenAICompatibleAdapter('openrouter'),
  groq: new OpenAICompatibleAdapter('groq'),
  coarena: new CoarenaAdapter(),
  custom: new OpenAICompatibleAdapter('custom'),
  gemini: new GeminiAdapter(),
};

export const PLATFORM_ENV_KEY_MAP: Record<BuiltInProviderId, string> = {
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  coarena: 'COARENA_API_KEY',
};

const PLATFORM_KEY_PLACEHOLDERS = new Set([
  'MY_GEMINI_API_KEY',
  'YOUR_API_KEY',
  'CHANGE_ME',
]);

export function getPlatformFallbackKey(
  provider: ProviderType,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (provider === 'custom') return null;
  const envName = PLATFORM_ENV_KEY_MAP[provider];
  if (!envName) return null;
  const raw = (env[envName] || '').trim();
  if (!raw || raw.length < 4 || PLATFORM_KEY_PLACEHOLDERS.has(raw)) {
    return null;
  }
  return raw;
}

export function listAvailablePlatformFallbackProviders(
  env: NodeJS.ProcessEnv = process.env
): Array<{ provider: BuiltInProviderId; envVar: string; keyLast4: string }> {
  const out: Array<{ provider: BuiltInProviderId; envVar: string; keyLast4: string }> = [];
  for (const [provider, envVar] of Object.entries(PLATFORM_ENV_KEY_MAP) as Array<[BuiltInProviderId, string]>) {
    const key = getPlatformFallbackKey(provider, env);
    if (key) {
      out.push({ provider, envVar, keyLast4: maskSecretLast4(key) });
    }
  }
  return out;
}

export function buildPlatformFallbackAdapterConfig(
  provider: BuiltInProviderId,
  env: NodeJS.ProcessEnv = process.env
): ProviderAdapterConfig | null {
  const apiKey = getPlatformFallbackKey(provider, env);
  if (!apiKey) return null;
  const displayNames: Record<BuiltInProviderId, string> = {
    gemini: 'Gemini (Platform .env)',
    anthropic: 'Anthropic (Platform .env)',
    openai: 'OpenAI (Platform .env)',
    openrouter: 'OpenRouter (Platform .env)',
    groq: 'Groq (Platform .env)',
    coarena: 'Coarena AI (Platform .env)',
  };
  return {
    providerKeyId: `key_platform_${provider}`,
    provider,
    label: displayNames[provider],
    apiKey,
    tierDeclared: provider === 'gemini' || provider === 'groq' || provider === 'openrouter' ? 'free' : 'unknown',
    supportsTools: 'yes',
    supportsVision: provider === 'groq' ? 'unknown' : 'yes',
  };
}

/**
 * Resolves the effective provider adapter configuration for a request:
 * 1. User BYOK key matching requestedProviderKeyId (or same provider when a virtual platform key was requested)
 * 2. Platform `.env` fallback key when the user has not configured a BYOK key for that provider
 */
export function resolveEffectiveProviderConfig(opts: {
  userByokConfigs: ProviderAdapterConfig[];
  requestedProviderKeyId?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderAdapterConfig | null {
  const env = opts.env ?? process.env;
  const requestedId = (opts.requestedProviderKeyId || '').trim();

  if (requestedId) {
    const exactByok = opts.userByokConfigs.find((c) => c.providerKeyId === requestedId);
    if (exactByok) return exactByok;

    if (requestedId.startsWith('key_platform_')) {
      const platProvider = requestedId.slice('key_platform_'.length) as BuiltInProviderId;
      const byokForSameProvider = opts.userByokConfigs.find((c) => c.provider === platProvider);
      if (byokForSameProvider) return byokForSameProvider;
      return buildPlatformFallbackAdapterConfig(platProvider, env);
    }
  }

  if (opts.userByokConfigs.length > 0) {
    return opts.userByokConfigs[0];
  }

  const availablePlatforms = listAvailablePlatformFallbackProviders(env);
  if (availablePlatforms.length > 0) {
    return buildPlatformFallbackAdapterConfig(availablePlatforms[0].provider, env);
  }
  return null;
}

export function getProviderAdapter(provider: ProviderType): ProviderAdapter {
  const adapter = adapters[provider];
  if (!adapter) {
    throw new Error(`Adapter tidak tersedia untuk provider: ${provider}`);
  }
  return adapter;
}

export * from './catalog';
export * from './coarena';
export * from './types';
export * from '../../shared/modelIdentity';
