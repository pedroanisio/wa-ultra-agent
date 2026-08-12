import { placeholderText } from "./message-kind.js";
import { buildDossier, resolvePerson } from "./people.js";
import {
  parseAliases,
  assertResolvedMatches,
  assertSendConfigured,
  assertSendable,
  normalizeName,
  resolveAlias,
} from "./recipients.js";
import {
  ENV as TRANSPORT_ENV,
  createTransport,
  drainOnce,
  resolveRecipient,
  startDrain,
} from "./transport.js";
import { openStore, retentionFromEnv } from "./store.js";
import { resolveChatAddress } from "./chat-address.js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CATEGORIES, IDLE, isOwnReply, mark, route } from "./plugins.js";
import { solidPngBase64 } from "./swatch.js";
import { assertSelfNoteConfigured, sendSelfNoteWith } from "./self-note.js";

/**
 * The bridge's core, on the protocol transport.
 *
 * Reception, sending, media and history all run through `whatsapp-transport`
 * (Go, whatsmeow). The browser driver this module used to be — Playwright,
 * Chromium under Xvfb, a rendered chat list and its selectors — is gone: it was
 * a second, weaker way to do the same things, keyed by fuzzy display names and
 * parsed dates rather than by the protocol's own ids and instants.
 *
 * The archive is unchanged. `store.js` remains the only writer of the
 * correspondence, and the drain below writes through the SAME handle as every
 * query here — a second `openStore` on one file would be a second writer to an
 * archive whose design rests on having exactly one.
 */

/**
 * The archive handle, opened once and shared.
 *
 * One handle, deliberately: the drain and every query here write and read
 * through the same connection, and a second `openStore` on the same file would
 * make two writers of an archive whose design assumes exactly one.
 */
let storeHandle = null;

function store() {
  storeHandle ??= openStore(process.env.WA_STORE_PATH || "./data/store.db", {
    // Only consulted for a window whose own rows cannot say whether "8/3" is
    // 3 August or 8 March. Evidence in the messages always wins.
    dateOrder: process.env.WA_DATE_ORDER,
  });
  return storeHandle;
}

/* ------------------------------------------------------------------
 * The protocol transport
 *
 * `whatsapp-transport` (Go, whatsmeow) receives messages over WhatsApp's own
 * multi-device protocol and queues them durably. This section is the bridge's
 * side of that hand-off. It is wired here rather than in server.js for one
 * reason: the drain must write through the SAME store handle as everything else.
 * A second `openStore` on the same file would be a second writer to an archive
 * whose whole design rests on having exactly one.
 *
 * All of it is inert unless WA_TRANSPORT_URL is set, so an installation that has
 * not adopted the transport is unaffected.
 * ------------------------------------------------------------------ */

let transportHandle = null;

/** Whether the operator has pointed this bridge at a transport at all. */
export function transportConfigured() {
  return Boolean(process.env[TRANSPORT_ENV.url]);
}

function transport() {
  if (!transportConfigured()) {
    const error = new Error(
      `No protocol transport is configured. Set ${TRANSPORT_ENV.url} (and ${TRANSPORT_ENV.token}) ` +
        "to the whatsapp-transport service to receive messages over the protocol instead of the DOM.",
    );
    error.statusCode = 503;
    throw error;
  }
  transportHandle ??= createTransport();
  return transportHandle;
}

/**
 * Pairing and queue state, plus what the archive knows that the transport cannot.
 *
 * `provisionalChats` is reported here because it is a gap only the archive can
 * see: the transport hands over `pn:` digests and LIDs with no link between them,
 * so a person may hold two chat rows and neither side alone can say so.
 */
export async function transportStatus() {
  const state = await transport().status();
  const unsettled = store().provisionalChats({ limit: 25 });
  return {
    ...state,
    archive: {
      provisionalChats: unsettled.length,
      // Names, never keys: this response is the most casually-logged thing here.
      provisional: unsettled.map((chat) => ({
        displayName: chat.display_name,
        messages: chat.messages,
      })),
    },
  };
}

/** Drain the queue once, now, rather than waiting for the next tick. */
export function transportDrain({ limit } = {}) {
  return drainOnce({ transport: transport(), store: store(), limit });
}

export function transportContacts() {
  return transport().contacts();
}

/**
 * One message's media, by the protocol's own id.
 *
 * Base64 here rather than at the transport: the wire between these two services
 * carries the bytes as bytes, and only the agent — which reads JSON — needs them
 * encoded. `sizeBytes` is the real length, measured before encoding, so a caller
 * bounding a download is not bounding base64's 33% inflation by mistake.
 */
export async function transportMedia(key) {
  const { bytes, mediaType, sizeBytes, filename } = await transport().media(key);
  return {
    key,
    mediaType,
    sizeBytes,
    ...(filename ? { filename } : {}),
    base64: bytes.toString("base64"),
  };
}

/**
 * Ask the phone for messages older than one already held.
 *
 * The chat is resolved for the same reason every other chat-taking entry point
 * resolves it: the transport addresses conversations by JID, the agent knows
 * them by name, and a name forwarded unresolved is a request the phone cannot
 * answer — which arrives back as "nothing older", indistinguishable from a chat
 * that really has nothing older. Same defect as the archive read; same fix.
 */
export function transportHistory({ chat, oldestId, oldestFromMe, oldestTimestamp, count }) {
  // Resolved BEFORE the transport is touched: a name that names nothing is the
  // caller's mistake either way, and reporting it as "no transport configured"
  // sends the reader to the wrong problem.
  const key = requireChatKey(chat);
  return transport().history({ chat: key, oldestId, oldestFromMe, oldestTimestamp, count });
}

export function transportPairPhone(phone) {
  if (!phone) throw badRequest("phone is required");
  return transport().pairPhone(phone);
}

/**
 * The rotating pairing code, as a live stream for something upstream to render.
 *
 * The bridge does not read it. It holds the transport's token and its consumer
 * — the agent's web UI — deliberately does not, which is the only reason this
 * proxy exists: rendering the code needs the stream, and handing out the token
 * that reaches it would give the UI the whole transport, sending included.
 */
export function transportPairQr(signal) {
  return transport().pairQrStream(signal);
}

