import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter } from './anthropic';
import { CoarenaAdapter, COARENA_DEFAULT_BASE_URL } from './coarena';
import { GeminiAdapter } from './gemini';
import { OpenAICompatibleAdapter } from './openaiCompatible';
import { getProviderAdapter } from './index';
import type { ProviderAdapterConfig, StreamEvent } from './types';

function makeSseResponse(chunks: string[], status = 200, headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

function makeJsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function collectEvents(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

const SAMPLE_TOOLS = [
  {
    name: 'write_file',
    description: 'Write file',
    parameters: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'path' }, content: { type: 'string', description: 'content' } },
      required: ['path', 'content'],
    },
  },
];

// ============================================================
// 1. DEDICATED COARENA AI PROVIDER ACCEPTANCE TESTS
// ============================================================
test('Coarena AI: registered as dedicated first-class adapter with verified default base URL', () => {
  const registered = getProviderAdapter('coarena');
  assert.equal(registered.id, 'coarena');
  assert.equal(COARENA_DEFAULT_BASE_URL, 'https://coarena.ai/api/v1');
});

test('Coarena AI: auth verification (/limits), model discovery (/models), capabilities, streaming, tools, vision, usage, retry, 401, 429, cancel', async () => {
  const captured: Array<{ url: string; headers: Record<string, string>; body?: Record<string, unknown> }> = [];
  let chatAttempt = 0;

  const adapter = new CoarenaAdapter(async (url, init) => {
    const hdrs = (init.headers || {}) as Record<string, string>;
    const parsedBody = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    captured.push({ url, headers: hdrs, body: parsedBody });

    if (url.endsWith('/limits')) {
      if (hdrs.Authorization === 'Bearer coa_valid_key_1234567890') {
        return makeJsonResponse({ dailyLimitUsd: 10, usedTodayUsd: 0.1 }, 200);
      }
      if (hdrs.Authorization === 'Bearer coa_rate_limited') {
        return makeJsonResponse({ error: { message: 'Too many requests' } }, 429, { 'retry-after': '12' });
      }
      return makeJsonResponse({ error: { message: 'Invalid API key' } }, 401);
    }

    if (url.endsWith('/models')) {
      return makeJsonResponse({
        object: 'list',
        data: [
          {
            id: 'coarena-smart-1',
            display_name: 'Coarena Smart 1',
            lifecycle: 'active',
            context_length: 128000,
            max_completion_tokens: 16384,
            pricing: { prompt: '0', completion: '0' },
            capabilities: { tools: true, vision: true },
          },
          {
            id: 'coarena-text-only',
            display_name: 'Coarena Text Only',
            lifecycle: 'active',
            max_input_tokens: 32000,
            max_tokens: 4096,
            pricing: { prompt: '0.000002', completion: '0.000004' },
            capabilities: { tools: false, vision: false },
          },
          {
            id: 'coarena-retired',
            display_name: 'Retired Model',
            lifecycle: 'deprecated',
            capabilities: { tools: true, vision: false },
          },
        ],
      });
    }

    if (url.endsWith('/chat/completions')) {
      if (init.signal?.aborted) throw new Error('Aborted');
      chatAttempt += 1;
      if (parsedBody?.model === 'trigger-retry-then-ok' && chatAttempt === 1) {
        return makeJsonResponse({ error: { message: 'Overloaded' } }, 503, { 'retry-after-ms': '20' });
      }
      if (parsedBody?.model === 'trigger-429-no-retry') {
        return makeJsonResponse({ error: { message: 'Rate limit exceeded' } }, 429, {
          'retry-after': '30',
          'x-should-retry': 'false',
        });
      }
      if (parsedBody?.model === 'trigger-network-err') {
        throw new Error('ECONNRESET upstream coa_valid_key_1234567890');
      }
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Halo ' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Coarena!' } }] })}\n\n`,
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_coa_1', function: { name: 'write_file', arguments: '{"path":"index.html",' } }],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"content":"<h1>OK</h1>"}' } }],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 18 } })}\n\n`,
        `data: [DONE]\n\n`,
      ]);
    }
    return makeJsonResponse({ error: 'unexpected' }, 500);
  });

  const validCfg: ProviderAdapterConfig = {
    providerKeyId: 'k_coa',
    provider: 'coarena',
    label: 'Coarena AI',
    apiKey: 'coa_valid_key_1234567890',
    tierDeclared: 'unknown',
  };

  // Auth valid vs invalid vs 429
  const okConn = await adapter.testConnection(validCfg);
  assert.equal(okConn.ok, true);

  const badConn = await adapter.testConnection({ ...validCfg, apiKey: 'coa_invalid_key' });
  assert.equal(badConn.ok, false);
  assert.equal(badConn.errorCode, 'AUTH_INVALID');

  const rlConn = await adapter.testConnection({ ...validCfg, apiKey: 'coa_rate_limited' });
  assert.equal(rlConn.ok, false);
  assert.equal(rlConn.errorCode, 'RATE_LIMIT');
  assert.match(rlConn.message, /12 detik/);

  // SSRF rejection on private custom Base URL override
  const ssrfConn = await adapter.testConnection({ ...validCfg, baseUrl: 'https://127.0.0.1/v1' });
  assert.equal(ssrfConn.ok, false);

  // Dynamic model discovery & exact capability mapping (no hardcoded model names!)
  const models = await adapter.listModels(validCfg);
  assert.equal(models.length, 2, 'Deprecated model must be filtered out');
  assert.equal(models[0].id, 'coarena-smart-1');
  assert.equal(models[0].provider, 'coarena');
  assert.equal(models[0].tier, 'free');
  assert.equal(models[0].toolCalling, 'yes');
  assert.equal(models[0].vision, 'yes');
  assert.equal(models[0].maxContext, 128000);
  assert.equal(models[0].maxOutput, 16384);

  assert.equal(models[1].id, 'coarena-text-only');
  assert.equal(models[1].tier, 'paid');
  assert.equal(models[1].toolCalling, 'no');
  assert.equal(models[1].vision, 'no');
  assert.equal(adapter.capabilities('coarena-text-only', validCfg).toolCalling, 'no');

  // Streaming + tool calling + vision + usage on capable model
  const events = await collectEvents(
    adapter.chatStream({
      config: validCfg,
      modelId: 'coarena-smart-1',
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Build app', imageBase64: 'AAAA', imageMimeType: 'image/png' }],
      tools: SAMPLE_TOOLS,
    })
  );
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join(''), 'Halo Coarena!');
  const tc = events.find((e) => e.type === 'tool_call');
  assert.ok(tc && tc.type === 'tool_call');
  assert.equal(tc.name, 'write_file');
  assert.equal(tc.arguments.path, 'index.html');
  const usage = events.find((e) => e.type === 'usage');
  assert.deepEqual(usage, { type: 'usage', tokensIn: 42, tokensOut: 18 });

  // Verify tools & vision omitted for model with capabilities.tools=false, vision=false
  await collectEvents(
    adapter.chatStream({
      config: validCfg,
      modelId: 'coarena-text-only',
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hi', imageBase64: 'AAAA', imageMimeType: 'image/png' }],
      tools: SAMPLE_TOOLS,
    })
  );
  const textOnlyReq = captured.at(-1)!;
  assert.equal(textOnlyReq.body?.tools, undefined);
  assert.equal(typeof (textOnlyReq.body?.messages as Array<{ content: unknown }>)[1].content, 'string');

  // Transient 503 with small Retry-After-Ms retries automatically and succeeds
  chatAttempt = 0;
  const retryEvents = await collectEvents(
    adapter.chatStream({
      config: validCfg,
      modelId: 'trigger-retry-then-ok',
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Retry test' }],
    })
  );
  assert.equal(chatAttempt, 2);
  assert.ok(retryEvents.some((e) => e.type === 'text_delta'));

  // 429 with x-should-retry: false surfaces RATE_LIMIT with Retry-After seconds
  const rateErrEvents = await collectEvents(
    adapter.chatStream({
      config: validCfg,
      modelId: 'trigger-429-no-retry',
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Rate limit' }],
    })
  );
  const rlErr = rateErrEvents.find((e) => e.type === 'error');
  assert.ok(rlErr && rlErr.type === 'error');
  assert.equal(rlErr.code, 'RATE_LIMIT');
  assert.match(rlErr.message, /30 detik/);

  // Network error scrubs API key
  const netErrEvents = await collectEvents(
    adapter.chatStream({
      config: validCfg,
      modelId: 'trigger-network-err',
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Net err' }],
    })
  );
  const netErr = netErrEvents.find((e) => e.type === 'error');
  assert.ok(netErr && netErr.type === 'error');
  assert.equal(netErr.code, 'PROVIDER_DOWN');
  assert.equal(netErr.message.includes('coa_valid_key'), false, 'API key must be scrubbed');

  // Cancellation via AbortSignal terminates cleanly with done (no error)
  const ac = new AbortController();
  ac.abort();
  const cancelEvents = await collectEvents(
    adapter.chatStream({
      config: validCfg,
      modelId: 'coarena-smart-1',
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Cancel' }],
      signal: ac.signal,
    })
  );
  assert.deepEqual(cancelEvents, [{ type: 'done' }]);
});

