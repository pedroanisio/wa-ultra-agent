# Plain Node, because this service no longer drives a browser.
#
# It used to be built on Playwright's own image — pinned to the client library's
# version, plus Xvfb, because WhatsApp Web serves a degraded experience to
# headless Chromium. All of that existed to scrape a rendering of data the
# protocol hands over directly. `whatsapp-transport` (Go, whatsmeow) now does
# reception, sending, media and history, and this container is what it always
# should have been: the archive and an HTTP API in front of it.
#
# The practical consequence is an image roughly an order of magnitude smaller,
# no `shm_size`, no virtual display, and no browser build to keep in step with a
# client library.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Node buffers stdout when it is a pipe, and a container's stdout always is, so
# without this a crash can be lost with the log line that would have explained it.
ENV NODE_OPTIONS=--enable-source-maps

# The archive belongs on the volume. Defaulting it under WORKDIR (/app) would put
# every ingested message inside the image layer, where replacing the container
# silently discards it.
ENV WA_STORE_PATH=/data/store.db
VOLUME ["/data"]

ENV PORT=8099
# Bind to the container interface so compose's internal network can reach it.
# Publishing this port to the host is a separate, deliberate decision.
ENV WA_BIND_HOST=0.0.0.0
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8099/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
