# whatsapp-agent

An eve agent with access to your personal WhatsApp, through WhatsApp's own
multi-device protocol.

## Disclaimer

This work is subject to the methodological caveats and commitments described in [@DISCLAIMER.md](./DISCLAIMER.md).
> No statement or premise not backed by a real logical definition or verifiable reference should be taken for granted.

## Read this first

**This violates WhatsApp's Terms of Service.** An unofficial protocol client is
not a supported integration, and accounts using one are banned at WhatsApp's
discretion — permanently, with no appeal, on the number you use.
The official route is WhatsApp Business Cloud (`eve add channel/chat-sdk-whatsapp`),
but it only reaches business messaging, never your personal chats. If you want
your own conversations, this is the only way, and the risk is real. Consider a
secondary number.

**The session is a credential.** The `whatsapp-transport-data` volume holds
`session.db`: a linked device. Anyone who copies it has your WhatsApp on their
machine with no QR scan. The `whatsapp-profile` volume holds `store.db` — every
message ever ingested — which is worth no less. Both are gitignored; keep them
that way, and never bake either into an image.

## Why there are three services

| Service | Holds |
|---|---|
| `whatsapp-transport` | Go + [whatsmeow](https://github.com/tulir/whatsmeow). The linked session, the protocol socket, a durable outbox |
| `whatsapp-bridge` | The archive (`store.db`) and the HTTP API over it. Its only writer |
| `agent` | The eve agent; its tools call the bridge over the internal network |

A fourth, `frameforge`, is optional and off unless you ask for it by profile —
the document renderer, which holds no WhatsApp credential at all. See
[Making documents, not just messages](#making-documents-not-just-messages).

The split is not decoration. eve compiles to a Nitro server that is replaced on
every deploy, while a linked WhatsApp session must survive exactly one login and
then persist. The archive has to outlive both.

Both the bridge (`127.0.0.1:8099`) and the transport (`127.0.0.1:8100`) are
published on **loopback only**, because pairing and health checks need host
access. Every route but `/health` requires a bearer token — a different one per
service, deliberately, so rotating either cannot silently unauthenticate the
other. Binding either to `0.0.0.0`, or tunnelling those ports, puts a live
WhatsApp account on the network.

## The transport is the only way in

There used to be a second one: a Playwright session driving `web.whatsapp.com`
under Xvfb, reading messages out of the rendered DOM. **It has been removed.** It
was not a fallback but a weaker duplicate, and every fact it produced was worse:

| | DOM path (removed) | Protocol path |
|---|---|---|
| Reception | poll a rendered chat list | pushed, into a durable outbox |
| Message id | hash of the rendered content | the protocol's own id |
| Timestamp | parsed from `"8/3/2026"`, sometimes unparseable | an exact instant |
| Identity | a fuzzy-matched display name | a stable per-person key |
| Costs | Chromium, Xvfb, 1 GB of shared memory | one static binary |

What went with it: `src/session.js`, `src/selectors.js`, `src/lifecycle.js`,
`src/watch.js`, the `/debug/*` and `/events*` routes, `/qr`, `/chats`,
`/messages`, `/ingest`, the prepare/commit send dance, and the Playwright
dependency. `test/anti-corruption-layer.test.js` now asserts that none of it
comes back — no source file may address WhatsApp's markup or drive a browser.

**It does not reduce the ban risk.** Read this first, above, applies unchanged:
an unofficial protocol client is no more sanctioned than an automated browser.
What it removes is fragility, not exposure.


### Turning it on

```bash
openssl rand -hex 32   # a SECOND token, for WA_TRANSPORT_TOKEN
```

Set `WA_TRANSPORT_TOKEN` and `WA_TRANSPORT_URL=http://whatsapp-transport:8100` in
`.env`, then bring it up and link the account. This consumes one of WhatsApp's
four linked-device slots:

```bash
docker compose up -d --build whatsapp-transport
curl -sN -H "Authorization: Bearer $WA_TRANSPORT_TOKEN" \
  http://127.0.0.1:8100/pair/qr        # server-sent events; the code rotates
```

Each `data:` line carries a fresh code — WhatsApp rotates it every ~20 s, which
is why this is a stream and not a single response. Render one as a QR and scan it
under **Linked devices**, or use the code-based flow instead:

```bash
curl -s -X POST -H "Authorization: Bearer $WA_TRANSPORT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"phone":"<your number, E.164>"}' \
  http://127.0.0.1:8100/pair/phone
```

Then confirm the bridge is draining:

```bash
curl -s -H "Authorization: Bearer $WA_BRIDGE_TOKEN" \
  http://127.0.0.1:8099/transport/status
```

`WA_TRANSPORT_URL` is required. There is no second path to fall back to, so
leaving it unset means the bridge has no way to receive anything and the
`/transport/*` routes answer `503`.

**Do not restart the transport while the phone still says "Logging in".** Pairing
completes only after the new session stays connected long enough to finish its
first login; tearing it down before that abandons the registration, and the next
connect is refused with `401 logged out from another device` — which whatsmeow
treats as a logout, deleting the session and wasting the scan.

### Two things to know before you rely on it

**A gap is reported, never silent.** The outbox holds 50,000 messages by default
and discards the oldest beyond that. Whatever it discarded is counted
permanently and reported on every drain, and the bridge logs it loudly, because
the alternative — an archive that is missing a week and looks merely quiet — is
the failure that cannot be detected after the fact.

**Some chats arrive twice, on purpose.** When the protocol has not yet given this
account a stable key for someone, the transport supplies a provisional one
derived from a digest (never their phone number). If a stable key arrives later,
that is a second chat row for the same person, and **nothing in the payload links
the two** — so the archive holds both and reports the count via
`/transport/status` rather than merging them on a matching display name. Merging
on a self-asserted name that two people can share would be a guess about whose
correspondence belongs to whom.

**Names arrive late.** whatsmeow caches its LID map on first use, and a cache
filled seconds after pairing is filled empty — every contact then resolves to a
provisional `pn:` digest instead of the durable key its messages carry, and the
two never join. Restarting the transport once history sync has settled refills
the cache; contacts flip from provisional to LID-keyed, and names start
resolving. History-sync messages also carry no push name at all, so chat labels
come from the contact store instead (see `Dispatcher.nameFor`).

**What could not be described is named, not just counted.** `/transport/status`
reports `events.unrecognisedTypes`: a tally of the protobuf arms this build has
no vocabulary for, keyed by protocol field name and carrying no correspondence.
The bare count that preceded it reached 446 on a real archive while saying
nothing about *what* those messages were, so the gap could not be prioritised —
the tally turns that number into a ranked list of what to implement next.

**One person, one row.** whatsmeow's contact store is keyed by JID and a person
routinely holds two — their phone JID and their LID — which resolve to the same
identity. `/contacts` collapses them, because two rows for one person make that
contact *unaddressable*: the resolver refuses them as ambiguous rather than
guessing. On the account this was built against, that was 108 of 479 contacts.

Your existing archive is migrated in place on first start (schema v1 → v3; v3
adds `messages.target_key` — what a reaction, vote or pin is *about* — and
`messages.unknown_type`).

## Setup

```bash
cp .env.example .env
openssl rand -hex 32   # paste into WA_BRIDGE_TOKEN
```

Set `ANTHROPIC_API_KEY`. Leave `WA_ALLOW_SEND=false` for now — read-only is the
right way to start.

```bash
docker compose up -d --build
```

### Link your account

The bridge starts logged out. Publish its port temporarily, scan, then stop
publishing:

```bash
docker compose port whatsapp-bridge 8099   # or add a temporary ports: mapping
curl -s -H "Authorization: Bearer $WA_BRIDGE_TOKEN" \
  http://127.0.0.1:8099/qr -o qr.png
```

Open `qr.png`, then on your phone: **WhatsApp → Settings → Linked devices →
Link a device**. Confirm:

```bash
curl -s -H "Authorization: Bearer $WA_BRIDGE_TOKEN" http://127.0.0.1:8099/status
# {"state":"logged_in"}
```

The session persists across restarts on the volume. WhatsApp expires linked
devices after a long idle period, so expect to re-scan occasionally.

## The web UI

`http://127.0.0.1:3000/ui`, behind `WA_UI_USERNAME` / `WA_UI_PASSWORD` — the same
credential and the same auth walk as the agent's API, because an endpoint that
can read and send your WhatsApp must not have a second, weaker door.

Five screens, and the unit of all of them is a **decision**, not a metric:

| Screen | What it is for |
|---|---|
| **Queue** | Everything waiting — proposals, overdue promises, unanswered questions, what someone owes you — each with the conversation, the twin's two halves, and the actions that close it |
| **Setup** | Eight gates in the order they can actually be satisfied, ending in a live QR you can scan |
| **Preferences** | Every switch that is safe to change from a browser, with what it costs stated on the row |
| **Edit & send** | The one moment the phone cannot give you: a draft, who it resolves to, and everything sending will do |
| **Tools** | Which of the 37 tools the model can reach right now, and why the rest are dark |

**A quiet day is an empty queue.** Not four zeroes — nothing. A page that always
has something on it turns every friendship into a backlog, which is the same
reason the daily digest sends nothing on a quiet day.

**Both halves of the twin stay apart.** *Measured* is arithmetic over rows that
were really read; *read* is a model's reading of the same messages. The agent is
required to say which one it is speaking from, and on this screen that stops
being a rule and becomes a layout.

**The queue can send, and that is the point.** `twin/proposals` exists because
something has to decide, and until now the only place to decide was the phone.
The allowlist is unchanged and still enforced by the bridge — this page is
another caller of `POST /send`, not a way around it. Two things it deliberately
does not have: a free-text "message anyone" box, so every send starts from a
conversation with its context on screen, and bulk actions, because accepting
four proposals with one click is how this becomes a machine that talks to your
friends on your behalf.

### Pairing from the browser

The transport streams a fresh QR payload every ~20 seconds. The bridge proxies
that stream (`GET /transport/pair/qr`) and the agent re-encodes each payload as
a module matrix the page paints — so the QR codec lives on one side of the wire
and the browser only draws cells. The agent never holds `WA_TRANSPORT_TOKEN`:
proxying one stream is strictly narrower than handing over a credential that
also sends messages.

Phone-number pairing is on the same screen and needs no QR at all.

### What Preferences can and cannot write

It writes `.env` — the same file the rest of this README tells you to edit —
because a settings table in `store.db` would be a second source of truth that
disagrees with the file the moment anyone edits it by hand. The edit is
surgical: the line for a key is replaced and every comment survives, since
`.env.example` is largely an explanation of what each switch costs.

Two limits are structural rather than incidental:

- **Only feature switches.** The writable set is `agent/lib/ui-settings.ts`:
  the send gate and allowlist, retention windows, third-party endpoints and
  their keys, the model id. Never `WA_UI_PASSWORD`, `WA_BRIDGE_TOKEN`,
  `WA_TRANSPORT_TOKEN`, a service URL, or a provider key. A UI that can rotate
  the secret guarding it, or point the agent at a different bridge, is not a
  settings page. `test/ui-settings.test.ts` asserts their absence.
- **A save changes the next start, never the running process.** Writing a file
  cannot change a live process's environment, so every row shows what is *in
  force* alongside what is *saved* and names the service to restart. A screen
  that reported a send allowlist which was not being enforced would be the most
  dangerous possible lie for this particular page to tell.

Drop the `./.env:/app/.env:rw` mount from `docker-compose.yml` and the screen is
read-only: it still reports everything, and every save is refused with a message
saying why.

## Self-notes

The agent can write to **your own chat** — drafts, summaries, transcripts,
reminders — so they land on your phone and you copy-paste them into the real
conversation yourself. Nothing reaches anyone else, so there is no allowlist and
no confirmation step.

There is nothing to configure about *which* chat is yours. The transport
addresses the account's own JID, read from its device store and never taken from
a caller, so no name is resolved and nothing can be mis-resolved.

That is a real change. The old path typed the chat's title into a search box and
clicked the first result, so `"Joao"` could open `"Joao Antunes"` — and the whole
safety argument was a strict comparison against `WA_SELF_CHAT_NAME` to catch it.
`POST /send/self` cannot address anyone else in the first place.

`WA_ALLOW_SELF_NOTE=false` switches self-notes off outright; that switch is now
the only gate.

## The self chat is a console

Your own chat is a notebook by default — write a note and nothing answers, which
is the point. Send `/menu` and it becomes a console:

```
📋 *What I can do here*

📋 *Session*
  `/menu` — List everything available here.
  `/quit` — Exit the state you are in and come back to the notebook.

🎮 *Games*
  `/game` — Enter a match. Reply with a cell number, 1–9. `/quit` abandons it.

🤖 *Agent*
  `/eve` — Send what you type straight to the agent until you `/quit`.

🗂 *Archive*
  `/status` — How much correspondence is held, and whether the transport is live.
```

**You enter and exit states.** A state captures the conversation: inside `/game`
a bare `5` is a move, and inside `/eve` it is a question for the agent. Outside
both it is a shopping note and nothing replies to it. Entering one state from
another leaves the first, because two open sessions in one chat would make the
next `5` ambiguous.

**The console is not the only thing that can answer this chat.** The agent also
has a scheduled tic-tac-toe (`ttt`, `agent/schedules/tictactoe.md`), which keeps
its board in the chat as a `#ttt` token rather than in a session file. Both read
a bare digit as a move, so `GET /self/chat` reports the open console state and
the scheduled game stands down whenever there is one — whoever is in a session
owns the keyboard. That game also takes one turn at a time and drops a turn it
finds already answered, which is what stops the same board being posted twice.

**A match is a session driven by events.** One arriving message is one event; the
board lives in the session, not in the model, and a decided match exits by itself
so the chat is a notebook again without your typing `/quit`. The session is
written to `console-session.json` beside the archive on every transition — not
into `store.db`, which is your correspondence, and a half-finished game is not
correspondence. A restart therefore resumes the match instead of abandoning it
with the board still sitting in the chat inviting a move.

**The state is signalled twice, on purpose.** Every reply carries its category's
emoji, and entering a state also sends a block of that category's colour as an
image. The emoji marks a line; the image marks the moment. A line of text is easy
to scroll past and easier to miss in a notification preview, and entering a state
is the one moment you must not be confused about — everything you type next is
read by it. The block is generated in `src/swatch.js`, a hand-written PNG encoder
of about sixty lines, because adding an image library to draw a rectangle to a
service that has no dependencies would be the mistake this project just undid by
deleting Playwright.

Rules, legality and the opponent are code (`src/plugins.js`), never the model:
the machine wins if it can and blocks if it must, but it is not solved, because a
game you cannot win is not a feature. `/eve` is the only state that reaches a
model, and it is explicit — the bridge queues what you typed at `/self/pending`
and the agent answers through `/send/self`. The queue exists because the
direction of this system is fixed: the agent calls the bridge and never the
reverse, and the bridge holding the agent's password to push a message would
invert that for one feature.

## Media

Every message row is classified and **none are dropped**. Voice notes, photos and
PDFs used to vanish before the agent saw them, so a chat full of them read as a
quiet chat. Now they arrive as placeholders — `[voice note · 3:42]`, `[image]`,
`[document · escola.pdf]` — and the agent can open them:

- `whatsapp_view_media` returns the picture or PDF itself to the model.
- `whatsapp_transcribe_voice` turns a voice note into text.

### Transcription endpoint

A model cannot listen, so voice notes need an OpenAI-compatible
`/audio/transcriptions` endpoint. `.env.example` ships pointed at OpenAI; add the
key and it works:

```bash
WA_TRANSCRIBE_URL=https://api.openai.com/v1/audio/transcriptions
WA_TRANSCRIBE_MODEL=gpt-transcribe
WA_TRANSCRIBE_KEY=sk-...
```

**This uploads private correspondence to OpenAI** — voice notes from people who
did not agree to it. If that is the wrong trade, point the same variable at a
local whisper server and nothing leaves the machine:

```bash
WA_TRANSCRIBE_URL=http://127.0.0.1:8080/v1/audio/transcriptions
WA_TRANSCRIBE_MODEL=whisper-1
```

A non-local endpoint with no key is refused up front, rather than downloading the
audio first and collecting a 401. Leave the URL unset and voice notes stay listed
but unread — a working state.

Transcripts are **stored against the message they came from** when that chat has
been archived, so the archive holds words instead of `[voice note · 3:42]` and
the same voice note is never uploaded to a transcription provider twice. A chat
that was never archived has no message for the transcript to cite; the tool says
so and still returns the text.

Media is addressed by **position from the end** of the chat, because this build of
WhatsApp Web renders no stable per-message id. That is racy — one new message
shifts every index — so the fetch also carries the `kind`, `from` and `time` that
were read, and the bridge refuses if the row there has changed. A refusal is the
guard working: read the chat again and use the new position.

If a row's kind cannot be identified it is reported as `unknown` rather than
dropped. Inspect it with `/archive/messages` and extend the signal table in
`whatsapp-bridge/src/message-kind.js`.

## Making documents, not just messages

Some answers are a page: a week on one sheet, a price list, a menu for a door, a
diagram. The `frameforge` skill wires the agent to
[FrameForge](https://github.com/pedroanisio/frameforge), a document renderer that
runs as its own MCP server. The agent authors the page in FrameForge's Python
SDK, renders it, **looks at the rendered PNG**, corrects it, and sends the result
into WhatsApp with `whatsapp_deliver_render`.

It is off by default and touches no WhatsApp credential. To turn it on:

```bash
# 1. Build the image from the FrameForge checkout (a separate repository)
cd /path/to/frameforge && make docker-build     # tags `frameforge`

# 2. Start the stack with the profile
cd /path/to/whatsapp-agent
docker compose --profile frameforge up -d
```

FrameForge's own distribution speaks stdio, and an eve connection needs a URL, so
`scripts/frameforge-http.py` asks FastMCP for its HTTP transport and nothing
else — FrameForge itself is unpatched. Compose mounts that script into the stock
image; run it directly to serve a renderer outside the stack (`--host`, `--port`,
`--allowed-host`, and it refuses to bind every interface without being told to).

The renderer and the agent share one volume: renders land in
`/work/sessions/<id>/` and the agent reads the finished page from the same path,
so nothing is copied over the wire. **That volume is the delivery path**, not an
optimisation — a renderer running somewhere the agent cannot read files can
render everything and deliver nothing.

The service is not published to the host at all: it runs model-authored Python in
a subprocess (`"sandboxed": false`, by FrameForge's own report), so the internal
network is its only reachable surface. Point `WA_FRAMEFORGE_MCP_URL` anywhere
else and that reasoning stops holding — give it a token, and mount its session
root here.

**A render that succeeded is not a render that is usable.** FrameForge measures
what a thumbnail cannot show: objects that painted no ink, text below the
contrast floor, text stacked on text, content clipped off the edge of its frame.
`whatsapp_deliver_render` re-reads those diagnostics from disk before sending and
refuses a defective page — the model's own opinion of the picture it just looked
at is not the gate (PALS's Law). `force: true` sends anyway and reports what was
overridden, so an intentional overlap is possible and a quiet one is not.

The tools the model sees are a filtered subset — author, render, verify, read an
artifact. FrameForge ships thirty-five, most of them a computer-vision lane for
turning screenshots back into vectors; the allowlist is in
`agent/connections/frameforge.ts`, and adding to it is meant to be a decision.

Configuration lives in the `frameforge` section of `.env.example`.

## Generating a picture

A page is not the same request as a picture. When what is wanted does not exist
yet — an illustration for a message, a sticker, a logo, a card — the
`image-generation` skill draws one with OpenAI's image model.

It is two tools, and the split is the design. `whatsapp_generate_image` draws the
picture, stores it, hands it back as a content part and **sends nothing**;
`whatsapp_send_image` sends the stored image by its id. The gap between them is
where the model looks at what it made.

That gap is the verification layer (PALS's Law). A generated image *is* model
output and fails the way model output fails — text in the picture comes out
misspelled or as letter-shaped noise, counts come out wrong, things appear that
nobody asked for — and the API reports none of it, because the response is a
`200` with a picture in it. There is no diagnostic to read here as there is for a
render, so the check is the looking, and a tool that generated and sent in one
call would have sent the picture before anyone could look.

What *is* checked in code is the envelope: the response is decoded rather than
forwarded, and bytes that are not a PNG, JPEG or WebP — a link instead of a
payload, an empty string, an error page from something in front of the API — are
refused before they can become a broken attachment on somebody's phone.

Sending to the user's own chat is unremarkable; sending to anyone else pauses for
approval, because a generated image arrives in the same bubble a photograph
arrives in and the recipient has nothing to tell them a machine drew it. That is
the user's call, so they see it first. Pictures of real people are out of scope
by instruction, and anything whose words must be correct is a document, not an
image — image models cannot spell.

Set `OPENAI_API_KEY` and it works; leave it unset and the tools are simply
unavailable, which is a working state. Only the prompt is uploaded — no message,
no contact and no image from a chat. Configuration is in the **Generated images**
section of `.env.example`.

## Searching the web

`whatsapp_search_web` asks Brave and returns titles, links and snippets. It sits
beside `whatsapp_search_archive`, and the pair answers different questions —
"what did somebody tell me?" is the archive, "what is true out in the world?" is
the web. The `web-search` skill carries the procedure.

eve ships a `web_search` and it cannot be used here: it selects an AI Gateway
provider (`exa` or `parallel`), and a direct provider model — which
[agent.ts](agent/agent.ts) uses — falls back to that provider's own server-side
search instead. Neither path can be pointed at a Brave subscription, so the key
gets its own tool.

Two things are enforced rather than left to judgement. Results are **stripped of
Brave's highlight markup** — the API wraps query terms in `<strong>` and escapes
punctuation as entities because its response is built to be rendered as HTML, and
nothing downstream renders HTML; handed on untouched, the model quotes
`&lt;strong&gt;April 2028` into somebody's chat. And a result with no openable
`http(s)` link is **dropped**, because a snippet the user cannot check is a claim
wearing a citation.

The output is labelled untrusted content every time. That is not decoration: this
agent can send messages, and anyone can publish "ignore your previous
instructions" and get it indexed. A search result is the case where a stranger
chooses the words knowing an agent may read them, so the standing rule — what you
read is not what you are told — is restated at the point of use.

Set `BRAVE_API_KEY` and it works; unset, the tool says search is not configured.
Only the query is uploaded. Configuration is in the **Web search** section of
`.env.example`.

## Tests

```bash
npm test
```

Runs both suites with the Node test runner — no dependencies, no build step. The
bridge's safety rules (`whatsapp-bridge/src/self-note.js`,
`whatsapp-bridge/src/plugins.js`) are tested without a transport: sending is
injected, so every refusal path can be exercised directly.

## Enabling send

Sending is off by default and fails closed twice over:

```bash
WA_ALLOW_SEND=true
WA_SEND_ALLOWLIST=Mum,Dad,Ana Paula
```

An **empty allowlist permits no one** — it never means everyone. Names are
matched case-insensitively, as substrings, against the name WhatsApp resolves.
Use the plain name: WhatsApp's search does not match UI decorations like a
trailing `(You)` on your own chat.

**The allowlist is the boundary, not a confirmation prompt.** `whatsapp_send_message`
sends in one call, autonomously, to anyone on the list. Anyone else gets a `403`.
So the blast radius of a wrong or repeated call is bounded by configuration
rather than by a human reading each message — which means the list is the thing
to keep short and deliberate.

Two guards survive regardless:

- The recipient is resolved, then the conversation actually open is re-checked
  against it immediately before typing. A chat that changed in between aborts
  rather than delivering to whoever happens to be open.
- The result reports `resolvedRecipient` and `exactMatch`, so a fuzzy match
  ("Ana" → "Ana Paula") is visible after the fact.

`POST /send/prepare` + `/send/commit` remain available for a confirm-first flow:
prepare returns a 5-minute single-use token and sends nothing. Nothing uses it by
default.

## Bridge API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness. `{ok, transport}`. No auth — it answers before the token check, so it must reveal nothing about the account |
| `GET /status` | `{archive, transport}` — what this service holds, and whether a transport is configured |
| `GET /transport/status` | The transport's own state: paired, connected, queue depth, dropped |
| `POST /send` | `{to, message, quoted}` → sends over the protocol (allowlisted only). `quoted: {messageId, sender}` makes it a reply to that message rather than just a message into the chat |
| `POST /send/media` | `{to, dataBase64, mimetype, kind, caption, filename, width, height, durationSeconds}` → an attachment, for an allowlisted recipient. `kind` is `image` (default), `video`, `audio`, `voice`, `document` or `sticker` |
| `POST /send/reaction` | `{to, messageId, emoji}` → reacts to a message. An **empty** emoji removes the reaction; that is WhatsApp's own way of undoing one, not a missing field |
| `POST /send/revoke` | `{to, messageId}` → deletes a message for everyone |
| `POST /send/edit` | `{to, messageId, message}` → replaces the text of a message already sent |
| `POST /send/poll` | `{to, name, options, selectableCount}` → asks a question with fixed answers. At least two options |
| `POST /send/poll/vote` | `{to, messageId, options}` → votes in a poll. `messageId` names the **poll**; the vote is encrypted against that poll's own secret, so a poll this account never received answers `422` rather than sending a vote nobody can read |
| `POST /presence` | `{to, state}` → `composing` or `paused`. Allowlisted like a message, because it is a signal this account emits into somebody's chat |
| `POST /send/self` | `{messages}` → writes to your own chat. No allowlist: the transport addresses the account's own JID from its device store, so there is no recipient to get wrong |
| `POST /send/self/media` | `{dataBase64, mimetype, kind, caption, ...}` → an attachment to your own chat, same kinds as `/send/media` and the same absence of an allowlist |
| `GET /self/chat` | Which chat is yours, as an identity key |
| `GET /self/pending` | What you typed in `/eve` mode, for the agent to answer. Drains on read |
| `GET /media?key=` | One message's media, by the protocol's own message id |
| `POST /history` | `{chat, oldestId, oldestTimestamp, count}` → ask your phone for older messages |
| `GET /archive/search` | Keyword search, with `sender` / `since` / `until` / `kind` / `outgoing` / `order` |
| `GET /archive/stats` | Counts **and `span`** — the oldest and newest message the archive holds, the days between, and how many messages carry no usable timestamp and so fall outside that range |
| `GET /archive/extractions` | Obligations, with `since` / `until` windowing **when something was said** (`dueBefore` windows when it is due — a different question) |
| `GET /archive/facts` · `POST /archive/facts` | Facts, each citing a message. Retracted ones are excluded |
| `POST /archive/facts/retract` | `{id, reason}` → withdraws a fact. A tombstone, not a delete; a reason is required |
| `POST /archive/facts/restore` | `{id}` → undoes a retraction made in error |
| `GET /archive/prune` · `POST /archive/prune` | Apply the retention policy. **Defaults to a dry run** — pass `{"dryRun": false}` to actually delete |
| `GET /archive/transcript` · `POST /archive/transcript` | A voice note's transcript, filed against its message |
| `GET /people/dossier?name=` | One person: activity, aliases, facts, obligations |
| `GET /people/aliases?origin=` | Every alias and where it came from — which nicknames the agent taught itself |
| `GET /twin?chat=` | One conversation's twin: measured behaviour, arcs, goals, contexts, staleness |
| `POST /twin/model` | One modelling pass. Rejected whole if any item cites an unread message |
| `GET /twin/stale` | Which twins have fallen behind the archive |
| `GET /twin/proposals` · `POST /twin/proposals` | Proposed next moves. Reaches nobody — proposals are rows |
| `POST /twin/proposals/resolve` | `{id, status}` → accepted / dismissed / expired |
| `POST /twin/arcs/resolve` | `{id, status}` → open / stalled / resolved / abandoned |

All except `/health` need `Authorization: Bearer $WA_BRIDGE_TOKEN`.

## Known limits

- **Selectors are unversioned.** WhatsApp Web ships obfuscated classes that
  change without notice. Every hook lives in `src/selectors.js` as an ordered
  list of candidates, so a rename degrades one selector instead of breaking the
  service — but a redesign will eventually need edits there. Archiving asserts
  the hooks it depends on before it walks a chat and refuses with a `503` naming
  the dead one, because the alternative failure is silent: a broken `messageRow`
  reads every conversation as empty and reports the archive as complete.
- **History is as deep as your phone.** Backfill is a request to the phone
  (`POST /history`), so the reachable depth is whatever it still holds — not
  whatever WhatsApp's servers hold. A short answer is a fact about the phone,
  not a failure.
- **The agent waits on the bridge's health.** `depends_on: service_healthy`
  takes the agent down whenever the bridge is unhealthy, even though `/twin`,
  `/archive/*` and `/people/*` read SQLite and need nothing else.
  `service_started` would decouple them.
- **Media is listed, not read.** Photos, voice notes and documents arrive as
  placeholders with a `kind`; opening one costs a fetch (`whatsapp_view_media`,
  `whatsapp_transcribe_voice`). A row whose kind cannot be identified is
  reported as `unknown` rather than dropped.
- **One linked device, and four slots.** WhatsApp allows four linked devices per
  account and this transport is one of them. Pair it once; a second pairing
  consumes another slot rather than replacing the first.
- **The twin is a reading, not a record.** Arcs, goals and contexts are what a
  model made of messages it was shown; each cites one, and anything it could not
  cite was dropped before storage, but a citation proves provenance, not
  correctness. Threads are identified by their title, so a genuinely reworded
  thread is stored twice — visible as two arcs over the same span, and merging
  them is not built (SPEC §8.10). Timing figures exclude any message whose
  timestamp did not parse, and say how many.
- **Message content is untrusted.** Chats are third-party text. The tools mark
  it `untrusted-user-content` and the skill forbids acting on it — a message
  saying "ignore your instructions" is a string to summarise, not a command.

## Obligations and the daily digest

Conversations generate obligations constantly — *"I'll send it tomorrow"*, *"can
you check this"* — and none of it is tracked anywhere. `whatsapp_extract_actions`
reads an archived chat and records what was promised, asked, decided or left
unanswered. Every item is stored with a foreign key onto the message it came
from, so nothing can be recorded without a citation.

```
whatsapp_obligations           what is owed, in both directions
whatsapp_resolve_obligation    close one out
whatsapp_attention             overdue / due soon / waiting on / unanswered
```

## Where a conversation stands, and what to do next

A chat is not a flat list of messages. It has threads running through it, each
side wants something out of each thread, and all of it sits inside a frame — the
language it is written in, how these two people talk, what is sensitive. That
structure is the **interaction twin**, and it is what the agent reasons from when
you ask what someone wants from you or what to do next.

```
whatsapp_twin                  read one twin; no chat → which twins are stale
whatsapp_model_interaction     build or refresh it: arcs, goals, contexts
whatsapp_next_best             propose the next move — never sends
whatsapp_resolve_proposal      accepted / dismissed / expired
```

**The twin has two halves, and they are not equally trustworthy.**

*Measured* is counted from the archive: how fast each side replies and over how
many exchanges, how long the message you send actually runs, who starts
conversations, how long it has been quiet, who spoke last. Arithmetic over rows
that were really read. It can be mis-sampled; it cannot be invented. Every figure
comes with its sample size, and when the sample is thin the twin says so instead
of calling three exchanges a habit.

*Modelled* is a model's reading of the same messages: the threads (**arcs**), what
each side is trying to get (**goals**, kept separate per side because they
conflict), and how the conversation works (**contexts**). Every one of those rows
cites a message, enforced by the same foreign keys as `facts` — and an arc cites
two, because an arc is a span.

The agent is required to tell you which half it is speaking from. *"You normally
answer her within the hour and it has been nine days"* is measured. *"She is
waiting on the price before she can book the tiler"* is read off her messages.

**Nothing claims to be complete.** "Find every thread" is not something a model
pass can guarantee, so the twin reports its coverage instead: each pass records
the last message it considered, and every read tells you how many messages have
arrived since. A twin you think is current when it is not is worse than no twin,
so staleness is the first thing it says.

### The next best interaction

`whatsapp_next_best` reads the twin and proposes what to do: reply, follow up on
something owed to you, deliver something you owe, ask you a question it cannot
answer, or **wait**. Each move arrives with the reasoning behind it and the
messages it rests on, and a draft when a message is the right answer.

Three things it will not do:

- **It cannot send.** Proposals go to a table the send path does not read. A draft
  becomes a message only when you ask, through `whatsapp_send_message`, still
  behind the allowlist.
- **It will not manufacture a move.** No open thread and nothing outstanding means
  no proposal at all, and it does not even spend a model call finding that out. An
  assistant that always has a suggestion turns every friendship into a backlog.
- **It will not word a commitment for you.** A draft that names a price, fixes a
  time, apologises or promises is flagged as yours to word and routed to your own
  chat. That flag only ever tightens: the model sets it, and a keyword check in
  Portuguese and English raises it again regardless.

If you turn a proposal down, `whatsapp_resolve_proposal` with `dismissed` makes it
stick — suppressed where suggestions are generated *and* where they are stored, so
the same idea does not come back next week.

`agent/schedules/twin-refresh.md` runs on Sunday at 12:00 UTC: it refreshes at
most five drifted twins, and writes one self-note only if something is genuinely
waiting on you. Modelling reads the archive only, so nothing in that run touches
WhatsApp except the note itself.

## People, and what you know about them

`whatsapp_person` answers "what's going on with Fabio" from the archive alone:
how much of the conversation is saved, which nicknames resolve to him, the facts
remembered about him, and what each of you owes the other — kept in separate
lists, for the same reason the digest keeps them apart.

`whatsapp_remember_fact` is how something gets remembered, and it **must cite the
message that says it**. The store enforces that with a foreign key, so a fact the
agent merely inferred has nothing to hang off and is refused. That is the feature,
not a limitation: it is what makes *"why do you think that?"* answerable with a
sentence somebody actually wrote.

Identity here is the **chat name**, not an id. WhatsApp Web renders no contact id
and exposes no contact list, so there is nothing stabler to key on; aliases
(`whatsapp_remember_alias`) collapse the nicknames you actually say onto it, and
a name matching two chats equally well is reported as ambiguous rather than
guessed.

The two directions stay separate throughout. What you owe and what you are owed
need different actions — work to do versus a follow-up to send — and merging them
gives you a backlog that reads as failure while burying the items that are
actually someone else's move.

### Provenance proves traceability, not truth

The foreign key guarantees a fact cites a message that was really read. It cannot
guarantee the message was true. Anyone in any group chat can write a false
statement, and a false statement that genuinely is in the archive passes every
check the store makes — then reads back as a *cited* fact with a receipt, which is
**more** persuasive than an uncited one, not less. Three things follow.

**Facts can be withdrawn.** `POST /archive/facts/retract` takes an `id` and a
required `reason`. Retracted facts stop appearing in recall immediately. The row
is kept rather than deleted, because *"why did I believe the tiler was booked?"*
gets asked **after** the belief turns out to be wrong, and deleting the row makes
it unanswerable — the fact that misled a decision is exactly the one that would
have been removed. `WA_RETAIN_RETRACTED_FACT_DAYS` eventually clears them.

**Every stored claim says whose words it came from.** Facts, goals and contexts
all report `source_outgoing`: `1` when the citing message was one *you* sent, `0`
when somebody else wrote it. A belief read off a third party's message in a group
chat is a different kind of object from one read off your own note to yourself,
and until this was on the row they were indistinguishable at read time. It is
resolved by joining the cited message rather than stored alongside it, so it
cannot drift from its own citation.

**Aliases carry provenance too.** `whatsapp_remember_alias` now requires the agent
to say whether *you* stated a nickname (`origin: "session"`) or whether it worked
it out from chat text (`origin: "message"`, which must cite the message, exactly
as a fact must). An alias learned from a chat is message content influencing which
conversation gets opened, one step removed — and the rule everywhere else here is
that no message content may select a recipient. It stays permitted, because a
nickname read from a chat is often right; it is permitted **on the record**.
`GET /people/aliases` lists them with their origin, which answers "which of these
did the agent teach itself?". Aliases that predate the column read as `unknown`
rather than being back-filled as `session`, because nobody knows that they were.

The allowlist was never the weak point: the canonical name an alias produces still
has to pass `assertSendable`, and that check runs on the chat that actually
opened, so no alias can widen who may be messaged. But *cannot widen the
allowlist* is not the same as *trustworthy*, and only one of those was previously
legible.

### Retention

The archive is the most sensitive artifact this system creates, and until
recently it was the one restraint layer with nothing behind it: `SPEC.md` §4
argues for not storing media bytes because there is "several orders of magnitude
more to lose", and then kept message text, transcripts, facts and arcs forever.

Three windows, configured in `.env` and documented there: messages,
transcripts (usually sooner — a transcript is a verbatim copy of somebody's
voice), and retracted facts (soonest). **Unset means keep forever**, and so does a
negative or unparseable value, because a typo that deletes an archive cannot be
undone. `0` is honoured and means keep nothing.

Nothing runs on a timer. `POST /archive/prune` applies the policy and **defaults
to a dry run** — it reports what it would remove and removes nothing unless you
pass `{"dryRun": false}`. The dry run is the same statements rolled back rather
than a separate counting query, so its prediction cannot disagree with the real
run.

Pruning **cascades**: removing an old message takes the facts, transcripts,
extractions, arcs, goals, contexts and modelling passes that cited it, and empties
the chat row if nothing is left. That follows from the store's own rule rather
than from convenience — a claim whose evidence is gone is the uncitable claim
`addFact` refuses to accept. Run a dry run first and read the per-table counts.

### Upgrading an archive you already have

The schema is versioned (`PRAGMA user_version`), and opening an existing archive
migrates it in place: new columns are added, existing rows are preserved, and the
whole step is one transaction, so a failure leaves the file exactly as the
previous build left it. Nothing to run by hand.

This matters more than it sounds. `CREATE TABLE IF NOT EXISTS` does nothing to a
table that already exists, so a new column would otherwise reach only databases
created after it shipped — and since every test opens an in-memory database, that
failure passes the whole suite and appears only on the machine holding real data.
`whatsapp-bridge/test/migrations.test.js` builds an archive the way the previous
version did, with rows in it, migrates it, and asserts the result is identical to
a freshly created one.

### The daily digest

`agent/schedules/daily-attention.md` runs at 11:00 UTC (08:00 in São Paulo) and
writes one self-note to your own chat.

Two deliberate constraints in that schedule:

- **A quiet day sends nothing.** A digest that reports "nothing to report" every
  morning is one you stop reading by week two.
- **It never touches WhatsApp.** It reads only what is already archived. Spending
  browser interactions *on a timer* — crawling chats every morning whether or not
  anything happened — is activity uncorrelated with any real event, which is the
  pattern that looks automated.

Reacting to a message that actually arrived is a different case, and it is what
[the inbox watcher](#reacting-to-messages) does.

Neither is incidental: a scheduled run is eve *task mode*, which cannot pause to
ask a person anything. Everything it does must be safe without approval, and the
self-note — one recipient, yourself — is the only delivery that qualifies.

Schedules do not fire under `eve dev`; a built app under `eve start` runs them.

## Reacting to messages

Reception is push, and always on. The transport holds the protocol socket, so a
message arrives as an event rather than as the result of a poll — into a durable
outbox, which the bridge drains into the archive every five seconds
(`WA_TRANSPORT_DRAIN_INTERVAL_MS`).

This is what replaced the browser's `MutationObserver` on `#pane-side`, and the
difference is not just mechanical. Detection used to be free but reacting was
not: topping up a chat meant opening it in a real browser, which was an
unattended interaction and part of the automation footprint that gets accounts
banned. It had to be rationed four ways — a cooldown, a chat cap, a scroll cap
and quiet hours — all of which existed to bound a cost that no longer exists.
Draining a queue costs nothing WhatsApp can see.

What still runs on arrival is the self-chat console: every drained message is
offered to the router, which answers only in your own chat and only when you
have entered a state. See *The self chat is a console*.

