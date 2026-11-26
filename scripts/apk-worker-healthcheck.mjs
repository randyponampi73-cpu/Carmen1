import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const HEALTH_FILE =
  process.env.CARMEN_APK_WORKER_HEALTH_FILE || path.join(os.tmpdir(), 'carmen-apk-worker-health.json');
const MAX_HEARTBEAT_AGE_MS = 45_000;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildRespCommand(parts) {
  let cmd = `*${parts.length}\r\n`;
  for (const part of parts) {
    const buf = Buffer.from(String(part), 'utf8');
    cmd += `$${buf.length}\r\n${buf.toString('utf8')}\r\n`;
  }
  return cmd;
}

function checkRedisPing(redisUrl) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(redisUrl);
    } catch (err) {
      reject(new Error(`Invalid REDIS_URL: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const useTls = parsed.protocol === 'rediss:';
    const host = parsed.hostname || '127.0.0.1';
    const port = Number(parsed.port || (useTls ? 6380 : 6379));
    const username = parsed.username ? decodeURIComponent(parsed.username) : '';
    const password = parsed.password ? decodeURIComponent(parsed.password) : '';

    const socket = useTls
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

    let settled = false;
    let buffer = '';
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Ignore socket destroy failure during cleanup
      }
      if (err) reject(err);
      else resolve();
    };

    const dbMatch = parsed.pathname.match(/^\/(\d+)$/);
    const dbIndex = dbMatch ? Number(dbMatch[1]) : 0;

    socket.setTimeout(3500);
    socket.once('timeout', () => finish(new Error('Redis PING timeout')));
    socket.once('error', (err) => finish(err));
    socket.once('connect', () => {
      let payload = '';
      if (password) {
        payload += username ? buildRespCommand(['AUTH', username, password]) : buildRespCommand(['AUTH', password]);
      }
      if (Number.isInteger(dbIndex) && dbIndex > 0) {
        payload += buildRespCommand(['SELECT', String(dbIndex)]);
      }
      payload += buildRespCommand(['PING']);
      socket.write(payload);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('-ERR') || buffer.includes('-WRONGPASS') || buffer.includes('-NOAUTH')) {
        finish(new Error(`Redis error response: ${buffer.trim()}`));
        return;
      }
      if (buffer.includes('+PONG')) {
        finish(null);
      }
    });
  });
}

async function main() {
  const redisUrl = (process.env.REDIS_URL || '').trim();
  if (!redisUrl) {
    console.error('[apk-worker-health] REDIS_URL tidak diatur.');
    process.exit(1);
  }

  if (!fs.existsSync(HEALTH_FILE)) {
    console.error(`[apk-worker-health] Heartbeat file tidak ditemukan (${HEALTH_FILE}).`);
    process.exit(1);
  }

  let heartbeat;
  try {
    heartbeat = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
  } catch (err) {
    console.error('[apk-worker-health] Gagal membaca heartbeat:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (!heartbeat || !heartbeat.running || !isPidAlive(heartbeat.pid)) {
    console.error('[apk-worker-health] Proses apk-worker tidak aktif.');
    process.exit(1);
  }

  const updatedAtMs = Date.parse(String(heartbeat.updatedAt || ''));
  if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > MAX_HEARTBEAT_AGE_MS) {
    console.error('[apk-worker-health] Heartbeat apk-worker kedaluwarsa.');
    process.exit(1);
  }

  await checkRedisPing(redisUrl);
  process.exit(0);
}

main().catch((err) => {
  console.error('[apk-worker-health] Unhealthy:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
