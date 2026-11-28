import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const ROOT_DIR = process.cwd();
const OUT_FILE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT_DIR, 'carmen-source-release.zip');

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'data',
  'docs',
  '.git',
  '.playwright-cli',
  '.aistudio',
  '.cache',
  'coverage',
]);

function isExcludedRelPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = norm.split('/');
  if (parts.some((p) => EXCLUDED_DIRS.has(p))) return true;
  const base = parts[parts.length - 1] || '';
  if (base === 'bun.lock' || base === 'bun.lockb') return true;
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return true;
  if (/\.(db|db-wal|db-shm|sqlite|sqlite3|zip|apk|aab|jks|keystore|p12|pem|key|log)$/i.test(base)) return true;
  return false;
}

async function main(): Promise<void> {
  const zip = new JSZip();
  let fileCount = 0;

  const walk = (dir: string, prefix: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (isExcludedRelPath(rel)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (ent.isFile()) {
        zip.file(rel, fs.readFileSync(full));
        fileCount += 1;
      }
    }
  };

  walk(ROOT_DIR, '');
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  fs.writeFileSync(OUT_FILE, buf);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  console.log(
    JSON.stringify(
      {
        archive: OUT_FILE,
        files: fileCount,
        sizeBytes: buf.length,
        sha256,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
