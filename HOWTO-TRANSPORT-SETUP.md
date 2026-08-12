---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5 (1M context) via Claude Code"
  date: "2026-08-11"
last_verified: "2026-08-11"
verified_how: >-
  Every step was executed on this machine against a real account, including
  Step 5. Pairing was completed by QR; the phone-code flow returned
  "400 bad-request" from WhatsApp's servers on repeated attempts and is marked
  accordingly in place. Steps 6-8 were run end to end: 8,658 queued messages
  drained into the archive with 0 dropped.
tool_versions:
  - tool: "Go (host)"
    version: "1.24.6"
  - tool: "Go (module requirement, auto-fetched)"
    version: "1.25.0"
  - tool: "Node.js"
    version: "24.14.0"
  - tool: "Docker Engine"
    version: "29.6.1"
  - tool: "Docker Compose"
    version: "5.3.1"
  - tool: "whatsmeow"
    version: "v0.0.0-20260810134348-a23afe317180"
---

# How to run whatsapp-agent on the Go protocol transport

## Disclaimer

This work is subject to the methodological caveats and commitments described in [@DISCLAIMER.md](./DISCLAIMER.md).
> No statement or premise not backed by a real logical definition or verifiable reference should be taken for granted.

## Overview

This guide moves message reception from the Playwright/Chromium browser session
onto `whatsapp-transport`, a Go service that speaks WhatsApp's multi-device
protocol directly. At the end, messages arrive in the archive by being pushed to
a durable queue rather than by scraping a rendered chat list, and the browser is
no longer required to receive anything.

For **who this is for**: an operator who already has this project running — the
bridge starts, the archive has messages in it, and `.env` is filled in.

**This does not reduce the ban risk.** An unofficial protocol client is no more
sanctioned by WhatsApp than an automated browser. Read the warning at the top of
[README.md](./README.md) again; it applies unchanged.

### Non-goals

- Installing the project from scratch — see [README.md](./README.md).
- `GET /media` and `POST /history` on the transport. Both exist on the Go side
  and are **not wired** into the bridge. Media bytes still travel through the
  browser.
- Removing the browser. The DOM routes, self-notes and event watching still use
  it. This guide changes reception and sending only.

## Prerequisites

1. Docker Engine and Compose:
   `docker compose version --short` prints `5.3.1` or later.
2. A filled-in `.env` at the repo root containing `WA_BRIDGE_TOKEN`,
   `ANTHROPIC_API_KEY` and `WA_UI_PASSWORD`:
   `grep -c '^WA_BRIDGE_TOKEN=.\+' .env` prints `1`.
3. The phone holding the WhatsApp account, unlocked, with network access.
4. `python3` for reading JSON responses:
   `python3 -c 'import json'` exits without output.
5. Only if you build outside Docker: Go with `GOTOOLCHAIN=auto` (the default).
   `go env GOTOOLCHAIN` prints `auto`.

## Steps

### Step 1: Back up the archive

Starting the new bridge code migrates the archive from schema v1 to v2 in place,
adding three columns to `chats`. The migration is additive and covered by tests,
but it runs against the file holding your correspondence, and a backup is the
only fallback that works if anything else on this list surprises you.

For a Compose install:

```bash
docker compose ps -q whatsapp-bridge >/dev/null && docker compose stop whatsapp-bridge
docker run --rm -v whatsapp-agent_whatsapp-profile:/data -v "$PWD":/backup alpine \
  sh -c 'cp /data/store.db /backup/store.db.pre-v2 && ls -la /backup/store.db.pre-v2'
```

For a bare `node src/server.js` install, copy the path in `WA_STORE_PATH`
(default `whatsapp-bridge/data/store.db`):

```bash
cp whatsapp-bridge/data/store.db ./store.db.pre-v2 && ls -la ./store.db.pre-v2
```

**Verify:** `store.db.pre-v2` exists and is the same size as the original.

**If the volume name is wrong:** `docker volume ls | grep profile` lists the
real name. Compose prefixes volumes with the project directory name.

### Step 2: Generate the transport token

The transport refuses to start without a token, because its API can read every
message the account receives and send as you. This is a **second** token, not
the bridge's: one secret spanning two trust boundaries means rotating it
silently unauthenticates the other side.

```bash
openssl rand -hex 32
```

Append to `.env`, pasting the value above:

```bash
WA_TRANSPORT_TOKEN=<the 64 hex characters>
WA_TRANSPORT_URL=
```

