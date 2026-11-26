import crypto from 'node:crypto';
import JSZip from 'jszip';
import type { BuildLogEntry, DeploymentRecord, DeploymentTarget, ProjectArchitectureInfo } from '../../src/types';
import { asyncDb, db } from '../db';
import { parseJsonColumn, toIsoTimestamp } from '../db/dialect';
import { collectProjectFilesForDistribution } from '../export/zipExporter';
import { detectProjectArchitectureAsync } from '../runtime/preview';
import { normalizeProjectPath, readResponseTextWithLimit, safeOutboundFetch, scrubSecrets } from '../security';

export interface DeployRequest {
  projectId: string;
  target: DeploymentTarget;
  projectName: string;
  apiToken?: string;
  siteId?: string; // Required for Netlify
  accountId?: string; // Required for Cloudflare Pages
  teamId?: string; // Optional for Vercel
  production?: boolean;
}

export type DeployFetchFn = (
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; maxRedirects: number; enforceCustomUrlPolicy: boolean }
) => Promise<Response>;

function makeLog(level: BuildLogEntry['level'], message: string): BuildLogEntry {
  return { timestamp: new Date().toISOString(), level, message };
}

function safeParseDeployLogsJson(raw: unknown): BuildLogEntry[] {
  const parsed = parseJsonColumn<unknown>(raw, []);
  return Array.isArray(parsed) ? (parsed as BuildLogEntry[]) : [];
}

export function sanitizeDeploySlug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'carmen-app';
}

export function generateSelfHostedArtifacts(
  projectName: string,
  hasPackageJson: boolean,
  architecture?: Partial<Pick<ProjectArchitectureInfo, 'hasCustomBackend' | 'backendEntry' | 'frontendEntry'>>,
  options?: { packageJsonContent?: string | null }
): Record<string, string> {
  const slug = sanitizeDeploySlug(projectName);
  const rawEntry = architecture?.hasCustomBackend ? architecture.backendEntry || 'server.ts' : null;
  const backendEntry = rawEntry ? normalizeProjectPath(rawEntry) || 'server.ts' : null;

  let pkgParsed: { type?: string; scripts?: Record<string, unknown> } | null = null;
  if (options?.packageJsonContent) {
    try {
      pkgParsed = JSON.parse(options.packageJsonContent) as { type?: string; scripts?: Record<string, unknown> };
    } catch {
      pkgParsed = null;
    }
  }

  const hasBuildScript = pkgParsed
    ? Boolean(pkgParsed.scripts && typeof pkgParsed.scripts.build === 'string' && pkgParsed.scripts.build.trim())
    : hasPackageJson;
  const frontendOutDir =
    architecture?.frontendEntry && architecture.frontendEntry.startsWith('client/') ? 'client/dist' : 'dist';

  let dockerfile: string;
  if (backendEntry) {
    // Strategy C: Full-Stack / Custom Node.js Backend (multi-stage build, non-root USER node, ZERO runtime npx)
    const isTsEntry = /\.(?:ts|tsx|mts|cts)$/i.test(backendEntry);
    const outExt = pkgParsed?.type === 'module' || /\.mts$/i.test(backendEntry) ? 'mjs' : 'cjs';
    const compiledRel = `dist-server/server.${outExt}`;
    const formatFlag = outExt === 'mjs' ? '--format=esm' : '--format=cjs';
    const runtimeEntry = isTsEntry ? compiledRel : backendEntry;

    dockerfile = [
      'FROM node:22-alpine AS builder',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi',
      'COPY . .',
      'RUN rm -f .env .env.local .env.*.local || true',
      hasBuildScript ? 'RUN npm run build' : 'RUN echo "No frontend build script; keeping static assets"',
      isTsEntry
        ? `RUN if [ -x ./node_modules/.bin/esbuild ]; then ESB=./node_modules/.bin/esbuild; else npm install --no-save --ignore-scripts esbuild && ESB=./node_modules/.bin/esbuild; fi && "$ESB" ${JSON.stringify(backendEntry)} --bundle --platform=node --target=node22 --packages=external ${formatFlag} --outfile=${compiledRel}`
        : `RUN test -f ${JSON.stringify(backendEntry)}`,
      '',
      'FROM node:22-alpine AS runtime',
      'ENV NODE_ENV=production PORT=8080',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; else npm install --omit=dev --ignore-scripts; fi',
      'COPY . .',
      'RUN rm -f .env .env.local .env.*.local || true',
      ...(isTsEntry ? [`COPY --from=builder /app/${compiledRel} ./${compiledRel}`] : []),
      ...(hasBuildScript ? [`COPY --from=builder /app/${frontendOutDir} ./${frontendOutDir}`] : []),
      'RUN mkdir -p /app/data && chown -R node:node /app',
      'USER node',
      'EXPOSE 8080',
      'HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch(\'http://127.0.0.1:8080/\').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"',
      `CMD ["node", ${JSON.stringify(runtimeEntry)}]`,
    ].join('\n');
  } else if (hasPackageJson && hasBuildScript) {
    // Strategy B: React / Vite Modular SPA (build production dist/, serve via non-root Nginx, NEVER raw source or npx)
    dockerfile = [
      'FROM node:22-alpine AS builder',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi',
      'COPY . .',
      'RUN rm -f .env .env.local .env.*.local || true',
      'RUN npm run build',
      '',
      'FROM nginxinc/nginx-unprivileged:1.27-alpine',
      `COPY --from=builder --chown=nginx:nginx /app/${frontendOutDir} /usr/share/nginx/html`,
      'USER 101',
      'EXPOSE 8080',
      'HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1',
      'CMD ["nginx", "-g", "daemon off;"]',
    ].join('\n');
  } else {
    // Strategy A: Pure Static HTML/CSS/JS served cleanly via unprivileged non-root Nginx
    dockerfile = [
      'FROM nginxinc/nginx-unprivileged:1.27-alpine',
      'COPY --chown=nginx:nginx . /usr/share/nginx/html',
      'RUN rm -f /usr/share/nginx/html/.env /usr/share/nginx/html/.env.* /usr/share/nginx/html/package*.json || true',
      'USER 101',
      'EXPOSE 8080',
      'HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1',
      'CMD ["nginx", "-g", "daemon off;"]',
    ].join('\n');
  }

  const composeLines = [
    'services:',
    `  ${slug}:`,
    '    build: .',
    '    ports:',
    '      - "8080:8080"',
    '    security_opt:',
    '      - "no-new-privileges:true"',
  ];
  if (backendEntry) {
    composeLines.push(
      '    environment:',
      '      NODE_ENV: production',
      '      PORT: 8080',
      '      SQLITE_DB_PATH: /app/data/app.db',
      '    volumes:',
      `      - ${slug}_data:/app/data`,
      '    restart: unless-stopped',
      '',
      'volumes:',
      `  ${slug}_data:`
    );
  } else {
    composeLines.push('    restart: unless-stopped');
  }
  const compose = composeLines.join('\n');

  return {
    Dockerfile: `${dockerfile}\n`,
    'docker-compose.yml': `${compose}\n`,
  };
}