export function transportConnect() {
  return transport().connect();
}

/**
 * The one gate every outbound path goes through.
 *
 * ── Why this is shared, having deliberately not been ────────────────────────
 * With two send paths the chain was written out twice on purpose, so each could
 * be read top to bottom and seen to be guarded — a wrapper would have hidden the
 * very omission that let a two-letter group name resolve to a person.
 *
 * That argument inverts at six. Repeating three checks across text, media,
 * reaction, revoke, edit and poll is not vigilance, it is six chances to leave
 * one out, and the omission would look exactly like the code around it. So the
 * chain lives here once, and `test/transport-send.test.js` drives EVERY exported
 * send function through the same near-miss to prove none of them skipped it.
 *
 * Returns the protocol address to send to.
 */
async function resolveAllowedRecipient(to) {
  assertSendConfigured();

  // The env alias map first, so "mãe" reaches the same person it would have
  // before, then the roster resolves whatever name that produced.
  const requested = resolveAlias(to);
  const { contacts, groupsUnavailable } = await transport().contacts();
  const resolved = resolveRecipient(requested, contacts, { groupsUnavailable });

  // The allowlist bounds WHO may be written to, and it is written in human names,
  // so it is checked against the name the roster matched — not against the key.
  assertSendable(resolved.matchedName ?? requested);

  // ...and this bounds whether the roster found the one that was asked for.
  assertResolvedMatches(requested, resolved.matchedName ?? "");

  return { to: resolved.to, resolvedName: resolved.matchedName };
}

/** React to a message, or remove a reaction with an empty emoji. */
export async function reactViaTransport({ to, messageId, emoji = "", sender }) {
  if (!messageId) throw badRequest("messageId is required");
  const resolved = await resolveAllowedRecipient(to);
  const result = await transport().sendReaction({ to: resolved.to, messageId, emoji, sender });
  return { ...result, requestedRecipient: to, resolvedName: resolved.resolvedName, via: "transport" };
}

/** Delete a message for everyone. */
export async function revokeViaTransport({ to, messageId, sender }) {
  if (!messageId) throw badRequest("messageId is required");
  const resolved = await resolveAllowedRecipient(to);
  const result = await transport().sendRevoke({ to: resolved.to, messageId, sender });
  return { ...result, requestedRecipient: to, resolvedName: resolved.resolvedName, via: "transport" };
}

/** Replace the text of a message already sent. */
export async function editViaTransport({ to, messageId, message }) {
  if (!messageId) throw badRequest("messageId is required");
  if (!message?.trim()) throw new Error("Refusing to edit a message to nothing — use revoke.");
  const resolved = await resolveAllowedRecipient(to);
  const result = await transport().sendEdit({ to: resolved.to, messageId, message });
  return { ...result, requestedRecipient: to, resolvedName: resolved.resolvedName, via: "transport" };
}

/**
 * Vote in a poll somebody else asked.
 *
 * `messageId` names the poll, not the vote: the payload is encrypted against
 * that poll's own secret, so a poll this account never received cannot be voted
 * in and the transport says so rather than sending a vote nobody can read.
 */
export async function pollVoteViaTransport({ to, messageId, sender, options }) {
  if (!messageId) throw badRequest("messageId is required — a vote names the poll");
  if (!Array.isArray(options) || options.length === 0) {
    throw badRequest("options is required — choose at least one");
  }
  const resolved = await resolveAllowedRecipient(to);
  const result = await transport().sendPollVote({ to: resolved.to, messageId, sender, options });
  return { ...result, requestedRecipient: to, resolvedName: resolved.resolvedName, via: "transport" };
}

/**
 * Show or clear the typing indicator.
 *
 * Behind the same gate as a message, because it is a signal this account emits
 * into somebody's chat — an ungated version could show a stranger "typing…".
 */
export async function presenceViaTransport({ to, state, media }) {
  if (state !== "composing" && state !== "paused") {
    throw badRequest('state must be "composing" or "paused"');
  }
  const resolved = await resolveAllowedRecipient(to);
  const result = await transport().presence({ to: resolved.to, state, media });
  return { ...result, requestedRecipient: to, resolvedName: resolved.resolvedName, via: "transport" };
}

/** Ask a question with fixed answers. */
export async function pollViaTransport({ to, name, options, selectableCount }) {
  if (!name?.trim()) throw badRequest("a poll needs a question");
  if (!Array.isArray(options) || options.length < 2) {
    throw badRequest("a poll needs at least two options");
  }
  const resolved = await resolveAllowedRecipient(to);
  const result = await transport().sendPoll({ to: resolved.to, name, options, selectableCount });
  return { ...result, requestedRecipient: to, resolvedName: resolved.resolvedName, via: "transport" };
}

export async function sendViaTransport({ to, message, quoted }) {
  if (!message?.trim()) throw new Error("Refusing to send an empty message.");
  const resolved = await resolveAllowedRecipient(to);

  const result = await transport().send({ to: resolved.to, message, quoted });

  // Same reason as a self-note: nothing echoes our own sends back, so a reply
  // that is not filed here leaves the archive holding one half of the exchange.
  archiveOutgoing({ id: result?.id, sentAt: result?.sentAt, chatKey: resolved.to, text: message });

  return {
    ...result,
    requestedRecipient: to,
    resolvedName: resolved.matchedName,
    via: "transport",
  };
}

/**
 * Send an image over the protocol.
 *
 * ── Why this repeats the guard chain instead of sharing a helper with text ──
 * It does share it — the same three functions, in the same order — and the
 * repetition is four lines. A `sendAnything({kind})` wrapper would save those
 * four lines and cost the property that matters: that every send path in this
 * file can be read top to bottom and seen to check permission, allowlist and
 * resolution. The bug that made `assertResolvedMatches` necessary here was born
 * of a path that looked like it inherited a guard and did not.
 *
 * @param image  Raw bytes (`Buffer` or `Uint8Array`) of a PNG or JPEG. SVG is
 *               rejected by the transport: WhatsApp renders no such image.
 */
