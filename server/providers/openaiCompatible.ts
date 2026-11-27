import type { ProviderModel, ProviderType } from '../../src/types';
import {
  readResponseTextWithLimit,
  safeOutboundFetch,
  scrubSecrets,
  validateCustomBaseUrl,
} from '../security';
import { findCatalogEntry, isNonChatModel, resolveModelTier } from './catalog';
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

const DEFAULT_BASE_URLS: Partial<Record<ProviderType, string>> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
};

const METADATA_TIMEOUT_MS = 20_000;
const STREAM_CONNECT_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 90_000;
const METADATA_MAX_BYTES = 4 * 1024 * 1024;

function resolveEndpoint(config: ProviderAdapterConfig): { baseUrl: string; chatPath: string } {
  if (config.provider === 'custom') {
    const check = validateCustomBaseUrl(config.baseUrl || '');
    if (!check.valid || !check.normalized) {
      throw new Error(check.error || 'Base URL tidak valid.');
    }
    const rawPath = (config.chatPath || '/chat/completions').trim();
    const chatPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    return { baseUrl: check.normalized, chatPath };
  }
  const baseUrl = DEFAULT_BASE_URLS[config.provider];
  if (!baseUrl) throw new Error(`Provider ${config.provider} belum memiliki Base URL.`);
  return { baseUrl, chatPath: '/chat/completions' };
}

function buildAuthHeaders(config: ProviderAdapterConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.provider === 'custom' && config.authHeader && config.authHeader.trim().toLowerCase() !== 'authorization') {
    headers[config.authHeader.trim()] = config.apiKey;
  } else {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  if (config.provider === 'openrouter') {
    headers['HTTP-Referer'] = process.env.APP_URL || 'http://localhost:3000';
    headers['X-Title'] = 'CARMEN';
  }

  if (config.extraHeaders) {
    for (const [k, v] of Object.entries(config.extraHeaders)) {
      if (k && v) headers[k] = v;
    }
  }

  return headers;
}

