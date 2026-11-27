import type { ModelTier, ProviderErrorCode, ProviderModel, ProviderType, TriState } from '../../src/types';

export interface ProviderAdapterConfig {
  providerKeyId: string;
  provider: ProviderType;
  label: string;
  apiKey: string;
  tierDeclared: ModelTier;
  baseUrl?: string | null;
  authHeader?: string | null;
  chatPath?: string | null;
  customModels?: string[];
  extraHeaders?: Record<string, string>;
  supportsTools?: TriState;
  supportsVision?: TriState;
}

export interface AdapterToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export interface AdapterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  imageBase64?: string;
  imageMimeType?: string;
  toolCallId?: string;
  toolName?: string;
  toolProvider?: ProviderType;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    thoughtSignature?: string;
    provider?: ProviderType;
  }>;
}

export interface ChatStreamRequest {
  config: ProviderAdapterConfig;
  modelId: string;
  systemPrompt: string;
  messages: AdapterMessage[];
  tools?: AdapterToolDefinition[];
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'truncated'; reason?: string }
  | { type: 'error'; code: ProviderErrorCode; message: string }
  | { type: 'done' };

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  errorCode?: ProviderErrorCode;
}

export interface ModelCapabilities {
  toolCalling: TriState;
  vision: TriState;
  maxContext: number | 'unknown';
  maxOutput: number | 'unknown';
}

export interface ProviderAdapter {
  readonly id: ProviderType;
  listModels(config: ProviderAdapterConfig): Promise<ProviderModel[]>;
  testConnection(config: ProviderAdapterConfig): Promise<TestConnectionResult>;
  chatStream(request: ChatStreamRequest): AsyncIterable<StreamEvent>;
  capabilities(modelId: string, config?: ProviderAdapterConfig): ModelCapabilities;
}

export function getSecretsToScrub(config: ProviderAdapterConfig): string[] {
  return [config.apiKey, ...Object.values(config.extraHeaders || {})]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

export function parseRetryAfterMs(headers: Headers | Record<string, string | undefined> | null | undefined): number | null {
  if (!headers) return null;
  const get = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? (headers[key] ?? null) : null;
  };

  const retryMs = get('retry-after-ms');
  if (retryMs) {
    const parsed = Number(retryMs);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }

  const retryAfter = get('retry-after');
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

export function normalizeProviderError(
  status: number,
  rawMessage: string,
  retryAfterMs?: number | null
): {
  code: ProviderErrorCode;
  message: string;
} {
  const cleanedRaw = String(rawMessage || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const lower = cleanedRaw.toLowerCase();
  const statusTag = status > 0 ? ` (HTTP ${status})` : '';
  const detailSuffix = cleanedRaw ? ` Detail: ${cleanedRaw}` : '';
  const retryHint =
    typeof retryAfterMs === 'number' && retryAfterMs > 0
      ? ` Coba lagi setelah ${Math.max(1, Math.ceil(retryAfterMs / 1000))} detik.`
      : '';

  if (
    status === 401 ||
    status === 403 ||
    lower.includes('api key') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid x-api-key') ||
    lower.includes('invalid_token') ||
    lower.includes('authentication_error')
  ) {
    return {
      code: 'AUTH_INVALID',
      message: `Key ditolak oleh provider${statusTag}. Periksa key di Pengaturan > Provider.${detailSuffix}`,
    };
  }

  const isPerMinuteRateLimit =
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('too many requests') ||
    lower.includes('tokens per min') ||
    lower.includes('requests per min') ||
    /\b(?:tpm|rpm)\b/.test(lower);

  const isQuotaOrCreditExhausted =
    status === 402 ||
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient_credits') ||
    lower.includes('payment required') ||
    lower.includes('credit balance is too low') ||
    lower.includes('more credits') ||
    lower.includes('out of credits') ||
    lower.includes('credits exhausted') ||
    lower.includes('billing hard limit') ||
    lower.includes('billing_error') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('usage limit') ||
    lower.includes('daily limit') ||
    lower.includes('monthly limit') ||
    lower.includes('spend limit') ||
    lower.includes('tokens per day') ||
    lower.includes('requests per day') ||
    /\b(?:tpd|rpd)\b/.test(lower) ||
    (!isPerMinuteRateLimit &&
      lower.includes('quota') &&
      (lower.includes('billing') || lower.includes('credit') || lower.includes('exceeded')));

  if (isQuotaOrCreditExhausted) {
    return {
      code: 'QUOTA_EXCEEDED',
      message: `Kuota atau saldo token/kredit akun provider habis${statusTag}. Beralih ke model cadangan.${retryHint}${detailSuffix}`,
    };
  }

  const isRateLimited =
    status === 429 ||
    isPerMinuteRateLimit ||
    lower.includes('resource_exhausted') ||
    lower.includes('resource exhausted');

  if (isRateLimited) {
    return {
      code: 'RATE_LIMIT',
      message: `Batas permintaan atau token per menit (rate limit) provider tercapai${statusTag}.${retryHint}${detailSuffix}`,
    };
  }

  if (
    status === 404 ||
    lower.includes('model_not_found') ||
    lower.includes('model not found') ||
    /\bmodel\b[^.]{0,60}\b(?:not found|does not exist)\b/i.test(cleanedRaw) ||
    (lower.includes('does not exist') && lower.includes('model'))
  ) {
    return {
      code: 'MODEL_NOT_FOUND',
      message: `Model tidak ditemukan pada provider ini${statusTag}. Segarkan daftar model di Pengaturan.${detailSuffix}`,
    };
  }

  if (
    status === 413 ||
    lower.includes('context_length_exceeded') ||
    lower.includes('context length') ||
    lower.includes('maximum context') ||
    lower.includes('too many tokens') ||
    lower.includes('prompt is too long') ||
    lower.includes('input is too long') ||
    lower.includes('exceeds the maximum number of tokens') ||
    lower.includes('token limit') ||
    lower.includes('reduce the length')
  ) {
    return {
      code: 'CONTEXT_TOO_LONG',
      message: `Konteks percakapan melebihi kapasitas model${statusTag}. Riwayat percakapan perlu dipadatkan atau beralih ke model dengan jendela konteks lebih besar.`,
    };
  }

  if (status >= 500 || lower.includes('overloaded') || lower.includes('unavailable') || lower.includes('fetch failed')) {
    return {
      code: 'PROVIDER_DOWN',
      message: `Layanan provider sedang tidak tersedia atau mengalami gangguan jaringan${statusTag}.${retryHint}${detailSuffix}`,
    };
  }
  return {
    code: 'UNKNOWN',
    message: cleanedRaw ? `${statusTag ? `[HTTP ${status}] ` : ''}${cleanedRaw}` : 'Terjadi kesalahan saat menghubungi provider.',
  };
}