export async function sendMediaViaTransport({
  to, image, mimetype, caption, width, height, kind, filename, durationSeconds, quoted,
}) {
  if (!image?.length) throw new Error("Refusing to send an empty attachment.");
  const resolved = await resolveAllowedRecipient(to);

  const result = await transport().sendMedia({
    to: resolved.to,
    kind,
    mimetype,
    caption,
    filename,
    width,
    height,
    durationSeconds,
    quoted,
    dataBase64: Buffer.from(image).toString("base64"),
  });
  return {
    ...result,
    requestedRecipient: to,
    resolvedName: resolved.matchedName,
    via: "transport",
  };
}

/**
 * Start draining on an interval. Called once at boot.
 *
 * Failures are logged and the loop continues, because nothing is acked until the
 * archive commits: a transport that is briefly unreachable costs latency, not
 * correspondence.
 */
/* ------------------------------------------------------------------
 * The self chat as a console
 *
 * Messages the operator writes to themselves pass through the drain like any
 * other. When one is a command, it is answered here rather than by the agent:
 * `/menu` and a game must be decidable, and a model in that loop can invent a
 * menu entry or argue its way out of a lost position. See plugins.js.
 * ------------------------------------------------------------------ */

/**
 * The console's state, on disk beside the archive.
 *
 * A match is a session spanning many events, and the events arrive minutes
 * apart — so "in memory" means a container restart silently abandons a game
 * mid-move, with the board still sitting in the chat inviting the next one.
 *
 * A file rather than a table in `store.db`: that database is the correspondence,
 * and a half-finished game is not correspondence. It also keeps `store.js`'s
 * migrations out of the way of a feature that changes shape more often than the
 * archive does. Written whole on every transition, because it is a few hundred
 * bytes and a partial write here would strand the session in a state no command
 * can leave.
 */
const CONSOLE_STATE_PATH =
  process.env.WA_CONSOLE_STATE_PATH ||
  join(dirname(process.env.WA_STORE_PATH || "./data/store.db"), "console-session.json");

let consoleSession = null;

function loadConsoleSession() {
  if (consoleSession) return consoleSession;
  try {
    consoleSession = JSON.parse(readFileSync(CONSOLE_STATE_PATH, "utf8"));
  } catch {
    // Absent or unreadable both mean the same thing: nothing is entered. A
    // corrupt file must not wedge the console, so it is replaced on next write.
    consoleSession = IDLE;
  }
  return consoleSession;
}

function saveConsoleSession(session) {
  consoleSession = session;
  try {
    writeFileSync(CONSOLE_STATE_PATH, JSON.stringify(session), "utf8");
  } catch (error) {
    // Not fatal: the session survives in memory for this process. Losing it on
    // restart is a worse outcome than refusing the move, but only slightly, so
    // it is reported rather than thrown.
    console.error("console: could not persist the session:", error?.message || error);
  }
}

/** Cached so a routine self-note does not cost a /status round trip. */
let selfKey = null;

async function selfChatKey() {
  if (selfKey) return selfKey;
  const state = await transport().status();
  selfKey = state?.session?.account?.key ?? null;
  return selfKey;
}

/**
 * Messages waiting for the agent, in `/eve` mode.
 *
 * ── Why this is on disk ─────────────────────────────────────────────────────
 * It is the fallback for a push that failed, and the commonest reason a push
 * fails is that the agent is restarting — which is also, invariably, when the
 * bridge is restarting. Held in memory, the queue was emptied by the very event
 * it existed to survive: two real questions were asked during a deploy, queued
 * correctly, and then lost when the bridge came back a minute later. The user
 * got silence and no error, which is the worst outcome available.
 *
 * Beside the console session and for the same reason: this is state about a
 * sitting, not correspondence, so it does not belong in store.db.
 */
const FORWARD_QUEUE_PATH =
  process.env.WA_CONSOLE_QUEUE_PATH ||
  join(dirname(process.env.WA_STORE_PATH || "./data/store.db"), "console-queue.json");

let forwardedCache = null;

function forwardedQueue() {
  if (forwardedCache) return forwardedCache;
  try {
    const parsed = JSON.parse(readFileSync(FORWARD_QUEUE_PATH, "utf8"));
    forwardedCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    forwardedCache = [];
  }
  return forwardedCache;
}

function saveForwardedQueue() {
  try {
    writeFileSync(FORWARD_QUEUE_PATH, JSON.stringify(forwardedQueue()), "utf8");
  } catch (error) {
    console.error("console: could not persist the forward queue:", error?.message || error);
  }
}

/**
 * Push one `/eve` message to the agent, now.
 *
 * This is what makes the mode reactive rather than polled: the drain routes the
 * message and hands it straight to the agent, so the reply arrives while the
 * user is still looking at their phone. A schedule still sweeps the queue every
 * ten minutes, but only for what this failed to deliver.
 *
 * Fire-and-forget by design. This runs inside the drain, whose job is getting
 * messages into the archive; an agent that is down, slow or restarting must not
 * stall that or cost a message. A failure leaves the item queued, which is
 * exactly where the fallback expects to find it.
 */
async function pushToAgent(text) {
  const url = process.env.WA_AGENT_URL;
  const token = process.env.WA_CONSOLE_PUSH_TOKEN;
  if (!url || !token) return false;

  // `/message`, not `/console/message`: eve mounts a custom channel's routes at
  // the root, and the file stem is the channel's identity rather than a URL
  // prefix. See agent/channels/console.ts.
  const response = await fetch(`${url.replace(/\/$/, "")}/message`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`agent returned ${response.status}: ${(await response.text()).slice(0, 160)}`);
  }
  return true;
}

/**
 * Hand the agent whatever the operator typed in `/eve` mode, and clear it.
 *
 * ── Why it can wait ─────────────────────────────────────────────────────────
 * A cron cannot run more than once a minute, so a plain poll makes every answer
 * up to a minute late — which is fine for a digest and useless for a
 * conversation. Holding the request open until something arrives lets one
 * scheduled run cover the whole gap to the next one: the operator types, this
 * resolves within milliseconds, and the reply comes back while they are still
 * looking at the screen.
 *
 * It waits only while the console is actually in `eve`. Any other time there is
 * nothing that could arrive, so the caller is told so immediately rather than
 * being held for no reason.
 */