// ============================================================
// 2. GEMINI PROVIDER ACCEPTANCE TESTS
// ============================================================
test('Gemini: auth, model discovery, streaming, tool calling with thoughtSignature, vision, usage, errors, cancel', async () => {
  const adapter = new GeminiAdapter({
    fetchFn: async (url, init) => {
      const hdrs = (init.headers || {}) as Record<string, string>;
      if (hdrs['x-goog-api-key'] !== 'AIzaValidKeyForTesting1234567890') {
        return makeJsonResponse({ error: { message: 'API key not valid' } }, 401);
      }
      if (url.includes('/v1beta/models')) {
        return makeJsonResponse({
          models: [
            {
              name: 'models/gemini-2.5-flash',
              displayName: 'Gemini 2.5 Flash',
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-1.5-pro',
              displayName: 'Deprecated 1.5',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        });
      }
      return makeJsonResponse({}, 404);
    },
    clientFactory: () =>
      ({
        models: {
          generateContentStream: async (opts: { model: string; config?: { abortSignal?: AbortSignal } }) => {
            if (opts.config?.abortSignal?.aborted) throw new Error('Aborted');
            if (opts.model === 'rate-limit') throw new Error('429 Resource exhausted rate limit');
            return (async function* () {
              yield { text: 'Hello Gemini', candidates: [], usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 7 } };
              yield {
                text: '',
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: { id: 'fc_1', name: 'write_file', args: { path: 'a.js', content: '1' } },
                          thoughtSignature: 'sig_verified_xyz',
                        },
                      ],
                    },
                  },
                ],
                usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 22 },
              };
            })();
          },
        },
      }) as unknown as ReturnType<ConstructorParameters<typeof GeminiAdapter>[0] extends { clientFactory?: infer F } ? NonNullable<F> : never>,
  });

  const cfg: ProviderAdapterConfig = {
    providerKeyId: 'k_gem',
    provider: 'gemini',
    label: 'Gemini',
    apiKey: 'AIzaValidKeyForTesting1234567890',
    tierDeclared: 'free',
  };

  assert.equal((await adapter.testConnection(cfg)).ok, true);
  assert.equal((await adapter.testConnection({ ...cfg, apiKey: 'AIzaBadKey' })).errorCode, 'AUTH_INVALID');

  const models = await adapter.listModels(cfg);
  assert.equal(models.some((m) => m.id === 'gemini-2.5-flash'), true);
  assert.equal(models.some((m) => m.id === 'gemini-1.5-pro'), false, 'Deprecated 1.5 skipped');

  const events = await collectEvents(
    adapter.chatStream({
      config: cfg,
      modelId: 'gemini-2.5-flash',
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Build', imageBase64: 'AAAA', imageMimeType: 'image/png' }],
      tools: SAMPLE_TOOLS,
    })
  );
  const tc = events.find((e) => e.type === 'tool_call');
  assert.ok(tc && tc.type === 'tool_call');
  assert.equal(tc.thoughtSignature, 'sig_verified_xyz');
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', tokensIn: 15, tokensOut: 22 });

  const rlEvents = await collectEvents(
    adapter.chatStream({ config: cfg, modelId: 'rate-limit', systemPrompt: 'S', messages: [{ role: 'user', content: 'x' }] })
  );
  assert.equal(rlEvents.find((e) => e.type === 'error')?.type, 'error');

  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(
    await collectEvents(
      adapter.chatStream({ config: cfg, modelId: 'gemini-2.5-flash', systemPrompt: 'S', messages: [{ role: 'user', content: 'x' }], signal: ac.signal })
    ),
    [{ type: 'done' }]
  );
});

