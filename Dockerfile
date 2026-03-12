# PANOPTICON // Geospatial Intelligence Dashboard v2
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ─── Production Image ──────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache libstdc++

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY server.js package.json ./
COPY public ./public

RUN mkdir -p /app/data

EXPOSE 3000
ENV PORT=3000
ENV DATA_DIR=/app/data

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