Leave `WA_TRANSPORT_URL` **empty** for now — Step 6 fills it in. Until then the
bridge can receive nothing: the DOM path that once covered this gap was removed,
so `/transport/*` answers 503 and the archive stays empty. That is expected at
this step, not a fault to debug.

**Verify:**

```bash
set -a; . ./.env; set +a; echo "${#WA_TRANSPORT_TOKEN}"
```

Prints `64`.

### Step 3: Start the transport alone

Bring up the new service by itself, before involving the bridge. A transport
that cannot start is a much easier problem to read in isolation.

```bash
docker compose up -d --build whatsapp-transport
docker compose logs --no-log-prefix whatsapp-transport
```

**Verify:** the log contains these two lines, in this order:

```
not paired — POST /pair/phone or open GET /pair/qr to link a device
listening on 0.0.0.0:8100
```

Then confirm the unauthenticated liveness route and the authenticated one:

```bash
set -a; . ./.env; set +a
curl -s http://127.0.0.1:8100/health
curl -s -H "Authorization: Bearer $WA_TRANSPORT_TOKEN" http://127.0.0.1:8100/status
```

Expected, exactly:

```json
{"status":"ok"}
```

```json
{"send":{"allowlistedSize":0,"enabled":false},"session":{"paired":false,"connected":false,"loggedIn":false,"events":{"messages":0,"fromHistory":0,"unrecognised":0,"undecryptable":0,"ignored":0,"failed":0,"mediaUnrecorded":0,"unrecognisedTypes":{}},"queue":{"depth":0,"dropped":0}}}
```

**If the container exits immediately**, read the last log line. There are exactly
three configuration refusals, and each names its own fix:

| Log line | Cause | Fix |
|---|---|---|
| `WA_TRANSPORT_TOKEN is required` | Token empty or absent from `.env` | Step 2 |
| `WA_TRANSPORT_DIR is required (…)` | `WA_TRANSPORT_DIR` unset | Compose sets `/data`; restore it if edited |
| `sendguard: WA_TRANSPORT_SEND_ALLOWLIST entry is not a usable address …: <contact-name>` | A display **name** in the allowlist | Empty it for now; Step 9 uses JIDs |

**If `/status` returns `{"error":"unauthorized"}`:** the token in your shell
differs from the container's. Re-run `set -a; . ./.env; set +a` and
`docker compose up -d whatsapp-transport` so both read the same `.env`.

**If port 8100 is already bound:** `ss -ltn | grep 8100` names the holder. Stop
it, or change both `WA_TRANSPORT_ADDR` and the published port in
`docker-compose.yml`.

### Step 4: Prove the queue works before pairing

This tests the queue and the ack path with a synthetic entry, so a real account
is never involved and the archive is never written to. Skip this step and the
first thing you debug will be three subsystems at once.

Queue one entry directly into the transport's outbox. The runtime image contains
only the static binary — no shell utilities for SQLite — so write to the volume
from a throwaway container:

```bash
docker volume ls | grep transport-data     # confirm the name Compose gave it
```

```bash
docker run --rm -v whatsapp-agent_whatsapp-transport-data:/data node:24-alpine node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/outbox.db");
db.prepare("INSERT INTO outbox (payload, enqueued_at) VALUES (?, ?)").run(
  JSON.stringify({key:"3EB0SMOKETEST01",
    chat:{key:"smoke-fixture@lid",kind:"lid",provisional:false},
    sender:{key:"smoke-fixture@lid",kind:"lid",provisional:false},
    pushName:"<contact-name>",outgoing:false,sentAt:"2026-08-11T09:05:00Z",
    kind:"voice",text:"",durationSeconds:222,recognised:true,fromHistory:false}),
  new Date().toISOString());
console.log("queued, depth:", db.prepare("SELECT COUNT(*) c FROM outbox").get().c);
db.close();'
```

Read it back, then discard it:

```bash
curl -s -H "Authorization: Bearer $WA_TRANSPORT_TOKEN" "http://127.0.0.1:8100/outbox?limit=5"
curl -s -X POST -H "Authorization: Bearer $WA_TRANSPORT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"through":1}' \
  http://127.0.0.1:8100/outbox/ack
curl -s -H "Authorization: Bearer $WA_TRANSPORT_TOKEN" "http://127.0.0.1:8100/outbox?limit=5"
```

**Verify:** the first call reports `"depth":1` with your entry, the ack reports
`{"removed":1}`, and the third reports `{"depth":0,"dropped":0,"entries":[]}`.

**If the ack returns `{"error":"through is required"}`:** the body was empty or
misspelled. A missing `through` is refused rather than treated as `0`, because
acking `0` looks like success and loops forever.