// ============================================================
// 3. ANTHROPIC PROVIDER ACCEPTANCE TESTS
// ============================================================
test('Anthropic: auth, model discovery, SSE text + tool_use streaming, vision, usage, 429 retry, 401, cancel', async () => {
  let msgAttempt = 0;
  const adapter = new AnthropicAdapter(async (url, init) => {
    const hdrs = (init.headers || {}) as Record<string, string>;
    if (hdrs['x-api-key'] !== 'sk-ant-valid-12345') {
      return makeJsonResponse({ error: { message: 'invalid x-api-key' } }, 401);
    }
    if (url.includes('/models')) {
      return makeJsonResponse({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] });
    }
    if (url.endsWith('/messages')) {
      if (init.signal?.aborted) throw new Error('Aborted');
      msgAttempt += 1;
      if (msgAttempt === 1) {
        return makeJsonResponse({ error: { message: 'overloaded' } }, 529, { 'retry-after-ms': '15' });
      }
      return makeSseResponse([
        `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 55 } } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Anthropic OK' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"app.js","content":"ok"}' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_stop' })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 33 } })}\n\n`,
      ]);
    }
    return makeJsonResponse({}, 404);
  });

  const cfg: ProviderAdapterConfig = {
    providerKeyId: 'k_ant',
    provider: 'anthropic',
    label: 'Anthropic',
    apiKey: 'sk-ant-valid-12345',
    tierDeclared: 'paid',
  };

  assert.equal((await adapter.testConnection(cfg)).ok, true);
  assert.equal((await adapter.testConnection({ ...cfg, apiKey: 'bad' })).errorCode, 'AUTH_INVALID');

  const models = await adapter.listModels(cfg);
  assert.equal(models[0].id, 'claude-sonnet-4-5');
  assert.equal(models[0].tier, 'paid');

  const events = await collectEvents(
    adapter.chatStream({
      config: cfg,
      modelId: 'claude-sonnet-4-5',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Hi', imageBase64: 'AAAA', imageMimeType: 'image/png' }],
      tools: SAMPLE_TOOLS,
    })
  );
  assert.equal(msgAttempt, 2, 'Should retry transient 529 once');
  assert.ok(events.some((e) => e.type === 'text_delta' && e.text === 'Anthropic OK'));
  assert.ok(events.some((e) => e.type === 'tool_call' && e.name === 'write_file'));
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', tokensIn: 55, tokensOut: 33 });
});