type RawDeploymentRow = {
  id: string;
  project_id: string;
  target: DeploymentTarget;
  status: DeploymentRecord['status'];
  deployment_url: string | null;
  external_id: string | null;
  project_name: string;
  logs_json: unknown;
  created_at: unknown;
};

function mapDeploymentRow(r: RawDeploymentRow): DeploymentRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    target: r.target,
    status: r.status,
    deploymentUrl: r.deployment_url,
    externalId: r.external_id,
    projectName: r.project_name,
    logs: safeParseDeployLogsJson(r.logs_json),
    createdAt: toIsoTimestamp(r.created_at),
  };
}

export function listProjectDeployments(projectId: string): DeploymentRecord[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, target, status, deployment_url, external_id, project_name, logs_json, created_at
       FROM deployments
       WHERE project_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 30`
    )
    .all(projectId) as RawDeploymentRow[];

  return rows.map(mapDeploymentRow);
}

export async function listProjectDeploymentsAsync(projectId: string): Promise<DeploymentRecord[]> {
  const rows = await asyncDb.all<RawDeploymentRow>(
    `SELECT id, project_id, target, status, deployment_url, external_id, project_name, logs_json, created_at
     FROM deployments
     WHERE project_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 30`,
    projectId
  );
  return rows.map(mapDeploymentRow);
}

export function getDeploymentById(deployId: string): DeploymentRecord | null {
  const row = db
    .prepare(
      `SELECT id, project_id, target, status, deployment_url, external_id, project_name, logs_json, created_at
       FROM deployments WHERE id = ?`
    )
    .get(deployId) as RawDeploymentRow | undefined;

  return row ? mapDeploymentRow(row) : null;
}

export async function getDeploymentByIdAsync(deployId: string): Promise<DeploymentRecord | null> {
  const row = await asyncDb.get<RawDeploymentRow>(
    `SELECT id, project_id, target, status, deployment_url, external_id, project_name, logs_json, created_at
     FROM deployments WHERE id = ?`,
    deployId
  );
  return row ? mapDeploymentRow(row) : null;
}

async function saveDeploymentRecordAsync(record: DeploymentRecord): Promise<void> {
  await asyncDb.run(
    `INSERT INTO deployments (id, project_id, target, status, deployment_url, external_id, project_name, logs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.projectId,
    record.target,
    record.status,
    record.deploymentUrl,
    record.externalId,
    record.projectName,
    JSON.stringify(record.logs),
    record.createdAt
  );
}

