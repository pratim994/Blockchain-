# ============================================================
# client/Dockerfile
#
# Stage 1: Build the React app with Vite
# Stage 2: Serve static assets via nginx with WS proxy
# ============================================================

# ── Stage 1: Build ───────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig*.json ./
RUN npm ci

COPY shared/ ./shared/
COPY core/   ./core/
COPY client/ ./client/

RUN npm run build --workspace=client


# ── Stage 2: Nginx ───────────────────────────────────────────
FROM nginx:1.25-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=5s \
  CMD wget -qO- http://localhost/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