export async function pendingForAgent({ waitMs = 0 } = {}) {
  const drain = () => {
    const queue = forwardedQueue();
    const items = queue.splice(0, queue.length);
    if (items.length) saveForwardedQueue();
    return { items, count: items.length, state: loadConsoleSession().state };
  };

  const immediate = drain();
  if (immediate.count > 0 || waitMs <= 0 || immediate.state !== "eve") return immediate;

  const deadline = Date.now() + Math.min(waitMs, 55_000);
  while (Date.now() < deadline) {
    // Polled rather than evented: the producer is a drain callback on a five
    // second timer, so a 250ms check costs nothing and needs no plumbing
    // between them. Anything finer would just spin.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const next = drain();
    if (next.count > 0 || next.state !== "eve") return next;
  }
  return drain();
}

/**
 * Say something in the operator's own chat, and record that we said it.
 *
 * The console used to call `transport().sendSelf` directly, which meant every
 * word it spoke — menus, board positions, "game abandoned" — was invisible to
 * the archive. That is the same one-sided-record defect `archiveOutgoing` exists
 * to close, and it mattered more here than anywhere: the console's replies are
 * half of a conversation the operator is having with this machine, and half a
 * conversation is not a record of it.
 */
async function answerSelf(text) {
  const key = await selfChatKey();
  const sent = await transport().sendSelf(text);
  archiveOutgoing({ id: sent?.id, sentAt: sent?.sentAt, chatKey: key, text });
  return sent;
}

/**
 * Route one drained message if it belongs to the operator's own chat.
 *
 * Everything else returns immediately: this runs for every message the archive
 * receives, so it must be cheap and must never answer a correspondent.
 */
export async function handleSelfMessage(payload) {
  if (!payload?.text) return null;
  if (payload.fromHistory) return null; // Replaying history must not replay commands.

  const key = await selfChatKey();
  if (!key || payload.chat?.key !== key || payload.sender?.key !== key) return null;

  // Our own replies arrive here too. See isOwnReply.
  if (isOwnReply(payload.text)) return null;

  const { session, reply, ask, forward, banner } = route(loadConsoleSession(), payload.text);
  saveConsoleSession(session);

  if (forward !== undefined) {
    const item = { text: forward, at: new Date().toISOString() };
    // Queued BEFORE the push is attempted, and removed only once it lands. A
    // crash between the two leaves the message waiting, which is recoverable;
    // the reverse order loses it.
    forwardedQueue().push(item);
    saveForwardedQueue();

    // Reactive: the agent is told immediately rather than discovering this on a
    // schedule. If the push lands, the item is taken back out of the queue so a
    // later poll cannot answer it a second time.
    try {
      if (await pushToAgent(forward)) {
        const queue = forwardedQueue();
        const at = queue.indexOf(item);
        if (at >= 0) {
          queue.splice(at, 1);
          saveForwardedQueue();
        }
        return { forwarded: true, pushed: true };
      }
    } catch (error) {
      console.error("console: could not push to the agent, leaving it queued:", error?.message || error);
    }
    return { forwarded: true, pushed: false };
  }

  if (ask === "status") {
    const stats = store().stats();
    const answer =
      `${stats.messages} messages across ${stats.chats} chats.\n` +
      `Transport: ${transportConfigured() ? "configured" : "unset"}.`;
    await answerSelf(mark("archive", answer));
    return { answered: true };
  }

  if (reply) {
    // The banner first, so the colour block sits above the text that explains
    // it — and so a notification preview carries the image, not just a line of
    // characters. A failure to send it must not cost the reply: the words are
    // the substance and the block is the signal.
    if (banner) {
      try {
        await transport().sendSelfMedia({
          mimetype: "image/png",
          caption: `${CATEGORIES[banner.category].emoji} ${banner.label}`,
          dataBase64: solidPngBase64(banner.color),
        });
      } catch (error) {
        console.error("console: could not send the state banner:", error?.message || error);
      }
    }
    await answerSelf(reply);
    return { answered: true };
  }
  return null;
}

/**
 * Teach the archive the names the roster knows.
 *
 * ── The bug this fixes ──────────────────────────────────────────────────────
 * The agent finds a conversation by name, and every group in the archive was
 * nameless, so it answered "no group called that" for groups that plainly exist
 * — while the same name resolved fine when SENDING, because sending asks the
 * roster and reading asks the archive. Two lookups over two different sources
 * that disagreed.
 *
 * A group's subject only exists on the server, so it can only arrive this way:
 * the roster is fetched and the names are written onto the chats already stored.
 * Cheap enough to repeat — one request and a handful of updates — and repeating
 * matters, because groups get renamed and a stale name is its own wrong answer.
 *
 * People are refreshed by the same pass. Their `pushName` does ride along on
 * messages, but only on live ones: everything replayed by history sync arrives
 * without it, which is why an archive built from a first pairing is mostly
 * unnamed until this runs.
 */
export async function refreshChatNames() {
  if (!transportConfigured()) return { renamed: 0, skipped: "no transport configured" };

  const roster = await transport().contacts();
  const entries = (roster?.contacts ?? [])
    .map((contact) => ({
      key: contact.key,
      // Subject first: for a group it is the only real name. For a person the
      // operator's own name for them beats the one they chose for themselves.
      displayName: contact.subject || contact.fullName || contact.pushName || contact.businessName || null,
    }))
    .filter((entry) => entry.key && entry.displayName);

  const { renamed } = store().renameChats(entries);
  return { renamed, considered: entries.length, groupsUnavailable: roster?.groupsUnavailable ?? null };
}

