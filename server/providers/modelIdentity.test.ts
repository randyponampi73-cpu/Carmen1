import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MODEL_CREATOR_BRANDS,
  PROVIDER_BRANDS,
  detectModelCreator,
  detectModelFamily,
  enrichProviderModel,
  getAllBrandCatalogSummary,
  resolveModelIdentity,
  validateSafeLogoUrl,
} from '../../shared/modelIdentity';
import type { ProviderModel } from '../../src/types';

test('Model Identity: every registered creator & provider logoPath points to an existing local SVG in /public/logos', () => {
  const publicDir = path.resolve(process.cwd(), 'public');
  const summary = getAllBrandCatalogSummary();
  assert.ok(summary.creators.length >= 14, 'Expected at least 14 creator brands');
  assert.equal(summary.providers.length, 7, 'Expected all 7 CARMEN providers');

  for (const brand of [...Object.values(MODEL_CREATOR_BRANDS), ...Object.values(PROVIDER_BRANDS)]) {
    assert.ok(validateSafeLogoUrl(brand.logoPath), `Logo path must pass safety check: ${brand.logoPath}`);
    const filePath = path.join(publicDir, brand.logoPath.replace(/^\//, ''));
    assert.ok(fs.existsSync(filePath), `Missing local logo SVG asset on disk: ${filePath}`);
    const svg = fs.readFileSync(filePath, 'utf8');
    assert.match(svg, /<svg[\s>]/i, `File ${brand.logoPath} must be valid SVG markup`);
    assert.equal(/<script/i.test(svg), false, `SVG ${brand.logoPath} must not contain script tags`);
  }
});

test('Model Identity: separates creator identity from provider identity on OpenRouter & Groq', () => {
  // OpenRouter serving Anthropic Claude
  const orClaude = resolveModelIdentity({
    provider: 'openrouter',
    modelId: 'anthropic/claude-3.7-sonnet',
    modelName: 'Claude 3.7 Sonnet',
  });
  assert.equal(orClaude.modelCreator, 'anthropic');
  assert.equal(orClaude.modelCreatorName, 'Anthropic');
  assert.equal(orClaude.modelCreatorLogo, '/logos/claude-color.svg');
  assert.equal(orClaude.provider, 'openrouter');
  assert.equal(orClaude.providerName, 'OpenRouter');
  assert.equal(orClaude.providerLogo, '/logos/openrouter.svg');
  assert.equal(orClaude.isAggregated, true);
  assert.match(orClaude.modelFamily, /Claude/i);

  // OpenRouter serving OpenAI GPT
  const orGpt = resolveModelIdentity({
    provider: 'openrouter',
    modelId: 'openai/gpt-4o-mini',
  });
  assert.equal(orGpt.modelCreator, 'openai');
  assert.equal(orGpt.modelCreatorLogo, '/logos/openai.svg');
  assert.equal(orGpt.modelCreatorMonochrome, true);
  assert.equal(orGpt.provider, 'openrouter');
  assert.equal(orGpt.isAggregated, true);

  // OpenRouter serving Google Gemini
  const orGemini = resolveModelIdentity({
    provider: 'openrouter',
    modelId: 'google/gemini-2.5-pro',
  });
  assert.equal(orGemini.modelCreator, 'google');
  assert.equal(orGemini.modelCreatorLogo, '/logos/gemini-color.svg');
  assert.match(orGemini.modelFamily, /Gemini/i);

  // Groq serving Meta Llama
  const groqLlama = resolveModelIdentity({
    provider: 'groq',
    modelId: 'llama-3.3-70b-versatile',
  });
  assert.equal(groqLlama.modelCreator, 'meta');
  assert.equal(groqLlama.modelCreatorName, 'Meta');
  assert.equal(groqLlama.modelCreatorLogo, '/logos/meta-color.svg');
  assert.equal(groqLlama.provider, 'groq');
  assert.equal(groqLlama.providerName, 'Groq');
  assert.equal(groqLlama.isAggregated, true);
  assert.match(groqLlama.modelFamily, /Llama/i);

  // Groq serving DeepSeek R1 Distill
  const groqDeepseek = resolveModelIdentity({
    provider: 'groq',
    modelId: 'deepseek-r1-distill-llama-70b',
  });
  assert.equal(groqDeepseek.modelCreator, 'deepseek');
  assert.match(groqDeepseek.modelFamily, /DeepSeek/i);
});

test('Model Identity: resolves direct providers, major open-weight families, and safe unknown/custom fallbacks', () => {
  const cases: Array<[string, string, string, RegExp]> = [
    ['openai', 'gpt-4.1', 'openai', /GPT/i],
    ['openai', 'o3-mini', 'openai', /o3|OpenAI/i],
    ['anthropic', 'claude-sonnet-4-20250514', 'anthropic', /Claude/i],
    ['gemini', 'gemini-2.5-flash', 'google', /Gemini/i],
    ['openrouter', 'mistralai/mistral-large-2411', 'mistral', /Mistral/i],
    ['openrouter', 'qwen/qwen-2.5-coder-32b-instruct', 'qwen', /Qwen/i],
    ['openrouter', 'x-ai/grok-3', 'xai', /Grok/i],
    ['openrouter', 'cohere/command-r-plus', 'cohere', /Command/i],
    ['openrouter', 'perplexity/sonar-pro', 'perplexity', /Sonar/i],
    ['openrouter', 'nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia', /Nemotron|Llama/i],
    ['openrouter', 'microsoft/phi-4', 'microsoft', /Phi/i],
    ['coarena', 'coarena-coder-pro', 'coarena', /Coarena/i],
    ['custom', 'my-internal-fine-tune-v1', 'custom', /Custom/i],
    ['openrouter', 'unrecognized-org/mystery-model-9b', 'unknown', /Model/i],
  ];

  for (const [provider, modelId, expectedCreator, familyPattern] of cases) {
    const creator = detectModelCreator(modelId, provider);
    assert.equal(creator, expectedCreator, `Creator mismatch for ${provider}:${modelId}`);
    const family = detectModelFamily(modelId, creator);
    assert.match(family, familyPattern, `Family mismatch for ${provider}:${modelId} (got ${family})`);
  }
});

test('Model Identity: enrichProviderModel attaches identity without mutating original model fields', () => {
  const base: ProviderModel = {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'openrouter',
    providerKeyId: 'key_1',
    providerLabel: 'OpenRouter Main',
    tier: 'paid',
    toolCalling: 'yes',
    vision: 'yes',
    maxContext: 200000,
    maxOutput: 8192,
    promptPricePerMillion: 3,
    completionPricePerMillion: 15,
    source: 'openrouter_api',
    lastVerified: new Date().toISOString(),
  };
  const enriched = enrichProviderModel(base);
  assert.equal(enriched.id, base.id);
  assert.equal(enriched.identity.modelCreator, 'anthropic');
  assert.equal(enriched.identity.provider, 'openrouter');
  assert.equal(enriched.identity.isAggregated, true);
  assert.equal(enriched.streaming, true);
  assert.equal(enriched.availability, 'available');
});

test('Model Identity Security: validateSafeLogoUrl blocks XSS, SSRF, protocol-relative, and path traversal URLs', () => {
  assert.equal(validateSafeLogoUrl('/logos/openai.svg'), '/logos/openai.svg');
  assert.equal(validateSafeLogoUrl('/logos/claude-color.svg'), '/logos/claude-color.svg');

  assert.equal(validateSafeLogoUrl('http://127.0.0.1/logo.svg'), null);
  assert.equal(validateSafeLogoUrl('http://localhost:3000/logo.svg'), null);
  assert.equal(validateSafeLogoUrl('//evil.example/logo.svg'), null);
  assert.equal(validateSafeLogoUrl('/logos/../secret.svg'), null);
  assert.equal(validateSafeLogoUrl('javascript:alert(1)'), null);
  assert.equal(validateSafeLogoUrl('data:image/svg+xml,<svg onload=alert(1)>'), null);
  assert.equal(validateSafeLogoUrl(''), null);
});
