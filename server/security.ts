import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ApkConfig } from '../src/types';

export const MIN_MASTER_KEY_LENGTH = 32;

export const MASTER_KEY_MISSING_ERROR =
  'ENCRYPTION_SECRET atau CARMEN_MASTER_KEY belum diatur. Atur minimal 32 karakter di Secrets sebelum menyimpan key.';

export const MASTER_KEY_TOO_SHORT_ERROR =
  'ENCRYPTION_SECRET atau CARMEN_MASTER_KEY terlalu pendek (minimal 32 karakter).';

const VAULT_V2_PREFIX = 'v2:';
const VAULT_SCRYPT_SALT = 'carmen-secret-vault-scrypt-v2';
let cachedScryptKey: { raw: string; key: Buffer } | null = null;

function readEncryptionSecretRaw(): string | undefined {
  const enc = process.env.ENCRYPTION_SECRET?.trim();
  if (enc) return enc;
  const master = process.env.CARMEN_MASTER_KEY?.trim();
  return master || undefined;
}

export function getMasterKeyConfigurationError(): string | null {
  const raw = readEncryptionSecretRaw();
  if (!raw) return MASTER_KEY_MISSING_ERROR;
  if (raw.length < MIN_MASTER_KEY_LENGTH) return MASTER_KEY_TOO_SHORT_ERROR;
  return null;
}

export function isMasterKeyConfigured(): boolean {
  return getMasterKeyConfigurationError() === null;
}

function getValidatedSecretRaw(): string {
  const raw = readEncryptionSecretRaw();
  if (!raw) {
    throw new Error(MASTER_KEY_MISSING_ERROR);
  }
  if (raw.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(MASTER_KEY_TOO_SHORT_ERROR);
  }
  return raw;
}

function getMasterKeyBuffer(): Buffer {
  const raw = getValidatedSecretRaw();
  if (cachedScryptKey && cachedScryptKey.raw === raw) {
    return cachedScryptKey.key;
  }
  const derived = crypto.scryptSync(raw, VAULT_SCRYPT_SALT, 32, { N: 16384, r: 8, p: 1 });
  cachedScryptKey = { raw, key: derived };
  return derived;
}

