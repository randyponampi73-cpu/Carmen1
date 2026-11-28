import type { ProviderModel, TriState } from '../../src/types';
import {
  readResponseTextWithLimit,
  safeOutboundFetch,
  scrubSecrets,
  validateCustomBaseUrl,
} from '../security';
import { isNonChatModel, resolveModelTier } from './catalog';
import {
  getSecretsToScrub,
  normalizeProviderError,
  parseRetryAfterMs,
  type ChatStreamRequest,
  type ModelCapabilities,
  type ProviderAdapter,
  type ProviderAdapterConfig,
  type StreamEvent,
  type TestConnectionResult,
} from './types';

/**
 * Verified against official Coarena OpenAPI specification (https://coarena.ai/api/openapi.json):
 * - OpenAI-compatible base URL: https://coarena.ai/api/v1
 * - Model discovery (public):   GET  /api/v1/models
 * - Authenticated key check:    GET  /api/v1/limits (accepts inference:read or inference:write)
 * - Chat completions:           POST /api/v1/chat/completions
 * - Auth header:                Authorization: Bearer <coa_...>
 * - Retry / rate-limit headers: retry-after, retry-after-ms, x-should-retry
 */
export const COARENA_DEFAULT_BASE_URL = 'https://coarena.ai/api/v1';

const METADATA_TIMEOUT_MS = 20_000;
const STREAM_CONNECT_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 90_000;
const METADATA_MAX_BYTES = 4 * 1024 * 1024;
const MAX_TRANSIENT_RETRY_WAIT_MS = 4_000;

export type CoarenaFetchFn = (
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; streamIdleTimeoutMs?: number; maxRedirects: number; enforceCustomUrlPolicy: boolean }
) => Promise<Response>;

interface CoarenaModelRecord {
  id: string;
  name?: string;
  display_name?: string;
  owned_by?: string;
  lifecycle?: string;
  context_length?: number;
  max_input_tokens?: number;
  max_completion_tokens?: number;
  max_tokens?: number;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
  };
  capabilities?: {
    vision?: boolean;
    tools?: boolean;
    json_schema?: boolean;
    reasoning_text?: boolean;
  };
}

function isHtmlResponse(res: Response, bodyText: string): boolean {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return true;
  return /^\s*<(?:!doctype\s+html|html)\b/i.test(bodyText);
}

