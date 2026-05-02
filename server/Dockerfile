# ============================================================
# server/Dockerfile
#
# Multi-stage build:
#   1. builder  — compile TypeScript, prune devDeps
#   2. runtime  — lean production image (Node Alpine)
#
# Image: ~80 MB vs ~600 MB with a naive single-stage build.
# ============================================================

# ── Stage 1: Builder ─────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first (layer-cache friendly)
COPY package*.json ./
COPY tsconfig*.json ./

# Install all deps (including devDeps for tsc)
RUN npm ci

# Copy source
COPY shared/ ./shared/
COPY core/   ./core/
COPY server/ ./server/

# Compile
RUN npm run build --workspace=server

# Prune devDependencies
RUN npm prune --production --workspace=server


# ── Stage 2: Runtime ─────────────────────────────────────────
FROM node:20-alpine AS runtime

# Don't run as root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

WORKDIR /app

# Copy compiled output and production node_modules only
COPY --from=builder --chown=appuser:appgroup /app/server/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules

# Expose WebSocket + HTTP port
EXPOSE 3000

# Health check (Docker / k8s liveness probe)
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

ENV NODE_ENV=production

CMD ["node", "dist/server/src/main.js"]
