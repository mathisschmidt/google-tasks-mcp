# syntax=docker/dockerfile:1

# ---- Build stage: compile TypeScript and install production dependencies ----
FROM node:22.22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage: Deno (Debian, required by the @deno/kv native binding) ----
FROM denoland/deno:debian-2.9.6
WORKDIR /app

ENV KV_PATH=/data/kv.sqlite3 \
    LOG_LEVEL=info

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json deno.json ./
COPY public ./public

RUN mkdir -p /data && chown deno:deno /data
VOLUME ["/data"]

USER deno
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["deno", "eval", "const r = await fetch('http://127.0.0.1:3000/health'); Deno.exit(r.ok ? 0 : 1);"]

CMD ["deno", "serve", "--unstable-kv", "--allow-net", "--allow-env", "--allow-read", "--allow-write=/data", "--allow-sys", "--allow-ffi", "--host", "0.0.0.0", "--port", "3000", "build/index.js"]