// ============================================================
// 4-7. GROQ, OPENROUTER, OPENAI, AND CUSTOM PROVIDER ACCEPTANCE TESTS
// ============================================================
for (const providerId of ['groq', 'openrouter', 'openai', 'custom'] as const) {
  test(`${providerId.toUpperCase()}: auth, discovery, streaming, tool calling, vision, usage, 429 retry, 401, cancel`, async () => {
    let attempts = 0;
    const seenHeaders: Record<string, string>[] = [];
    const seenUrls: string[] = [];

    const adapter = new OpenAICompatibleAdapter(providerId, async (url, init) => {
      const hdrs = (init.headers || {}) as Record<string, string>;
      seenHeaders.push(hdrs);
      seenUrls.push(url);
      const authVal = hdrs.Authorization || hdrs['X-Custom-Key'] || '';
      if (providerId === 'openrouter' && url.endsWith('/key')) {
        if (!authVal.includes('valid_secret_token')) {
          return makeJsonResponse({ error: { message: 'User not found.', code: 401 } }, 401);
        }
        return makeJsonResponse({ data: { label: 'test-key', usage: 0, is_free_tier: true } }, 200);
      }
      // Simulate OpenRouter's real public /models behavior (200 even without valid key)
      if (providerId !== 'openrouter' && !authVal.includes('valid_secret_token')) {
        return makeJsonResponse({ error: { message: 'Unauthorized key' } }, 401);
      }
      if (url.endsWith('/models')) {
        return makeJsonResponse({
          data: [
            {
              id: `${providerId}-model-free`,
              name: `${providerId} Free Model`,
              context_length: 64000,
              pricing: providerId === 'openrouter' ? { prompt: '0', completion: '0' } : undefined,
              supported_parameters: ['tools'],
            },
            {
              id: `${providerId}-model-paid`,
              name: `${providerId} Paid Model`,
              context_length: 128000,
              pricing: providerId === 'openrouter' ? { prompt: '0.000001', completion: '0.000002' } : undefined,
            },
          ],
        });
      }
      if (url.endsWith('/chat/completions') || url.endsWith('/v2/chat')) {
        if (init.signal?.aborted) throw new Error('Aborted');
        attempts += 1;
        if (attempts === 1) {
          return makeJsonResponse({ error: { message: 'rate limit' } }, 429, { 'retry-after-ms': '15' });
        }
        return makeSseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: `OK:${providerId}` } }] })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: `tc_${providerId}`, function: { name: 'write_file', arguments: '{"path":"index.html","content":"hi"}' } }],
                },
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
          `data: [DONE]\n\n`,
        ]);
      }
      return makeJsonResponse({}, 404);
    });

    const cfg: ProviderAdapterConfig = {
      providerKeyId: `k_${providerId}`,
      provider: providerId,
      label: providerId.toUpperCase(),
      apiKey: 'valid_secret_token_9999',
      tierDeclared: providerId === 'groq' ? 'free' : 'unknown',
      ...(providerId === 'custom'
        ? {
            baseUrl: 'https://api.custom-example.test/v1',
            authHeader: 'X-Custom-Key',
            chatPath: '/v2/chat',
            customModels: ['manual-fallback-model'],
            supportsTools: 'yes',
            supportsVision: 'yes',
          }
        : {}),
    };

    assert.equal((await adapter.testConnection(cfg)).ok, true);
    assert.equal((await adapter.testConnection({ ...cfg, apiKey: 'invalid' })).errorCode, 'AUTH_INVALID');

    const models = await adapter.listModels(cfg);
    assert.ok(models.length >= 2);
    if (providerId === 'openrouter') {
      assert.equal(seenUrls[0].endsWith('/key'), true, 'OpenRouter testConnection must validate via /key');
      assert.equal(models.find((m) => m.id === 'openrouter-model-free')?.tier, 'free');
      assert.equal(models.find((m) => m.id === 'openrouter-model-paid')?.tier, 'paid');
      assert.ok(seenHeaders[0]['HTTP-Referer']);
      assert.equal(seenHeaders[0]['X-Title'], 'CARMEN');
    }
    if (providerId === 'custom') {
      assert.ok(models.some((m) => m.id === 'manual-fallback-model'));
      assert.equal(seenHeaders[0]['X-Custom-Key'], 'valid_secret_token_9999');
    }

    const events = await collectEvents(
      adapter.chatStream({
        config: cfg,
        modelId: models[0].id,
        systemPrompt: 'Sys',
        messages: [{ role: 'user', content: 'Build', imageBase64: 'AAAA', imageMimeType: 'image/png' }],
        tools: SAMPLE_TOOLS,
      })
    );
    assert.equal(attempts, 2, `${providerId} retries once on short 429`);
    assert.ok(events.some((e) => e.type === 'text_delta' && e.text === `OK:${providerId}`));
    assert.ok(events.some((e) => e.type === 'tool_call' && e.name === 'write_file'));
    assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', tokensIn: 10, tokensOut: 5 });

    const ac = new AbortController();
    ac.abort();
    assert.deepEqual(
      await collectEvents(
        adapter.chatStream({ config: cfg, modelId: models[0].id, systemPrompt: 'S', messages: [{ role: 'user', content: 'x' }], signal: ac.signal })
      ),
      [{ type: 'done' }]
    );
  });
}