/**
 * Executes a real deployment through the selected adapter (Vercel, Netlify, Cloudflare Pages, or Self-Hosted).
 * NEVER fabricates a successful deployment URL if credentials are missing or the remote provider rejects the request.
 */
export async function executeDeployment(
  req: DeployRequest,
  fetchFn: DeployFetchFn = (url, init, opts) => safeOutboundFetch(url, init, opts)
): Promise<DeploymentRecord> {
  const deployId = `dep_${crypto.randomUUID().slice(0, 10)}`;
  const createdAt = new Date().toISOString();
  const slug = sanitizeDeploySlug(req.projectName);
  const logs: BuildLogEntry[] = [makeLog('info', `Memulai deployment target=${req.target} untuk "${slug}".`)];

  const secretList = req.apiToken ? [req.apiToken] : [];
  let distribution: Awaited<ReturnType<typeof collectProjectFilesForDistribution>>;
  try {
    distribution = await collectProjectFilesForDistribution(req.projectId, secretList);
  } catch {
    distribution = { project: { name: slug, type: 'web', stack: 'Static' }, files: [], hasPackageJson: false, packageJsonContent: null };
  }

  const collectedFiles = distribution.files;
  if (collectedFiles.length === 0) {
    logs.push(makeLog('error', 'Proyek tidak memiliki file aman untuk di-deploy.'));
    const failed: DeploymentRecord = {
      id: deployId,
      projectId: req.projectId,
      target: req.target,
      status: 'failed',
      deploymentUrl: null,
      externalId: null,
      projectName: slug,
      logs,
      createdAt,
    };
    await saveDeploymentRecordAsync(failed);
    return failed;
  }

  // 1. SELF-HOSTED DOCKER DEPLOYMENT CONFIG
  if (req.target === 'self-hosted') {
    const architecture = await detectProjectArchitectureAsync(req.projectId);
    const artifacts = generateSelfHostedArtifacts(slug, distribution.hasPackageJson, architecture, {
      packageJsonContent: distribution.packageJsonContent,
    });
    logs.push(
      makeLog('info', `Memvalidasi ${collectedFiles.length} file proyek bersih (tanpa secret/env, arsitektur=${architecture.stackKind}).`),
      makeLog('success', `Konfigurasi self-hosted (${Object.keys(artifacts).join(', ')}) siap. Unduh ZIP proyek lalu jalankan: docker compose up --build -d`)
    );
    const record: DeploymentRecord = {
      id: deployId,
      projectId: req.projectId,
      target: 'self-hosted',
      status: 'ready',
      deploymentUrl: null,
      externalId: `self-hosted:${slug}`,
      projectName: slug,
      logs,
      createdAt,
    };
    await saveDeploymentRecordAsync(record);
    return record;
  }

  const token = (req.apiToken || '').trim();
  if (!token) {
    logs.push(makeLog('error', `Token API ${req.target} wajib diisi untuk deployment nyata.`));
    const failed: DeploymentRecord = {
      id: deployId,
      projectId: req.projectId,
      target: req.target,
      status: 'failed',
      deploymentUrl: null,
      externalId: null,
      projectName: slug,
      logs,
      createdAt,
    };
    await saveDeploymentRecordAsync(failed);
    return failed;
  }

  try {
    // 2. VERCEL REAL API (POST /v13/deployments)
    if (req.target === 'vercel') {
      const qs = req.teamId?.trim() ? `?teamId=${encodeURIComponent(req.teamId.trim())}` : '';
      const url = `https://api.vercel.com/v13/deployments${qs}`;
      logs.push(makeLog('info', `Mengunggah ${collectedFiles.length} file ke Vercel API (v13/deployments)...`));

      const res = await fetchFn(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: slug,
            target: req.production === false ? 'preview' : 'production',
            files: collectedFiles.map((f) => ({
              file: f.path,
              data: f.isBinary ? f.buffer.toString('base64') : f.textContent ?? f.buffer.toString('utf8'),
              encoding: f.isBinary ? 'base64' : 'utf-8',
            })),
            projectSettings: {
              framework: null,
            },
          }),
        },
        { timeoutMs: 30_000, maxRedirects: 2, enforceCustomUrlPolicy: false }
      );

      const text = scrubSecrets(await readResponseTextWithLimit(res, 512 * 1024), secretList);
      if (!res.ok) {
        let detail = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { error?: { message?: string } };
          if (j.error?.message) detail = j.error.message;
        } catch {
          // keep text
        }
        logs.push(makeLog('error', `Vercel API menolak deployment (HTTP ${res.status}): ${detail}`));
        const failed: DeploymentRecord = {
          id: deployId,
          projectId: req.projectId,
          target: 'vercel',
          status: 'failed',
          deploymentUrl: null,
          externalId: null,
          projectName: slug,
          logs,
          createdAt,
        };
        await saveDeploymentRecordAsync(failed);
        return failed;
      }

      const json = JSON.parse(text) as { id?: string; url?: string; readyState?: string };
      const deployUrl = json.url ? (json.url.startsWith('http') ? json.url : `https://${json.url}`) : null;
      logs.push(
        makeLog('success', `Vercel mengonfirmasi deployment id=${json.id || 'unknown'} (${json.readyState || 'QUEUED'}).`)
      );
      const record: DeploymentRecord = {
        id: deployId,
        projectId: req.projectId,
        target: 'vercel',
        status: deployUrl ? 'ready' : 'pending',
        deploymentUrl: deployUrl,
        externalId: json.id || null,
        projectName: slug,
        logs,
        createdAt,
      };
      await saveDeploymentRecordAsync(record);
      return record;
    }

    // 3. NETLIFY REAL API (POST /api/v1/sites/{siteId}/deploys with application/zip)
    if (req.target === 'netlify') {
      const siteId = (req.siteId || '').trim();
      if (!siteId || !/^[a-zA-Z0-9._-]+$/.test(siteId)) {
        logs.push(makeLog('error', 'Netlify Site ID wajib diisi dengan format valid.'));
        const failed: DeploymentRecord = {
          id: deployId,
          projectId: req.projectId,
          target: 'netlify',
          status: 'failed',
          deploymentUrl: null,
          externalId: null,
          projectName: slug,
          logs,
          createdAt,
        };
        await saveDeploymentRecordAsync(failed);
        return failed;
      }

      const zip = new JSZip();
      for (const f of collectedFiles) zip.file(f.path, f.buffer);
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      logs.push(makeLog('info', `Mengunggah arsip ZIP (${zipBuf.length} byte) ke Netlify site ${siteId}...`));

      const res = await fetchFn(
        `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/zip',
          },
          body: new Uint8Array(zipBuf),
        },
        { timeoutMs: 30_000, maxRedirects: 2, enforceCustomUrlPolicy: false }
      );

      const text = scrubSecrets(await readResponseTextWithLimit(res, 512 * 1024), secretList);
      if (!res.ok) {
        logs.push(makeLog('error', `Netlify API menolak deployment (HTTP ${res.status}): ${text.slice(0, 300)}`));
        const failed: DeploymentRecord = {
          id: deployId,
          projectId: req.projectId,
          target: 'netlify',
          status: 'failed',
          deploymentUrl: null,
          externalId: null,
          projectName: slug,
          logs,
          createdAt,
        };
        await saveDeploymentRecordAsync(failed);
        return failed;
      }

      const json = JSON.parse(text) as { id?: string; ssl_url?: string; deploy_ssl_url?: string; url?: string };
      const deployUrl = json.ssl_url || json.deploy_ssl_url || json.url || null;
      logs.push(makeLog('success', `Netlify mengonfirmasi deploy id=${json.id || 'unknown'}.`));
      const record: DeploymentRecord = {
        id: deployId,
        projectId: req.projectId,
        target: 'netlify',
        status: deployUrl ? 'ready' : 'pending',
        deploymentUrl: deployUrl,
        externalId: json.id || null,
        projectName: slug,
        logs,
        createdAt,
      };
      await saveDeploymentRecordAsync(record);
      return record;
    }

    // 4. CLOUDFLARE PAGES REAL API (Verify project via Cloudflare v4 API + Direct Upload trigger)
    if (req.target === 'cloudflare-pages') {
      const accountId = (req.accountId || '').trim();
      if (!accountId || !/^[a-fA-F0-9]{16,64}$/.test(accountId)) {
        logs.push(makeLog('error', 'Cloudflare Account ID (hex) wajib diisi.'));
        const failed: DeploymentRecord = {
          id: deployId,
          projectId: req.projectId,
          target: 'cloudflare-pages',
          status: 'failed',
          deploymentUrl: null,
          externalId: null,
          projectName: slug,
          logs,
          createdAt,
        };
        await saveDeploymentRecordAsync(failed);
        return failed;
      }

      logs.push(makeLog('info', `Memverifikasi proyek Cloudflare Pages "${slug}" pada akun ${accountId.slice(0, 8)}...`));
      const checkRes = await fetchFn(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(slug)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        },
        { timeoutMs: 25_000, maxRedirects: 2, enforceCustomUrlPolicy: false }
      );
      const checkText = scrubSecrets(await readResponseTextWithLimit(checkRes, 512 * 1024), secretList);
      if (!checkRes.ok) {
        logs.push(
          makeLog(
            'error',
            `Cloudflare Pages API menolak permintaan (HTTP ${checkRes.status}): ${checkText.slice(0, 300)}`
          )
        );
        const failed: DeploymentRecord = {
          id: deployId,
          projectId: req.projectId,
          target: 'cloudflare-pages',
          status: 'failed',
          deploymentUrl: null,
          externalId: null,
          projectName: slug,
          logs,
          createdAt,
        };
        await saveDeploymentRecordAsync(failed);
        return failed;
      }

      const manifest: Record<string, string> = {};
      const form = new FormData();
      for (const f of collectedFiles) {
        const hash = crypto.createHash('sha256').update(f.buffer).digest('hex').slice(0, 32);
        manifest[`/${f.path.replace(/^\/+/, '')}`] = hash;
        form.append(hash, new Blob([new Uint8Array(f.buffer)], { type: 'application/octet-stream' }), f.path);
      }
      form.append('manifest', JSON.stringify(manifest));

      const deployRes = await fetchFn(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(slug)}/deployments`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        },
        { timeoutMs: 30_000, maxRedirects: 2, enforceCustomUrlPolicy: false }
      );

      const deployText = scrubSecrets(await readResponseTextWithLimit(deployRes, 512 * 1024), secretList);
      if (!deployRes.ok) {
        logs.push(
          makeLog('error', `Cloudflare Pages gagal mengunggah deployment (HTTP ${deployRes.status}): ${deployText.slice(0, 300)}`)
        );
        const failed: DeploymentRecord = {
          id: deployId,
          projectId: req.projectId,
          target: 'cloudflare-pages',
          status: 'failed',
          deploymentUrl: null,
          externalId: null,
          projectName: slug,
          logs,
          createdAt,
        };
        await saveDeploymentRecordAsync(failed);
        return failed;
      }

      const json = JSON.parse(deployText) as { result?: { id?: string; url?: string } };
      const deployUrl = json.result?.url || null;
      logs.push(makeLog('success', `Cloudflare Pages mengonfirmasi deployment id=${json.result?.id || 'unknown'}.`));
      const record: DeploymentRecord = {
        id: deployId,
        projectId: req.projectId,
        target: 'cloudflare-pages',
        status: deployUrl ? 'ready' : 'pending',
        deploymentUrl: deployUrl,
        externalId: json.result?.id || null,
        projectName: slug,
        logs,
        createdAt,
      };
      await saveDeploymentRecordAsync(record);
      return record;
    }

    throw new Error(`Target deployment tidak dikenal: ${String(req.target)}`);
  } catch (err) {
    const msg = scrubSecrets(err instanceof Error ? err.message : String(err), secretList);
    logs.push(makeLog('error', `Gagal menghubungi layanan deployment: ${msg}`));
    const failed: DeploymentRecord = {
      id: deployId,
      projectId: req.projectId,
      target: req.target,
      status: 'failed',
      deploymentUrl: null,
      externalId: null,
      projectName: slug,
      logs,
      createdAt,
    };
    await saveDeploymentRecordAsync(failed);
    return failed;
  }
}
