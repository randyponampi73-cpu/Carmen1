import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

function resolveAllowedViteHosts(env: NodeJS.ProcessEnv): true | string[] {
  const raw = (env.VITE_ALLOWED_HOSTS || '').trim();
  if (raw) {
    if (raw === '*') return true;
    const parsed = raw.split(',').map((h) => h.trim()).filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  const allowAllPreview =
    env.VITE_STRICT_HOSTS !== 'true' &&
    (env.DISABLE_HMR === 'true' || Boolean(env.APPLET_ID || env.K_SERVICE));
  if (allowAllPreview) {
    return true;
  }
  const hosts = new Set<string>([
    'localhost',
    '127.0.0.1',
    '.localhost',
    '.aistudio.google.com',
    '.usercontent.goog',
    '.scf.usercontent.com',
    '.run.app',
  ]);
  for (const urlVal of [env.APP_URL, env.PREVIEW_ORIGIN]) {
    if (!urlVal) continue;
    try {
      hosts.add(new URL(urlVal).hostname);
    } catch {
      // Ignore malformed env URL
    }
  }
  if (env.CARMEN_DOMAIN && /^[a-zA-Z0-9._-]+$/.test(env.CARMEN_DOMAIN.trim())) {
    hosts.add(env.CARMEN_DOMAIN.trim());
  }
  return Array.from(hosts);
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(rootDir, 'dist');
          const srcAssets = path.resolve(rootDir, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(rootDir, '.'),
      },
    },
    server: {
      host: (process.env.HOST || (process.env.VITE_LOCAL_ONLY === 'true' ? '127.0.0.1' : '0.0.0.0')).trim(),
      port: 3000,
      allowedHosts: resolveAllowedViteHosts(process.env),
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
