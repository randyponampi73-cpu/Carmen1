import { GoogleGenAI, Type, type FunctionDeclaration } from '@google/genai';
import type { ProviderModel } from '../../src/types';
import { readResponseTextWithLimit, safeOutboundFetch, scrubSecrets } from '../security';
import { findCatalogEntry, isNonChatModel, loadModelCatalog, resolveModelTier } from './catalog';
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

const METADATA_TIMEOUT_MS = 20_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;

function getGeminiStreamIdleTimeoutMs(): number {
  const raw = Number(process.env.CARMEN_STREAM_IDLE_TIMEOUT_MS || DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 50 && raw <= 600_000 ? Math.floor(raw) : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

export type GeminiFetchFn = (
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; maxRedirects: number }
) => Promise<Response>;

export type GeminiClientFactory = (apiKey: string) => Pick<GoogleGenAI, 'models'>;

function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function buildGeminiContents(messages: ChatStreamRequest['messages']): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  const filtered = messages.filter((m) => m.role !== 'system');

  for (let i = 0; i < filtered.length; i += 1) {
    const m = filtered[i];

    // Group consecutive tool responses into a single 'user' turn with multiple functionResponse parts
    if (m.role === 'tool') {
      const toolParts: Array<Record<string, unknown>> = [];
      let j = i;
      while (j < filtered.length && filtered[j].role === 'tool') {
        const tm = filtered[j];
        const fnResp: Record<string, unknown> = {
          name: tm.toolName || 'tool',
          response: { result: tm.content },
        };
        if (tm.toolCallId) {
          fnResp.id = tm.toolCallId;
        }
        toolParts.push({ functionResponse: fnResp });
        j += 1;
      }
      i = j - 1;
      contents.push({ role: 'user', parts: toolParts });
      continue;
    }

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls) {
        const fc: Record<string, unknown> = {
          name: tc.name,
          args: tc.arguments,
        };
        if (tc.id) {
          fc.id = tc.id;
        }
        const part: Record<string, unknown> = { functionCall: fc };
        if (tc.thoughtSignature) {
          part.thoughtSignature = tc.thoughtSignature;
        }
        parts.push(part);
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    const parts: Array<Record<string, unknown>> = [];
    if (m.imageBase64 && m.imageMimeType) {
      parts.push({ inlineData: { mimeType: m.imageMimeType, data: m.imageBase64 } });
    }
    parts.push({ text: m.content });
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts,
    });
  }

  return contents;
}

