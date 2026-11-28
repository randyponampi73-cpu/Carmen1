/**
 * Centralized AI Model Identity & Brand Registry
 *
 * Strictly separates:
 *  1. Provider Identity  — the API platform / router executing requests (Anthropic, Google Gemini, OpenAI, OpenRouter, Groq, Coarena AI, Custom)
 *  2. Model Creator      — the organization that authored the underlying model (Anthropic, OpenAI, Google, Meta, DeepSeek, Mistral, Qwen, xAI, Cohere, Perplexity, NVIDIA, Microsoft, Coarena, Custom, Unknown)
 *
 * Shared by both backend provider adapters / catalog APIs and frontend UI components.
 * All local SVG paths resolve under /public/logos/ (served at /logos/*.svg).
 */

export type ProviderId =
  | 'anthropic'
  | 'gemini'
  | 'openai'
  | 'openrouter'
  | 'groq'
  | 'coarena'
  | 'custom';

export type ModelCreatorId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'meta'
  | 'deepseek'
  | 'mistral'
  | 'qwen'
  | 'xai'
  | 'cohere'
  | 'perplexity'
  | 'nvidia'
  | 'microsoft'
  | 'huggingface'
  | 'coarena'
  | 'custom'
  | 'unknown';

export type ModelAvailability = 'available' | 'limited' | 'deprecated' | 'unknown';

export interface BrandMarkDefinition {
  id: string;
  displayName: string;
  shortName: string;
  logoPath: string;
  /** True for monochrome black/currentColor SVGs that should invert in dark mode */
  monochrome: boolean;
  fallbackMonogram: string;
  accentColor: string;
  license: string;
  source: string;
}

export interface ModelIdentity {
  modelId: string;
  modelName: string;
  modelFamily: string;
  modelCreator: ModelCreatorId;
  modelCreatorName: string;
  modelCreatorLogo: string;
  modelCreatorMonochrome: boolean;
  modelCreatorMonogram: string;
  modelCreatorAccent: string;
  provider: ProviderId;
  providerName: string;
  providerLogo: string;
  providerMonochrome: boolean;
  providerMonogram: string;
  providerAccent: string;
  /** True when the API provider is routing a model authored by another creator or acting as an aggregator */
  isAggregated: boolean;
}