export function startTransportDrain() {
  const intervalMs = Number(process.env.WA_TRANSPORT_DRAIN_INTERVAL_MS) || 5_000;

  // Once at boot and then hourly. Not on every drain: the names change on the
  // scale of somebody renaming a group, and a roster fetch per five seconds
  // would be a request-per-second against the transport for nothing.
  const nameRefresh = () =>
    refreshChatNames()
      .then(({ renamed, groupsUnavailable }) => {
        if (renamed) console.log(`transport: named ${renamed} chat(s) from the roster`);
        if (groupsUnavailable) {
          console.error(
            `transport: the roster could not list groups (${groupsUnavailable}), so group names ` +
              "are missing rather than absent. Conversations will not be findable by name until this clears.",
          );
        }
      })
      .catch((error) => console.error("transport: could not refresh chat names:", error?.message || error));

  setTimeout(nameRefresh, 2_000).unref?.();
  setInterval(nameRefresh, 60 * 60_000).unref?.();
  return startDrain({
    transport: transport(),
    store: store(),
    intervalMs,
    onDrain: (outcome) =>
      console.log(
        `transport: drained ${outcome.fetched} (${outcome.inserted} new, ` +
          `${outcome.duplicates} known, ${outcome.rejected} unwritable), depth ${outcome.depth}`,
      ),
    // Loud and unmissable. A non-zero `dropped` means the queue overflowed while
    // this bridge was down and that correspondence is gone for good — the one
    // thing that must never be inferred from a quiet-looking archive.
    onGap: (dropped) =>
      console.error(
        `transport: ${dropped} message(s) were DROPPED by the transport's outbox before this ` +
          "bridge could store them. That is a permanent gap in the archive, not a quiet period.",
      ),
    onError: (error) => console.error("transport: drain failed:", error?.message || error),
    // The self chat doubles as a console. Runs per message, after the store has
    // it and the batch is acked, so a command that fails costs a reply and never
    // a message. See handleSelfMessage.
    onMessage: (payload) => handleSelfMessage(payload),
  });
}

/** A caller mistake, not a fault: 400 keeps it out of the error log. */
function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/**
 * Keyword search over everything ingested so far.
 *
 * `filters` is passed through whole, deliberately. Naming the fields again here
 * is what caused them to be dropped: this function once destructured `{ query,
 * chat, limit }` and silently discarded the other five between the HTTP layer
 * that parsed them and the store that implements them. See archive-query.js.
 */
export function searchArchive({ query, ...filters }) {
  // The chat filter is an ADDRESS at the store, and a name everywhere above it.
  // Left unresolved it narrowed the search to a chat that does not exist, and a
  // search that found nothing looked exactly like a subject nobody had raised.
  const chat = filters.chat ? requireChatKey(filters.chat) : filters.chat;
  return { query, chat, hits: store().search(query, { ...filters, chat }) };
}

/** Recent conversations, from the archive. Replaces the DOM's rendered list. */
export function archiveChats({ limit = 50 } = {}) {
  return { chats: store().chats({ limit }) };
}

export function archiveStats() {
  return store().stats();
}

/** The conversation around one search hit. Reads SQLite, never WhatsApp. */
export function archiveContext({ key, before, after }) {
  return store().contextAround(key, { before, after });
}

/** Stored messages for one chat, each carrying the key an extraction must cite. */
/**
 * Resolve whatever the caller called a chat into the key the archive stores it
 * under, or null.
 *
 * ── The bug this fixes ──────────────────────────────────────────────────────
 * The archive files every conversation under its protocol address —
 * `120363000000000002@g.us` — and the agent asks for "Duo". Nothing matched, so
 * reading a group by name returned zero messages and the agent reported the
 * group as unarchived while 809 of its messages sat in the table.
 *
 * The rules live in `chat-address.js` so they can be tested without a database,
 * and so every route that takes a chat string answers the question the same way.
 * Ambiguity is refused rather than guessed: reading the wrong person's chat is a
 * smaller harm than writing to them, but it is still the wrong answer given
 * confidently.
 */
export function resolveArchiveChat(query) {
  return resolveChatAddress(store().chats({ limit: 10_000 }), query).key;
}

/**
 * The same, for callers that cannot proceed without an answer.
 *
 * ── Why an unresolved name must not fall through ────────────────────────────
 * It used to: `resolveArchiveChat(chat) ?? chat` handed the raw name to the
 * store, which matches chats on their address, so the query ran against a chat
 * that does not exist and came back empty. Every caller then reported an empty
 * conversation. The agent, told a busy group held nothing, offered the user a
 * cause it had invented — "non-text content or a sync gap" — because nothing in
 * the answer said the name had simply not been found.
 *
 * ARCHITECTURAL REQUIREMENT (PALS's LAW): LLMs will always produce some form of
 * error. Absence of output verification is a design defect, not a runtime bug.
 * A resolution that failed must SAY it failed; anything else asks the model to
 * explain a silence, and it always will.
 */
export function requireChatKey(query) {
  const { key, candidates } = resolveChatAddress(store().chats({ limit: 10_000 }), query);
  if (key) return key;

  // What it nearly matched, in the message rather than in a log. A refusal that
  // knows "Alpha Fixture" is one word from what was asked and does not say so
  // reads as "that person is not in the archive" — which was false, and sent a
  // user hunting for a sync failure that did not exist.
  const near = (candidates ?? [])
    .map((chat) => `"${chat.displayName ?? chat.key}" (${chat.messages} messages)`)
    .join(", ");

  const error = new Error(
    `No conversation in the archive answers to "${String(query ?? "").trim()}". ` +
      "This is a name that did not resolve, NOT an empty conversation." +
      (near
        ? ` The closest names in the archive are: ${near}. Ask again with one of those exactly, ` +
          "or check with the user which one they meant — do not report the conversation as missing."
        : " Call /archive/chats (whatsapp_list_chats) and use a name exactly as it is listed " +
          "there, or the chat's key."),
  );
  error.statusCode = 404;
  throw error;
}

export async function archiveMessages({ chat, limit, newest = false }) {
  // Resolved, then reported back as asked: the caller gets both, so a wrong
  // resolution is visible rather than silent. `matched` says HOW it resolved,
  // so an approximate match can be named in the answer instead of passing for
  // an exact one.
  const { key, matched } = resolveChatAddress(store().chats({ limit: 10_000 }), chat);
  if (!key) requireChatKey(chat);
  const messages = store().messagesFor(key, { limit, newest });
  return { chat, resolved: key, matched, messages: await withSenderNames(messages) };
}

/**
 * The roster, cached, keyed by identity.
 *
 * Refetched on a timer rather than per read: a chat read is the most frequent
 * call the agent makes and the roster changes on the scale of new contacts, not
 * seconds. A stale name is a cosmetic error for minutes; a roster fetch on every
 * read is a network round trip on every read.
 */