// ============================================================
// GROUP B: OUTPUT TOKEN LIMIT, TRUNCATION EVENTS & MALFORMED TOOL JSON
// ============================================================
test('Group B1 & B2: Anthropic raises max_tokens >= 16384, emits truncated on max_tokens/length/MAX_TOKENS, and surfaces JSON parse failures cleanly', async () => {
  let capturedAnthropicBody: Record<string, unknown> = {};
  const ant = new AnthropicAdapter(async (_url, init) => {
    capturedAnthropicBody = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
    if (capturedAnthropicBody.model === 'claude-bad-json') {
      return makeSseResponse([
        `data: ${JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_bad', name: 'write_file' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"index.html","content":' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_stop' })}\n\n`,
      ]);
    }
    return makeSseResponse([
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Potongan teks...' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 16384 } })}\n\n`,
    ]);
  });

  const antCfg: ProviderAdapterConfig = {
    providerKeyId: 'k_ant_b',
    provider: 'anthropic',
    label: 'Anthropic',
    apiKey: 'sk-ant-valid-12345',
    tierDeclared: 'paid',
  };

  const antEvents = await collectEvents(
    ant.chatStream({
      config: antCfg,
      modelId: 'claude-sonnet-4-5',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Build large app' }],
    })
  );
  assert.ok(Number(capturedAnthropicBody.max_tokens) >= 16384, 'Anthropic max_tokens must not be stuck at 4096');
  assert.ok(antEvents.some((e) => e.type === 'truncated' && e.reason === 'max_tokens'));

  const antBadJsonEvents = await collectEvents(
    ant.chatStream({
      config: antCfg,
      modelId: 'claude-bad-json',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Write file' }],
      tools: SAMPLE_TOOLS,
    })
  );
  assert.equal(antBadJsonEvents.some((e) => e.type === 'tool_call'), false, 'Malformed JSON must NOT emit empty {} tool_call');
  const antErr = antBadJsonEvents.find((e) => e.type === 'error');
  assert.ok(antErr && antErr.type === 'error');
  assert.match(antErr.message, /write_file.*rusak atau terpotong/i);

  // OpenAI-compatible & Coarena finish_reason === 'length' and invalid tool JSON
  for (const kind of ['groq', 'coarena'] as const) {
    const adapter =
      kind === 'coarena'
        ? new CoarenaAdapter(async (_url, init) => {
            const body = JSON.parse(String(init.body || '{}')) as { model?: string };
            if (body.model === 'bad-json') {
              return makeSseResponse([
                `data: ${JSON.stringify({
                  choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{broken' } }] } }],
                })}\n\n`,
                `data: [DONE]\n\n`,
              ]);
            }
            return makeSseResponse([
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial' }, finish_reason: 'length' }] })}\n\n`,
              `data: [DONE]\n\n`,
            ]);
          })
        : new OpenAICompatibleAdapter('groq', async (_url, init) => {
            const body = JSON.parse(String(init.body || '{}')) as { model?: string };
            if (body.model === 'bad-json') {
              return makeSseResponse([
                `data: ${JSON.stringify({
                  choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{broken' } }] } }],
                })}\n\n`,
                `data: [DONE]\n\n`,
              ]);
            }
            return makeSseResponse([
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial' }, finish_reason: 'length' }] })}\n\n`,
              `data: [DONE]\n\n`,
            ]);
          });

    const cfg: ProviderAdapterConfig = {
      providerKeyId: `k_${kind}`,
      provider: kind,
      label: kind,
      apiKey: 'valid_key_1234567890',
      tierDeclared: 'free',
    };

    const truncEvents = await collectEvents(
      adapter.chatStream({ config: cfg, modelId: 'ok-model', systemPrompt: 'S', messages: [{ role: 'user', content: 'Hi' }] })
    );
    assert.ok(truncEvents.some((e) => e.type === 'truncated' && e.reason === 'length'));

    const badEvents = await collectEvents(
      adapter.chatStream({ config: cfg, modelId: 'bad-json', systemPrompt: 'S', messages: [{ role: 'user', content: 'Hi' }] })
    );
    assert.equal(badEvents.some((e) => e.type === 'tool_call'), false);
    assert.equal(badEvents.some((e) => e.type === 'error'), true);
  }

  // Gemini MAX_TOKENS finishReason
  const gem = new GeminiAdapter({
    clientFactory: () =>
      ({
        models: {
          generateContentStream: async () =>
            (async function* () {
              yield { text: 'Cut off', candidates: [{ finishReason: 'MAX_TOKENS' }] };
            })(),
        },
      }) as unknown as ReturnType<ConstructorParameters<typeof GeminiAdapter>[0] extends { clientFactory?: infer F } ? NonNullable<F> : never>,
  });
  const gemEvents = await collectEvents(
    gem.chatStream({
      config: { providerKeyId: 'kg', provider: 'gemini', label: 'Gem', apiKey: 'AIzaTestKey12345678901234', tierDeclared: 'free' },
      modelId: 'gemini-2.5-flash',
      systemPrompt: 'S',
      messages: [{ role: 'user', content: 'Hi' }],
    })
  );
  assert.ok(gemEvents.some((e) => e.type === 'truncated' && e.reason === 'MAX_TOKENS'));
});

