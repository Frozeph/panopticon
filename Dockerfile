# PANOPTICON // Geospatial Intelligence Dashboard v2
FROM node:20-alpine AS builder

# Build deps for native modules (better-sqlite3 needs Python + make)
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ─── Production Image ──────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache libstdc++ && \
    addgroup -S panopticon && adduser -S panopticon -G panopticon

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --chown=panopticon:panopticon server.js package.json ./
COPY --chown=panopticon:panopticon public ./public

# Data directory for SQLite DB
RUN mkdir -p /app/data && chown panopticon:panopticon /app/data

USER panopticon

EXPOSE 3000
ENV PORT=3000
ENV DATA_DIR=/app/data

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