### Step 5: Pair the account

> **Verified by QR; the code flow failed.** Both flows below were attempted
> against a real account. The QR flow works. `POST /pair/phone` returned
> `400 bad-request` from WhatsApp's own servers on every attempt, with and
> without a leading `+` — whatsmeow strips non-digits itself, so the format was
> never the difference. Prefer the QR flow until that is understood. Everything else in
> this guide was run.

This is a **new linked device**, separate from the browser session. It consumes
one of WhatsApp's linked-device slots and does not disturb the existing one.

The QR flow is the one that works here. Note that the code rotates every ~20s
and the channel closes after about two minutes, so render it somewhere live
rather than sending yourself a snapshot — a stale code fails as
"Couldn't link device", which looks like a rejection but is an expiry.

**Do not restart the transport while the phone says "Logging in".** The
registration completes only once the new session stays connected long enough to
finish its first login. Tearing it down before that abandons it, and the next
connect is refused with `401 logged out from another device` — which whatsmeow
treats as a logout, deleting the session and wasting the scan.

The code flow, for reference — it needs no QR rendering, but see the note above:

```bash
curl -s -X POST -H "Authorization: Bearer $WA_TRANSPORT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"phone":"<your number, E.164: a leading + then country code and number, no spaces>"}' \
  http://127.0.0.1:8100/pair/phone
```

Returns `{"code":"XXXX-XXXX"}`. On the phone: **WhatsApp → Settings → Linked
devices → Link a device → Link with phone number instead**, then type the code.

As a fallback, stream QR codes. `qrencode` is **not installed on this machine**
(`command -v qrencode` finds nothing), so install it first:

```bash
sudo apt-get install -y qrencode
curl -sN -H "Authorization: Bearer $WA_TRANSPORT_TOKEN" http://127.0.0.1:8100/pair/qr
```

Each `data:` line carries a fresh code; WhatsApp rotates it roughly every 20
seconds, which is why this is a stream. Render the newest one:

```bash
qrencode -t ANSIUTF8 '<the code field from the newest data: line>'
```

**Verify:**

```bash
curl -s -H "Authorization: Bearer $WA_TRANSPORT_TOKEN" http://127.0.0.1:8100/status
```

`"paired"` and `"loggedIn"` are both `true`.

**If the stream ends with `{"event":"timeout"}`:** the codes expired unscanned.
Re-request; nothing is left in a bad state.

**If `/status` still shows `"paired":false`** after the phone reports success,
restart the service — pairing state is read at startup:
`docker compose restart whatsapp-transport`.

### Step 6: Point the bridge at the transport

Now connect the two. Set the URL in `.env` to the **service name**, because the
bridge reaches it over Compose's internal network, not over loopback:

```bash
WA_TRANSPORT_URL=http://whatsapp-transport:8100
```

Restart the bridge. This is the start that runs the v1 → v2 migration:

```bash
docker compose up -d whatsapp-bridge
docker compose logs --no-log-prefix --tail=10 whatsapp-bridge
```

**Verify:** the boot log contains this line:

```
transport: draining the outbox into the archive
```

If it instead says `transport: none configured (set WA_TRANSPORT_URL to receive
over the protocol)`, the container did not pick up the new `.env`; re-run
`docker compose up -d whatsapp-bridge`.

Then confirm the migration landed and the two services can talk:

```bash
set -a; . ./.env; set +a
curl -s -H "Authorization: Bearer $WA_BRIDGE_TOKEN" http://127.0.0.1:8099/transport/status
```

Expected shape — the transport's own status, plus what only the archive knows:

```json
{
  "send": { "allowlistedSize": 0, "enabled": false },
  "session": { "paired": true, "connected": true, "loggedIn": true,
    "events": { "messages": 0, "fromHistory": 0, "unrecognised": 0,
                "undecryptable": 0, "ignored": 0, "failed": 0, "mediaUnrecorded": 0,
                "unrecognisedTypes": {} },
    "queue": { "depth": 0, "dropped": 0 } },
  "archive": { "provisionalChats": 0, "provisional": [] }
}
```

**If this returns `401` with `transport: rejected the bearer token (401).
WA_TRANSPORT_TOKEN must be identical in the bridge and the transport…`:** the two
services hold different tokens. Both read the same `.env` key, so this means one
container is running with a stale environment. `docker compose up -d` both.

**If it returns `503`:** `WA_TRANSPORT_URL` is empty in the bridge's environment.

