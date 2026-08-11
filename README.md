# whatsapp-agent

An eve agent with access to your personal WhatsApp, through a long-running
Playwright session on `web.whatsapp.com`.

## Disclaimer

This work is subject to the methodological caveats and commitments described in [@DISCLAIMER.md](./DISCLAIMER.md).
> No statement or premise not backed by a real logical definition or verifiable reference should be taken for granted.

## Read this first

**This violates WhatsApp's Terms of Service.** Automating WhatsApp Web with a
browser driver is not a supported integration, and accounts doing it are banned
at WhatsApp's discretion — permanently, with no appeal, on the number you use.
The official route is WhatsApp Business Cloud (`eve add channel/chat-sdk-whatsapp`),
but it only reaches business messaging, never your personal chats. If you want
your own conversations, this is the only way, and the risk is real. Consider a
secondary number.

**The session profile is a credential.** `whatsapp-bridge/data/profile` (the
`whatsapp-profile` volume in compose) contains a linked session. Anyone who
copies that directory has your WhatsApp on their machine with no QR scan. It is
gitignored; keep it that way, and never bake it into an image.

## Why there are two services

The browser cannot live inside the agent. eve compiles to a Nitro server that is
replaced on every deploy, while a linked WhatsApp session is a stateful,
long-lived browser profile that survives exactly one login. So:

| Service | Holds |
|---|---|
| `whatsapp-bridge` | Playwright, Chromium under Xvfb, the linked session, a small HTTP API |
| `agent` | The eve agent; its tools call the bridge over the internal network |

The bridge is published on **loopback only** (`127.0.0.1:8099`), because linking
and health checks need host access. Every route but `/health` requires the
bearer token. Binding it to `0.0.0.0`, or tunnelling that port, puts a live
WhatsApp account on the network.

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

## Self-notes

The agent can write to **your own chat** — drafts, summaries, transcripts,
reminders — so they land on your phone and you copy-paste them into the real
conversation yourself. Nothing reaches anyone else, so there is no allowlist and
no confirmation step.

It needs to know which chat is yours. Open your own chat in WhatsApp, copy the
title from the conversation header verbatim, and set:

```bash
WA_SELF_CHAT_NAME="Joao (You)"
```

The comparison is **exact**. `"Joao"` will not match `"Joao (You)"`, and that
strictness is the point: the alternative is a fuzzy search that could open a
similarly-named contact and deliver a private draft to them. If the bridge
cannot confirm your chat is the one open, it refuses to type.

Leave `WA_SELF_CHAT_NAME` unset and self-notes are simply unavailable — that is
the intended default. `WA_ALLOW_SELF_NOTE=false` switches them off outright.

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
dropped. Inspect it with `/debug/rows` and extend the signal table in
`whatsapp-bridge/src/message-kind.js`.

## Tests

```bash
npm test
```

Runs both suites with the Node test runner — no dependencies, no build step. The
bridge's safety rules (`whatsapp-bridge/src/self-note.js`) are tested without a
browser: the page-driving parts are injected, so the refusal paths can be
exercised directly.

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
| `GET /health` | Is Chromium up? `{ok, browser}` — `starting` / `up` / `down`. `503` on `down`. No auth (it reveals nothing about the account). |
| `GET /status` | `logged_in` / `logged_out` / `loading` |
| `GET /qr` | PNG of the linking QR |
| `GET /chats?limit=` | Recent conversations |
| `GET /messages?chat=&limit=` | One conversation's recent messages |
| `POST /send` | `{to, message}` → sends in one call (allowlisted only) |
| `POST /send/prepare` | Stage `{to, message}` → token. Sends nothing. |
| `POST /send/commit` | `{token}` → sends |
| `GET /archive/search` | Keyword search, with `sender` / `since` / `until` / `kind` / `outgoing` / `order` |
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
| `GET /debug/screenshot` | PNG of the live page — the fastest "what is it looking at" |
| `GET /debug/selectors` | Live match count per selector candidate |
| `GET /debug/selector-health` | Are the hooks ingestion needs alive? `503` when not |
| `GET /debug/session` | Why the browser is down: launch error, attempt counts. Answers while wedged |
| `GET /debug/rows` | DOM shape of the first chat rows |
| `GET /debug/structure` | Ids, testids, header text, message-row markers |

All except `/health` need `Authorization: Bearer $WA_BRIDGE_TOKEN`.

## Known limits

- **Selectors are unversioned.** WhatsApp Web ships obfuscated classes that
  change without notice. Every hook lives in `src/selectors.js` as an ordered
  list of candidates, so a rename degrades one selector instead of breaking the
  service — but a redesign will eventually need edits there. Archiving asserts
  the hooks it depends on before it walks a chat and refuses with a `503` naming
  the dead one, because the alternative failure is silent: a broken `messageRow`
  reads every conversation as empty and reports the archive as complete.
