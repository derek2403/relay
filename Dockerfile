# The relay (Next.js app + API routes) for Docker Compose behind Traefik.
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so they come in as build args;
# every server secret is read at runtime from the Compose env_file and never enters the image.

FROM node:24.19.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_SEPOLIA_RPC_URL=""
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=""
ARG NEXT_PUBLIC_SESSION_MINTER=""
ENV NEXT_TELEMETRY_DISABLED=1
# prebuild bundles the `relay` CLI into public/cli/ for /install.
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24.19.0-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    RELAY_DATA_DIR=/data
COPY --from=build --chown=node:node /app/package.json /app/next.config.mjs ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
# The blockchain workspace (contract addresses and hashes, no keys) the relay reads at runtime.
COPY --from=build --chown=node:node /app/org/chain.json ./org/chain.json
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/relay/status').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# One process only: the spend meter in /data must not be shared between replicas.
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