// ============================================================
// GROUP D: ERROR NORMALIZATION, MID-STREAM SSE ERRORS, UNIQUE TOOL IDS, PARAMETER TYPES & MODEL LIST CAP
// ============================================================
test('Group D (D1-D6): error normalization, Gemini structured status & param types, mid-stream SSE errors, unique tool call IDs, and 250+ model cap', async () => {
  const { Type } = await import('@google/genai');
  const { normalizeProviderError } = await import('./types');

  // D1: Tighten MODEL_NOT_FOUND so generic "resource/file not found" isn't misclassified, while expanding CONTEXT_TOO_LONG
  assert.equal(normalizeProviderError(400, 'Endpoint resource not found on gateway').code, 'UNKNOWN');
  assert.equal(normalizeProviderError(404, 'No such route').code, 'MODEL_NOT_FOUND');
  assert.equal(normalizeProviderError(400, 'Model claude-unknown does not exist').code, 'MODEL_NOT_FOUND');
  assert.equal(normalizeProviderError(400, 'Error: prompt is too long: 210000 tokens > 200000 maximum').code, 'CONTEXT_TOO_LONG');
  assert.equal(normalizeProviderError(400, 'context_length_exceeded: reduce the length of messages').code, 'CONTEXT_TOO_LONG');

  // D2 & D5: Gemini inspects err.status before regex fallback and maps integer/boolean/string schema types accurately
  let capturedDecls: Array<{ parameters?: { properties?: Record<string, { type?: unknown }> } }> | undefined;
  const gem = new GeminiAdapter({
    clientFactory: () =>
      ({
        models: {
          generateContentStream: async (opts: {
            model: string;
            config?: { tools?: Array<{ functionDeclarations?: typeof capturedDecls }> };
          }) => {
            capturedDecls = opts.config?.tools?.[0]?.functionDeclarations;
            if (opts.model === 'structured-429') {
              const err = new Error('Resource has been exhausted without numeric digits in message') as Error & { status?: number };
              err.status = 429;
              throw err;
            }
            return (async function* () {
              yield { text: 'OK' };
            })();
          },
        },
      }) as unknown as ReturnType<ConstructorParameters<typeof GeminiAdapter>[0] extends { clientFactory?: infer F } ? NonNullable<F> : never>,
  });

  const gemCfg: ProviderAdapterConfig = {
    providerKeyId: 'kg_d',
    provider: 'gemini',
    label: 'Gemini',
    apiKey: 'AIzaTestKey12345678901234',
    tierDeclared: 'free',
  };

  await collectEvents(
    gem.chatStream({
      config: gemCfg,
      modelId: 'gemini-2.5-flash',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Read lines 1..10' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read file lines',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path' },
              start_line: { type: 'integer', description: 'Start line' },
              exact: { type: 'boolean', description: 'Exact mode' },
            },
            required: ['path'],
          },
        },
      ],
    })
  );
  assert.equal(capturedDecls?.[0]?.parameters?.properties?.path?.type, Type.STRING);
  assert.equal(capturedDecls?.[0]?.parameters?.properties?.start_line?.type, Type.INTEGER);
  assert.equal(capturedDecls?.[0]?.parameters?.properties?.exact?.type, Type.BOOLEAN);

  const gemErrEvents = await collectEvents(
    gem.chatStream({
      config: gemCfg,
      modelId: 'structured-429',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })
  );
  const gemRateErr = gemErrEvents.find((e) => e.type === 'error');
  assert.ok(gemRateErr && gemRateErr.type === 'error');
  assert.equal(gemRateErr.code, 'RATE_LIMIT');

  // D3: Mid-stream SSE error events surface immediately instead of being silently ignored
  const antMidErr = new AnthropicAdapter(async () =>
    makeSseResponse([
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Awal ' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded upstream' } })}\n\n`,
    ])
  );
  const antMidEvents = await collectEvents(
    antMidErr.chatStream({
      config: { providerKeyId: 'ka_d', provider: 'anthropic', label: 'Anthropic', apiKey: 'sk-ant-123', tierDeclared: 'paid' },
      modelId: 'claude-sonnet-4-5',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })
  );
  assert.equal(antMidEvents.some((e) => e.type === 'error' && e.code === 'PROVIDER_DOWN'), true);
  assert.equal(antMidEvents.some((e) => e.type === 'done'), false);

  for (const kind of ['openrouter', 'coarena'] as const) {
    const midStreamAdapter =
      kind === 'coarena'
        ? new CoarenaAdapter(async () =>
            makeSseResponse([
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'Start' } }] })}\n\n`,
              `data: ${JSON.stringify({ error: { code: 429, message: 'Rate limit mid-stream' } })}\n\n`,
            ])
          )
        : new OpenAICompatibleAdapter('openrouter', async () =>
            makeSseResponse([
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'Start' } }] })}\n\n`,
              `data: ${JSON.stringify({ error: { code: 429, message: 'Rate limit mid-stream' } })}\n\n`,
            ])
          );

    const evts = await collectEvents(
      midStreamAdapter.chatStream({
        config: { providerKeyId: `k_${kind}`, provider: kind, label: kind, apiKey: 'key_123', tierDeclared: 'free' },
        modelId: 'test-model',
        systemPrompt: 'Sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    );
    const errEvt = evts.find((e) => e.type === 'error');
    assert.ok(errEvt && errEvt.type === 'error');
    assert.equal(errEvt.code, 'RATE_LIMIT');
    assert.equal(evts.some((e) => e.type === 'done'), false);
  }

  // D4: Fallback tool IDs (when provider omits tc.id) are unique across chatStream invocations
  const noIdOai = new OpenAICompatibleAdapter('groq', async () =>
    makeSseResponse([
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'list_files', arguments: '{}' } }] } }],
      })}\n\n`,
      `data: [DONE]\n\n`,
    ])
  );
  const groqCfg: ProviderAdapterConfig = {
    providerKeyId: 'k_groq_d4',
    provider: 'groq',
    label: 'Groq',
    apiKey: 'gsk_test_12345',
    tierDeclared: 'free',
  };
  const evA = await collectEvents(noIdOai.chatStream({ config: groqCfg, modelId: 'llama-3.3-70b', systemPrompt: 'S', messages: [{ role: 'user', content: '1' }] }));
  const evB = await collectEvents(noIdOai.chatStream({ config: groqCfg, modelId: 'llama-3.3-70b', systemPrompt: 'S', messages: [{ role: 'user', content: '2' }] }));
  const tcA = evA.find((e) => e.type === 'tool_call');
  const tcB = evB.find((e) => e.type === 'tool_call');
  assert.ok(tcA && tcA.type === 'tool_call' && tcB && tcB.type === 'tool_call');
  assert.notEqual(tcA.id, tcB.id, 'Fallback tool call IDs must be unique across turns');

  // D6: listModels supports >200 models (up to 1000) without truncating OpenRouter/Coarena catalogs prematurely
  const bigList = Array.from({ length: 260 }, (_, i) => ({ id: `model-${i}:free`, name: `Model ${i}` }));
  const bigOr = new OpenAICompatibleAdapter('openrouter', async () => makeJsonResponse({ data: bigList }));
  const orModels = await bigOr.listModels({
    providerKeyId: 'k_or_d6',
    provider: 'openrouter',
    label: 'OpenRouter',
    apiKey: 'sk-or-test',
    tierDeclared: 'free',
  });
  assert.equal(orModels.length, 260);
});