- **Reading is a window, not history.** The chat list virtualises and only the
  visible tail of a conversation is in the DOM. The agent cannot say what
  someone never sent, only what is not in what it can see.
- **The browser starts lazily, and two knobs around that are unset by choice.**
  Chromium launches on the first request, not at boot, so between `compose up`
  and that request there is no session — `/health` reports `starting` and stays
  healthy, because failing there would trip `depends_on: service_healthy` and
  keep the agent from ever starting. Two consequences are deliberately left
  as they are, because both change deployment behaviour:
  an eager warm-up at boot would make the healthcheck meaningful sooner, and
  `depends_on: service_healthy` currently takes the *agent* down whenever the
  bridge's browser is down — even though `/twin`, `/archive/*` and `/people/*`
  read SQLite and need no browser at all. `service_started` would decouple them.
- **Media is listed, not read.** Photos, voice notes and documents arrive as
  placeholders with a `kind`; opening one costs a fetch (`whatsapp_view_media`,
  `whatsapp_transcribe_voice`). A row whose kind cannot be identified is
  reported as `unknown` rather than dropped.
- **One session per profile.** WhatsApp allows one web session per browser
  profile; this is a singleton by nature.
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

Off by default. `WA_WATCH_EVENTS=true` turns it on.

Everything above is pull: the agent sees WhatsApp only when you ask it something,
or when the 11:00 digest reads the archive. This is the part that reacts on its
own.

### Detection is free; reacting is not

SPEC §0.1 says there is no push — every observation is a poll. That is true of the
**transport**: WhatsApp Web offers no webhook to register. It is not true of the
**browser session the bridge already holds open**. `#pane-side` mutates in the
local DOM the instant a message lands in any chat, and a `MutationObserver`
reading that costs no clicks, no keystrokes and no navigation. Passive observation
is not an automation signal; actions are. So detection is unrationed and runs
continuously.

Reacting is the opposite. When an event fires the bridge opens the changed chat
and tops up the archive, which **is** an unattended browser interaction — a real
change to this project's risk posture, and one the daily digest still refuses. It
is bounded four ways, all enforced in the bridge rather than asked of the agent,
for the same reason the send allowlist is:

| Bound | Setting | What it prevents |
|---|---|---|
| Coalescing | — | Ten messages in a group becoming ten reads |
| Per-chat cooldown | `WA_EVENT_COOLDOWN_MINUTES` | An active conversation holding the session in a read loop |
| Quiet hours | `WA_QUIET_HOURS` | Activity at 04:00, which no explanation fixes |
| Fan-out cap | `WA_EVENT_MAX_CHATS` | An overnight backlog becoming a thirty-chat sweep |

Event reads draw from the same `WA_MAX_INTERACTIONS_PER_HOUR` budget as a
user-initiated archive. An event cannot buy extra interactions.

Quiet hours suppress the **notification** too, not just the read. Writing a
self-note opens a chat and types, so "just a quick note at 04:00" would produce
the exact activity the window exists to prevent — and ring your phone as a bonus.

### What actually happens

```
message arrives
  → #pane-side mutates          (free, continuous)
  → bridge diffs the chat list  (free — no clicks, no typing)
  → event queued in SQLite      (deduplicated by content)
  → inbox-watch fires, ≤15 min later
  → bridge claims, gates, tops up the archive for what it may open
  → agent writes ONE self-note, then acks the events
```

The queue is durable and content-addressed, so a restart loses nothing and a
double-fired observer produces one event. The agent acknowledges events only
*after* writing the note: crash in between and you are told late rather than
never.

Two things the watcher deliberately never infers. A row that vanished is not an
event — the pane is virtualised, so absence means scrolled-away or archived. And
the first snapshot after a restart emits nothing, or every already-unread chat
would fire at boot.

### Inspecting it

```sh
curl -s localhost:8099/events/status -H "authorization: Bearer $WA_BRIDGE_TOKEN"
```

Reports whether the in-page observer actually installed. Worth checking: an
uninstalled observer produces an empty queue, which is indistinguishable from a
quiet day unless something says so.

### What it does not do

- **It never sends to another person.** The only message a reactive run may write
  is the self-note. Replies stay a thing you ask for, through the two-phase send.
- **It does not read the message you got.** An event carries the chat-list
  snippet — 160 characters, sender prefix included. Where the archive was topped
  up the real text is searchable; where a cooldown held the read, the agent can
  only tell you something arrived and from whom.
- **It is not a command channel.** Self-chat text is ordinary untrusted input,
  never elevated privilege (SPEC §8, open question 9).
