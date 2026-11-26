import crypto from 'node:crypto';
import type { ProviderErrorCode, ProviderType } from '../../src/types';
import type { ProviderAdapterConfig } from '../providers/types';
import type { TaskComplexity } from './planner';

export interface RouteCandidate {
  adapterConfig: ProviderAdapterConfig;
  modelId: string;
  priority?: number;
  supportsTools?: boolean;
  maxContext?: number | 'unknown';
  reason?: string;
}

export interface ProviderHealthEntry {
  key: string; // `${provider}:${modelId}:${credentialFingerprint}`
  credentialFingerprint: string;
  provider: ProviderType;
  modelId: string;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  lastErrorCode: ProviderErrorCode | null;
  cooldownUntilMs: number;
  lastUpdatedAt: string;
}

/**
 * Computes an opaque, non-reversible SHA-256 fingerprint for a provider credential + endpoint
 * so per-user / per-key errors (e.g. AUTH_INVALID, personal QUOTA_EXCEEDED) never poison other users.
 * Never exposes plaintext API keys, raw user IDs, or custom endpoint URLs.
 */
export function makeCredentialFingerprint(
  config: Pick<ProviderAdapterConfig, 'provider' | 'providerKeyId' | 'apiKey' | 'baseUrl'>
): string {
  const material = `${config.provider}|${config.providerKeyId}|${(config.baseUrl || '').trim()}|${config.apiKey || ''}`;
  const digest = crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
  return `cred_${digest}`;
}

export interface FallbackDecision {
  shouldFallback: boolean;
  reason: string;
  cooldownMs: number;
  skipSameProviderKey: boolean;
}

const DEFAULT_COOLDOWNS: Record<ProviderErrorCode, number> = {
  RATE_LIMIT: 45_000,
  QUOTA_EXCEEDED: 120_000,
  PROVIDER_DOWN: 30_000,
  MODEL_NOT_FOUND: 300_000,
  CONTEXT_TOO_LONG: 0,
  AUTH_INVALID: 600_000,
  UNKNOWN: 15_000,
};

/**
 * Determines whether a provider error justifies switching to the next compatible model/provider.
 * Critically: AUTH_INVALID never retries the same broken API key, but CAN fall back to a DIFFERENT configured provider key.
 */
export function classifyFallbackEligibility(errorCode: ProviderErrorCode): FallbackDecision {
  switch (errorCode) {
    case 'QUOTA_EXCEEDED':
      return {
        shouldFallback: true,
        reason: 'Kuota model/provider habis — beralih ke model cadangan.',
        cooldownMs: DEFAULT_COOLDOWNS.QUOTA_EXCEEDED,
        skipSameProviderKey: false, // Another model on the same key may have separate quota
      };
    case 'RATE_LIMIT':
      return {
        shouldFallback: true,
        reason: 'Batas kecepatan (HTTP 429) tercapai — beralih ke model cadangan.',
        cooldownMs: DEFAULT_COOLDOWNS.RATE_LIMIT,
        skipSameProviderKey: false,
      };
    case 'PROVIDER_DOWN':
      return {
        shouldFallback: true,
        reason: 'Provider sedang gangguan atau timeout — beralih ke model cadangan.',
        cooldownMs: DEFAULT_COOLDOWNS.PROVIDER_DOWN,
        skipSameProviderKey: true,
      };
    case 'MODEL_NOT_FOUND':
      return {
        shouldFallback: true,
        reason: 'Model tidak tersedia pada provider ini — beralih ke model cadangan.',
        cooldownMs: DEFAULT_COOLDOWNS.MODEL_NOT_FOUND,
        skipSameProviderKey: false,
      };
    case 'CONTEXT_TOO_LONG':
      return {
        shouldFallback: true,
        reason: 'Konteks melebihi kapasitas model — beralih ke model dengan jendela konteks lebih besar.',
        cooldownMs: 0,
        skipSameProviderKey: false,
      };
    case 'AUTH_INVALID':
      return {
        shouldFallback: true,
        reason: 'Kredensial key ini ditolak (HTTP 401/403) — melewati key ini dan mencoba provider lain yang valid.',
        cooldownMs: DEFAULT_COOLDOWNS.AUTH_INVALID,
        skipSameProviderKey: true, // NEVER retry invalid credentials on the same provider key
      };
    default:
      return {
        shouldFallback: false,
        reason: 'Error tidak diklasifikasikan sebagai gangguan provider.',
        cooldownMs: DEFAULT_COOLDOWNS.UNKNOWN,
        skipSameProviderKey: false,
      };
  }
}

