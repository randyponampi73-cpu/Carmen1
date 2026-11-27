export type PreviewLifecycleStage =
  | 'empty'
  | 'installing'
  | 'loading_html'
  | 'mounting_iframe'
  | 'ready'
  | 'error';

export type PreviewResponseClassification =
  | {
      kind: 'installing';
      status: number;
      packageManager?: 'npm' | 'bun';
      missingPackages?: string[];
    }
  | {
      kind: 'auth_failed';
      status: number;
      code: string;
      message: string;
    }
  | {
      kind: 'proxy_redirect';
      status: number;
      message: string;
    }
  | {
      kind: 'non_html_error';
      status: number;
      message: string;
    }
  | {
      kind: 'html_error';
      status: number;
      html: string;
      fallbackMessage: string;
    }
  | {
      kind: 'html_ok';
      status: number;
      html: string;
    };

export interface PreviewDiagnosticEvent {
  projectId: string;
  previewRequestId: string;
  stage: PreviewLifecycleStage;
  event: string;
  status?: number;
  durationMs?: number;
  lifecycleState?: string;
  installStatus?: string;
  reason?: string;
}

export function createPreviewRequestId(): string {
  const bytes = new Uint8Array(6);
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `prv_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function scrubClientPreviewMessage(text: string): string {
  return String(text || '')
    .replace(/(\/preview\/[^/\s?#]+\/t\/)[A-Za-z0-9._-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/([?&]pt=)[A-Za-z0-9._-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/(carmen_preview_[A-Za-z0-9_-]+=)[^;\s]+/gi, '$1[REDACTED_COOKIE]')
    .replace(/(carmen_session=)[^;\s]+/gi, '$1[REDACTED_SESSION]')
    .replace(/(X-Carmen-Preview-Token\s*[:=]\s*)[A-Za-z0-9._-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,})\b/g, '[REDACTED_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]');
}

/**
 * Determine fetch credentials policy for preview requests:
 * - Same-origin preview (default, including authenticated HTTPS reverse proxies such as AI Studio / Cloud Run):
 *   use 'include' so proxy session cookies pass through to Express alongside X-Carmen-Preview-Token.
 * - Cross-origin sandbox domain (explicit PREVIEW_ORIGIN !== window.location.origin):
 *   use 'omit' so main app session cookies are never transmitted cross-origin; auth uses X-Carmen-Preview-Token.
 */
export function resolvePreviewFetchCredentials(
  normalizedPreviewOrigin: string,
  currentWindowOrigin: string
): RequestCredentials {
  if (!normalizedPreviewOrigin) return 'include';
  if (currentWindowOrigin && normalizedPreviewOrigin === currentWindowOrigin) return 'include';
  return 'omit';
}

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractMessageFromBody(body: string, contentType: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  if (contentType.includes('application/json') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        return scrubClientPreviewMessage(parsed.error.trim()).slice(0, 400);
      }
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return scrubClientPreviewMessage(parsed.message.trim()).slice(0, 400);
      }
    } catch {
      // Fall through to text extraction
    }
  }
  const pMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(trimmed);
  if (pMatch) {
    const plain = decodeBasicHtmlEntities(pMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (plain) return scrubClientPreviewMessage(plain).slice(0, 400);
  }
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(trimmed);
  if (h1Match) {
    const plain = decodeBasicHtmlEntities(h1Match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (plain) return scrubClientPreviewMessage(plain).slice(0, 400);
  }
  const stripped = decodeBasicHtmlEntities(trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  return scrubClientPreviewMessage(stripped).slice(0, 300);
}

export function classifyPreviewHttpResponse(opts: {
  status: number;
  redirected: boolean;
  url: string;
  contentType: string;
  body: string;
  installingHeader: string | null;
  previewBasePath: string;
}): PreviewResponseClassification {
  const ct = (opts.contentType || '').toLowerCase();
  const body = opts.body || '';

  // 1. Non-blocking dependency installation response (HTTP 202 or X-Carmen-Preview-Installing: 1)
  if (opts.status === 202 || opts.installingHeader === '1') {
    let packageManager: 'npm' | 'bun' | undefined;
    let missingPackages: string[] | undefined;
    try {
      const parsed = JSON.parse(body) as {
        packageManager?: unknown;
        missingPackages?: unknown;
      };
      if (parsed.packageManager === 'npm' || parsed.packageManager === 'bun') {
        packageManager = parsed.packageManager;
      }
      if (Array.isArray(parsed.missingPackages)) {
        missingPackages = parsed.missingPackages.filter((x): x is string => typeof x === 'string');
      }
    } catch {
      // Optional metadata
    }
    return { kind: 'installing', status: opts.status, packageManager, missingPackages };
  }

  // 2. Proxy redirect outside /preview/ (e.g. upstream auth gateway redirect to external login page)
  if (opts.redirected && opts.url && !opts.url.includes('/preview/')) {
    return {
      kind: 'proxy_redirect',
      status: opts.status,
      message: 'Preview request was redirected by an upstream proxy. Reload the page or sign in again.',
    };
  }

  // 3. Authentication / authorization failure (401 / 403)
  if (opts.status === 401 || opts.status === 403) {
    const extracted = extractMessageFromBody(body, ct);
    let code = opts.status === 401 ? 'UNAUTHORIZED' : 'INVALID_TOKEN';
    if (ct.includes('application/json') || body.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(body) as { code?: unknown };
        if (typeof parsed.code === 'string' && parsed.code) code = parsed.code;
      } catch {
        // Keep default code
      }
    } else if (body.includes('"URL_TOKEN_FORBIDDEN"')) {
      code = 'URL_TOKEN_FORBIDDEN';
    }
    return {
      kind: 'auth_failed',
      status: opts.status,
      code,
      message: extracted || `Preview authorization failed (HTTP ${opts.status}).`,
    };
  }

  // 4. Other non-2xx responses (404, 429, 500, 502, 503, etc.)
  if (opts.status < 200 || opts.status >= 300) {
    const extracted = extractMessageFromBody(body, ct);
    const isHtml = ct.includes('text/html');
    const hasCarmenErrorBridge = body.includes('carmen-preview-error');
    if (isHtml && hasCarmenErrorBridge) {
      return {
        kind: 'html_error',
        status: opts.status,
        html: body,
        fallbackMessage: extracted || `Preview failed with HTTP ${opts.status}.`,
      };
    }
    return {
      kind: 'non_html_error',
      status: opts.status,
      message: extracted || `Preview server returned HTTP ${opts.status}.`,
    };
  }

  // 5. 2xx response must be non-empty HTML
  if (!body.trim()) {
    return {
      kind: 'non_html_error',
      status: opts.status,
      message: 'Preview server returned an empty document.',
    };
  }

  if (ct && !ct.includes('text/html') && !ct.includes('application/xhtml+xml')) {
    return {
      kind: 'non_html_error',
      status: opts.status,
      message: `Unexpected preview content type: ${scrubClientPreviewMessage(ct)}`,
    };
  }

  return {
    kind: 'html_ok',
    status: opts.status,
    html: body,
  };
}

export function logPreviewDiagnostic(event: PreviewDiagnosticEvent): void {
  if (typeof console === 'undefined' || typeof console.info !== 'function') return;
  const payload: Record<string, unknown> = {
    projectId: event.projectId,
    previewRequestId: event.previewRequestId,
    stage: event.stage,
    event: event.event,
  };
  if (typeof event.status === 'number') payload.status = event.status;
  if (typeof event.durationMs === 'number') payload.durationMs = Math.round(event.durationMs);
  if (event.lifecycleState) payload.lifecycleState = event.lifecycleState;
  if (event.installStatus) payload.installStatus = event.installStatus;
  if (event.reason) payload.reason = scrubClientPreviewMessage(event.reason).slice(0, 240);
  console.info('[CARMEN Preview]', payload);
}