function mapGeminiParamType(rawType: string): Type {
  switch (String(rawType || '').toLowerCase()) {
    case 'number':
      return Type.NUMBER;
    case 'integer':
      return Type.INTEGER;
    case 'boolean':
      return Type.BOOLEAN;
    case 'array':
      return Type.ARRAY;
    case 'object':
      return Type.OBJECT;
    default:
      return Type.STRING;
  }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'gemini' as const;
  private readonly fetchFn: GeminiFetchFn;
  private readonly clientFactory: GeminiClientFactory;

  constructor(deps?: { fetchFn?: GeminiFetchFn; clientFactory?: GeminiClientFactory }) {
    this.fetchFn = deps?.fetchFn ?? ((url, init, options) => safeOutboundFetch(url, init, options));
    this.clientFactory = deps?.clientFactory ?? createGeminiClient;
  }

  capabilities(modelId: string): ModelCapabilities {
    const entry = findCatalogEntry('gemini', modelId);
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
    const results: ProviderModel[] = [];
    const seen = new Set<string>();

    const res = await this.fetchFn(
      'https://generativelanguage.googleapis.com/v1beta/models',
      {
        headers: { 'x-goog-api-key': config.apiKey },
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
    const json = JSON.parse(rawText) as {
          models?: Array<{
            name: string;
            displayName?: string;
            inputTokenLimit?: number;
            outputTokenLimit?: number;
            supportedGenerationMethods?: string[];
          }>;
        };
        for (const item of json.models ?? []) {
          if (!item.supportedGenerationMethods?.includes('generateContent')) continue;
          const modelId = item.name.replace(/^models\//, '');
          // Skip deprecated 1.5/2.0/gemini-pro aliases
          if (/^gemini-(1\.5|2\.0|pro$)/.test(modelId)) continue;
          if (seen.has(modelId)) continue;
          seen.add(modelId);
          const entry = findCatalogEntry('gemini', modelId);
          const { tier, tierNote } = resolveModelTier({
            provider: 'gemini',
            tierDeclared: config.tierDeclared,
            catalogEntry: entry,
          });
          const apiName = item.displayName || modelId;
          results.push({
            id: modelId,
            name: apiName,
            provider: 'gemini',
            providerKeyId: config.providerKeyId,
            providerLabel: config.label,
            tier,
            tierNote,
            toolCalling: entry?.toolCalling ?? 'yes',
            vision: entry?.vision ?? 'yes',
            maxContext: item.inputTokenLimit ?? entry?.maxContext ?? 'unknown',
            maxOutput: item.outputTokenLimit ?? entry?.maxOutput ?? 'unknown',
            source: 'generativelanguage.googleapis.com/v1beta/models',
            lastVerified: new Date().toISOString().slice(0, 10),
            isNonChat: isNonChatModel(modelId, apiName),
          });
        }

    // Include curated Gemini catalog entries if model-catalog.json exists
    for (const entry of loadModelCatalog().filter((e) => e.provider === 'gemini')) {
      if (seen.has(entry.modelId)) continue;
      seen.add(entry.modelId);
      const { tier, tierNote } = resolveModelTier({
        provider: 'gemini',
        tierDeclared: config.tierDeclared,
        catalogEntry: entry,
      });
      results.unshift({
        id: entry.modelId,
        name: entry.name,
        provider: 'gemini',
        providerKeyId: config.providerKeyId,
        providerLabel: config.label,
        tier,
        tierNote,
        toolCalling: entry.toolCalling,
        vision: entry.vision,
        maxContext: entry.maxContext,
        maxOutput: entry.maxOutput,
        source: entry.source,
        lastVerified: entry.lastVerified,
        isNonChat: isNonChatModel(entry.modelId, entry.name),
      });
    }

    return results;
  }

  async testConnection(config: ProviderAdapterConfig): Promise<TestConnectionResult> {
    try {
      const res = await this.fetchFn(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
        {
          headers: { 'x-goog-api-key': config.apiKey },
        },
        { timeoutMs: METADATA_TIMEOUT_MS, maxRedirects: 3 }
      );
      if (res.ok) {
        return { ok: true, message: 'Koneksi ke Gemini berhasil diverifikasi.' };
      }
      const retryMs = parseRetryAfterMs(res.headers);
      const body = scrubSecrets(
        await readResponseTextWithLimit(res, 512 * 1024).catch(() => ''),
        getSecretsToScrub(config)
      );
      const norm = normalizeProviderError(res.status, body, retryMs);
      return { ok: false, message: norm.message, errorCode: norm.code };
    } catch (err) {
      const msg = scrubSecrets(err instanceof Error ? err.message : String(err), getSecretsToScrub(config));
      return { ok: false, message: `Gagal menghubungi Gemini: ${msg}`, errorCode: 'PROVIDER_DOWN' };
    }
  }

  async *chatStream(request: ChatStreamRequest): AsyncIterable<StreamEvent> {
    const { config, modelId, systemPrompt, messages, tools, signal } = request;
    const ai = this.clientFactory(config.apiKey);

    const contents = buildGeminiContents(messages);

    const functionDeclarations: FunctionDeclaration[] | undefined =
      tools && tools.length > 0
        ? tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: {
              type: Type.OBJECT,
              properties: Object.fromEntries(
                Object.entries(t.parameters.properties).map(([k, v]) => [
                  k,
                  { type: mapGeminiParamType(v.type), description: v.description },
                ])
              ),
              required: t.parameters.required,
            },
          }))
        : undefined;

    const idleTimeoutMs = getGeminiStreamIdleTimeoutMs();
    const streamController = new AbortController();
    let timedOutByIdle = false;
    let idleTimer: NodeJS.Timeout | null = null;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOutByIdle = true;
        streamController.abort(new Error(`Gemini stream idle timeout after ${idleTimeoutMs}ms`));
      }, idleTimeoutMs);
    };
    const onCallerAbort = () => {
      streamController.abort(signal?.reason);
    };
    if (signal) {
      if (signal.aborted) {
        yield { type: 'done' };
        return;
      }
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      armIdleTimer();
      const stream = await ai.models.generateContentStream({
        model: modelId,
        contents,
        config: {
          systemInstruction: systemPrompt,
          ...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
          abortSignal: streamController.signal,
        },
      });

      let tokensIn = 0;
      let tokensOut = 0;
      let emittedTruncated = false;

      for await (const chunk of stream) {
        if (signal?.aborted) break;
        if (timedOutByIdle) {
          throw new Error(`Permintaan ke model melebihi batas waktu idle (${idleTimeoutMs}ms).`);
        }
        armIdleTimer();
        if (chunk.text) {
          yield { type: 'text_delta', text: chunk.text };
        }

        // Read raw candidate parts to preserve official `thoughtSignature` alongside `functionCall`
        const rawParts = (
          chunk.candidates?.[0]?.content?.parts as
            | Array<{
                functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
                thoughtSignature?: string;
              }>
            | undefined
        )?.filter((p) => Boolean(p?.functionCall));

        if (rawParts && rawParts.length > 0) {
          for (const part of rawParts) {
            const fc = part.functionCall!;
            yield {
              type: 'tool_call',
              id: fc.id || `gem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: fc.name || '',
              arguments: (fc.args as Record<string, unknown>) || {},
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            };
          }
        } else if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          for (const fc of chunk.functionCalls) {
            yield {
              type: 'tool_call',
              id: fc.id || `gem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: fc.name || '',
              arguments: (fc.args as Record<string, unknown>) || {},
            };
          }
        }

        const finishReason = (chunk.candidates?.[0] as { finishReason?: string } | undefined)?.finishReason;
        if (finishReason === 'MAX_TOKENS' && !emittedTruncated) {
          emittedTruncated = true;
          yield { type: 'truncated', reason: 'MAX_TOKENS' };
        }

        if (chunk.usageMetadata) {
          tokensIn = chunk.usageMetadata.promptTokenCount || tokensIn;
          tokensOut = chunk.usageMetadata.candidatesTokenCount || tokensOut;
        }
      }

      if (timedOutByIdle && !signal?.aborted) {
        yield {
          type: 'error',
          code: 'PROVIDER_DOWN',
          message: `Permintaan ke model melebihi batas waktu idle stream (${Math.round(idleTimeoutMs / 1000)} detik).`,
        };
        return;
      }

      if (tokensIn || tokensOut) {
        yield { type: 'usage', tokensIn, tokensOut };
      }
      yield { type: 'done' };
    } catch (err) {
      if (signal?.aborted) {
        yield { type: 'done' };
        return;
      }
      if (timedOutByIdle) {
        yield {
          type: 'error',
          code: 'PROVIDER_DOWN',
          message: `Permintaan ke model melebihi batas waktu idle stream (${Math.round(idleTimeoutMs / 1000)} detik).`,
        };
        return;
      }
      const errObj = err as
        | {
            status?: unknown;
            statusCode?: unknown;
            code?: unknown;
            cause?: { status?: unknown; statusCode?: unknown; code?: unknown };
          }
        | null;
      const structuredStatus = [
        errObj?.status,
        errObj?.statusCode,
        errObj?.code,
        errObj?.cause?.status,
        errObj?.cause?.statusCode,
        errObj?.cause?.code,
      ].find((s): s is number => typeof s === 'number' && Number.isFinite(s) && s >= 400 && s <= 599);

      const raw = scrubSecrets(err instanceof Error ? err.message : String(err), getSecretsToScrub(config));
      const statusMatch = raw.match(/\b(400|401|403|404|413|429|500|502|503)\b/);
      const status = structuredStatus ?? (statusMatch ? Number(statusMatch[1]) : 500);
      const norm = normalizeProviderError(status, raw);
      yield { type: 'error', code: norm.code, message: norm.message };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  }
}
