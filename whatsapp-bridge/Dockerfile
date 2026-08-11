# Playwright's own image, because matching the browser build to the client
# library is the failure this avoids: a mismatched pair fails at launch with
# "Executable doesn't exist", and the version must track package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

# Xvfb: WhatsApp Web serves a degraded experience to headless Chromium, so the
# container runs a real browser against a virtual display instead.
RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Node buffers stdout when it is a pipe, and a container's stdout always is, so
# without this a crash can be lost with the log line that would have explained it.
ENV NODE_OPTIONS=--enable-source-maps
ENV PYTHONUNBUFFERED=1

# The session profile lives on a volume, never in the image: an image layer
# containing a linked WhatsApp session would leak the account to anyone who
# pulls it.
ENV WA_PROFILE_DIR=/data/profile
# The archive belongs on the volume too. Defaulting it under WORKDIR (/app)
# would put every ingested message inside the image layer, where replacing the
# container silently discards it.
ENV WA_STORE_PATH=/data/store.db
VOLUME ["/data"]

ENV PORT=8099
# Bind to the container interface so compose's internal network can reach it.
# Publishing this port to the host is a separate, deliberate decision.
ENV WA_BIND_HOST=0.0.0.0
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8099/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./entrypoint.sh"]