let rosterCache = { at: 0, names: new Map() };
const ROSTER_TTL_MS = 5 * 60 * 1000;

async function senderNames() {
  if (Date.now() - rosterCache.at < ROSTER_TTL_MS) return rosterCache.names;
  try {
    const { contacts } = await transport().contacts();
    const names = new Map();
    for (const contact of contacts ?? []) {
      const name = contact.pushName || contact.fullName || contact.businessName || contact.subject;
      if (name) names.set(contact.key, name);
    }
    rosterCache = { at: Date.now(), names };
  } catch {
    // Keep whatever was cached. A read that loses its names is worse than one
    // whose names are a few minutes old, and the transport being briefly
    // unreachable must not make a conversation unreadable.
  }
  return rosterCache.names;
}

/**
 * Put a human name on every row that has one.
 *
 * ── Why this is not cosmetic ────────────────────────────────────────────────
 * The archive stores `sender` as a bare identity key — `<digits>@lid` — and
 * nothing else. A model reading a group therefore sees opaque keys and a chat
 * title, and if it needs to say who said what it has only the title to guess
 * from. That is exactly what happened: in a group whose NAME contained two
 * people, a line one of them wrote was reported to the operator as something
 * the other had said — in a chat where the misquoted one had sent three of
 * sixty-three messages.
 *
 * ARCHITECTURAL CONTRACT (PALS's LAW): a model asked to attribute a quote from
 * data that does not carry attribution will produce one anyway. The fix is not a
 * better prompt — it is giving the read path the name, so attribution is looked
 * up rather than inferred.
 */
async function withSenderNames(messages) {
  if (!messages?.length) return messages ?? [];

  const names = await senderNames();
  return messages.map((message) => ({
    ...message,
    // The operator's own messages are labelled as such rather than by name: the
    // agent is writing TO them, and "you" is what makes a summary read correctly.
    senderName: message.outgoing ? "you" : (names.get(message.sender) ?? null),
  }));
}

/** Persist what an extraction pass found. All-or-nothing on provenance. */
export function saveExtractions({ items }) {
  return store().addExtractions(items || []);
}

/**
 * File a voice note's transcript against the message it came from.
 *
 * Two reasons this is stored rather than returned and forgotten. A transcript
 * is the only readable form a voice note ever has, so without it the archive
 * holds `[voice note · 3:42]` and nothing else — the chat stays unsearchable.
 * And transcription is the one step that can send private audio to a third
 * party, so doing it twice for the same message is a privacy cost, not just a
 * bill.
 *
 * The message must already be archived: `requireMessage` refuses otherwise
 * (409), because a transcript with no message to cite is exactly the unsourced
 * row the foreign keys exist to prevent.
 */
export function recordTranscript({ key, text }) {
  if (!key) throw badRequest("key is required.");
  if (!String(text || "").trim()) throw badRequest("Refusing to store an empty transcript.");

  store().recordTranscript(key, String(text).trim());
  return { stored: true, key };
}

/** A transcript already stored for this message, or null. */
export function getTranscript({ key }) {
  if (!key) throw badRequest("key is required.");
  const row = store().transcriptFor(key);
  return { key, transcript: row ? row.text : null, createdAt: row?.created_at };
}

/**
 * Record something durable about a person or a project.
 *
 * The provenance rule is the whole feature: a fact carries the key of the
 * message it came from, the store enforces that with a foreign key, and so
 * "why do you think the meeting moved?" is answerable with the sentence that
 * caused the belief. A fact the agent merely inferred has nothing to cite and
 * is refused — which is the intended outcome, not a limitation.
 */
export function addFact({ subject, statement, sourceMessageKey, confidence }) {
  if (!String(statement || "").trim()) throw badRequest("statement is required.");
  if (!sourceMessageKey) {
    throw badRequest(
      "sourceMessageKey is required. A fact with no message behind it cannot be stored — that is " +
        "what keeps the archive from filling with things nobody said.",
    );
  }

  const id = store().addFact({
    subject: subject?.trim() || null,
    statement: String(statement).trim(),
    sourceMessageKey,
    confidence,
  });
  return { id, subject: subject?.trim() || null, sourceMessageKey };
}

/** Stored facts, each joined to the message that produced it. */
export function listFacts({ subject, chat, limit }) {
  return { facts: store().factsWithSource({ subject, chat: chat ? requireChatKey(chat) : chat, limit }) };
}

export function listExtractions(filters = {}) {
  return {
    items: store().extractions({
      ...filters,
      ...(filters.chat ? { chat: requireChatKey(filters.chat) } : {}),
    }),
  };
}

/* ------------------------------------------------------------------ *
 * The interaction twin.
 *
 * All four of these are archive operations: they read and write SQLite and
 * never open a chat, so none of them spends from the interaction budget and
 * none of them can be rate-limited. That is what makes it reasonable to model
 * a conversation on a cadence, unlike reading one.
 * ------------------------------------------------------------------ */

/**
 * Write one modelling pass: the arcs running through a conversation, what each
 * side wants out of them, and the standing frame the conversation happens in.
 *
 * Nothing here is trusted. Every arc, goal and context cites a message, the
 * store rejects the pass if any citation names a message nobody read, and the
 * pass records the last message it considered so staleness is a count rather
 * than a guess.
 */
/**
 * ── Why the chat is RESOLVED here, and why that is not cosmetic ─────────────
 * This function is where the archive was corrupted. It passed the agent's
 * string — a display name — straight to the store, which inserted it as a chat
 * ADDRESS. Nine conversations grew a second, empty row keyed by their own name,
 * carrying every arc, context and proposal the twin had produced, while the real
 * chat row with the messages carried none. Reads by that name then landed on the
 * shadow: "Alpha + Pais" had 19 modelled arcs over 0 archived messages.
 *
 * Resolving first makes the address the identity of a modelling pass, which the
 * content keys (`arcKeyFor`, and the context and proposal keys) are derived
 * from — so a pass run against the name and one run against the key continue the
 * same arcs instead of forking them.
 */