test('Token/credit/limit errors normalize accurately, Anthropic lifts artificial max_tokens cap with 400 fallback, and choice.error streams surface cleanly', async () => {
  const { normalizeProviderError } = await import('./types');

  // 1) Quota / credit exhaustion & rate limits across providers
  assert.equal(
    normalizeProviderError(400, 'Your credit balance is too low to access the Anthropic API.').code,
    'QUOTA_EXCEEDED'
  );
  assert.equal(
    normalizeProviderError(402, 'This request requires more credits, or fewer max_tokens.').code,
    'QUOTA_EXCEEDED'
  );
  assert.equal(
    normalizeProviderError(429, 'Rate limit reached for tokens per day (TPD) on model').code,
    'QUOTA_EXCEEDED'
  );
  assert.equal(
    normalizeProviderError(429, 'Rate limit reached for tokens per minute (TPM)').code,
    'RATE_LIMIT'
  );
  assert.equal(
    normalizeProviderError(429, 'RESOURCE_EXHAUSTED: Quota exceeded for requests per min').code,
    'RATE_LIMIT'
  );

  // 2) Anthropic defaults to 64k max_tokens (no 32k clamp) and retries automatically if a legacy model has a lower ceiling
  const sentMaxTokens: number[] = [];
  const antCeilingAdapter = new AnthropicAdapter(async (_url, init) => {
    const body = JSON.parse(String(init.body || '{}')) as { max_tokens: number };
    sentMaxTokens.push(body.max_tokens);
    if (sentMaxTokens.length === 1) {
      return makeJsonResponse(
        { error: { type: 'invalid_request_error', message: 'max_tokens: 64000 > 8192, which is the maximum allowed for this model' } },
        400
      );
    }
    return makeSseResponse([
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Berhasil dengan batas model 8192.' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ]);
  });

  const antRetryEvents = await collectEvents(
    antCeilingAdapter.chatStream({
      config: { providerKeyId: 'ka_retry', provider: 'anthropic', label: 'Claude', apiKey: 'sk-ant-123', tierDeclared: 'paid' },
      modelId: 'claude-3-5-sonnet-20240620',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })
  );
  assert.deepEqual(sentMaxTokens, [64000, 8192]);
  assert.equal(antRetryEvents.some((e) => e.type === 'text_delta' && e.text.includes('Berhasil')), true);
  assert.equal(antRetryEvents.some((e) => e.type === 'done'), true);

  // 3) OpenAI-compatible & Coarena catch choice.error / finish_reason === 'error'
  for (const kind of ['openrouter', 'coarena'] as const) {
    const sse = makeSseResponse([
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'error', error: { code: 402, message: 'More credits are required for this request' } }],
      })}\n\n`,
    ]);
    const adapter =
      kind === 'coarena'
        ? new CoarenaAdapter(async () => sse)
        : new OpenAICompatibleAdapter('openrouter', async () => sse);

    const events = await collectEvents(
      adapter.chatStream({
        config: { providerKeyId: `k_ce_${kind}`, provider: kind, label: kind, apiKey: 'sk-test-1234', tierDeclared: 'free' },
        modelId: 'model-test',
        systemPrompt: 'Sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    );
    const errEvt = events.find((e) => e.type === 'error');
    assert.ok(errEvt && errEvt.type === 'error');
    assert.equal(errEvt.code, 'QUOTA_EXCEEDED');
  }
});

test('F-19 & F-14: external model-catalog.json loads curated fallback models and estimates completion cost server-side', async () => {
  const {
    estimateModelCostUsd,
    findCatalogEntry,
    getModelCatalogMetadata,
    loadModelCatalog,
    reloadModelCatalog,
  } = await import('./catalog');

  const entries = reloadModelCatalog();
  assert.ok(entries.length >= 10, `Expected curated fallback catalog entries, got ${entries.length}`);

  const meta = getModelCatalogMetadata();
  assert.equal(meta.version, 1);
  assert.equal(meta.count, entries.length);
  assert.ok(meta.updatedAt);

  for (const prov of ['gemini', 'anthropic', 'openai', 'groq', 'openrouter', 'coarena'] as const) {
    assert.ok(
      entries.some((e) => e.provider === prov),
      `Catalog missing fallback entry for provider ${prov}`
    );
  }

  // Missing file path fails gracefully with empty list rather than crashing
  assert.deepEqual(loadModelCatalog('/tmp/definitely-missing-carmen-catalog-file.json'), []);

  const sonnet = findCatalogEntry('anthropic', 'claude-sonnet-4-5');
  assert.ok(sonnet);
  assert.equal(sonnet.toolCalling, 'yes');

  const cost = estimateModelCostUsd('anthropic', 'claude-sonnet-4-5', 1000, 2000);
  assert.ok(cost > 0 && cost < 1, `Unexpected estimated cost: ${cost}`);
  assert.equal(estimateModelCostUsd('anthropic', 'claude-sonnet-4-5', 0, 0), 0);
});