function getLegacySha256KeyBuffer(): Buffer {
  const raw = getValidatedSecretRaw();
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function decryptWithKey(raw: Buffer, key: Buffer): string {
  if (raw.length < 28) {
    throw new Error('Encrypted payload is corrupted');
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Encrypts sensitive strings (API keys, env secrets, custom headers) with AES-256-GCM.
 * Stored format: "v2:" + base64(iv[12] + authTag[16] + ciphertext) using scrypt-derived key.
 */
export function encryptSecret(plaintext: string): string {
  const key = getMasterKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VAULT_V2_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  const v2Key = getMasterKeyBuffer();
  if (payload.startsWith(VAULT_V2_PREFIX)) {
    const raw = Buffer.from(payload.slice(VAULT_V2_PREFIX.length), 'base64');
    return decryptWithKey(raw, v2Key);
  }
  const raw = Buffer.from(payload, 'base64');
  try {
    return decryptWithKey(raw, v2Key);
  } catch {
    // Backwards-compatible fallback for legacy unprefixed SHA-256 AES-256-GCM ciphertexts
    return decryptWithKey(raw, getLegacySha256KeyBuffer());
  }
}

export function maskSecretLast4(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 4) return '****';
  return trimmed.slice(-4);
}

/**
 * Password hashing using Node crypto.scryptSync with random salt
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, hashHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Checks whether an IPv4 or IPv6 address belongs to private, loopback, link-local,
 * CGNAT, multicast, reserved, or IPv4-mapped private ranges.
 */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const ipType = net.isIP(ip);
  if (ipType === 4) {
    const octets = ip.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b, c] = octets;
    return (
      a === 0 || // 0.0.0.0/8
      a === 10 || // 10.0.0.0/8
      a === 127 || // 127.0.0.0/8 loopback
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
      (a === 169 && b === 254) || // 169.254.0.0/16 link-local & cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
      (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
      (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
      (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
      a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
    );
  }

  if (ipType === 6) {
    if (ip === '::' || ip === '::1') return true;
    // Strip IPv6 zone index if present (e.g. fe80::1%eth0)
    const cleanV6 = ip.split('%')[0];

    // Normalize full-expanded IPv4-mapped IPv6 e.g. 0:0:0:0:0:ffff:7f00:1 or ::ffff:127.0.0.1
    const mappedMatch = cleanV6.match(/^(?:::|(?:0{1,4}:){5})ffff:(.+)$/i);
    if (mappedMatch) {
      const rest = mappedMatch[1];
      if (net.isIP(rest) === 4) {
        return isPrivateOrReservedIp(rest);
      }
      const hexParts = rest.split(':');
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          return isPrivateOrReservedIp(v4);
        }
      }
      return true;
    }

    // IPv4-compatible IPv6 ::a.b.c.d
    if (cleanV6.startsWith('::') && cleanV6.includes('.')) {
      const rest = cleanV6.slice(2);
      if (net.isIP(rest) === 4) return isPrivateOrReservedIp(rest);
    }

    // NAT64 (64:ff9b::/96, 64:ff9b:1::/48), 6to4 (2002::/16), Teredo (2001:0::/32)
    if (
      cleanV6.startsWith('64:ff9b:') ||
      cleanV6.startsWith('0064:ff9b:') ||
      cleanV6.startsWith('2002:') ||
      cleanV6.startsWith('2001:0:') ||
      cleanV6.startsWith('2001:0000:') ||
      cleanV6.startsWith('2001::')
    ) {
      return true;
    }

    // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8, discard 100::/64, doc 2001:db8::/32
    if (
      cleanV6.startsWith('fc') ||
      cleanV6.startsWith('fd') ||
      cleanV6.startsWith('fe8') ||
      cleanV6.startsWith('fe9') ||
      cleanV6.startsWith('fea') ||
      cleanV6.startsWith('feb') ||
      cleanV6.startsWith('ff') ||
      cleanV6.startsWith('100::') ||
      cleanV6.startsWith('2001:db8:') ||
      cleanV6.startsWith('2001:0db8:')
    ) {
      return true;
    }

    // Check leading zeros representations of :: and ::1 (e.g. 0:0:0:0:0:0:0:1)
    const stripped = cleanV6.replace(/0/g, '').replace(/:/g, '');
    if (stripped === '' || stripped === '1') return true;
    return false;
  }

  return true;
}

/**
 * SSRF & endpoint validation for Custom Provider Base URL (PRD Section 5.6).
 * Only permits HTTPS URLs on default port 443 pointing to public hostnames (rejects private/loopback/link-local IPs
 * and web UI paths like /account, /dashboard, /login).
 */
export function validateCustomBaseUrl(rawUrl: string): { valid: boolean; normalized?: string; error?: string } {
  const input = rawUrl.trim();
  if (!input) {
    return { valid: false, error: 'Base URL wajib diisi dari dokumentasi resmi provider.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { valid: false, error: 'Format Base URL tidak valid. Gunakan alamat HTTPS lengkap.' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Hanya protokol HTTPS yang diizinkan untuk Custom Provider.' };
  }

  if (parsed.port && parsed.port !== '443') {
    return { valid: false, error: 'Hanya port standar HTTPS (443) yang diizinkan untuk Custom Provider.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Base URL tidak boleh memuat kredensial di dalam URL.' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host ||
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === 'ip6-localhost' ||
    host === 'ip6-loopback' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost') ||
    host.endsWith('.arpa') ||
    host === 'metadata.google.internal' ||
    host === 'metadata.goog'
  ) {
    return { valid: false, error: 'Alamat jaringan lokal atau internal ditolak (perlindungan SSRF).' };
  }

  const ipType = net.isIP(host);
  if (ipType === 4 || ipType === 6) {
    if (isPrivateOrReservedIp(host)) {
      return { valid: false, error: 'Alamat IP privat, internal, atau loopback ditolak (perlindungan SSRF).' };
    }
  } else if (!host.includes('.')) {
    return { valid: false, error: 'Hostname internal tanpa domain publik ditolak (perlindungan SSRF).' };
  }

  const lowerPath = parsed.pathname.toLowerCase();
  if (/(?:^|\/)(?:account|dashboard|login)(?:\/|$)/i.test(lowerPath)) {
    return {
      valid: false,
      error:
        'Alamat ini mengarah ke halaman web (/account, /dashboard, atau /login), bukan API. Periksa Base URL di dokumentasi resmi penyedia.',
    };
  }

  const normalized = parsed.toString().replace(/\/+$/, '');
  return { valid: true, normalized };
}

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultDnsLookup: DnsLookupFn = async (hostname: string) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
};

export interface ResolvedOutboundTarget {
  valid: boolean;
  normalized?: string;
  resolvedAddress?: string;
  resolvedFamily?: 4 | 6;
  allAddresses?: Array<{ address: string; family: number }>;
  error?: string;
}

/**
 * Resolves DNS for an outbound URL ONCE and blocks any hostname that resolves to private/internal/reserved IPs.
 * Returns the validated public IP address + family so the transport can pin the connection directly to that IP
 * without performing a second DNS lookup (eliminates DNS rebinding TOCTOU).
 */
export async function resolveAndValidateOutboundUrl(
  rawUrl: string,
  lookupFn: DnsLookupFn = defaultDnsLookup
): Promise<ResolvedOutboundTarget> {
  const staticCheck = validateCustomBaseUrl(rawUrl);
  if (!staticCheck.valid || !staticCheck.normalized) {
    return staticCheck;
  }

  const parsed = new URL(staticCheck.normalized);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  const ipFamily = net.isIP(host);
  if (ipFamily === 4 || ipFamily === 6) {
    if (isPrivateOrReservedIp(host)) {
      return { valid: false, error: 'Alamat IP tujuan termasuk rentang privat/internal (perlindungan SSRF).' };
    }
    return {
      ...staticCheck,
      resolvedAddress: host,
      resolvedFamily: ipFamily,
      allAddresses: [{ address: host, family: ipFamily }],
    };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookupFn(host);
  } catch {
    return { valid: false, error: `Host "${host}" tidak dapat diresolusi melalui DNS.` };
  }

  if (!records || records.length === 0) {
    return { valid: false, error: `Host "${host}" tidak memiliki alamat IP publik.` };
  }

  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      return {
        valid: false,
        error: `Host "${host}" mengarah ke alamat jaringan privat/internal dan diblokir oleh perlindungan SSRF.`,
      };
    }
  }

  // Prefer validated IPv4 first if available for widest upstream compatibility, else validated IPv6
  const chosen = records.find((r) => net.isIP(r.address) === 4) || records[0];
  const chosenFamily = (net.isIP(chosen.address) === 6 ? 6 : 4) as 4 | 6;

  return {
    ...staticCheck,
    resolvedAddress: chosen.address,
    resolvedFamily: chosenFamily,
    allAddresses: records,
  };
}