export const MODEL_CREATOR_BRANDS: Record<ModelCreatorId, BrandMarkDefinition> = {
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic',
    shortName: 'Anthropic',
    logoPath: '/logos/claude-color.svg',
    monochrome: false,
    fallbackMonogram: 'AN',
    accentColor: '#D97757',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    shortName: 'OpenAI',
    logoPath: '/logos/openai.svg',
    monochrome: true,
    fallbackMonogram: 'OA',
    accentColor: '#10A37F',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  google: {
    id: 'google',
    displayName: 'Google',
    shortName: 'Google',
    logoPath: '/logos/gemini-color.svg',
    monochrome: false,
    fallbackMonogram: 'GG',
    accentColor: '#3186FF',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  meta: {
    id: 'meta',
    displayName: 'Meta',
    shortName: 'Meta',
    logoPath: '/logos/meta-color.svg',
    monochrome: false,
    fallbackMonogram: 'MT',
    accentColor: '#0082FB',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    shortName: 'DeepSeek',
    logoPath: '/logos/deepseek-color.svg',
    monochrome: false,
    fallbackMonogram: 'DS',
    accentColor: '#4D6BFE',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  mistral: {
    id: 'mistral',
    displayName: 'Mistral AI',
    shortName: 'Mistral',
    logoPath: '/logos/mistral-color.svg',
    monochrome: false,
    fallbackMonogram: 'MI',
    accentColor: '#FA500F',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  qwen: {
    id: 'qwen',
    displayName: 'Qwen (Alibaba Cloud)',
    shortName: 'Qwen',
    logoPath: '/logos/qwen-color.svg',
    monochrome: false,
    fallbackMonogram: 'QW',
    accentColor: '#615CED',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  xai: {
    id: 'xai',
    displayName: 'xAI',
    shortName: 'xAI',
    logoPath: '/logos/grok.svg',
    monochrome: true,
    fallbackMonogram: 'XA',
    accentColor: '#6B7280',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  cohere: {
    id: 'cohere',
    displayName: 'Cohere',
    shortName: 'Cohere',
    logoPath: '/logos/cohere-color.svg',
    monochrome: false,
    fallbackMonogram: 'CH',
    accentColor: '#39594D',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  perplexity: {
    id: 'perplexity',
    displayName: 'Perplexity',
    shortName: 'Perplexity',
    logoPath: '/logos/perplexity-color.svg',
    monochrome: false,
    fallbackMonogram: 'PX',
    accentColor: '#22B8CD',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  nvidia: {
    id: 'nvidia',
    displayName: 'NVIDIA',
    shortName: 'NVIDIA',
    logoPath: '/logos/nvidia-color.svg',
    monochrome: false,
    fallbackMonogram: 'NV',
    accentColor: '#74B71B',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  microsoft: {
    id: 'microsoft',
    displayName: 'Microsoft',
    shortName: 'Microsoft',
    logoPath: '/logos/microsoft-color.svg',
    monochrome: false,
    fallbackMonogram: 'MS',
    accentColor: '#00A4EF',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  huggingface: {
    id: 'huggingface',
    displayName: 'Hugging Face',
    shortName: 'HF',
    logoPath: '/logos/huggingface-color.svg',
    monochrome: false,
    fallbackMonogram: 'HF',
    accentColor: '#FF9D0B',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  coarena: {
    id: 'coarena',
    displayName: 'Coarena AI',
    shortName: 'Coarena',
    logoPath: '/logos/coarena.svg',
    monochrome: false,
    fallbackMonogram: 'CA',
    accentColor: '#C8324B',
    license: 'MIT (CARMEN geometric emblem)',
    source: 'local',
  },
  custom: {
    id: 'custom',
    displayName: 'Custom Endpoint',
    shortName: 'Custom',
    logoPath: '/logos/custom.svg',
    monochrome: true,
    fallbackMonogram: 'CU',
    accentColor: '#64748B',
    license: 'MIT (CARMEN neutral mark)',
    source: 'local',
  },
  unknown: {
    id: 'unknown',
    displayName: 'Other / Unclassified',
    shortName: 'Model',
    logoPath: '/logos/unknown.svg',
    monochrome: true,
    fallbackMonogram: 'AI',
    accentColor: '#64748B',
    license: 'MIT (CARMEN neutral mark)',
    source: 'local',
  },
};

export const PROVIDER_BRANDS: Record<ProviderId, BrandMarkDefinition> = {
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic',
    shortName: 'Anthropic',
    logoPath: '/logos/anthropic.svg',
    monochrome: true,
    fallbackMonogram: 'AN',
    accentColor: '#D97757',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Google Gemini',
    shortName: 'Gemini',
    logoPath: '/logos/gemini-color.svg',
    monochrome: false,
    fallbackMonogram: 'GM',
    accentColor: '#3186FF',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    shortName: 'OpenAI',
    logoPath: '/logos/openai.svg',
    monochrome: true,
    fallbackMonogram: 'OA',
    accentColor: '#10A37F',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    shortName: 'OpenRouter',
    logoPath: '/logos/openrouter.svg',
    monochrome: true,
    fallbackMonogram: 'OR',
    accentColor: '#6466F1',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  groq: {
    id: 'groq',
    displayName: 'Groq',
    shortName: 'Groq',
    logoPath: '/logos/groq.svg',
    monochrome: true,
    fallbackMonogram: 'GQ',
    accentColor: '#F55036',
    license: 'MIT (@lobehub/icons-static-svg)',
    source: 'https://github.com/lobehub/lobe-icons',
  },
  coarena: {
    id: 'coarena',
    displayName: 'Coarena AI',
    shortName: 'Coarena',
    logoPath: '/logos/coarena.svg',
    monochrome: false,
    fallbackMonogram: 'CA',
    accentColor: '#C8324B',
    license: 'MIT (CARMEN geometric emblem)',
    source: 'local',
  },
  custom: {
    id: 'custom',
    displayName: 'Custom Provider',
    shortName: 'Custom',
    logoPath: '/logos/custom.svg',
    monochrome: true,
    fallbackMonogram: 'CU',
    accentColor: '#64748B',
    license: 'MIT (CARMEN neutral mark)',
    source: 'local',
  },
};

const PRIVATE_OR_LOOPBACK_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\]|172\.(1[6-9]|2\d|3[0-1])\.)/i;

/**
 * Validates an optional custom logo URL against XSS, data-URI injection, and internal-network SSRF.
 * Allows either local `/logos/<safe-name>.svg|png|webp` paths or external `https://` public hosts.
 */
export function validateSafeLogoUrl(rawUrl?: string | null): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 512) return null;

  // Reject control characters or whitespace
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null;
  }

  if (trimmed.startsWith('/logos/')) {
    if (/^\/logos\/[a-zA-Z0-9._-]+\.(svg|png|webp)$/.test(trimmed) && !trimmed.includes('..')) {
      return trimmed;
    }
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || PRIVATE_OR_LOOPBACK_HOST.test(parsed.hostname)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeProvider(provider?: string): ProviderId {
  switch ((provider || '').toLowerCase()) {
    case 'anthropic':
      return 'anthropic';
    case 'gemini':
    case 'google':
      return 'gemini';
    case 'openai':
      return 'openai';
    case 'openrouter':
      return 'openrouter';
    case 'groq':
      return 'groq';
    case 'coarena':
      return 'coarena';
    default:
      return 'custom';
  }
}

/**
 * Determines the model creator strictly from the model ID / name first (so aggregated models on
 * OpenRouter, Groq, Coarena, or Custom endpoints receive their true model creator brand mark),
 * falling back to direct single-vendor providers only when the model ID carries no creator signal.
 */
export function detectModelCreator(modelId: string, provider?: string, modelName?: string): ModelCreatorId {
  const id = (modelId || '').trim().toLowerCase();
  const name = (modelName || '').trim().toLowerCase();
  const combined = `${id} ${name}`;

  // 1. Explicit namespace prefix (OpenRouter / HuggingFace / Groq / OpenAI-compatible paths)
  const slashIdx = id.indexOf('/');
  if (slashIdx > 0) {
    const namespace = id.slice(0, slashIdx);
    if (namespace === 'anthropic') return 'anthropic';
    if (namespace === 'openai') return 'openai';
    if (namespace === 'google' || namespace === 'google-deepmind') return 'google';
    if (namespace === 'meta-llama' || namespace === 'meta') return 'meta';
    if (namespace === 'deepseek' || namespace === 'deepseek-ai') return 'deepseek';
    if (namespace === 'mistralai' || namespace === 'mistral') return 'mistral';
    if (namespace === 'qwen' || namespace === 'alibaba') return 'qwen';
    if (namespace === 'x-ai' || namespace === 'xai') return 'xai';
    if (namespace === 'cohere' || namespace === 'cohereforai') return 'cohere';
    if (namespace === 'perplexity') return 'perplexity';
    if (namespace === 'nvidia') return 'nvidia';
    if (namespace === 'microsoft') return 'microsoft';
    if (namespace === 'huggingfaceh4' || namespace === 'huggingface') return 'huggingface';
    if (namespace === 'coarena') return 'coarena';
  }

  // 2. Model family pattern matching (works across direct & aggregated providers)
  if (/(^|[/:_\s-])claude([-\s_.\d]|$)/.test(combined) || /\banthropic\b/.test(combined)) {
    return 'anthropic';
  }
  if (
    /(^|[/:_\s-])(gpt|chatgpt|text-embedding|whisper|dall-e|o1|o3|o4)([-\s_.\d]|$)/.test(id) ||
    /\bopenai\b/.test(combined)
  ) {
    return 'openai';
  }
  if (
    /(^|[/:_\s-])(gemini|gemma|palm|imagen|veo|learnlm)([-\s_.\d]|$)/.test(combined) ||
    /\bgoogle\b/.test(combined)
  ) {
    return 'google';
  }
  if (/(^|[/:_\s-])deepseek([-\s_.\d]|$)/.test(combined)) {
    return 'deepseek';
  }
  if (/(^|[/:_\s-])(nemotron|nvidia)([-\s_.\d]|$)/.test(combined)) {
    return 'nvidia';
  }
  if (/(^|[/:_\s-])(llama|meta-llama|codellama)([-\s_.\d]|$)/.test(combined)) {
    return 'meta';
  }
  if (
    /(^|[/:_\s-])(mistral|mixtral|codestral|pixtral|ministral|devstral|magistral)([-\s_.\d]|$)/.test(
      combined
    )
  ) {
    return 'mistral';
  }
  if (/(^|[/:_\s-])(qwen|qwq|qvq)([-\s_.\d]|$)/.test(combined)) {
    return 'qwen';
  }
  if (/(^|[/:_\s-])grok([-\s_.\d]|$)/.test(combined) || /\bxai\b/.test(combined)) {
    return 'xai';
  }
  if (/(^|[/:_\s-])(command-r|command-a|c4ai-aya|cohere)([-\s_.\d]|$)/.test(combined)) {
    return 'cohere';
  }
  if (/(^|[/:_\s-])(sonar|perplexity|pplx)([-\s_.\d]|$)/.test(combined)) {
    return 'perplexity';
  }
  if (/(^|[/:_\s-])(phi-[234]|wizardlm|mai-)([-\s_.\d]|$)/.test(combined)) {
    return 'microsoft';
  }
  if (/(^|[/:_\s-])coarena([-\s_.\d]|$)/.test(combined)) {
    return 'coarena';
  }

  // 3. Direct single-vendor provider fallback (never attribute aggregator brands as model creator)
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider === 'anthropic') return 'anthropic';
  if (normalizedProvider === 'openai') return 'openai';
  if (normalizedProvider === 'gemini') return 'google';
  if (normalizedProvider === 'coarena') return 'coarena';
  if (normalizedProvider === 'custom') return 'custom';

  return 'unknown';
}

export function detectModelFamily(modelId: string, creator: ModelCreatorId): string {
  const id = (modelId || '').toLowerCase();
  if (id.includes('claude-opus-4') || id.includes('claude-4-opus')) return 'Claude 4 Opus';
  if (id.includes('claude-sonnet-4') || id.includes('claude-4-sonnet')) return 'Claude 4 Sonnet';
  if (id.includes('claude-3-7') || id.includes('claude-3.7')) return 'Claude 3.7';
  if (id.includes('claude-3-5') || id.includes('claude-3.5')) return 'Claude 3.5';
  if (id.includes('claude')) return 'Claude';

  if (id.includes('gpt-5')) return 'GPT-5';
  if (id.includes('gpt-4.5')) return 'GPT-4.5';
  if (id.includes('gpt-4.1')) return 'GPT-4.1';
  if (id.includes('gpt-4o')) return 'GPT-4o';
  if (id.includes('gpt-4')) return 'GPT-4';
  if (/(^|[/:_-])o4/.test(id)) return 'OpenAI o4';
  if (/(^|[/:_-])o3/.test(id)) return 'OpenAI o3';
  if (/(^|[/:_-])o1/.test(id)) return 'OpenAI o1';

  if (id.includes('gemini-2.5')) return 'Gemini 2.5';
  if (id.includes('gemini-2.0')) return 'Gemini 2.0';
  if (id.includes('gemini-1.5')) return 'Gemini 1.5';
  if (id.includes('gemini')) return 'Gemini';
  if (id.includes('gemma')) return 'Gemma';

  if (id.includes('deepseek-r1')) return 'DeepSeek R1';
  if (id.includes('deepseek-v3')) return 'DeepSeek V3';
  if (id.includes('deepseek')) return 'DeepSeek';

  if (id.includes('nemotron')) return 'Nemotron';

  if (id.includes('llama-4') || id.includes('llama4')) return 'Llama 4';
  if (id.includes('llama-3.3') || id.includes('llama3.3')) return 'Llama 3.3';
  if (id.includes('llama-3.2') || id.includes('llama3.2')) return 'Llama 3.2';
  if (id.includes('llama-3.1') || id.includes('llama3.1')) return 'Llama 3.1';
  if (id.includes('llama')) return 'Llama';

  if (id.includes('codestral')) return 'Codestral';
  if (id.includes('devstral')) return 'Devstral';
  if (id.includes('mixtral')) return 'Mixtral';
  if (id.includes('mistral')) return 'Mistral';

  if (id.includes('qwen3') || id.includes('qwen-3')) return 'Qwen 3';
  if (id.includes('qwen-2.5') || id.includes('qwen2.5')) return 'Qwen 2.5';
  if (id.includes('qwq')) return 'QwQ';
  if (id.includes('qwen')) return 'Qwen';

  if (id.includes('grok-4')) return 'Grok 4';
  if (id.includes('grok-3')) return 'Grok 3';
  if (id.includes('grok')) return 'Grok';

  if (id.includes('command-a')) return 'Command A';
  if (id.includes('command-r')) return 'Command R';
  if (id.includes('sonar')) return 'Sonar';
  if (id.includes('phi-')) return 'Phi';
  if (id.includes('coarena')) return 'Coarena';

  return MODEL_CREATOR_BRANDS[creator].shortName;
}

export function resolveModelIdentity(input: {
  provider: string;
  modelId: string;
  modelName?: string;
  customLogoUrl?: string | null;
}): ModelIdentity {
  const provider = normalizeProvider(input.provider);
  const providerBrand = PROVIDER_BRANDS[provider];
  const creator = detectModelCreator(input.modelId, provider, input.modelName);
  const creatorBrand = MODEL_CREATOR_BRANDS[creator];

  // For Google Gemma models vs Gemini models, use Google G mark for Gemma and Gemini star for Gemini
  const lowerId = (input.modelId || '').toLowerCase();
  let creatorLogo = creatorBrand.logoPath;
  let creatorMonochrome = creatorBrand.monochrome;
  if (creator === 'google' && lowerId.includes('gemma')) {
    creatorLogo = '/logos/google-color.svg';
    creatorMonochrome = false;
  }

  // Optional validated custom logo URL applies strictly to custom provider/creator
  const safeCustomLogo = validateSafeLogoUrl(input.customLogoUrl);
  let providerLogo = providerBrand.logoPath;
  let providerMonochrome = providerBrand.monochrome;
  if (provider === 'custom' && safeCustomLogo) {
    providerLogo = safeCustomLogo;
    providerMonochrome = false;
    if (creator === 'custom' || creator === 'unknown') {
      creatorLogo = safeCustomLogo;
      creatorMonochrome = false;
    }
  }

  const providerMatchesCreator =
    (provider === 'anthropic' && creator === 'anthropic') ||
    (provider === 'openai' && creator === 'openai') ||
    (provider === 'gemini' && creator === 'google') ||
    (provider === 'coarena' && creator === 'coarena');

  const isAggregated =
    provider === 'openrouter' ||
    provider === 'groq' ||
    provider === 'custom' ||
    !providerMatchesCreator;

  return {
    modelId: input.modelId,
    modelName: input.modelName || input.modelId,
    modelFamily: detectModelFamily(input.modelId, creator),
    modelCreator: creator,
    modelCreatorName: creatorBrand.displayName,
    modelCreatorLogo: creatorLogo,
    modelCreatorMonochrome: creatorMonochrome,
    modelCreatorMonogram: creatorBrand.fallbackMonogram,
    modelCreatorAccent: creatorBrand.accentColor,
    provider,
    providerName: providerBrand.displayName,
    providerLogo,
    providerMonochrome,
    providerMonogram: providerBrand.fallbackMonogram,
    providerAccent: providerBrand.accentColor,
    isAggregated,
  };
}

export function getProviderBrand(provider: string): BrandMarkDefinition {
  return PROVIDER_BRANDS[normalizeProvider(provider)];
}

export function getModelCreatorBrand(creator: ModelCreatorId): BrandMarkDefinition {
  return MODEL_CREATOR_BRANDS[creator] || MODEL_CREATOR_BRANDS.unknown;
}

export interface EnrichableProviderModel {
  id: string;
  name: string;
  provider: ProviderId;
  toolCalling?: 'yes' | 'no' | 'unknown';
  vision?: 'yes' | 'no' | 'unknown';
  streaming?: boolean;
  structuredOutput?: 'yes' | 'no' | 'unknown';
  availability?: ModelAvailability;
  identity?: ModelIdentity;
}

export function enrichProviderModel<T extends EnrichableProviderModel>(
  model: T,
  options?: { customLogoUrl?: string | null; availability?: ModelAvailability }
): T & {
  identity: ModelIdentity;
  streaming: boolean;
  structuredOutput: 'yes' | 'no' | 'unknown';
  availability: ModelAvailability;
} {
  const identity = resolveModelIdentity({
    provider: model.provider,
    modelId: model.id,
    modelName: model.name,
    customLogoUrl: options?.customLogoUrl,
  });

  const lowerId = model.id.toLowerCase();
  const inferredStructuredOutput: 'yes' | 'no' | 'unknown' =
    model.structuredOutput ??
    (model.toolCalling === 'yes' ||
    /(gpt-4|gpt-5|o1|o3|o4|gemini|claude|deepseek|mistral|qwen|llama-3\.[123]|llama-4|grok|command)/.test(
      lowerId
    )
      ? 'yes'
      : model.toolCalling === 'no'
        ? 'no'
        : 'unknown');

  return {
    ...model,
    identity,
    streaming: model.streaming ?? true,
    structuredOutput: inferredStructuredOutput,
    availability: options?.availability ?? model.availability ?? 'available',
  };
}

export function getAllBrandCatalogSummary() {
  return {
    providers: Object.values(PROVIDER_BRANDS),
    creators: Object.values(MODEL_CREATOR_BRANDS),
  };
}
