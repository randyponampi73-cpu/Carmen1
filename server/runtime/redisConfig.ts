export interface RedisValidationResult {
  configured: boolean;
  required: boolean;
  url?: string;
  tls: boolean;
  error?: string;
}

/**
 * Validates REDIS_URL protocol, host, port, and optional db path index cleanly without leaking credentials.
 * Shared across Redis rate limiting and shared-key daily quota enforcement.
 */
export function validateRedisConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  options: { requireRedis?: boolean } = {}
): RedisValidationResult {
  const raw = (env.REDIS_URL || '').trim();
  const required = Boolean(options.requireRedis);
  if (!raw) {
    if (required) {
      return {
        configured: false,
        required,
        tls: false,
        error: 'REDIS_URL wajib dikonfigurasi saat Redis diwajibkan.',
      };
    }
    return { configured: false, required: false, tls: false };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      configured: false,
      required,
      tls: false,
      error: 'Format REDIS_URL tidak valid. Gunakan skema redis:// atau rediss:// dengan hostname yang benar.',
    };
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    return {
      configured: false,
      required,
      tls: false,
      error: `Protokol REDIS_URL tidak didukung ("${parsed.protocol}"). Gunakan redis:// atau rediss://.`,
    };
  }
  if (!parsed.hostname) {
    return {
      configured: false,
      required,
      tls: parsed.protocol === 'rediss:',
      error: 'REDIS_URL harus menyertakan hostname Redis yang valid.',
    };
  }
  if (parsed.port) {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return {
        configured: false,
        required,
        tls: parsed.protocol === 'rediss:',
        error: `Port REDIS_URL tidak valid (${parsed.port}).`,
      };
    }
  }
  const cleanDbPath = parsed.pathname.replace(/^\/+/, '');
  if (cleanDbPath && !/^\d+$/.test(cleanDbPath)) {
    return {
      configured: false,
      required,
      tls: parsed.protocol === 'rediss:',
      error: 'Indeks database REDIS_URL pada path URL harus berupa angka (misal /0).',
    };
  }

  return {
    configured: true,
    required,
    url: raw,
    tls: parsed.protocol === 'rediss:',
  };
}

export function isRedisConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return validateRedisConfiguration(env).configured;
}
