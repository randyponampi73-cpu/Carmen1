import fs from 'node:fs';
import path from 'node:path';
import type { ModelTier, ProviderModel, ProviderType, TriState } from '../../src/types';

export interface CatalogEntry {
  provider: ProviderType;
  modelId: string;
  name: string;
  tier: ModelTier;
  toolCalling: TriState;
  vision: TriState;
  maxContext: number | 'unknown';
  maxOutput: number | 'unknown';
  promptPricePerMillion?: number | null;
  completionPricePerMillion?: number | null;
  source: string;
  lastVerified: string;
}

const VALID_PROVIDERS = new Set<ProviderType>([
  'gemini',
  'anthropic',
  'openai',
  'openrouter',
  'groq',
  'coarena',
  'custom',
]);
const VALID_TIERS = new Set<ModelTier>(['free', 'paid', 'unknown']);
const VALID_TRISTATE = new Set<TriState>(['yes', 'no', 'unknown']);

const CATALOG_PATH = path.resolve(process.cwd(), 'server/data/model-catalog.json');

let cachedCatalog: CatalogEntry[] | null = null;
let cachedCatalogMeta: { version: number; updatedAt: string | null } = { version: 0, updatedAt: null };

function normalizeCatalogEntry(raw: unknown): CatalogEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.provider !== 'string' || !VALID_PROVIDERS.has(item.provider as ProviderType)) return null;
  if (typeof item.modelId !== 'string' || !item.modelId.trim()) return null;
  const maxContext =
    typeof item.maxContext === 'number' && Number.isFinite(item.maxContext) && item.maxContext > 0
      ? item.maxContext
      : 'unknown';
  const maxOutput =
    typeof item.maxOutput === 'number' && Number.isFinite(item.maxOutput) && item.maxOutput > 0
      ? item.maxOutput
      : 'unknown';
  return {
    provider: item.provider as ProviderType,
    modelId: item.modelId.trim(),
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.modelId.trim(),
    tier: typeof item.tier === 'string' && VALID_TIERS.has(item.tier as ModelTier) ? (item.tier as ModelTier) : 'unknown',
    toolCalling:
      typeof item.toolCalling === 'string' && VALID_TRISTATE.has(item.toolCalling as TriState)
        ? (item.toolCalling as TriState)
        : 'unknown',
    vision:
      typeof item.vision === 'string' && VALID_TRISTATE.has(item.vision as TriState)
        ? (item.vision as TriState)
        : 'unknown',
    maxContext,
    maxOutput,
    promptPricePerMillion:
      typeof item.promptPricePerMillion === 'number' && Number.isFinite(item.promptPricePerMillion)
        ? item.promptPricePerMillion
        : null,
    completionPricePerMillion:
      typeof item.completionPricePerMillion === 'number' && Number.isFinite(item.completionPricePerMillion)
        ? item.completionPricePerMillion
        : null,
    source: typeof item.source === 'string' && item.source.trim() ? item.source.trim() : 'curated-fallback',
    lastVerified: typeof item.lastVerified === 'string' && item.lastVerified.trim() ? item.lastVerified.trim() : '',
  };
}

export function loadModelCatalog(filePath = CATALOG_PATH): CatalogEntry[] {
  if (cachedCatalog && filePath === CATALOG_PATH) return cachedCatalog;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown; updatedAt?: unknown; entries?: unknown[] };
    const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const entries = rawEntries.map(normalizeCatalogEntry).filter((e): e is CatalogEntry => e !== null);
    if (filePath === CATALOG_PATH) {
      cachedCatalog = entries;
      cachedCatalogMeta = {
        version: typeof parsed?.version === 'number' && Number.isFinite(parsed.version) ? parsed.version : 1,
        updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
      };
    }
    return entries;
  } catch {
    if (filePath === CATALOG_PATH) {
      cachedCatalog = [];
      cachedCatalogMeta = { version: 0, updatedAt: null };
    }
    return [];
  }
}

export function reloadModelCatalog(): CatalogEntry[] {
  cachedCatalog = null;
  return loadModelCatalog();
}

export function getModelCatalogMetadata(): { version: number; updatedAt: string | null; count: number; path: string } {
  const entries = loadModelCatalog();
  return {
    version: cachedCatalogMeta.version,
    updatedAt: cachedCatalogMeta.updatedAt,
    count: entries.length,
    path: CATALOG_PATH,
  };
}

export function findCatalogEntry(provider: ProviderType, modelId: string): CatalogEntry | undefined {
  const catalog = loadModelCatalog();
  return catalog.find((entry) => entry.provider === provider && entry.modelId === modelId);
}

/**
 * Estimates USD cost for a completion from catalog pricing (or conservative fallback rates).
 * Computed strictly server-side from provider usage telemetry.
 */