export type OutboundFetchFn = (
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; streamIdleTimeoutMs?: number; maxRedirects: number; enforceCustomUrlPolicy: boolean }
) => Promise<Response>;

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
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

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: ProviderType;
  private readonly fetchFn: OutboundFetchFn;

  constructor(providerId: 'openai' | 'openrouter' | 'groq' | 'custom', fetchFn?: OutboundFetchFn) {
    this.id = providerId;
    this.fetchFn = fetchFn ?? ((url, init, options) => safeOutboundFetch(url, init, options));
  }

  private providerFetch(
    provider: ProviderType,
    url: string,
    init: RequestInit,
    timeoutMs = METADATA_TIMEOUT_MS,
    streamIdleTimeoutMs?: number
  ): Promise<Response> {
    return this.fetchFn(url, init, {
      timeoutMs,
      ...(streamIdleTimeoutMs ? { streamIdleTimeoutMs } : {}),
      maxRedirects: 3,
      enforceCustomUrlPolicy: provider === 'custom',
    });
  }

  capabilities(modelId: string, config?: ProviderAdapterConfig): ModelCapabilities {
    if (this.id === 'custom') {
      return {
        toolCalling: config?.supportsTools ?? 'unknown',
        vision: config?.supportsVision ?? 'unknown',
        maxContext: 'unknown',
        maxOutput: 'unknown',
      };
    }
    const entry = findCatalogEntry(this.id, modelId);
    if (!entry) {
      return { toolCalling: 'unknown', vision: 'unknown', maxContext: 'unknown', maxOutput: 'unknown' };
    }
    return {
      toolCalling: entry.toolCalling,
      vision: entry.vision,
      maxContext: entry.maxContext,
      maxOutput: entry.maxOutput,
    };
  }

  async listModels(config: ProviderAdapterConfig): Promise<ProviderModel[]> {
    const { baseUrl } = resolveEndpoint(config);
    const headers = buildAuthHeaders(config);

    try {
      const res = await this.providerFetch(config.provider, `${baseUrl}/models`, { headers }, METADATA_TIMEOUT_MS);
      const rawText = await readResponseTextWithLimit(res, METADATA_MAX_BYTES);
      if (!res.ok) {
        if (config.provider === 'custom' && config.customModels && config.customModels.length > 0) {
          return this.buildManualCustomModels(config);
        }
        const retryMs = parseRetryAfterMs(res.headers);
        const body = scrubSecrets(rawText, getSecretsToScrub(config));
        const norm = normalizeProviderError(res.status, body, retryMs);
        throw new Error(`${norm.code}: ${norm.message}`);
      }

      const json = JSON.parse(rawText) as {
        data?: Array<{
          id: string;
          name?: string;
          context_length?: number;
          pricing?: { prompt?: string | number; completion?: string | number };
          supported_parameters?: string[];
        }>;
      };

      if (!Array.isArray(json.data)) {
        if (config.provider === 'custom' && config.customModels && config.customModels.length > 0) {
          return this.buildManualCustomModels(config);
        }
        throw new Error(
          'Format respons provider tidak sesuai OpenAI-compatible. Periksa Base URL dan path pada dokumentasi resmi provider.'
        );
      }

      const seen = new Set<string>();
      const fetched: ProviderModel[] = [];
      for (const item of json.data.slice(0, 1000)) {
        if (!item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        const entry = findCatalogEntry(config.provider, item.id);
        const promptPrice = item.pricing?.prompt;
        const completionPrice = item.pricing?.completion;
        const { tier, tierNote } = resolveModelTier({
          provider: config.provider,
          tierDeclared: config.tierDeclared,
          catalogEntry: entry,
          openRouterPromptPrice: promptPrice,
          openRouterCompletionPrice: completionPrice,
        });

        const supportsTools =
          config.provider === 'custom'
            ? config.supportsTools ?? 'unknown'
            : Array.isArray(item.supported_parameters)
              ? item.supported_parameters.includes('tools')
                ? 'yes'
                : 'no'
              : entry?.toolCalling ?? 'unknown';

        const apiName = item.name || item.id;
        fetched.push({
          id: item.id,
          name: apiName,
          provider: config.provider,
          providerKeyId: config.providerKeyId,
          providerLabel: config.label,
          tier,
          tierNote,
          toolCalling: supportsTools,
          vision: config.provider === 'custom' ? config.supportsVision ?? 'unknown' : entry?.vision ?? 'unknown',
          maxContext: item.context_length ?? entry?.maxContext ?? 'unknown',
          maxOutput: entry?.maxOutput ?? 'unknown',
          promptPricePerMillion:
            promptPrice !== undefined ? Number(promptPrice) * 1_000_000 : entry?.promptPricePerMillion ?? null,
          completionPricePerMillion:
            completionPrice !== undefined
              ? Number(completionPrice) * 1_000_000
              : entry?.completionPricePerMillion ?? null,
          source: `${baseUrl}/models`,
          lastVerified: new Date().toISOString().slice(0, 10),
          isNonChat: isNonChatModel(item.id, apiName),
        });
      }

      if (config.provider === 'custom' && config.customModels && config.customModels.length > 0) {
        const existingIds = new Set(fetched.map((m) => m.id));
        for (const manual of this.buildManualCustomModels(config)) {
          if (!existingIds.has(manual.id)) fetched.unshift(manual);
        }
      }

      return fetched;
    } catch (err) {
      if (config.provider === 'custom' && config.customModels && config.customModels.length > 0) {
        // Still fail if error was an SSRF policy block!
        const msg = err instanceof Error ? err.message : '';
        if (/SSRF|privat|lokal|internal|port standar/i.test(msg)) {
          throw err;
        }
        return this.buildManualCustomModels(config);
      }
      throw err;
    }
  }

  private buildManualCustomModels(config: ProviderAdapterConfig): ProviderModel[] {
    const { tier } = resolveModelTier({
      provider: 'custom',
      tierDeclared: config.tierDeclared,
    });
    return (config.customModels || [])
      .map((m) => m.trim())
      .filter(Boolean)
      .map((modelId) => ({
        id: modelId,
        name: modelId,
        provider: 'custom',
        providerKeyId: config.providerKeyId,
        providerLabel: config.label,
        tier,
        toolCalling: config.supportsTools ?? 'unknown',
        vision: config.supportsVision ?? 'unknown',
        maxContext: 'unknown',
        maxOutput: 'unknown',
        source: 'manual',
        lastVerified: new Date().toISOString().slice(0, 10),
      }));
  }

  async testConnection(config: ProviderAdapterConfig): Promise<TestConnectionResult> {
    let endpoint: { baseUrl: string; chatPath: string };
    try {
      endpoint = resolveEndpoint(config);
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Konfigurasi endpoint tidak valid.',
        errorCode: 'UNKNOWN',
      };
    }

    const HTML_ERROR_MSG =
      'Alamat ini mengembalikan halaman web, bukan API. Periksa Base URL di dokumentasi resmi penyedia.';

    const isHtmlResponse = (res: Response, bodyText: string): boolean => {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html') || ct.includes('application/xhtml')) return true;
      return /^\s*<(?:!doctype\s+html|html)\b/i.test(bodyText);
    };

    const formatProviderFailure = (
      status: number,
      bodyText: string,
      headers?: Headers
    ): { code: ReturnType<typeof normalizeProviderError>['code']; message: string } => {
      const scrubbed = scrubSecrets(bodyText, getSecretsToScrub(config)).trim();
      let detail = scrubbed;
      try {
        const parsed = JSON.parse(scrubbed) as {
          error?: string | { message?: string; code?: string };
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
      const shortDetail = detail.replace(/\s+/g, ' ').slice(0, 260);
      const retryMs = parseRetryAfterMs(headers);
      const norm = normalizeProviderError(status, scrubbed, retryMs);
      const message = shortDetail ? `HTTP ${status} — ${shortDetail}` : `HTTP ${status} — ${norm.message}`;
      return { code: norm.code, message };
    };

    const headers = buildAuthHeaders(config);
    // OpenRouter serves /models publicly (HTTP 200 even with invalid keys); /key enforces Bearer auth.
    const probePath = config.provider === 'openrouter' ? '/key' : '/models';
    try {
      const res = await this.providerFetch(config.provider, `${endpoint.baseUrl}${probePath}`, { headers }, METADATA_TIMEOUT_MS);
      const text = await readResponseTextWithLimit(res, METADATA_MAX_BYTES);

      if (isHtmlResponse(res, text)) {
        return { ok: false, message: HTML_ERROR_MSG, errorCode: 'UNKNOWN' };
      }

      if (res.ok) {
        try {
          const parsed = JSON.parse(text);
          if (config.provider === 'custom' && !parsed.data && !Array.isArray(parsed)) {
            return {
              ok: false,
              message:
                'Respons endpoint tidak sesuai format OpenAI-compatible. Periksa Base URL dan path pada dokumentasi resmi penyedia.',
              errorCode: 'UNKNOWN',
            };
          }
        } catch {
          return { ok: false, message: HTML_ERROR_MSG, errorCode: 'UNKNOWN' };
        }
        return { ok: true, message: `Koneksi ke ${config.label} berhasil diverifikasi (HTTP ${res.status}).` };
      }

      // If /models returned 404 on a custom provider with manual model ID, try a minimal chat request
      if (res.status === 404 && config.provider === 'custom' && config.customModels && config.customModels[0]) {
        const chatRes = await this.providerFetch(
          config.provider,
          `${endpoint.baseUrl}${endpoint.chatPath}`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: config.customModels[0],
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }],
            }),
          },
          METADATA_TIMEOUT_MS
        );
        const chatText = await readResponseTextWithLimit(chatRes, METADATA_MAX_BYTES);
        if (isHtmlResponse(chatRes, chatText)) {
          return { ok: false, message: HTML_ERROR_MSG, errorCode: 'UNKNOWN' };
        }
        if (chatRes.ok) {
          try {
            JSON.parse(chatText);
          } catch {
            return { ok: false, message: HTML_ERROR_MSG, errorCode: 'UNKNOWN' };
          }
          return {
            ok: true,
            message: `Koneksi ke ${config.label} berhasil lewat endpoint chat (HTTP ${chatRes.status}).`,
          };
        }
        const fail = formatProviderFailure(chatRes.status, chatText, chatRes.headers);
        return { ok: false, message: fail.message, errorCode: fail.code };
      }

      const fail = formatProviderFailure(res.status, text, res.headers);
      return { ok: false, message: fail.message, errorCode: fail.code };
    } catch (err) {
      const msg = scrubSecrets(err instanceof Error ? err.message : String(err), getSecretsToScrub(config));
      return { ok: false, message: `Gagal terhubung ke ${config.label}: ${msg}`, errorCode: 'PROVIDER_DOWN' };
    }
  }

  async *chatStream(request: ChatStreamRequest): AsyncIterable<StreamEvent> {
    const { config, modelId, systemPrompt, messages, tools, signal } = request;
    let endpoint: { baseUrl: string; chatPath: string };
    try {
      endpoint = resolveEndpoint(config);
    } catch (err) {
      yield {
        type: 'error',
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : 'Base URL tidak valid.',
      };
      return;
    }

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
        if (m.imageBase64 && m.imageMimeType) {
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
      ...(config.provider !== 'custom' ? { stream_options: { include_usage: true } } : {}),
      messages: mappedMessages,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    let res: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        res = await this.providerFetch(
          config.provider,
          `${endpoint.baseUrl}${endpoint.chatPath}`,
          {
            method: 'POST',
            headers: buildAuthHeaders(config),
            body: JSON.stringify(payload),
            signal,
          },
          STREAM_CONNECT_TIMEOUT_MS,
          STREAM_IDLE_TIMEOUT_MS
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

      if (attempt < 3 && (res.status === 429 || res.status === 503)) {
        const retryMs = parseRetryAfterMs(res.headers);
        const waitMs = retryMs !== null ? retryMs : Math.min(3_000, 400 * Math.pow(2, attempt - 1));
        if (waitMs <= 3_000) {
          await res.text().catch(() => {});
          try {
            await sleepAbortable(waitMs, signal);
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
      const retryMs = parseRetryAfterMs(res?.headers);
      const body = res ? scrubSecrets(await readResponseTextWithLimit(res, 512 * 1024).catch(() => ''), getSecretsToScrub(config)) : '';
      const norm = normalizeProviderError(status, body, retryMs);
      yield { type: 'error', code: norm.code, message: norm.message };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pendingTools = new Map<number, { id: string; name: string; args: string }>();
    const streamCallPrefix = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    try {
      while (true) {
        if (signal?.aborted) break;
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

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
            // Ignore partial SSE comment lines
          }
        }
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
