# syntax=docker/dockerfile:1

# The eve agent only. The browser lives in whatsapp-bridge/Dockerfile, because
# a Playwright session is stateful and long-lived while this server is
# replaced on every deploy.
FROM node:24-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# eve's default sandbox backend resolves to just-bash on a host with no Docker
# daemon and no KVM. This agent never runs sandbox commands — every tool is an
# HTTP call to the bridge — but the backend is initialised at startup anyway,
# so the container crash-loops without it.
RUN npm install --no-save just-bash

COPY . .

# `eve build` evaluates authored modules, and agent/channels/eve.ts throws at
# module scope when WA_UI_PASSWORD is missing — a deliberate guard against
# serving an ungated agent. The build only needs the variable present, not
# correct; compose injects the real one at runtime, and this placeholder never
# reaches the runtime image, which copies only build artifacts.
RUN WA_UI_PASSWORD=build-time-placeholder npm run build

# --- runtime --------------------------------------------------------------
FROM node:24-slim AS agent

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# .output is the self-contained Nitro bundle; .eve carries the compiled agent
# manifest naming the tools and the whatsapp skill.
COPY --from=builder --chown=node:node /app/.output ./.output
COPY --from=builder --chown=node:node /app/.eve ./.eve

# `eve start` is the supported entrypoint: running .output/server/index.mjs
# directly skips Nitro's schedule runner. It needs the eve binary, the package
# manifest that resolves it, and the authored sources it re-resolves at startup.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/agent ./agent
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json

RUN mkdir -p /app/.eve/.workflow-data && chown -R node:node /app/.eve

USER node
EXPOSE 3000

CMD ["npx", "eve", "start", "--host", "0.0.0.0"]