export function saveInteractionModel({ chat, throughMessageKey, considered, arcs, contexts }) {
  if (!String(chat || "").trim()) throw badRequest("chat is required.");
  if (!throughMessageKey) {
    throw badRequest(
      "throughMessageKey is required. Without the last message a pass considered, a twin cannot " +
        "say how out of date it is, and a stale twin reads exactly like a current one.",
    );
  }
  return store().saveInteractionModel({
    chat: requireChatKey(chat),
    throughMessageKey,
    considered,
    arcs,
    contexts,
  });
}

/** The assembled twin: what is counted, what was read, and how stale it is. */
export function interactionTwin({ chat, arcStatus, horizonDays }) {
  if (!String(chat || "").trim()) throw badRequest("chat is required.");
  return store().twin(requireChatKey(chat), { arcStatus, horizonDays });
}

/** Conversations whose archive has moved on since they were last modelled. */
export function staleTwins({ limit, minimumNew } = {}) {
  return { chats: store().staleTwins({ limit, minimumNew }) };
}

export function resolveArc({ id, status }) {
  if (!Number.isInteger(id)) throw badRequest("id must be an integer.");
  return store().resolveArc(id, status);
}

/**
 * Record proposed next moves. Proposals only — nothing here is sent.
 *
 * Separate from sending on purpose, and it is the safety property of the whole
 * feature: this endpoint cannot reach another person, so a bad proposal is a bad
 * suggestion in a table rather than a message that cannot be recalled.
 */
export function saveProposals({ items }) {
  if (!Array.isArray(items)) throw badRequest("items must be an array.");
  // Same reason as `saveInteractionModel`: a proposal filed under a display name
  // mints a chat row keyed by that name, and the move then belongs to a
  // conversation that holds no messages.
  return store().addProposals(
    items.map((item) => (item?.chat ? { ...item, chat: requireChatKey(item.chat) } : item)),
  );
}

export function listProposals({ chat, status, limit } = {}) {
  return { proposals: store().proposals({ chat: chat ? requireChatKey(chat) : undefined, status, limit }) };
}

export function resolveProposal({ id, status }) {
  if (!Number.isInteger(id)) throw badRequest("id must be an integer.");
  return store().resolveProposal(id, status);
}

/** Close an extracted obligation out. */
export function resolveExtraction({ id, status }) {
  return store().resolveExtraction(id, status);
}

/** "What needs my attention?" — assembled from the archive, browser-free. */
export function attention({ horizonDays } = {}) {
  return store().attention({ horizonDays });
}

/* ------------------------------------------------------------------ *
 * The people graph.
 *
 * WhatsApp's search ranks by recency, so it answers "who did you mean" with
 * "whoever spoke last". The roster built from the archive answers it by name
 * instead — see people.js. Aliases come from two places and both are honoured:
 * WA_CONTACT_ALIASES for the operator's hand-edits, and the store for ones the
 * agent has been taught at runtime.
 * ------------------------------------------------------------------ */

/** Env aliases and learned ones, merged. Learned entries win. */
function allAliases() {
  const merged = new Map();
  for (const [alias, canonical] of parseAliases(process.env)) merged.set(alias, canonical);
  for (const [alias, canonical] of store().aliasMap()) merged.set(alias, canonical);
  return merged;
}

export function resolveContact({ name }) {
  return resolvePerson(name, { roster: store().roster(), aliases: allAliases() });
}

export function peopleRoster() {
  return { roster: store().roster(), aliases: Object.fromEntries(allAliases()) };
}

/**
 * Everything known about one person, gathered from the archive.
 *
 * Browser-free, so it costs nothing from the interaction budget: the roster,
 * the facts and the obligations were all written by earlier reads. The shaping
 * lives in people.js; this is only the gathering.
 */
export function personDossier({ name }) {
  const db = store();
  const resolution = resolvePerson(name, { roster: db.roster(), aliases: allAliases() });

  if (!resolution.name) return { query: name, ...buildDossier(resolution) };

  const canonical = resolution.name;
  return {
    query: name,
    ...buildDossier(resolution, {
      profile: db.roster().find((entry) => entry.name === canonical),
      // Every nickname that points here, so the agent can say "you call them
      // tonhão" instead of silently accepting it.
      aliases: [...allAliases()]
        .filter(([, target]) => normalizeName(target) === normalizeName(canonical))
        .map(([alias]) => alias),
      facts: db.factsWithSource({ subject: canonical }),
      obligations: db.extractions({ chat: canonical, limit: 200 }),
    }),
  };
}

/**
 * @param origin  "session" when the user said so in conversation with the agent,
 *                "message" when it was read out of chat text — which then has to
 *                cite the message, exactly as a fact does. Defaults to "session"
 *                so existing callers keep working, but the tool description tells
 *                the agent to pass "message" when it inferred rather than was told.
 */
export function rememberAlias({ alias, canonical, origin, sourceMessageKey }) {
  return store().setAlias(alias, canonical, { origin, sourceMessageKey });
}

export function forgetAlias({ alias }) {
  return store().removeAlias(alias);
}

/** Every alias with where it came from — the review surface for learned nicknames. */
export function listAliases({ origin } = {}) {
  return { aliases: store().aliasesWithProvenance({ origin }) };
}

/**
 * Withdraw a stored fact.
 *
 * Exposed because provenance proves traceability, not truth: a false statement
 * genuinely present in the archive passes every check the store makes, and then
 * reads back as a cited fact with a receipt. Without this the only way to correct
 * it is to edit the database by hand.
 */
export function retractFact({ id, reason }) {
  if (!Number.isInteger(id)) throw badRequest("id must be an integer.");
  return store().retractFact(id, reason);
}

export function restoreFact({ id }) {
  if (!Number.isInteger(id)) throw badRequest("id must be an integer.");
  return store().restoreFact(id);
}

/**
 * Apply the retention policy.
 *
 * `dryRun` defaults to TRUE here, unlike in the store. This is reachable over
 * HTTP and it deletes correspondence; the default for a destructive operation
 * behind a network boundary should be to describe itself.
 */
