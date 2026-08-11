# The protocol transport: whatsmeow over WhatsApp's own multi-device protocol.
#
# ── Why this image has no browser in it ──────────────────────────────────────
# That is the entire point of the service. `whatsapp-bridge` needs Chromium under
# Xvfb and a gigabyte of shared memory to render a chat list; this speaks the
# protocol directly, so the runtime is one static binary and a data directory.

FROM golang:1.25-alpine AS build

WORKDIR /src

# Dependencies first, as their own layer: the module graph changes far less often
# than the source, so an edit to one .go file does not re-download it.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO off, which is what makes a static binary possible here at all: the SQLite
# driver is modernc.org/sqlite — a pure-Go translation, not a cgo binding — so
# there is nothing to link against and nothing to carry into the runtime image.
#
# The build runs the tests first. A transport that cannot pass its own suite must
# not become an image that looks deployable.
ENV CGO_ENABLED=0
RUN go vet ./... && go test ./... && \
    go build -trimpath -ldflags="-s -w" -o /out/whatsapp-transport ./cmd/whatsapp-transport

FROM alpine:3.21

# Alpine rather than distroless or scratch for one reason: the container
# healthcheck needs something that can make an HTTP request, and busybox wget is
# already here. TLS roots are needed to reach WhatsApp's servers at all.
RUN apk add --no-cache ca-certificates && \
    adduser -D -H -u 10001 transport

COPY --from=build /out/whatsapp-transport /usr/local/bin/whatsapp-transport

# The paired session lives here and IS the account credential — anyone who copies
# this directory has the WhatsApp account with no QR scan. Mount a volume over it;
# never bake it into an image.
ENV WA_TRANSPORT_DIR=/data
RUN mkdir -p /data && chown transport /data
VOLUME ["/data"]

# Unprivileged: this process holds a live account and needs nothing from root.
USER transport

EXPOSE 8100

# /health is the one unauthenticated route, and it reveals only that the process
# is up — a healthcheck must not need the send-capable token.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8100/health || exit 1

ENTRYPOINT ["/usr/local/bin/whatsapp-transport"]