#### Running the bridge outside Docker

If you run `node src/server.js` directly, the transport is on loopback and the
bridge needs the variables in its own environment. Stop the running process
first — a second one exits with `EADDRINUSE: address already in use
127.0.0.1:8099`:

```bash
set -a; . ./.env; set +a
WA_TRANSPORT_URL=http://127.0.0.1:8100 \
WA_TRANSPORT_TOKEN="$WA_TRANSPORT_TOKEN" \
node whatsapp-bridge/src/server.js
```

A long-running bridge process loaded its modules at startup, so it keeps using
the old code — and the old schema — until restarted.

### Step 7: Confirm real messages arrive

Send yourself a message from another phone, or have someone message you. Wait
six seconds: the bridge drains every five by default.

```bash
curl -s -H "Authorization: Bearer $WA_BRIDGE_TOKEN" http://127.0.0.1:8099/archive/stats
```

**Verify:** `messages` increased. `session.events.messages` in
`/transport/status` also increased.

To drain immediately instead of waiting:

```bash
curl -s -X POST -H "Authorization: Bearer $WA_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:8099/transport/drain
```

Expected, with one new message:

```json
{ "fetched": 1, "inserted": 1, "duplicates": 0, "rejected": 0,
  "acked": 1, "depth": 1, "dropped": 0, "chats": ["<an identity key>"] }
```

**If `fetched` is 0 while `session.events.messages` is climbing:** the transport
is receiving but the bridge already drained it. Check `/archive/stats` rather
than this number.

**If `queue.depth` climbs and never falls:** the bridge is not draining. Look for
`transport: drain failed:` in `docker compose logs whatsapp-bridge`.

**If `inserted` is 0 while `duplicates` equals `fetched`:** the messages were
already stored. This is the correct outcome after a restart — delivery is
at-least-once and re-delivery is free.

### Checkpoint

At this point: the transport is paired and connected, the bridge drains it, and
new messages reach the archive without the browser being involved. Sending is
still disabled and the browser still serves the DOM routes. Stopping here leaves
a working, read-only system.

### Step 8: Read a chat by its new address

Protocol-era chats are addressed by identity key, not by display name. Confirm
what the agent will now see:

```bash
curl -s -H "Authorization: Bearer $WA_BRIDGE_TOKEN" \
  "http://127.0.0.1:8099/archive/search?q=<a word from a recent message>"
```

**Verify:** the hit's `chat` is an identity key such as `<id>@lid` or a group
JID, not a display name.

To let the agent and yourself refer to a person by name, teach it an alias:

```bash
curl -s -X POST -H "Authorization: Bearer $WA_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"alias":"<contact-name>","canonical":"<the identity key from above>"}' \
  http://127.0.0.1:8099/people/alias
```

**Verify:** `GET /people/aliases` lists it with `"origin":"session"`.

### Step 9: Enable sending (optional)

Sending passes **two** independent gates, and both must permit the recipient.
Leave this step undone to stay read-only.

Read the roster to get JIDs — the transport's allowlist is written in addresses,
not names:

```bash
curl -s -H "Authorization: Bearer $WA_TRANSPORT_TOKEN" http://127.0.0.1:8100/contacts
```

Set both gates in `.env`, then recreate both services:

```bash
WA_ALLOW_SEND=true
WA_SEND_ALLOWLIST=<contact-name>
WA_TRANSPORT_ALLOW_SEND=true
WA_TRANSPORT_SEND_ALLOWLIST=<the key for <contact-name> from /contacts>
```

```bash
docker compose up -d whatsapp-transport whatsapp-bridge
```

**Verify:** `/transport/status` reports `"send":{"enabled":true,"allowlistedSize":1}`.

Then send to yourself or a consenting recipient:

```bash
curl -s -X POST -H "Authorization: Bearer $WA_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"to":"<contact-name>","message":"test"}' \
  http://127.0.0.1:8099/send
```

**Verify:** the response contains `"via":"transport"` and an `id`.

**If it returns `403` with `sendguard: recipient is not allowlisted`:** the name
passed the bridge's gate and the JID failed the transport's. The two lists are
written in different vocabularies; check the key against `/contacts`.

**If it returns `403` with `sendguard: no recipients are allowlisted`:** sending
is enabled with an empty transport allowlist. That is a configuration mistake,
reported rather than treated as permissive.

**If it returns `409` with `is ambiguous — it matches N contacts`:** two contacts
advertise that push name. Address the identity key directly instead of the name.