export function pruneArchive({ dryRun = true, ...overrides } = {}) {
  const policy = { ...retentionFromEnv(process.env), ...overrides };
  return { policy, ...store().prune({ ...policy, dryRun }) };
}

/* ------------------------------------------------------------------ *
 * The user's own chat.
 *
 * On the protocol this is a stronger construct than it was on the DOM. There,
 * "your own chat" was a display title typed into an env var and compared to
 * whatever Chromium had open — a string, checked exactly, because a fuzzy search
 * could open a similarly-named contact and deliver a private draft to them.
 *
 * Here it is the account's own key, read from the live session. It is what the
 * archive already files self-messages under, it is what the protocol addresses,
 * and it cannot fuzzy-match anybody: there is no roster lookup in this path and
 * no name to mistype. That is why neither the allowlist nor a confirmation step
 * appears below — not because self-notes are trusted, but because the recipient
 * is not a choice.
 * ------------------------------------------------------------------ */

/**
 * Which chat is the user's own, and where to read it.
 *
 * `source` is reported rather than left implicit because a caller that wants to
 * read the chat it writes to has to know that reading means the ARCHIVE, not a
 * conversation opened somewhere. A caller that assumes otherwise ends up
 * addressing a component this bridge no longer has.
 */
/**
 * File a message this bridge just sent into the archive.
 *
 * ── Why this has to exist ───────────────────────────────────────────────────
 * The protocol does not echo our own sends back to us. `dispatch.go` is the only
 * thing that appends to the outbox and it only ever sees INBOUND traffic, so
 * without this the archive holds every message received and not one message
 * sent — a one-sided transcript of every conversation in it. The DOM path hid
 * this, because a sent message appeared on screen and was picked up by the next
 * read; the move to the protocol removed the accident that was covering it.
 *
 * Verified rather than assumed: a note sent through `/send/self` was still
 * absent from the archive twelve seconds and one drain later.
 *
 * The row is keyed by the protocol's own message id, which is what the transport
 * returns and what a later history sync would carry, so a message that does
 * arrive by both routes collides on `messages.key` and is stored once.
 */
function archiveOutgoing({ id, sentAt, chatKey, text, kind = "text", caption = null }) {
  if (!id || !chatKey) return { archived: false };

  const at = sentAt ?? new Date().toISOString();
  const { inserted } = store().upsertTransportMessages([
    {
      key: id,
      chat: { key: chatKey, kind: "person", provisional: false, displayName: null },
      // Our own account. The archive reads direction off `outgoing`, and a
      // sender that is not the chat partner is what keeps a self-note from
      // renaming the chat after itself.
      sender: { key: chatKey, kind: "person" },
      sentAt: at,
      sentAtIso: at,
      kind,
      // An image carries no body of its own, so the archive stores the same
      // placeholder a received image would get. Storing "" instead is what makes
      // a chat full of pictures read back as a silent one.
      text: kind === "text" ? text : placeholderText({ kind, caption }),
      caption,
      filename: null,
      durationSeconds: null,
      outgoing: true,
      recognised: true,
      fromHistory: false,
    },
  ]);

  return { archived: inserted > 0 };
}

/**
 * Write a note to the operator's own chat, and record that we did.
 *
 * The recording is not bookkeeping — it is what makes the note part of the
 * conversation as far as anything reading the archive is concerned. A feature
 * that writes to the chat and then cannot see what it wrote will do it again.
 */
export async function sendSelfNote({ messages }) {
  const { chat } = await selfChatIdentity();

  const result = await sendSelfNoteWith(
    {
      env: process.env,
      send: async (message) => {
        const sent = await transport().sendSelf(message);
        archiveOutgoing({ id: sent?.id, sentAt: sent?.sentAt, chatKey: chat, text: message });
        return sent;
      },
    },
    { messages },
  );

  return { ...result, chat };
}

/**
 * Write an image to the operator's own chat, and record that we did.
 *
 * ── Why this has no allowlist ───────────────────────────────────────────────
 * The same reason `sendSelfNote` has none: there is exactly one possible
 * recipient and it is the operator. `assertSelfNoteConfigured` is still the gate
 * — the feature switch and the "which chat is yours" answer — because a bridge
 * that has not been told whose chat this is must write nothing at all.
 *
 * The archive row matters as much as the send. A feature that posts to the chat
 * and then cannot see what it posted will post it again on the next tick, which
 * for a game means a second copy of the same final board.
 */
export async function sendSelfImage({
  image, mimetype = "image/png", caption, width, height, kind = "image", filename, durationSeconds,
}) {
  if (!image?.length) throw new Error("Refusing to send an empty attachment.");
  assertSelfNoteConfigured();

  const { chat } = await selfChatIdentity();
  const sent = await transport().sendSelfMedia({
    kind,
    mimetype,
    caption,
    filename,
    width,
    height,
    durationSeconds,
    dataBase64: Buffer.from(image).toString("base64"),
  });

  const { archived } = archiveOutgoing({
    id: sent?.id,
    sentAt: sent?.sentAt,
    chatKey: chat,
    kind,
    caption: caption ?? null,
  });

  return { ...sent, chat, archived };
}

/**
 * Which console state the self chat is in, if any.
 *
 * Reported so that a second responder can stand down. The self chat has one
 * keyboard and now has two things listening to it: this bridge's console, which
 * answers `/game` deterministically as each message arrives, and the agent's
 * tic-tac-toe tool, which answers `ttt` on a schedule. Both read bare digits as
 * moves, so while the console holds a session the digits are ITS input and
 * anything else answering them is talking over it.
 */
export function consoleState() {
  return loadConsoleSession()?.state ?? null;
}

export async function selfChatIdentity() {
  const state = await transport().status();
  const key = state?.session?.account?.key;
  if (!key) {
    const error = new Error(
      "The transport has no account key yet, so it cannot say which chat is yours. Pair the " +
        "session first — /transport/status reports whether it is paired.",
    );
    error.statusCode = 503;
    throw error;
  }
  return { chat: key, source: "archive", via: "transport" };
}

// Writing a self-note lives with the other transport calls, above: it goes to
// `/send/self`, which addresses the account from the transport's own device
// store. Only the READ side needed anything new, and that is `selfChatIdentity`.