export interface PinnedRequestContext {
  url: string;
  pinnedAddress: string;
  pinnedFamily: 4 | 6;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  signal: AbortSignal;
}

export type PinnedTransportFn = (ctx: PinnedRequestContext) => Promise<Response>;

const SENSITIVE_REDIRECT_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-goog-api-key',
]);

function normalizeHeadersToRecord(input?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  const h = new Headers(input);
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function normalizeBodyToBuffer(body?: BodyInit | null): Promise<Buffer | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  // Fallback for Blob / ReadableStream
  const ab = await new Response(body).arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Executes an HTTP/HTTPS request using Node's native transport with a pinned DNS lookup callback.
 * The underlying TCP socket connects ONLY to `ctx.pinnedAddress` (never re-resolving DNS),
 * while TLS SNI and certificate hostname verification still validate against the original URL hostname.
 */
async function defaultPinnedTransport(ctx: PinnedRequestContext): Promise<Response> {
  const parsed = new URL(ctx.url);
  const isHttps = parsed.protocol === 'https:';
  const transportMod = isHttps ? https : http;

  const pinnedLookup = (
    _hostname: string,
    optsOrCb: unknown,
    maybeCb?: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void
  ) => {
    const cb = typeof optsOrCb === 'function'
      ? (optsOrCb as (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void)
      : maybeCb!;
    const opts = typeof optsOrCb === 'object' && optsOrCb !== null ? (optsOrCb as { all?: boolean }) : {};
    if (opts.all) {
      cb(null, [{ address: ctx.pinnedAddress, family: ctx.pinnedFamily }]);
    } else {
      cb(null, ctx.pinnedAddress, ctx.pinnedFamily);
    }
  };

  return await new Promise<Response>((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(ctx.signal.reason || new Error('Permintaan dibatalkan.'));
      return;
    }

    const reqHeaders: Record<string, string> = { ...ctx.headers };
    if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'host')) {
      reqHeaders.host = parsed.host;
    }
    if (ctx.body && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      reqHeaders['content-length'] = String(ctx.body.byteLength);
    }

    const reqOptions: https.RequestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: ctx.method,
      headers: reqHeaders,
      lookup: pinnedLookup as unknown as https.RequestOptions['lookup'],
      ...(isHttps
        ? {
            servername: parsed.hostname.replace(/^\[|\]$/g, ''),
            rejectUnauthorized: true,
          }
        : {}),
    };

    const req = transportMod.request(reqOptions, (incoming) => {
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(incoming.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) resHeaders.append(k, item);
        } else {
          resHeaders.set(k, v);
        }
      }

      const status = incoming.statusCode || 502;
      const statusText = incoming.statusMessage || '';
      const hasNullBody = status === 204 || status === 205 || status === 304 || ctx.method === 'HEAD';
      const webBody = hasNullBody ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);

      resolve(
        new Response(webBody, {
          status,
          statusText,
          headers: resHeaders,
        })
      );
    });

    const onAbort = () => {
      req.destroy(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('Permintaan dibatalkan atau melebihi batas waktu.'));
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    req.on('error', (err) => {
      ctx.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.on('close', () => {
      ctx.signal.removeEventListener('abort', onAbort);
    });

    if (ctx.body) {
      req.write(ctx.body);
    }
    req.end();
  });
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRedirects?: number;
  enforceCustomUrlPolicy?: boolean;
  lookupFn?: DnsLookupFn;
  transportFn?: PinnedTransportFn;
}