function extractErrorDetail(bodyText: string, secrets: string[]): string {
  const scrubbed = scrubSecrets(bodyText, secrets).trim();
  let detail = scrubbed;
  try {
    const parsed = JSON.parse(scrubbed) as {
      error?: string | { message?: string; code?: string; type?: string };
      message?: string;
      detail?: string;
    };
    if (typeof parsed.error === 'string') detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
    else if (parsed.message) detail = parsed.message;
    else if (parsed.detail) detail = parsed.detail;
  } catch {
    // Keep scrubbed plain text
  }
  return detail.replace(/\s+/g, ' ').slice(0, 260);
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class CoarenaAdapter implements ProviderAdapter {
  readonly id = 'coarena' as const;
  private readonly fetchFn: CoarenaFetchFn;
  private readonly discoveredCapabilities = new Map<string, ModelCapabilities>();

  constructor(fetchFn?: CoarenaFetchFn) {
    this.fetchFn = fetchFn ?? ((url, init, options) => safeOutboundFetch(url, init, options));
  }

  resolveBaseUrl(config: ProviderAdapterConfig): string {
    const raw = (config.baseUrl || '').trim();
    if (!raw) return COARENA_DEFAULT_BASE_URL;
    const check = validateCustomBaseUrl(raw);
    if (!check.valid || !check.normalized) {
      throw new Error(check.error || 'Base URL Coarena AI tidak valid.');
    }
    return check.normalized;
  }

  private buildHeaders(config: ProviderAdapterConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey.trim()}`,
    };
    if (config.extraHeaders) {
      for (const [k, v] of Object.entries(config.extraHeaders)) {
        if (k && v) headers[k] = v;
      }
    }
    return headers;
  }

  capabilities(modelId: string, config?: ProviderAdapterConfig): ModelCapabilities {
    const cached = this.discoveredCapabilities.get(modelId);
    const fallbackTools: TriState = config?.supportsTools && config.supportsTools !== 'unknown' ? config.supportsTools : 'unknown';
    const fallbackVision: TriState =
      config?.supportsVision && config.supportsVision !== 'unknown' ? config.supportsVision : 'unknown';

    if (!cached) {
      return {
        toolCalling: fallbackTools,
        vision: fallbackVision,
        maxContext: 'unknown',
        maxOutput: 'unknown',
      };
    }

    return {
      toolCalling:
        config?.supportsTools && config.supportsTools !== 'unknown' ? config.supportsTools : cached.toolCalling,
      vision:
        config?.supportsVision && config.supportsVision !== 'unknown' ? config.supportsVision : cached.vision,
      maxContext: cached.maxContext,
      maxOutput: cached.maxOutput,
    };
  }

  async listModels(config: ProviderAdapterConfig): Promise<ProviderModel[]> {
    const baseUrl = this.resolveBaseUrl(config);
    const isCustomOverride = baseUrl !== COARENA_DEFAULT_BASE_URL;

    const res = await this.fetchFn(
      `${baseUrl}/models`,
      { headers: this.buildHeaders(config) },
      {
        timeoutMs: METADATA_TIMEOUT_MS,
        maxRedirects: 3,
        enforceCustomUrlPolicy: isCustomOverride,
      }
    );

    const rawText = await readResponseTextWithLimit(res, METADATA_MAX_BYTES);
    if (isHtmlResponse(res, rawText)) {
      throw new Error(
        'Alamat Coarena AI mengembalikan halaman web, bukan API JSON. Periksa Base URL (default: https://coarena.ai/api/v1).'
      );
    }

    if (!res.ok) {
      const retryAfterMs = parseRetryAfterMs(res.headers);
      const body = scrubSecrets(rawText, getSecretsToScrub(config));
      const norm = normalizeProviderError(res.status, body, retryAfterMs);
      throw new Error(`${norm.code}: ${norm.message}`);
    }

    const parsed = JSON.parse(rawText) as { data?: CoarenaModelRecord[] };
    if (!Array.isArray(parsed.data)) {
      throw new Error('Respons Coarena AI /models tidak memiliki daftar model (array data).');
    }

    const seen = new Set<string>();
    const models: ProviderModel[] = [];

    for (const item of parsed.data.slice(0, 1000)) {
      if (!item?.id || seen.has(item.id)) continue;
      if (item.lifecycle && item.lifecycle !== 'active') continue;
      seen.add(item.id);

      const promptPrice = item.pricing?.prompt;
      const completionPrice = item.pricing?.completion;
      const { tier, tierNote } = resolveModelTier({
        provider: 'coarena',
        tierDeclared: config.tierDeclared,
        openRouterPromptPrice: promptPrice,
        openRouterCompletionPrice: completionPrice,
      });

      const toolCalling: TriState =
        typeof item.capabilities?.tools === 'boolean'
          ? item.capabilities.tools
            ? 'yes'
            : 'no'
          : config.supportsTools ?? 'unknown';
      const vision: TriState =
        typeof item.capabilities?.vision === 'boolean'
          ? item.capabilities.vision
            ? 'yes'
            : 'no'
          : config.supportsVision ?? 'unknown';

      const maxContext = item.context_length ?? item.max_input_tokens ?? 'unknown';
      const maxOutput = item.max_completion_tokens ?? item.max_tokens ?? 'unknown';

      this.discoveredCapabilities.set(item.id, {
        toolCalling,
        vision,
        maxContext,
        maxOutput,
      });

      const displayName = item.display_name || item.name || item.id;
      const promptNum =
        promptPrice !== undefined && promptPrice !== null && String(promptPrice).trim() !== ''
          ? Number(promptPrice)
          : NaN;
      const completionNum =
        completionPrice !== undefined && completionPrice !== null && String(completionPrice).trim() !== ''
          ? Number(completionPrice)
          : NaN;

      models.push({
        id: item.id,
        name: displayName,
        provider: 'coarena',
        providerKeyId: config.providerKeyId,
        providerLabel: config.label,
        tier,
        tierNote,
        toolCalling,
        vision,
        maxContext,
        maxOutput,
        promptPricePerMillion: Number.isFinite(promptNum) ? promptNum * 1_000_000 : null,
        completionPricePerMillion: Number.isFinite(completionNum) ? completionNum * 1_000_000 : null,
        source: `${baseUrl}/models`,
        lastVerified: new Date().toISOString().slice(0, 10),
        isNonChat: isNonChatModel(item.id, displayName),
      });
    }

    return models;
  }

  async testConnection(config: ProviderAdapterConfig): Promise<TestConnectionResult> {
    let baseUrl: string;
    try {
      baseUrl = this.resolveBaseUrl(config);
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Base URL Coarena AI tidak valid.',
        errorCode: 'UNKNOWN',
      };
    }

    const isCustomOverride = baseUrl !== COARENA_DEFAULT_BASE_URL;
    const headers = this.buildHeaders(config);

    try {
      // GET /api/v1/limits requires a valid Coarena personal API key (inference:read or inference:write)
      // whereas GET /api/v1/models is public and does not reject invalid keys.
      const res = await this.fetchFn(
        `${baseUrl}/limits`,
        { headers },
        {
          timeoutMs: METADATA_TIMEOUT_MS,
          maxRedirects: 3,
          enforceCustomUrlPolicy: isCustomOverride,
        }
      );

      const text = await readResponseTextWithLimit(res, METADATA_MAX_BYTES);
      if (isHtmlResponse(res, text)) {
        return {
          ok: false,
          message:
            'Alamat Coarena AI mengembalikan halaman web, bukan API JSON. Pastikan Base URL adalah https://coarena.ai/api/v1.',
          errorCode: 'UNKNOWN',
        };
      }

      if (res.ok) {
        return {
          ok: true,
          message: `Koneksi dan autentikasi API key ke ${config.label || 'Coarena AI'} berhasil diverifikasi (HTTP ${res.status}).`,
        };
      }

      // If a user points to a compatible proxy that does not implement /limits, verify /models explicitly
      if (res.status === 404 && isCustomOverride) {
        const modelsRes = await this.fetchFn(
          `${baseUrl}/models`,
          { headers },
          {
            timeoutMs: METADATA_TIMEOUT_MS,
            maxRedirects: 3,
            enforceCustomUrlPolicy: true,
          }
        );
        const modelsText = await readResponseTextWithLimit(modelsRes, METADATA_MAX_BYTES);
        if (modelsRes.ok && !isHtmlResponse(modelsRes, modelsText)) {
          try {
            const parsed = JSON.parse(modelsText) as { data?: unknown[] };
            if (Array.isArray(parsed.data)) {
              return {
                ok: true,
                message: `Endpoint ${config.label || 'Coarena AI'} dapat dijangkau (${parsed.data.length} model ditemukan).`,
              };
            }
          } catch {
            // Fall through to invalid format error
          }
        }
        const retryMs = parseRetryAfterMs(modelsRes.headers);
        const norm = normalizeProviderError(
          modelsRes.status,
          extractErrorDetail(modelsText, getSecretsToScrub(config)),
          retryMs
        );
        return { ok: false, message: `HTTP ${modelsRes.status} — ${norm.message}`, errorCode: norm.code };
      }

      const retryAfterMs = parseRetryAfterMs(res.headers);
      const detail = extractErrorDetail(text, getSecretsToScrub(config));
      const norm = normalizeProviderError(res.status, detail, retryAfterMs);
      return {
        ok: false,
        message: detail ? `HTTP ${res.status} — ${norm.message} (${detail})` : `HTTP ${res.status} — ${norm.message}`,
        errorCode: norm.code,
      };
    } catch (err) {
      const msg = scrubSecrets(err instanceof Error ? err.message : String(err), getSecretsToScrub(config));
      return {
        ok: false,
        message: `Gagal terhubung ke ${config.label || 'Coarena AI'}: ${msg}`,
        errorCode: 'PROVIDER_DOWN',
      };
    }
  }

  async *chatStream(request: ChatStreamRequest): AsyncIterable<StreamEvent> {
    const { config, modelId, systemPrompt, messages, tools, signal } = request;
    let baseUrl: string;
    try {
      baseUrl = this.resolveBaseUrl(config);
    } catch (err) {
      yield {
        type: 'error',
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : 'Base URL Coarena AI tidak valid.',
      };
      return;
    }

    const caps = this.capabilities(modelId, config);
    const allowVision = caps.vision !== 'no';
    const allowTools = caps.toolCalling !== 'no';

    const mappedMessages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'tool',
            tool_call_id: m.toolCallId || 'tool_0',
            content: m.content,
          };
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          };
        }
        if (allowVision && m.imageBase64 && m.imageMimeType) {
          return {
            role: m.role,
            content: [
              { type: 'text', text: m.content },
              {
                type: 'image_url',
                image_url: { url: `data:${m.imageMimeType};base64,${m.imageBase64}` },
              },
            ],
          };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    const payload: Record<string, unknown> = {
      model: modelId,
      stream: true,
      stream_options: { include_usage: true },
      messages: mappedMessages,
    };

    if (allowTools && tools && tools.length > 0) {
      payload.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const isCustomOverride = baseUrl !== COARENA_DEFAULT_BASE_URL;
    let res: Response | null = null;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        res = await this.fetchFn(
          `${baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: this.buildHeaders(config),
            body: JSON.stringify(payload),
            signal,
          },
          {
            timeoutMs: STREAM_CONNECT_TIMEOUT_MS,
            streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
            maxRedirects: 3,
            enforceCustomUrlPolicy: isCustomOverride,
          }
        );
      } catch (err) {
        if (signal?.aborted) {
          yield { type: 'done' };
          return;
        }
        const msg = scrubSecrets(err instanceof Error ? err.message : String(err), getSecretsToScrub(config));
        yield { type: 'error', code: 'PROVIDER_DOWN', message: msg };
        return;
      }

      const shouldRetryHeader = (res.headers.get('x-should-retry') || '').toLowerCase();
      const retryableStatus = res.status === 429 || res.status === 503 || res.status === 502;
      if (attempt < maxAttempts && retryableStatus && shouldRetryHeader !== 'false') {
        const retryAfterMs = parseRetryAfterMs(res.headers);
        const waitMs = retryAfterMs !== null ? retryAfterMs : 600;
        if (waitMs <= MAX_TRANSIENT_RETRY_WAIT_MS) {
          // Drain body before retrying
          await res.text().catch(() => {});
          try {
            await sleepWithAbort(waitMs, signal);
            continue;
          } catch {
            yield { type: 'done' };
            return;
          }
        }
      }
      break;
    }

    if (!res || !res.ok || !res.body) {
      const status = res?.status ?? 503;
      const retryAfterMs = parseRetryAfterMs(res?.headers);
      const rawBody = res ? await readResponseTextWithLimit(res, 512 * 1024).catch(() => '') : '';
      const detail = extractErrorDetail(rawBody, getSecretsToScrub(config));
      const norm = normalizeProviderError(status, scrubSecrets(detail || rawBody, getSecretsToScrub(config)), retryAfterMs);
      yield { type: 'error', code: norm.code, message: norm.message };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pendingTools = new Map<number, { id: string; name: string; args: string }>();
    const streamCallPrefix = `coa_call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    try {
      while (true) {
        if (signal?.aborted) break;
        const { value, done } = await reader.read();
        let lines: string[];
        if (done) {
          buffer += decoder.decode();
          if (!buffer.trim()) break;
          lines = buffer.split('\n');
          buffer = '';
        } else {
          buffer += decoder.decode(value, { stream: true });
          lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
        }

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === '[DONE]') continue;
          try {
            const evt = JSON.parse(dataStr);
            const choice = evt.choices?.[0];
            const streamErr = evt.error || choice?.error;
            if (streamErr || choice?.finish_reason === 'error') {
              const errObj = streamErr ?? { message: 'Stream terminated with provider error' };
              const errStatus =
                typeof errObj === 'object' && typeof errObj.code === 'number' && errObj.code >= 400 && errObj.code <= 599
                  ? errObj.code
                  : typeof errObj === 'object' && typeof errObj.status === 'number' && errObj.status >= 400 && errObj.status <= 599
                    ? errObj.status
                    : 0;
              const errMsgRaw =
                typeof errObj === 'string'
                  ? errObj
                  : errObj.message || errObj.code || JSON.stringify(errObj);
              const norm = normalizeProviderError(errStatus, scrubSecrets(String(errMsgRaw), getSecretsToScrub(config)));
              yield { type: 'error', code: norm.code, message: norm.message };
              return;
            }
            const delta = choice?.delta;
            if (delta?.content) {
              yield { type: 'text_delta', text: delta.content };
            }
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const current = pendingTools.get(idx) ?? {
                  id: tc.id || `${streamCallPrefix}_${idx}`,
                  name: tc.function?.name || '',
                  args: '',
                };
                if (tc.id) current.id = tc.id;
                if (tc.function?.name) current.name = tc.function.name;
                if (tc.function?.arguments) current.args += tc.function.arguments;
                pendingTools.set(idx, current);
              }
            }
            if (choice?.finish_reason === 'length') {
              yield { type: 'truncated', reason: 'length' };
            }
            if (evt.usage) {
              yield {
                type: 'usage',
                tokensIn: evt.usage.prompt_tokens || 0,
                tokensOut: evt.usage.completion_tokens || 0,
              };
            }
          } catch {
            // Ignore partial SSE comment/keepalive lines
          }
        }
        if (done) break;
      }
    } catch (err) {
      if (!signal?.aborted) {
        const msg = scrubSecrets(err instanceof Error ? err.message : String(err), getSecretsToScrub(config));
        yield { type: 'error', code: 'PROVIDER_DOWN', message: msg };
        return;
      }
    } finally {
      reader.releaseLock();
    }

    if (signal?.aborted) {
      yield { type: 'done' };
      return;
    }

    for (const tool of pendingTools.values()) {
      if (!tool.name) continue;
      let parsedArgs: Record<string, unknown> = {};
      const trimmedArgs = tool.args.trim();
      if (trimmedArgs) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmedArgs);
        } catch (parseErr) {
          const errMsg = parseErr instanceof Error ? parseErr.message : 'JSON tidak valid';
          yield {
            type: 'error',
            code: 'UNKNOWN',
            message: `Argumen JSON untuk tool "${tool.name}" rusak atau terpotong (${errMsg}).`,
          };
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          yield {
            type: 'error',
            code: 'UNKNOWN',
            message: `Argumen JSON untuk tool "${tool.name}" harus berupa objek JSON yang valid.`,
          };
          return;
        }
        parsedArgs = parsed as Record<string, unknown>;
      }
      yield { type: 'tool_call', id: tool.id, name: tool.name, arguments: parsedArgs };
    }

    yield { type: 'done' };
  }
}
