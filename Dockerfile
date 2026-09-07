# syntax=docker/dockerfile:1

# ============================================================
# SinterIQ / Innovista Research AI — production image.
#
# Unlike Pomotoro (static nginx container + separate API container), this app
# is ONE process: server.ts in production mode serves the /api routes AND the
# built Vite bundle from dist/. So there is no container nginx and no separate
# api service — the host nginx proxies straight to this container.
#
# Debian slim, not Alpine: better-sqlite3 is a native addon and glibc is the
# path with prebuilt/most-tested binaries. Alpine/musl forces a source build
# and buys nothing here.
#
# NOTE: no AI provider key is ever a build arg. Keys are runtime-only env
# (server-side, encrypted at rest). Baking one in would put it in an image
# layer and, for anything VITE_-prefixed, in the browser bundle.
# ============================================================

###############################################
# Stage 1 — production dependencies only
# (compiles better-sqlite3 against this exact Node ABI)
###############################################
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

###############################################
# Stage 2 — build the Vite bundle (needs devDependencies: vite, plugin-react)
###############################################
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# vite build -> dist/ (public/branding/* is copied in by Vite)
RUN npm run build \
 && test -f dist/index.html \
 && test -f dist/branding/innovista.svg

###############################################
# Stage 3 — runtime
###############################################
FROM node:22-bookworm-slim AS runtime

# Label so CI prunes ONLY this app's images and never touches
# pomotoro / tawazun / sentry / jenkins layers on the shared VPS.
LABEL com.zengineering.app="sinteriq"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    INNOVISTA_DATA_DIR=/app/data

WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist

# The server runs TypeScript directly through tsx (a production dependency),
# and server/documents.ts forks server/document-worker.ts with `--import tsx`,
# so the .ts sources must ship — this is not a compiled-to-JS build.
COPY package.json package-lock.json ./
COPY server.ts ./
COPY server  ./server
COPY shared  ./shared
COPY scripts ./scripts

# First-run DB seeding reads ../docs/sintertechnik-training.md (unguarded).
COPY docs/sintertechnik-training.md ./docs/sintertechnik-training.md

# openDatabase() mkdirs the data dir with mode 0700. Creating it here owned by
# `node` means the named volume inherits that ownership on first mount, so the
# container can run unprivileged.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000

# /api/health checks the database init record: 200 connected / 503 unavailable.
# Host header must be an allowed one — app.ts allows localhost:$PORT, so keep
# PORT at 3000 (or update both together).
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form so SIGTERM reaches Node directly and server.ts's shutdown handler
# closes the HTTP server and the SQLite handle cleanly (WAL checkpoint).
CMD ["node", "--import", "tsx", "server.ts", "--production"]