**If it returns `409` with `has no routable address yet`:** the person's identity
is still provisional, so the protocol has given this account no stable address
for them. Send to them from your phone once, then retry.

## Verification

One sequence that exercises the whole path. All four must hold:

```bash
set -a; . ./.env; set +a
# 1. The transport is paired, connected and reports no gap.
curl -s -H "Authorization: Bearer $WA_TRANSPORT_TOKEN" http://127.0.0.1:8100/status \
  | python3 -c 'import json,sys; s=json.load(sys.stdin)["session"]; print("paired",s["paired"],"loggedIn",s["loggedIn"],"dropped",s["queue"]["dropped"])'
# 2. The bridge can reach it and the archive agrees.
curl -s -H "Authorization: Bearer $WA_BRIDGE_TOKEN" http://127.0.0.1:8099/transport/status \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("provisional", d["archive"]["provisionalChats"])'
# 3. The archive is on the new schema.
docker compose exec -T whatsapp-bridge node -e \
  'import("/app/src/store.js").then(m=>{const s=m.openStore(process.env.WA_STORE_PATH);console.log("schema v"+s.schemaVersion());s.close()})'
# 4. A drain completes and acks.
curl -s -X POST -H "Authorization: Bearer $WA_BRIDGE_TOKEN" -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:8099/transport/drain
```

Expected: `paired True loggedIn True dropped 0`, a provisional count you have
read, `schema v2`, and a drain result whose `rejected` is `0`.

## Troubleshooting

Organised by what you see, not by cause.

**`go: go.mod requires go >= 1.25.0 (running go 1.24.6; GOTOOLCHAIN=local)`**
Only when building outside Docker. The module needs Go 1.25.0 and this host has
1.24.6; the default `GOTOOLCHAIN=auto` fetches the right one. Run
`GOTOOLCHAIN=auto go build ./...`, or build in Docker, where the image is pinned.

**`dropped` is greater than zero**
The outbox filled while the bridge was not draining, and those messages are
permanently gone — the count is cumulative and never resets. Nothing recovers
them; `POST /history` on the transport can re-request from your phone, but it is
not wired into the bridge. Prevent recurrence by raising
`WA_TRANSPORT_OUTBOX_CAPACITY` above the 50,000 default, or by not leaving the
bridge stopped for long. Treat a non-zero count as a stated gap in the archive,
never as a quiet period.

**`archive.provisionalChats` is greater than zero**
Expected, and not an error. Those chats are keyed on a digest because the
protocol has not yet given this account a stable key for the person. If a stable
key arrives later, that person has two chat rows and **nothing links them** — the
payload carries no mapping. The archive reports the count instead of merging on a
display name, because two people can advertise the same one.

**Messages stop arriving after days of working**
WhatsApp expires linked devices after long idle periods, exactly as it does for
the browser session. Check `"loggedIn"` in `/status` and re-pair (Step 5).

**Two `sender` vocabularies in the archive**
Rows ingested from the DOM store a display name in `messages.sender`;
protocol rows store an identity key. Both eras coexist by design, and
`chats.identity_kind` distinguishes them: `NULL` means the chat was addressed by
a rendered name.

**Do not raise the log level to DEBUG**
`WA_TRANSPORT_LOG_LEVEL=DEBUG` makes whatsmeow print decrypted stanzas, and a
stanza carries the sender's full address — which, before the LID migration, is
their phone number. That writes contacts' numbers into container logs and
bypasses the containment the rest of the system maintains. `INFO` and `WARN` do
not.

## Rolling back

To return to the DOM path, empty `WA_TRANSPORT_URL` and restart the bridge:

```bash
docker compose up -d whatsapp-bridge
docker compose logs --no-log-prefix --tail=5 whatsapp-bridge   # expect: transport: none configured
```

Reception returns to the browser immediately. The `whatsapp-transport` service
can be stopped and its volume kept, so re-enabling needs no second pairing.

Two things do **not** roll back:

- **The schema stays at v2.** Downgrading the bridge code leaves the three added
  columns in place, unused and harmless — but restore `store.db.pre-v2` from
  Step 1 if you need v1 exactly.
- **Messages already ingested from the protocol keep their identity-key chat
  addresses.** They do not merge with same-person chats ingested from the DOM.

## Next steps

- [README.md](./README.md) — the project overview and the ban-risk warning.
- [SPEC.md](./SPEC.md) — what this transport does and does not make possible.
- `GET /media` and `POST /history` are implemented on the transport and unwired
  in the bridge. Wiring `/media` changes what the existing media tool does,
  because it currently fetches bytes through the browser.
