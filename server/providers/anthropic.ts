import type { ProviderModel } from '../../src/types';
import { readResponseTextWithLimit, safeOutboundFetch, scrubSecrets } from '../security';
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

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const METADATA_TIMEOUT_MS = 20_000;
const STREAM_CONNECT_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_ANTHROPIC_MAX_TOKENS = 64_000;

export type AnthropicFetchFn = (
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; streamIdleTimeoutMs?: number; maxRedirects: number }
) => Promise<Response>;

function toAnthropicContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(content)) {
    return content as Array<Record<string, unknown>>;
  }
  const text = String(content ?? '');
  return text ? [{ type: 'text', text }] : [];
}

/**
 * Maps CARMEN conversation messages to Anthropic Messages API format:
 * - Groups consecutive `role: 'tool'` messages into a SINGLE `role: 'user'` turn
 *   containing multiple `tool_result` blocks (required by Anthropic `/v1/messages`).
 * - Merges adjacent `role: 'user'` turns so roles strictly alternate.
 */
export function buildAnthropicMessages(
  messages: ChatStreamRequest['messages']
): Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> = [];
  const filtered = messages.filter((m) => m.role !== 'system');

  const pushMessage = (role: 'user' | 'assistant', content: string | Array<Record<string, unknown>>) => {
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      prev.content = [...toAnthropicContentBlocks(prev.content), ...toAnthropicContentBlocks(content)];
      return;
    }
    out.push({ role, content });
  };

  for (let i = 0; i < filtered.length; i += 1) {
    const m = filtered[i];

    if (m.role === 'tool') {
      const blocks: Array<Record<string, unknown>> = [];
      let j = i;
      while (j < filtered.length && filtered[j].role === 'tool') {
        const tm = filtered[j];
        blocks.push({
          type: 'tool_result',
          tool_use_id: tm.toolCallId || `tool_${j}`,
          content: tm.content,
        });
        j += 1;
      }
      i = j - 1;
      pushMessage('user', blocks);
      continue;
    }

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      pushMessage('assistant', blocks);
      continue;
    }

    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    if (m.imageBase64 && m.imageMimeType) {
      pushMessage(role, [
        {
          type: 'image',
          source: { type: 'base64', media_type: m.imageMimeType, data: m.imageBase64 },
        },
        { type: 'text', text: m.content },
      ]);
      continue;
    }
    pushMessage(role, m.content);
  }

  return out;
}

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

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic' as const;
  private readonly fetchFn: AnthropicFetchFn;

  constructor(fetchFn?: AnthropicFetchFn) {
    this.fetchFn = fetchFn ?? ((url, init, options) => safeOutboundFetch(url, init, options));
  }

  capabilities(modelId: string): ModelCapabilities {
    const entry = findCatalogEntry('anthropic', modelId);
    if (!entry) {
      return { toolCalling: 'yes', vision: 'yes', maxContext: 'unknown', maxOutput: 'unknown' };
    }
    return {
      toolCalling: entry.toolCalling,
      vision: entry.vision,
      maxContext: entry.maxContext,
      maxOutput: entry.maxOutput,
    };
  }

  async listModels(config: ProviderAdapterConfig): Promise<ProviderModel[]> {
    const res = await this.fetchFn(
      `${ANTHROPIC_BASE}/models`,
      {
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
      },
      { timeoutMs: METADATA_TIMEOUT_MS, maxRedirects: 3 }
    );

    const rawText = await readResponseTextWithLimit(res, 2 * 1024 * 1024);
    if (!res.ok) {
      const retryMs = parseRetryAfterMs(res.headers);
      const body = scrubSecrets(rawText, getSecretsToScrub(config));
      const norm = normalizeProviderError(res.status, body, retryMs);
      throw new Error(`${norm.code}: ${norm.message}`);
    }

    const json = JSON.parse(rawText) as { data?: Array<{ id: string; display_name?: string }> };
    const items = json.data ?? [];
    const seen = new Set<string>();
    const out: ProviderModel[] = [];
    for (const item of items) {
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      const entry = findCatalogEntry('anthropic', item.id);
      const { tier, tierNote } = resolveModelTier({
        provider: 'anthropic',
        tierDeclared: config.tierDeclared,
        catalogEntry: entry,
      });
      const apiName = item.display_name || item.id;
      out.push({
        id: item.id,
        name: apiName,
        provider: 'anthropic',
        providerKeyId: config.providerKeyId,
        providerLabel: config.label,
        tier,
        tierNote,
        toolCalling: entry?.toolCalling ?? 'yes',
        vision: entry?.vision ?? 'yes',
        maxContext: entry?.maxContext ?? 'unknown',
        maxOutput: entry?.maxOutput ?? 'unknown',
        source: 'api.anthropic.com/v1/models',
        lastVerified: new Date().toISOString().slice(0, 10),
        isNonChat: isNonChatModel(item.id, apiName),
      });
    }
    return out;
  }

  async testConnection(config: ProviderAdapterConfig): Promise<TestConnectionResult> {
    try {
      const res = await this.fetchFn(
        `${ANTHROPIC_BASE}/models?limit=1`,
        {
          headers: {
            'x-api-key': config.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
        },
        { timeoutMs: METADATA_TIMEOUT_MS, maxRedirects: 3 }
      );
      if (res.ok) {
        return { ok: true, message: 'Koneksi ke Anthropic berhasil diverifikasi.' };
      }
      const retryMs = parseRetryAfterMs(res.headers);
      const body = scrubSecrets(await readResponseTextWithLimit(res, 512 * 1024).catch(() => ''), getSecretsToScrub(config));
      const norm = normalizeProviderError(res.status, body, retryMs);
      return { ok: false, message: norm.message, errorCode: norm.code };
    } catch (err) {
      const msg = scrubSecrets(err instanceof Error ? err.message : String(err), getSecretsToScrub(config));
      return { ok: false, message: `Gagal menghubungi Anthropic: ${msg}`, errorCode: 'PROVIDER_DOWN' };
    }
  }

  async *chatStream(request: ChatStreamRequest): AsyncIterable<StreamEvent> {
    const { config, modelId, systemPrompt, messages, tools, signal } = request;
    const mappedMessages = buildAnthropicMessages(messages);

    const caps = this.capabilities(modelId);
    const maxTokens =
      typeof caps.maxOutput === 'number' && caps.maxOutput >= 1024
        ? caps.maxOutput
        : DEFAULT_ANTHROPIC_MAX_TOKENS;

    const payload: Record<string, unknown> = {
      model: modelId,
      max_tokens: maxTokens,
      stream: true,
      system: systemPrompt,
      messages: mappedMessages,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    let res: Response | null = null;
    let adjustedMaxTokens = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        res = await this.fetchFn(
          `${ANTHROPIC_BASE}/messages`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': config.apiKey,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            body: JSON.stringify(payload),
            signal,
          },
          { timeoutMs: STREAM_CONNECT_TIMEOUT_MS, streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS, maxRedirects: 3 }
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

      if (attempt < 3 && (res.status === 429 || res.status === 503 || res.status === 529)) {
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

      if (!adjustedMaxTokens && res.status === 400 && attempt < 3) {
        const errBodyText = await readResponseTextWithLimit(res, 128 * 1024).catch(() => '');
        const maxMatch =
          errBodyText.match(/max_tokens\s*[:=]\s*\d+\s*>\s*(\d+)/i) ||
          errBodyText.match(/maximum\s+(?:allowed\s+)?(?:number\s+of\s+output\s+tokens\s+(?:is|for)[^0-9]*)?(\d+)/i);
        const serverLimit = maxMatch ? Number(maxMatch[1]) : 0;
        const currentMax = Number(payload.max_tokens);
        if (Number.isFinite(serverLimit) && serverLimit >= 1024 && serverLimit < currentMax) {
          adjustedMaxTokens = true;
          payload.max_tokens = serverLimit;
          continue;
        }
        const retryMs = parseRetryAfterMs(res.headers);
        const norm = normalizeProviderError(400, scrubSecrets(errBodyText, getSecretsToScrub(config)), retryMs);
        yield { type: 'error', code: norm.code, message: norm.message };
        return;
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
    let activeToolId = '';
    let activeToolName = '';
    let activeToolJson = '';
    let tokensIn = 0;
    let tokensOut = 0;

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
            if (evt.type === 'message_start' && evt.message?.usage) {
              tokensIn = evt.message.usage.input_tokens || 0;
            } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
              activeToolId = evt.content_block.id;
              activeToolName = evt.content_block.name;
              activeToolJson = '';
            } else if (evt.type === 'content_block_delta') {
              if (evt.delta?.type === 'text_delta' && evt.delta.text) {
                yield { type: 'text_delta', text: evt.delta.text };
              } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
                activeToolJson += evt.delta.partial_json;
              }
            } else if (evt.type === 'content_block_stop' && activeToolName) {
              let parsedArgs: Record<string, unknown> = {};
              const trimmedJson = activeToolJson.trim();
              if (trimmedJson) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(trimmedJson);
                } catch (parseErr) {
                  const errMsg = parseErr instanceof Error ? parseErr.message : 'JSON tidak valid';
                  yield {
                    type: 'error',
                    code: 'UNKNOWN',
                    message: `Argumen JSON untuk tool "${activeToolName}" rusak atau terpotong (${errMsg}).`,
                  };
                  return;
                }
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                  yield {
                    type: 'error',
                    code: 'UNKNOWN',
                    message: `Argumen JSON untuk tool "${activeToolName}" harus berupa objek JSON yang valid.`,
                  };
                  return;
                }
                parsedArgs = parsed as Record<string, unknown>;
              }
              yield { type: 'tool_call', id: activeToolId, name: activeToolName, arguments: parsedArgs };
              activeToolId = '';
              activeToolName = '';
              activeToolJson = '';
            } else if (evt.type === 'error') {
              const rawErrMsg = scrubSecrets(
                String(evt.error?.message || evt.message || 'Anthropic stream error'),
                getSecretsToScrub(config)
              );
              const errType = typeof evt.error?.type === 'string' ? evt.error.type : '';
              const errStatus =
                errType === 'rate_limit_error'
                  ? 429
                  : errType === 'overloaded_error'
                    ? 529
                    : errType === 'authentication_error'
                      ? 401
                      : errType === 'billing_error'
                        ? 402
                        : errType === 'invalid_request_error'
                          ? 400
                          : 0;
              const norm = normalizeProviderError(errStatus, rawErrMsg);
              yield { type: 'error', code: norm.code, message: norm.message };
              return;
            } else if (evt.type === 'message_delta') {
              if (evt.usage) {
                tokensOut = evt.usage.output_tokens || tokensOut;
              }
              if (evt.delta?.stop_reason === 'max_tokens') {
                yield { type: 'truncated', reason: 'max_tokens' };
              }
            }
          } catch {
            // Ignore malformed keepalive chunks
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

    if (tokensIn || tokensOut) {
      yield { type: 'usage', tokensIn, tokensOut };
    }
    yield { type: 'done' };
  }
}
