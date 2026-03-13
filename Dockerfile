FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data
ENV DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
