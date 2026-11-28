import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright-core';

function resolveChromiumExecutable(): string {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
  ].filter((p): p is string => Boolean(p && p.trim()));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return chromium.executablePath();
}

const CHROMIUM_EXECUTABLE = resolveChromiumExecutable();

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to allocate ephemeral port')));
      }
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`CARMEN server failed healthcheck within ${timeoutMs}ms: ${String(lastErr)}`);
}

describe('Playwright + Chromium Real Browser E2E Verification (F-21)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-e2e-'));
  let serverProc: ChildProcess | null = null;
  let browser: Browser | null = null;
  let baseUrl = '';

  before(async () => {
    assert.ok(
      fs.existsSync(CHROMIUM_EXECUTABLE),
      `Headless Chromium binary not found at ${CHROMIUM_EXECUTABLE}`
    );

    const distIndex = path.resolve(process.cwd(), 'dist/index.html');
    if (!fs.existsSync(distIndex)) {
      execFileSync('npm', ['run', 'build'], { cwd: process.cwd(), stdio: 'pipe' });
    }

    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');

    serverProc = spawn(tsxBin, ['server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        CARMEN_DB_PATH: path.join(tempDir, 'e2e.db'),
        CARMEN_SANDBOX_ROOT: path.join(tempDir, 'sandboxes'),
        CARMEN_MASTER_KEY: 'carmen-e2e-master-key-32-bytes-min!!',
        CARMEN_ENABLE_DEMO: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitForHealth(baseUrl);

    browser = await chromium.launch({
      executablePath: CHROMIUM_EXECUTABLE,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  });

  after(async () => {
    await browser?.close().catch(() => {});
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 400));
      if (!serverProc.killed) serverProc.kill('SIGKILL');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('verifies auth fail-closed UI, registration, session persistence, local-only key storage, Monaco code edit + live preview iframe, Self-Hosted deploy, and mobile layout', async () => {
    assert.ok(browser);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'dark',
    });
    const page = await context.newPage();

    const pageErrors: string[] = [];
    const fatalConsoleErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore expected HTTP 401 notice generated during deliberate wrong-password negative check
        if (!text.includes('401')) fatalConsoleErrors.push(text);
      }
    });

    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' });

      // 1) Obsidian + Crimson theme tokens & F-07 Magic Link tab hidden when emailEnabled === false
      const themeTokens = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          bg: cs.getPropertyValue('--bg').trim().toLowerCase(),
          accent: cs.getPropertyValue('--accent').trim().toLowerCase(),
          hasDarkClass: document.documentElement.classList.contains('dark'),
        };
      });
      assert.equal(themeTokens.hasDarkClass, true);
      assert.equal(themeTokens.bg, '#0e0f11');
      assert.equal(themeTokens.accent, '#c8324b');

      const tabTexts = await page.locator('[role="tab"]').allInnerTexts();
      assert.equal(tabTexts.some((t) => /magic/i.test(t)), false, 'Magic Link tab must be hidden when emailEnabled=false');

      // 2) Negative login error handling
      await page.fill('#auth-email', 'nonexistent-e2e@example.com');
      await page.fill('#auth-password', 'wrongpass123');
      await page.click('button[type="submit"]');
      await page.locator('[role="alert"]').waitFor({ state: 'visible', timeout: 8000 });

      // 3) Register new account & skip provider onboarding
      await page.locator('[role="tab"]', { hasText: /Daftar|Register/i }).click();
      await page.fill('#auth-name', 'E2E Tester');
      await page.fill('#auth-email', 'e2e-user@example.com');
      await page.fill('#auth-password', 'SecretPass123!');
      await page.click('button[type="submit"]');

      await page.getByRole('button', { name: /Lewati dulu|Skip for now/i }).click();
      await page.locator('h1').waitFor({ state: 'visible', timeout: 8000 });

      // 4) Reload & verify session persists across browser reload
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('nav').waitFor({ state: 'visible', timeout: 8000 });

      // 5) F-13 Local-Only API Key flow in Settings (persists in localStorage, zero server DB rows)
      await page.locator('nav button', { hasText: /Pengaturan|Settings/i }).first().click();
      await page.getByRole('button', { name: /Tambah Custom Provider|Add Custom Provider/i }).first().click();
      await page.fill('#prov-label', 'E2E Device Provider');
      await page.fill('#prov-baseurl', 'https://api.example.com/v1');
      await page.fill('#prov-models', 'e2e-custom-chat');
      await page.fill('#prov-apikey', 'sk-e2e-device-secret-9999');
      await page.getByLabel(/Simpan hanya di perangkat ini|Store on this device only/i).check();
      await page.locator('text=/localStorage/i').first().waitFor({ state: 'visible' });
      await page.locator('form button[type="submit"]').click();

      await page.locator('text=E2E Device Provider').first().waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('text=/Hanya di perangkat|Device only/i').first().waitFor({ state: 'visible', timeout: 5000 });

      const localStorageRaw = await page.evaluate(() => localStorage.getItem('carmen_local_only_keys_v1'));
      assert.ok(localStorageRaw && localStorageRaw.includes('E2E Device Provider'));

      const serverDbKeys = await page.evaluate(async () => {
        const token = sessionStorage.getItem('carmen_session_token');
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const r = await fetch('/api/providers/keys', { credentials: 'include', headers });
        return r.json();
      });
      assert.equal((serverDbKeys.keys as unknown[]).length, 0, 'Local-only key must NOT be written to server DB');

      // Reload & confirm local-only key survives reload
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('nav button', { hasText: /Pengaturan|Settings/i }).first().click();
      await page.locator('text=E2E Device Provider').first().waitFor({ state: 'visible', timeout: 5000 });

      // 6) Create first project from Home & verify Workspace Code Edit + Save + Live Preview iframe + Self-Hosted Deploy
      await page.locator('nav button', { hasText: /Beranda|Home/i }).first().click();
      await page.getByRole('button', { name: /Buat Proyek Pertama|Create First Project/i }).first().click();

      await page.locator('[role="tab"]', { hasText: /Kode|Code/i }).first().waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('[role="tab"]', { hasText: /Kode|Code/i }).first().click();
      await page.locator('[data-testid="vscode-code-pane"]').waitFor({ state: 'visible', timeout: 15_000 });

      // Wait for Monaco editor lines to mount cleanly, ensure index.html is active, replace content, and save
      const indexTreeBtn = page.locator('[data-testid="vscode-code-pane"] [role="tree"] button', { hasText: 'index.html' }).first();
      if (await indexTreeBtn.isVisible().catch(() => false)) {
        await indexTreeBtn.click();
      }
      const monacoSurface = page.locator('[data-testid="vscode-code-pane"] .monaco-editor').first();
      await monacoSurface.waitFor({ state: 'visible', timeout: 20_000 });
      await monacoSurface.locator('.view-lines').first().click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText(
        '<!doctype html><html><head><title>E2E</title></head><body><h1 id="e2e-preview-ok">E2E Live Preview Verified</h1></body></html>'
      );

      const saveBtn = page.getByRole('button', { name: /^(Simpan|Save)$/i }).first();
      const saveRespPromise = page.waitForResponse(
        (resp) => resp.url().includes('/api/projects/') && resp.url().includes('/files') && resp.request().method() === 'PUT'
      );
      await saveBtn.click();
      const saveResp = await saveRespPromise;
      assert.equal(saveResp.ok(), true, `Saving index.html failed with HTTP ${saveResp.status()}`);
      await page.waitForFunction(
        () => {
          const btn = Array.from(document.querySelectorAll('button')).find((b) =>
            /^(Simpan|Save)$/i.test((b.textContent || '').trim())
          );
          return btn?.disabled === true;
        },
        { timeout: 10_000 }
      );

      // Switch to Preview tab and assert iframe renders updated DOM
      await page.locator('[role="tab"]', { hasText: /Pratinjau|Preview/i }).first().click();
      const previewFrame = page.frameLocator('iframe').first();
      try {
        await previewFrame.locator('#e2e-preview-ok').waitFor({ state: 'visible', timeout: 15_000 });
      } catch (err) {
        const diag = await page.evaluate(() => ({
          empty: document.querySelector('[data-testid="preview-empty-state"]')?.textContent ?? null,
          installing: document.querySelector('[data-testid="preview-installing-state"]')?.textContent ?? null,
          errorStage: document.querySelector('[data-testid="preview-error-stage"]')?.textContent ?? null,
          iframeCount: document.querySelectorAll('iframe').length,
          iframeSrc: document.querySelector('iframe')?.getAttribute('src') ?? null,
        }));
        throw new Error(`Preview did not render #e2e-preview-ok (${JSON.stringify(diag)})`, { cause: err });
      }
      const headingText = await previewFrame.locator('#e2e-preview-ok').innerText();
      assert.equal(headingText.trim(), 'E2E Live Preview Verified');

      // 7) Deploy modal -> generate Self-Hosted config
      await page.getByRole('button', { name: 'Deploy' }).first().click();
      await page.getByRole('button', { name: /Buat Konfigurasi Self-Hosted|Generate Self-Hosted Config/i }).click();
      await page.locator('text=Dockerfile').first().waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByRole('button', { name: /Tutup|Close/i }).first().click();

      // 8) Desktop & Mobile zero horizontal overflow check
      const desktopOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      assert.equal(desktopOverflow, false, 'Desktop 1440px viewport must not horizontally overflow');

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(250);
      const mobileOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      assert.equal(mobileOverflow, false, 'Mobile 390px viewport must not horizontally overflow');

      assert.deepEqual(pageErrors, [], `Unexpected pageerror(s): ${pageErrors.join(' | ')}`);
      assert.deepEqual(fatalConsoleErrors, [], `Unexpected console.error(s): ${fatalConsoleErrors.join(' | ')}`);
    } finally {
      await context.close();
    }
  });
});