export class ProviderHealthMonitor {
  private readonly entries = new Map<string, ProviderHealthEntry>();

  private makeKey(provider: ProviderType, modelId: string, credentialFingerprint = 'global'): string {
    const fp = credentialFingerprint || 'global';
    return `${provider}:${modelId}:${fp}`;
  }

  recordSuccess(
    provider: ProviderType,
    modelId: string,
    latencyMs: number,
    credentialFingerprint = 'global'
  ): void {
    const fp = credentialFingerprint || 'global';
    const key = this.makeKey(provider, modelId, fp);
    const prev = this.entries.get(key);
    const successes = (prev?.successes ?? 0) + 1;
    const avgLatencyMs = prev
      ? Math.round((prev.avgLatencyMs * prev.successes + Math.max(0, latencyMs)) / successes)
      : Math.max(0, Math.round(latencyMs));

    this.entries.set(key, {
      key,
      credentialFingerprint: fp,
      provider,
      modelId,
      successes,
      failures: prev?.failures ?? 0,
      consecutiveFailures: 0,
      avgLatencyMs,
      lastErrorCode: null,
      cooldownUntilMs: 0,
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  recordFailure(
    provider: ProviderType,
    modelId: string,
    errorCode: ProviderErrorCode,
    nowMs = Date.now(),
    credentialFingerprint = 'global'
  ): void {
    const fp = credentialFingerprint || 'global';
    const key = this.makeKey(provider, modelId, fp);
    const prev = this.entries.get(key);
    const decision = classifyFallbackEligibility(errorCode);
    const consecutive = (prev?.consecutiveFailures ?? 0) + 1;
    // Cap backoff multiplier at 3x to keep cooldowns bounded
    const cooldownMs = decision.cooldownMs * Math.min(3, consecutive);

    this.entries.set(key, {
      key,
      credentialFingerprint: fp,
      provider,
      modelId,
      successes: prev?.successes ?? 0,
      failures: (prev?.failures ?? 0) + 1,
      consecutiveFailures: consecutive,
      avgLatencyMs: prev?.avgLatencyMs ?? 0,
      lastErrorCode: errorCode,
      cooldownUntilMs: cooldownMs > 0 ? nowMs + cooldownMs : 0,
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  isInCooldown(
    provider: ProviderType,
    modelId: string,
    nowMs = Date.now(),
    credentialFingerprint = 'global'
  ): boolean {
    const entry = this.entries.get(this.makeKey(provider, modelId, credentialFingerprint));
    return Boolean(entry && entry.cooldownUntilMs > nowMs);
  }

  getEntry(
    provider: ProviderType,
    modelId: string,
    credentialFingerprint = 'global'
  ): ProviderHealthEntry | null {
    return this.entries.get(this.makeKey(provider, modelId, credentialFingerprint)) ?? null;
  }

  snapshot(): ProviderHealthEntry[] {
    return Array.from(this.entries.values())
      .map((entry) => ({ ...entry }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  reset(): void {
    this.entries.clear();
  }
}

export const providerHealthMonitor = new ProviderHealthMonitor();

/**
 * Ranks fallback candidates intelligently according to task complexity, tool-calling compatibility,
 * context window, latency, and recent per-credential health cooldowns — while always keeping the user's
 * explicit primary selection first unless it is currently in active cooldown.
 */
export function buildOrderedFallbackChain(params: {
  primary: RouteCandidate;
  candidates: RouteCandidate[];
  complexity: TaskComplexity;
  requireTools: boolean;
  health?: ProviderHealthMonitor;
  nowMs?: number;
}): RouteCandidate[] {
  const { primary, candidates, complexity, requireTools, health = providerHealthMonitor, nowMs = Date.now() } = params;

  const dedup = new Map<string, RouteCandidate>();
  const addCandidate = (c: RouteCandidate) => {
    const id = `${c.adapterConfig.providerKeyId}::${c.modelId}`;
    if (!dedup.has(id)) dedup.set(id, c);
  };

  addCandidate(primary);
  for (const c of candidates) {
    if (c.adapterConfig.apiKey && c.modelId.trim()) {
      addCandidate(c);
    }
  }

  const all = Array.from(dedup.values());
  const primaryId = `${primary.adapterConfig.providerKeyId}::${primary.modelId}`;

  const scoreCandidate = (c: RouteCandidate): number => {
    const cid = `${c.adapterConfig.providerKeyId}::${c.modelId}`;
    let score = 0;

    // Respect user's explicitly selected primary model first
    if (cid === primaryId) score += 1000;
    if (typeof c.priority === 'number') score += c.priority;

    // Tool-calling requirement for build tasks
    if (requireTools) {
      if (c.supportsTools === true) score += 120;
      else if (c.supportsTools === false) score -= 250;
    }

    // Prefer larger context windows for medium/high complexity full-stack tasks
    if (typeof c.maxContext === 'number') {
      if (complexity === 'high' && c.maxContext >= 128_000) score += 80;
      else if (complexity === 'medium' && c.maxContext >= 64_000) score += 40;
    }

    // Penalize routes currently in active cooldown or with recent consecutive failures for THIS credential
    const fp = makeCredentialFingerprint(c.adapterConfig);
    const entry = health.getEntry(c.adapterConfig.provider, c.modelId, fp)
      ?? health.getEntry(c.adapterConfig.provider, c.modelId);
    if (entry) {
      if (entry.cooldownUntilMs > nowMs) {
        score -= cid === primaryId ? 1500 : 800;
      }
      score -= Math.min(200, entry.consecutiveFailures * 40);
      if (entry.avgLatencyMs > 0 && entry.avgLatencyMs < 4000) {
        score += 20;
      }
    }

    return score;
  };

  return all.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

/**
 * Selects the next eligible route after an error, ensuring:
 * - No infinite retry cycles (never revisits an already attempted route)
 * - Invalid credentials (AUTH_INVALID) or provider outages skip the broken providerKeyId completely
 * - Context overflow prefers candidates with a larger context window if available
 */
export function selectNextFallbackRoute(params: {
  chain: RouteCandidate[];
  attemptedIds: Set<string>;
  failedCandidate: RouteCandidate;
  errorCode: ProviderErrorCode;
  health?: ProviderHealthMonitor;
  nowMs?: number;
}): { next: RouteCandidate | null; decision: FallbackDecision } {
  const { chain, attemptedIds, failedCandidate, errorCode, health = providerHealthMonitor, nowMs = Date.now() } = params;
  const decision = classifyFallbackEligibility(errorCode);
  if (!decision.shouldFallback) {
    return { next: null, decision };
  }

  const eligible = chain.filter((c) => {
    const id = `${c.adapterConfig.providerKeyId}::${c.modelId}`;
    if (attemptedIds.has(id)) return false;
    if (decision.skipSameProviderKey && c.adapterConfig.providerKeyId === failedCandidate.adapterConfig.providerKeyId) {
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    return { next: null, decision };
  }

  let pool = eligible;
  const failedMaxContext = failedCandidate.maxContext;
  if (errorCode === 'CONTEXT_TOO_LONG' && typeof failedMaxContext === 'number') {
    const largerOrUnknown = eligible.filter(
      (c) => typeof c.maxContext !== 'number' || c.maxContext > failedMaxContext
    );
    if (largerOrUnknown.length > 0) {
      pool = largerOrUnknown;
    }
  }

  // Prefer candidates not currently in cooldown for their own credential fingerprint
  const healthy = pool.filter((c) => {
    const fp = makeCredentialFingerprint(c.adapterConfig);
    return !health.isInCooldown(c.adapterConfig.provider, c.modelId, nowMs, fp);
  });
  return { next: healthy[0] ?? pool[0], decision };
}
