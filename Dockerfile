# CARMEN Multi-Stage Production Web Application Image
# Target: Web Full-Stack AI App Builder (Node.js 22 + built-in node:sqlite / PostgreSQL + Vite SPA bundle)

# ── Stage 1: Build Vite frontend production bundle ────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json vite.config.ts index.html metadata.json ./
COPY public ./public
COPY src ./src

RUN npm run build \
    && test -f /app/dist/index.html

# ── Stage 2: Install clean production-only dependencies ───────────────────────
FROM node:22-bookworm-slim AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# ── Stage 3: Minimal non-root runtime image ───────────────────────────────────
FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    CARMEN_DB_PATH=/app/data/carmen.db

WORKDIR /app

# util-linux provides unshare/setpriv/prlimit for Linux namespace workspace isolation
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

COPY package.json package-lock.json tsconfig.json server.ts ./
COPY server ./server
COPY skills ./skills
COPY src/types.ts ./src/types.ts

RUN find /app/server -name '*.test.ts' -delete \
    && test -d /app/skills/development \
    && mkdir -p /app/data/sandboxes /app/data/artifacts \
    && chown -R node:node /app \
    && chmod -R u=rwX,go=rX /app/skills \
    && chmod 750 /app/data /app/data/sandboxes /app/data/artifacts

VOLUME ["/app/data"]

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
