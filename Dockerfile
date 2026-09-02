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

# Every path is resolved against the process CWD, i.e. this WORKDIR.
#
# THE THREE WRITABLE STORES ALL LIVE ON /app/state, the declared VOLUME below.
# The quota file guards the bill; the member store IS the roster, and losing it
# revokes everybody; the invite store holds outstanding invitations. None may sit
# on the container's writable layer, where `docker rm` takes them.
#
# MEMBERS_FILE is the LEGACY hand-edited registry, read once and folded into the
# member store on first boot (ADR-0002). An installation that never had one
# leaves it unmounted, and the gateway starts normally.
ENV PORT=3602 \
    MEMBERS_FILE=/app/config/members.json \
    QUOTA_STORE_FILE=/app/state/quota-store.json \
    MEMBER_STORE_FILE=/app/state/member-store.json \
    INVITE_STORE_FILE=/app/state/invite-store.json \
    LOG_LEVEL=info \
    NODE_ENV=production

# A named volume, on its FIRST mount, copies the ownership of the image
# directory it replaces. /app/state does not exist yet at this point in the
# image, so without this step it is created root:root 0755 by the COPY/RUN
# layers above — and the container, which runs as `node` below, can never
# write member-store.json, invite-store.json or quota-store.json into it.
# Boots healthy, then fails on the very first invite.
RUN mkdir -p /app/state && chown node:node /app/state

VOLUME /app/state

EXPOSE 3602

# Runs unprivileged. The node image ships a `node` user; /app/state must be
# writable by it, which the chown above (and the compose example) handles.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3602)+'/healthcheck').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