export function estimateModelCostUsd(
  provider: ProviderType,
  modelId: string,
  tokensIn: number,
  tokensOut: number
): number {
  const safeIn = Math.max(0, Number.isFinite(tokensIn) ? tokensIn : 0);
  const safeOut = Math.max(0, Number.isFinite(tokensOut) ? tokensOut : 0);
  if (safeIn === 0 && safeOut === 0) return 0;

  const entry = findCatalogEntry(provider, modelId);
  let promptPerMillion = entry?.promptPricePerMillion ?? null;
  let completionPerMillion = entry?.completionPricePerMillion ?? null;

  if (promptPerMillion === null || completionPerMillion === null) {
    if (provider === 'anthropic') {
      promptPerMillion = 3;
      completionPerMillion = 15;
    } else if (provider === 'openai') {
      promptPerMillion = 2;
      completionPerMillion = 8;
    } else if (provider === 'gemini') {
      promptPerMillion = 0.35;
      completionPerMillion = 1.05;
    } else if (provider === 'groq') {
      promptPerMillion = 0.4;
      completionPerMillion = 0.6;
    } else {
      promptPerMillion = 0.5;
      completionPerMillion = 1.5;
    }
  }

  const usd = (safeIn / 1_000_000) * promptPerMillion + (safeOut / 1_000_000) * completionPerMillion;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/**
 * Resolves model tier strictly according to PRD Section 5.4 rules.
 */
export function resolveModelTier(params: {
  provider: ProviderType;
  tierDeclared: ModelTier;
  catalogEntry?: CatalogEntry;
  openRouterPromptPrice?: string | number | null;
  openRouterCompletionPrice?: string | number | null;
}): { tier: ModelTier; tierNote?: string } {
  const { provider, tierDeclared, catalogEntry, openRouterPromptPrice, openRouterCompletionPrice } = params;

  if (provider === 'openrouter' || provider === 'coarena') {
    if (
      openRouterPromptPrice !== undefined &&
      openRouterPromptPrice !== null &&
      openRouterCompletionPrice !== undefined &&
      openRouterCompletionPrice !== null
    ) {
      const p = Number(openRouterPromptPrice);
      const c = Number(openRouterCompletionPrice);
      if (!Number.isNaN(p) && !Number.isNaN(c)) {
        return {
          tier: p === 0 && c === 0 ? 'free' : 'paid',
          ...(provider === 'coarena' && p === 0 && c === 0 ? { tierNote: 'Batas harian/menit berlaku sesuai akun Coarena' } : {}),
        };
      }
    }
    if (catalogEntry) return { tier: catalogEntry.tier };
    return { tier: tierDeclared !== 'unknown' ? tierDeclared : 'unknown' };
  }

  if (provider === 'groq' || provider === 'gemini') {
    const tier = tierDeclared !== 'unknown' ? tierDeclared : catalogEntry?.tier ?? 'unknown';
    return {
      tier,
      tierNote: 'Batas dapat berbeda per paket',
    };
  }

  if (provider === 'custom') {
    return { tier: tierDeclared || 'unknown' };
  }

  // Anthropic, OpenAI: paid unless admin catalog states otherwise
  if (catalogEntry) return { tier: catalogEntry.tier };
  return { tier: 'paid' };
}

// 1-hour per-key model cache (PRD Section 5.3)
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const modelCache = new Map<string, { fetchedAt: number; models: ProviderModel[] }>();

export function getCachedModels(providerKeyId: string): ProviderModel[] | null {
  const hit = modelCache.get(providerKeyId);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > MODEL_CACHE_TTL_MS) {
    modelCache.delete(providerKeyId);
    return null;
  }
  return hit.models;
}

export function setCachedModels(providerKeyId: string, models: ProviderModel[]): void {
  modelCache.set(providerKeyId, { fetchedAt: Date.now(), models });
}

export function invalidateCachedModels(providerKeyId: string): void {
  modelCache.delete(providerKeyId);
}

const NON_CHAT_MODEL_RE =
  /(?:^|[-_./:\s])(image|imagen|nano-banana|tts|transcribe|embedding|embed|aqa|veo|live|lyria|whisper|dall-e|moderation|sora|audio|speech|realtime|rerank|bge-|e5-)(?:$|[-_./:\s0-9])/i;

/**
 * Returns true if a model ID or display name represents a non-chat modality
 * (image, audio/TTS/STT, video, embedding, AQA, live, moderation, etc.).
 */
export function isNonChatModel(modelId: string, modelName?: string): boolean {
  const combined = `${modelId} ${modelName || ''}`;
  return (
    NON_CHAT_MODEL_RE.test(combined) ||
    /nano-banana|imagen|embedding|transcribe|\btts\b|\baqa\b|\bveo\b|\blive\b|\blyria\b|\bwhisper\b|dall-e/i.test(
      combined
    )
  );
}

export function deduplicateModels(models: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  const out: ProviderModel[] = [];
  for (const m of models) {
    const key = `${m.providerKeyId}::${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