function wrapBodyWithIdleTimeout(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
  userSignal?: AbortSignal
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  let finished = false;

  const cleanup = () => {
    finished = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (userSignal && onAbort) {
      userSignal.removeEventListener('abort', onAbort);
      onAbort = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (userSignal) {
        if (userSignal.aborted) {
          cleanup();
          const abortErr =
            userSignal.reason instanceof Error ? userSignal.reason : new Error('Permintaan dibatalkan.');
          reader.cancel(abortErr).catch(() => {});
          controller.error(abortErr);
          return;
        }
        onAbort = () => {
          if (finished) return;
          cleanup();
          const abortErr =
            userSignal.reason instanceof Error ? userSignal.reason : new Error('Permintaan dibatalkan.');
          reader.cancel(abortErr).catch(() => {});
          controller.error(abortErr);
        };
        userSignal.addEventListener('abort', onAbort, { once: true });
      }
    },
    async pull(controller) {
      if (finished) return;
      if (idleTimer) clearTimeout(idleTimer);
      const idleErr = new Error(
        `Koneksi stream ke provider terputus karena tidak ada data selama ${Math.max(1, Math.round(idleTimeoutMs / 1000))} detik.`
      );
      idleTimer = setTimeout(() => {
        if (finished) return;
        cleanup();
        reader.cancel(idleErr).catch(() => {});
        try {
          controller.error(idleErr);
        } catch {
          // Ignore if already closed/errored
        }
      }, idleTimeoutMs);

      try {
        const { value, done } = await reader.read();
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (finished) return;
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        cleanup();
        try {
          controller.error(err);
        } catch {
          // Ignore if already errored
        }
      }
    },
    async cancel(reason) {
      cleanup();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Performs an outbound HTTP/HTTPS request with zero-TOCTOU DNS pinning, full SSRF validation
 * on initial target and every redirect hop, cross-origin credential header stripping, and enforced timeout.
 * When `streamIdleTimeoutMs` is specified, `timeoutMs` governs connecting/receiving headers while
 * `streamIdleTimeoutMs` enforces per-chunk inactivity timeout across long-lived SSE streams.
 */
export async function safeOutboundFetch(
  url: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {}
): Promise<Response> {
  const {
    timeoutMs = 30_000,
    streamIdleTimeoutMs,
    maxRedirects = 3,
    lookupFn = defaultDnsLookup,
    transportFn = defaultPinnedTransport,
  } = options;

  let currentUrl = url;
  let currentMethod = (init.method || 'GET').toUpperCase();
  let currentHeaders = normalizeHeadersToRecord(init.headers);
  let currentBody = await normalizeBodyToBuffer(init.body);

  const connectAbortController = streamIdleTimeoutMs ? new AbortController() : null;
  const connectTimer = connectAbortController
    ? setTimeout(() => {
        connectAbortController.abort(new Error('Batas waktu koneksi awal ke endpoint tercapai.'));
      }, timeoutMs)
    : null;
  const timeoutSignal = connectAbortController ? connectAbortController.signal : AbortSignal.timeout(timeoutMs);
  const combinedSignal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      // Always validate URL + resolve DNS ONCE + pin IP on EVERY hop (initial and redirects)
      const check = await resolveAndValidateOutboundUrl(currentUrl, lookupFn);
      if (!check.valid || !check.resolvedAddress || !check.resolvedFamily) {
        throw new Error(check.error || 'URL tujuan ditolak oleh kebijakan SSRF.');
      }

      const res = await transportFn({
        url: check.normalized || currentUrl,
        pinnedAddress: check.resolvedAddress,
        pinnedFamily: check.resolvedFamily,
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        signal: combinedSignal,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          if (connectTimer) clearTimeout(connectTimer);
          return res;
        }
        // Drain/cancel redirect body so underlying socket closes cleanly
        try {
          await res.body?.cancel();
        } catch {
          // Ignore
        }
        if (hop === maxRedirects) {
          throw new Error('Terlalu banyak pengalihan (redirect) dari endpoint tujuan.');
        }

        const prevOrigin = new URL(currentUrl).origin;
        const nextUrlObj = new URL(location, currentUrl);
        currentUrl = nextUrlObj.toString();

        // Strip auth headers when redirecting across origins
        if (nextUrlObj.origin !== prevOrigin) {
          const cleaned: Record<string, string> = {};
          for (const [k, v] of Object.entries(currentHeaders)) {
            if (!SENSITIVE_REDIRECT_HEADERS.has(k.toLowerCase())) {
              cleaned[k] = v;
            }
          }
          currentHeaders = cleaned;
        }

        // RFC 9110: 303 See Other (and 301/302 on POST) converts to GET without body
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody = null;
        }
        continue;
      }

      if (connectTimer) clearTimeout(connectTimer);
      if (streamIdleTimeoutMs && res.body) {
        const wrappedBody = wrapBodyWithIdleTimeout(res.body, streamIdleTimeoutMs, init.signal ?? undefined);
        return new Response(wrappedBody, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
      return res;
    }
  } catch (err) {
    if (connectTimer) clearTimeout(connectTimer);
    throw err;
  }

  if (connectTimer) clearTimeout(connectTimer);
  throw new Error('Gagal menyelesaikan permintaan keluar.');
}

/**
 * Reads a fetch Response body up to maxBytes to prevent memory exhaustion from oversized upstream payloads.
 */
export async function readResponseTextWithLimit(res: Response, maxBytes = 2 * 1024 * 1024): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('Ukuran respons dari provider melebihi batas aman.');
    }
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Ukuran respons dari provider melebihi batas aman.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Scrubs known secrets and common API key token prefixes from logs or error messages
 * so keys never leak into logs, responses, or exported files (PRD 5.5 & 8.9).
 */
export function scrubSecrets(text: string, activeSecrets: string[] = []): string {
  let clean = text;
  for (const secret of activeSecrets) {
    if (secret && secret.length >= 8) {
      clean = clean.split(secret).join('[REDACTED_KEY]');
    }
  }
  clean = clean
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\bgsk_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\bcoa_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1[REDACTED_KEY]');
  return clean;
}

const ALLOWED_SANDBOX_BINARIES = new Set([
  'npm',
  'npx',
  'bun',
  'node',
  'ls',
  'pwd',
  'sqlite',
  'db:sync',
  'git',
  'tsc',
]);

const COMMAND_DENYLIST: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+\//i,
  /\bsudo\b/i,
  /\bsu\s+-/i,
  /\bchmod\s+777\b/i,
  /\bchown\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /\b(xmrig|minerd|cpuminer|cgminer|ethminer)\b/i,
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/i,
  /\/etc\/|\/proc\/|\/sys\/|\/app\/|\/var\/run\/|docker\.sock|carmen\.db/i,
  /(?:^|[\s/'"])\.env(?!\.example\b)(?:\.[a-z0-9_-]+)?(?=$|[\s'"])/i,
  /\.\.\//,
  /[;`]|&&|\|\||\$\(/,
];

/**
 * Sandbox command validator (PRD 8.9): enforces binary allowlist, filters destructive commands,
 * shell injection operators, and attempts to escape project directory.
 */
export function validateSandboxCommand(cmd: string): { allowed: boolean; reason?: string } {
  const trimmed = cmd.trim();
  if (!trimmed) return { allowed: false, reason: 'Perintah kosong.' };
  if (trimmed.length > 500) return { allowed: false, reason: 'Perintah melebihi batas panjang.' };
  if (/[\r\n\0]/.test(trimmed)) {
    return { allowed: false, reason: 'Karakter kontrol atau baris baru tidak diizinkan pada perintah.' };
  }
  for (const pattern of COMMAND_DENYLIST) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: 'Perintah diblokir oleh kebijakan keamanan sandbox CARMEN.',
      };
    }
  }
  const firstToken = trimmed.split(/\s+/)[0] || '';
  if (!ALLOWED_SANDBOX_BINARIES.has(firstToken)) {
    return {
      allowed: false,
      reason: `Perintah "${firstToken}" tidak termasuk dalam daftar binari sandbox yang diizinkan.`,
    };
  }
  return { allowed: true };
}

export function normalizeProjectPath(filePath: string): string | null {
  const cleaned = filePath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!cleaned || cleaned.includes('\0') || cleaned.startsWith('~')) {
    return null;
  }
  const segments = cleaned.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) {
    return null;
  }
  return segments.join('/');
}

/**
 * Checks whether a path references host-sensitive secrets, container sockets, system virtual filesystems,
 * or core platform database files that tenants must never access.
 */
export function isSensitiveHostResourcePath(candidatePath: string): boolean {
  const raw = String(candidatePath || '').trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0')) return true;
  const lower = raw.toLowerCase();
  const base = path.posix.basename(lower);

  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) {
    return true;
  }
  if (
    lower.includes('docker.sock') ||
    lower.startsWith('/var/run') ||
    lower.includes('/var/run/') ||
    lower.startsWith('/proc/') ||
    lower === '/proc' ||
    lower.startsWith('/sys/') ||
    lower === '/sys' ||
    lower.startsWith('/etc/') ||
    lower === '/etc' ||
    lower.includes('/etc/shadow') ||
    lower.includes('/etc/passwd') ||
    lower.includes('carmen.db') ||
    lower.startsWith('/app/data') ||
    lower.includes('/app/data/')
  ) {
    return true;
  }
  const configuredDb = (process.env.CARMEN_DB_PATH || '').trim().replace(/\\/g, '/').toLowerCase();
  if (configuredDb && (lower === configuredDb || lower.startsWith(`${path.posix.dirname(configuredDb)}/`))) {
    return true;
  }
  return false;
}

/**
 * Enforces strict multi-tenant workspace path isolation:
 * - Rejects null bytes, host sensitive paths (.env, docker.sock, /etc, /proc, /sys, carmen.db)
 * - Resolves symlinks along existing prefixes to prevent symlink escapes into host or cross-tenant dirs
 * - Ensures resolved target stays strictly inside `workspaceDir` (and never enters sibling tenant dirs)
 */
export function validateTenantWorkspacePath(
  workspaceDir: string,
  candidatePath: string,
  sandboxesRoot?: string
): { valid: boolean; resolvedPath?: string; reason?: string } {
  if (!candidatePath || typeof candidatePath !== 'string' || candidatePath.includes('\0')) {
    return { valid: false, reason: 'Path tidak valid.' };
  }
  if (isSensitiveHostResourcePath(candidatePath)) {
    return {
      valid: false,
      reason: 'Akses ke file sensitif host (.env, docker.sock, /etc, /proc, /sys, carmen.db) ditolak.',
    };
  }

  let realWorkspace: string;
  try {
    realWorkspace = fs.realpathSync(workspaceDir);
  } catch {
    realWorkspace = path.resolve(workspaceDir);
  }

  const rawTrimmed = candidatePath.trim();
  const normalizedTarget = path.isAbsolute(rawTrimmed)
    ? path.resolve(rawTrimmed)
    : path.resolve(realWorkspace, rawTrimmed);

  if (normalizedTarget !== realWorkspace && !normalizedTarget.startsWith(realWorkspace + path.sep)) {
    return {
      valid: false,
      reason: 'Path keluar dari direktori workspace tenant dan ditolak.',
    };
  }

  if (sandboxesRoot) {
    let realSandboxesRoot: string;
    try {
      realSandboxesRoot = fs.realpathSync(sandboxesRoot);
    } catch {
      realSandboxesRoot = path.resolve(sandboxesRoot);
    }
    const workspaceInRoot =
      realWorkspace === realSandboxesRoot || realWorkspace.startsWith(realSandboxesRoot + path.sep);
    if (
      workspaceInRoot &&
      normalizedTarget !== realWorkspace &&
      !normalizedTarget.startsWith(realWorkspace + path.sep)
    ) {
      return {
        valid: false,
        reason: 'Akses lintas direktori workspace tenant lain ditolak.',
      };
    }
  }

  // Walk existing path segments from workspaceDir downward to block symlinks pointing outside workspaceDir
  const rel = path.relative(realWorkspace, normalizedTarget);
  if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
    return { valid: false, reason: 'Path traversal lintas direktori ditolak.' };
  }

  const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
  let probe = realWorkspace;
  for (const part of parts) {
    probe = path.join(probe, part);
    try {
      const lstat = fs.lstatSync(probe);
      if (lstat.isSymbolicLink()) {
        const realLink = fs.realpathSync(probe);
        if (realLink !== realWorkspace && !realLink.startsWith(realWorkspace + path.sep)) {
          return {
            valid: false,
            reason: 'Symlink mengarah ke luar workspace tenant dan diblokir.',
          };
        }
        probe = realLink;
      }
    } catch {
      // Segment does not yet exist on disk; lexical containment above guarantees it stays inside workspace
      break;
    }
  }

  return { valid: true, resolvedPath: normalizedTarget };
}

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * XML escaping for AndroidManifest.xml and other XML templates to prevent XML injection.
 */
export function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Strict validation for Android APK build configuration.
 */
export function validateApkConfig(config: Partial<ApkConfig> | undefined): {
  valid: boolean;
  sanitized?: ApkConfig;
  error?: string;
} {
  if (!config) {
    return { valid: false, error: 'Konfigurasi build APK wajib diisi.' };
  }
  const appName = String(config.appName ?? '').trim();
  if (!appName || appName.length > 80 || /[\r\n\0]/.test(appName)) {
    return { valid: false, error: 'Nama aplikasi harus 1–80 karakter tanpa karakter kontrol.' };
  }
  const packageId = String(config.packageId ?? '').trim();
  if (
    !packageId ||
    packageId.length > 128 ||
    !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(packageId)
  ) {
    return {
      valid: false,
      error: `Package ID "${packageId}" tidak valid. Gunakan format reverse-domain seperti id.carmen.aplikasi.`,
    };
  }
  const versionName = String(config.versionName ?? '1.0.0').trim();
  if (!/^[0-9]+(\.[0-9]+){0,2}(-[a-zA-Z0-9._-]+)?$/.test(versionName) || versionName.length > 32) {
    return { valid: false, error: 'Version Name tidak valid. Gunakan format semver seperti 1.0.0.' };
  }
  const versionCode = Number(config.versionCode ?? 1);
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
    return { valid: false, error: 'Version Code harus berupa bilangan bulat positif (1–2100000000).' };
  }
  const buildType = config.buildType === 'release' ? 'release' : 'debug';
  const rawColor = String(config.iconColor ?? '#C8324B').trim();
  const iconColor = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : '#C8324B';

  return {
    valid: true,
    sanitized: {
      appName,
      packageId,
      versionName,
      versionCode,
      iconColor,
      buildType,
      hasKeystore: Boolean(config.hasKeystore),
    },
  };
}

/**
 * Validates project schema.sql before execution on the per-project SQLite database.
 * Blocks dangerous SQLite directives (ATTACH, DETACH, LOAD_EXTENSION, PRAGMA) that could
 * escape the project DB and read/corrupt host databases.
 */
export function validateSqlSchemaSafe(sql: string): { safe: boolean; reason?: string } {
  // Strip SQL comments before checking keywords
  const withoutComments = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Strip single-quoted string literals so benign text values don't trigger false positives
  const withoutStrings = withoutComments.replace(/'(?:''|[^'])*'/g, "''");

  if (/\bATTACH\b/i.test(withoutStrings) || /\bDETACH\b/i.test(withoutStrings)) {
    return { safe: false, reason: 'Perintah SQL ATTACH/DETACH diblokir demi isolasi database proyek.' };
  }
  if (/\bload_extension\s*\(/i.test(withoutStrings)) {
    return { safe: false, reason: 'Fungsi SQL load_extension diblokir oleh kebijakan keamanan.' };
  }
  if (/\bPRAGMA\b/i.test(withoutStrings)) {
    return { safe: false, reason: 'Perintah PRAGMA tidak diizinkan pada schema.sql proyek.' };
  }
  if (/\bVACUUM\s+INTO\b/i.test(withoutStrings)) {
    return { safe: false, reason: 'Perintah VACUUM INTO diblokir oleh kebijakan keamanan.' };
  }
  return { safe: true };
}

/**
 * Sanitizes filenames used in Content-Disposition headers to prevent header injection.
 */
export function sanitizeDownloadFilename(name: string, fallback = 'download.zip'): string {
  const cleaned = name.replace(/["\\\r\n\0/]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 && cleaned.length <= 120 ? cleaned : fallback;
}

// Ephemeral fallback signing key for short-lived preview tokens when CARMEN_MASTER_KEY is unset
const EPHEMERAL_PREVIEW_SECRET = crypto.randomBytes(32).toString('hex');

function getPreviewSigningKey(): Buffer {
  const base =
    readEncryptionSecretRaw() ||
    process.env.SESSION_SECRET?.trim() ||
    EPHEMERAL_PREVIEW_SECRET;
  return crypto.createHash('sha256').update(`carmen-preview-v1:${base}`, 'utf8').digest();
}

/**
 * Mints a short-lived HMAC-SHA256 preview access token scoped strictly to (projectId, userId, exp).
 * Used to authorize sandboxed opaque-origin iframe preview loads and ./api/:table calls
 * without requiring allow-same-origin or exposing main app cookies.
 */
export function createPreviewToken(projectId: string, userId: string, ttlSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ pid: projectId, uid: userId, exp }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getPreviewSigningKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyPreviewToken(
  token: string | undefined | null,
  expectedProjectId: string
): { valid: boolean; userId?: string; projectId?: string } {
  if (!token || typeof token !== 'string') return { valid: false };
  const parts = token.trim().split('.');
  if (parts.length !== 2) return { valid: false };
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return { valid: false };

  const expectedSig = crypto.createHmac('sha256', getPreviewSigningKey()).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sigB64, 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false };
  }

  try {
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      pid?: string;
      uid?: string;
      exp?: number;
    };
    if (!decoded.pid || !decoded.uid || typeof decoded.exp !== 'number') return { valid: false };
    if (decoded.pid !== expectedProjectId) return { valid: false };
    if (decoded.exp < Math.floor(Date.now() / 1000)) return { valid: false };
    return { valid: true, userId: decoded.uid, projectId: decoded.pid };
  } catch {
    return { valid: false };
  }
}
