# openplate-gateway — one small image, no model, no database.
#
# ── WHAT THIS IMAGE IS ─────────────────────────────────────────────────────
# A stateless HTTP proxy. Unlike its sibling openplate-inference, there is no
# model runtime, no GPU stack and no weights: this container forwards requests
# to an upstream provider and counts them. That is why it is a plain Node image
# and why it runs happily on a Raspberry-Pi-class box — which is the deployment
# the family use case actually has.
#
# ── STATE ──────────────────────────────────────────────────────────────────
# Two files, both mounted from outside: the members registry (read-only, holds
# token DIGESTS, never tokens) and the quota counter file (read-write). Nothing
# else survives a restart, and nothing else needs to. The quota file MUST be on
# a volume — losing it hands every member a fresh daily allowance.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# Stage 1 — build the bundle
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

# Manifests first so a source-only change reuses the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
# `pnpm build` is `tsx scripts/build.ts` — the bundler lives in scripts/, so it
# has to be in the context too. Without it the build stage dies with
# ERR_MODULE_NOT_FOUND on /app/scripts/build.ts.
COPY scripts ./scripts
RUN pnpm build

# ---------------------------------------------------------------------------
# Stage 2 — runtime dependencies only
# ---------------------------------------------------------------------------
# A second, production-only install with the HOISTED linker. pnpm's default
# symlinked store cannot be copied between stages — the links point outside
# node_modules. `--prod` drops typescript/vitest/esbuild, which is most of the
# weight.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --config.node-linker=hoisted

# ---------------------------------------------------------------------------
# Stage 3 — the shipped image
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE}
WORKDIR /app

COPY --from=build     /app/dist         /app/dist
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY package.json /app/package.json

# Both paths are resolved against the process CWD, i.e. this WORKDIR. Mount the
# members file read-only and the quota file on a volume.
ENV PORT=3602 \
    MEMBERS_FILE=/app/config/members.json \
    QUOTA_STORE_FILE=/app/state/quota-store.json \
    LOG_LEVEL=info \
    NODE_ENV=production

VOLUME /app/state

EXPOSE 3602

# Runs unprivileged. The node image ships a `node` user; /app/state must be
# writable by it, which the compose example handles.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3602)+'/healthcheck').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
