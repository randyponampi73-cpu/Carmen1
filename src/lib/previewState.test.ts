import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPreviewHttpResponse,
  createPreviewRequestId,
  resolvePreviewFetchCredentials,
  scrubClientPreviewMessage,
} from './previewState';

test('resolvePreviewFetchCredentials uses include for same-origin and omit for cross-origin previewOrigin', () => {
  assert.equal(resolvePreviewFetchCredentials('', 'https://ais-dev-abc.run.app'), 'include');
  assert.equal(
    resolvePreviewFetchCredentials('https://ais-dev-abc.run.app', 'https://ais-dev-abc.run.app'),
    'include'
  );
  assert.equal(
    resolvePreviewFetchCredentials('https://preview-sandbox.example.com', 'https://app.example.com'),
    'omit'
  );
});

test('classifyPreviewHttpResponse distinguishes 202 installing, 401/403 auth, 429 JSON, proxy redirects, HTML errors, and 200 HTML', () => {
  const installing = classifyPreviewHttpResponse({
    status: 202,
    redirected: false,
    url: '/preview/p1/',
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ installing: true, packageManager: 'npm', missingPackages: ['zod', 'recharts'] }),
    installingHeader: '1',
    previewBasePath: '/preview/p1/',
  });
  assert.equal(installing.kind, 'installing');
  if (installing.kind === 'installing') {
    assert.equal(installing.packageManager, 'npm');
    assert.deepEqual(installing.missingPackages, ['zod', 'recharts']);
  }

  const rateLimited = classifyPreviewHttpResponse({
    status: 429,
    redirected: false,
    url: '/preview/p1/',
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ error: 'Terlalu banyak permintaan ke endpoint pratinjau.', code: 'RATE_LIMITED' }),
    installingHeader: null,
    previewBasePath: '/preview/p1/',
  });
  assert.equal(rateLimited.kind, 'non_html_error');
  if (rateLimited.kind === 'non_html_error') {
    assert.equal(rateLimited.status, 429);
    assert.match(rateLimited.message, /Terlalu banyak permintaan/);
  }

  const proxyRedirect = classifyPreviewHttpResponse({
    status: 200,
    redirected: true,
    url: 'https://accounts.google.com/v3/signin',
    contentType: 'text/html',
    body: '<html><body>Sign in</body></html>',
    installingHeader: null,
    previewBasePath: '/preview/p1/',
  });
  assert.equal(proxyRedirect.kind, 'proxy_redirect');

  const authFail = classifyPreviewHttpResponse({
    status: 403,
    redirected: false,
    url: '/preview/p1/',
    contentType: 'text/html; charset=utf-8',
    body: '<html><body><h1>Token invalid</h1><p>Token pratinjau kedaluwarsa</p></body></html>',
    installingHeader: null,
    previewBasePath: '/preview/p1/',
  });
  assert.equal(authFail.kind, 'auth_failed');
  if (authFail.kind === 'auth_failed') {
    assert.equal(authFail.status, 403);
    assert.match(authFail.message, /Token pratinjau kedaluwarsa/);
  }

  const htmlError = classifyPreviewHttpResponse({
    status: 500,
    redirected: false,
    url: '/preview/p1/',
    contentType: 'text/html; charset=utf-8',
    body: '<html><head><script>carmen-preview-error</script></head><body><p>Syntax error in App.tsx:12</p></body></html>',
    installingHeader: null,
    previewBasePath: '/preview/p1/',
  });
  assert.equal(htmlError.kind, 'html_error');
  if (htmlError.kind === 'html_error') {
    assert.match(htmlError.fallbackMessage, /Syntax error in App\.tsx:12/);
  }

  const okHtml = classifyPreviewHttpResponse({
    status: 200,
    redirected: false,
    url: '/preview/p1/',
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><body><div id="root"></div></body></html>',
    installingHeader: null,
    previewBasePath: '/preview/p1/',
  });
  assert.equal(okHtml.kind, 'html_ok');

  const emptyOk = classifyPreviewHttpResponse({
    status: 200,
    redirected: false,
    url: '/preview/p1/',
    contentType: 'text/html; charset=utf-8',
    body: '   ',
    installingHeader: null,
    previewBasePath: '/preview/p1/',
  });
  assert.equal(emptyOk.kind, 'non_html_error');
});

test('scrubClientPreviewMessage redacts tokens, cookies, and API keys while createPreviewRequestId returns safe short IDs', () => {
  const dirty =
    'GET /preview/p1/t/abc.def?pt=tok123 Cookie: carmen_session=secret123; carmen_preview_p1=pv123 X-Carmen-Preview-Token: tok999 key=sk-1234567890abcdef';
  const clean = scrubClientPreviewMessage(dirty);
  assert.equal(clean.includes('tok123'), false);
  assert.equal(clean.includes('secret123'), false);
  assert.equal(clean.includes('pv123'), false);
  assert.equal(clean.includes('tok999'), false);
  assert.equal(clean.includes('sk-1234567890abcdef'), false);

  const reqId = createPreviewRequestId();
  assert.match(reqId, /^prv_[a-f0-9]{12}$/);

  const htmlErr = classifyPreviewHttpResponse({
    status: 500,
    redirected: false,
    url: '/preview/p1/',
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><body><p>Dependensi &quot;missing-pkg&quot; tidak ditemukan</p><script>postMessage({type:"carmen-preview-error"})</script></body></html>',
    installingHeader: null,
    previewBasePath: '/preview/p1/',
  });
  assert.equal(htmlErr.kind, 'html_error');
  if (htmlErr.kind === 'html_error') {
    assert.equal(htmlErr.fallbackMessage, 'Dependensi "missing-pkg" tidak ditemukan');
  }
});
