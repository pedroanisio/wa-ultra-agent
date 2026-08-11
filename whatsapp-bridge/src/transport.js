/**
 * Client for `whatsapp-transport`, the Go process that speaks the WhatsApp
 * multi-device protocol.
 *
 * ── What moved and what did not ─────────────────────────────────────────────
 * The transport replaces the Playwright half of this bridge — the browser, the
 * selectors, the DOM walking — and nothing else. `store.js` remains the archive's
 * only writer, so this file is a client on one side and a producer of rows for
 * the store on the other. Nothing here writes SQL.
 *
 * ── Why the mapping lives here ──────────────────────────────────────────────
 * This is the anti-corruption layer for the protocol boundary. The transport
 * deliberately does not render the placeholder strings the model reads: that
 * vocabulary is `placeholderText` in message-kind.js, and a second copy in Go
 * would drift from it silently. So the payload arrives with an empty `text` for
 * media and this file renders it — which also keeps `store.js` free of any
 * knowledge of WhatsApp's message kinds.
 *
 * ── The one ordering rule ───────────────────────────────────────────────────
 * Delivery is at-least-once. `drainOnce` acks only after the archive has
 * committed, because an ack tells the transport to forget the entry and there is
 * no second copy of anybody's correspondence anywhere.
 */

import { placeholderText } from "./message-kind.js";

/** Matches `DefaultDrainLimit` in internal/httpapi. */
export const DEFAULT_DRAIN_LIMIT = 200;

/**
 * Matches `MaxDrainLimit`. Clamped here as well as there because the Go side
 * clamps SILENTLY: a caller that asked for 5000 and received 1000 would believe
 * it had drained the queue when it had not.
 */
export const MAX_DRAIN_LIMIT = 1000;

/** Environment variables this client reads, named as the transport names them. */
export const ENV = {
  url: "WA_TRANSPORT_URL",
  token: "WA_TRANSPORT_TOKEN",
};

/**
 * An error that carries the transport's own status code.
 *
 * `refused` separates a decision from a fault. A 403 is the send guard doing its
 * job and retrying it will never help; a 502 is the socket failing and retrying
 * might. Collapsing both into "send failed" is how a default-deny allowlist ends
 * up looking like an outage.
 */
class TransportError extends Error {
  constructor(message, { statusCode, refused = false } = {}) {
    super(message);
    this.name = "TransportError";
    this.statusCode = statusCode;
    this.refused = refused;
  }
}

/**
 * Turn one outbox payload into a row `store.upsertTransportMessages` can write.
 *
 * Refuses only what cannot be stored — a message with no id, or none with no chat
 * — and degrades everything else, because the archive would rather hold an
 * imperfect row than lose correspondence.
 */
export function toArchiveRow(payload) {
  if (!payload?.key) {
    throw new TransportError(
      "transport: message has no id, so it cannot be stored — messages.key is UNIQUE and " +
        "every provenance foreign key cites it",
    );
  }
  if (!payload?.chat?.key) {
    throw new TransportError("transport: message has no chat, so there is nothing to file it under");
  }

  const kind = payload.kind || "unknown";

  return {
    key: payload.key,
    chat: {
      key: payload.chat.key,
      kind: payload.chat.kind,
      provisional: Boolean(payload.chat.provisional),
      displayName: chatDisplayName(payload),
    },
    sender: payload.sender?.key ? { key: payload.sender.key, kind: payload.sender.kind } : null,

    // Both forms are kept: the raw instant as the transport stated it, and the
    // normalised one every query orders and filters on. `parseSentAt` is
    // deliberately not involved — it exists to guess at rendered strings like
    // "8/3/2026" and can fail to date a row at all, which would be a downgrade
    // from an unambiguous timestamp.
    sentAt: payload.sentAt ?? null,
    sentAtIso: normaliseInstant(payload.sentAt),

    kind,
    text: bodyText(payload, kind),
    caption: payload.caption || null,
    filename: payload.filename || null,
    durationSeconds: payload.durationSeconds ?? null,
    outgoing: Boolean(payload.outgoing),
    recognised: Boolean(payload.recognised),
    fromHistory: Boolean(payload.fromHistory),
  };
}

/**
 * The label to hang on the CHAT, which is not always the sender's label.
 *
 * `pushName` is the name the sending device advertises. In a direct message that
 * is the chat partner, so it labels the chat. In a group it is one participant,
 * and using it would rename the group after whoever spoke last.
 */
function chatDisplayName(payload) {
  if (payload.chat?.kind === "group") return null;
  if (payload.sender?.key && payload.sender.key !== payload.chat?.key) return null;
  return payload.pushName || null;
}

/**
 * What the model reads.
 *
 * Media arrives with an empty `text` by design, so an empty body on anything but
 * a text message means "render the placeholder", not "this message was blank".
 * Storing "" there is what makes a chat full of voice notes read as a quiet chat.
 */
function bodyText(payload, kind) {
  if (payload.text) return payload.text;
  if (kind === "text") return "";
  return placeholderText({
    kind,
    durationSeconds: payload.durationSeconds,
    filename: payload.filename,
    caption: payload.caption,
  });
}

/** RFC 3339 to the archive's ISO form, or null if it cannot be read at all. */
function normaliseInstant(value) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * Find the address to send to, from a human name and the roster.
 *
 * ── Why this refuses instead of choosing ────────────────────────────────────
 * The DOM path had a real bug of exactly this shape: searching "Helena Braga"
 * opened the group "We", because she was its most recent sender and WhatsApp
 * ranks by recency. The fix there was `assertResolvedMatches` — verify that what
 * opened is what was asked for.
 *
 * The roster is not recency-ranked, so that particular failure is gone, but the
 * ambiguity is not: `pushName` is self-asserted and two contacts can advertise
 * the same one. Picking either would be a coin flip over whose correspondence
 * receives the message, so an ambiguous name is refused WITH its candidates and
 * the operator disambiguates. Silence is not an option and neither is a guess.
 *
 * @param name      What the caller asked for.
 * @param contacts  `GET /contacts` output — identity-keyed, never phone numbers.
 */
export function resolveRecipient(name, contacts = []) {
  const wanted = normaliseName(name);
  if (!wanted) {
    throw new TransportError("transport: no recipient was named", { statusCode: 400 });
  }

  const labelled = contacts.map((contact) => ({
    contact,
    labels: [contact.pushName, contact.fullName, contact.businessName]
      .filter(Boolean)
      .map(normaliseName),
  }));

  const exact = labelled.filter(({ labels }) => labels.includes(wanted));
  const candidates = exact.length
    ? exact
    : labelled.filter(({ labels }) => labels.some((label) => label.startsWith(wanted)));

  if (candidates.length === 0) {
    throw new TransportError(
      `transport: no contact matches "${name}". The roster only contains people this account has ` +
        "actually corresponded with, so a name that never appears there cannot be addressed.",
      { statusCode: 404 },
    );
  }

  if (candidates.length > 1) {
    // The labels, not the keys: a key is a stable per-person identifier and
    // printing one into an error that will be logged republishes it.
    const names = candidates.map(({ contact }) => contact.pushName || contact.fullName).join(", ");
    throw new TransportError(
      `transport: "${name}" is ambiguous — it matches ${candidates.length} contacts (${names}). ` +
        "Refusing to choose, because choosing wrong sends a private message to the wrong person.",
      { statusCode: 409 },
    );
  }

  const { contact } = candidates[0];

  // A provisional identity is a digest, deliberately not an address: it exists so
  // that no phone number is ever used as a key. There is genuinely nothing to
  // send to until a LID arrives, and saying so beats a 400 from ParseJID.
  if (contact.provisional || String(contact.key).startsWith("pn:")) {
    throw new TransportError(
      `transport: "${name}" has no routable address yet. Their identity is still provisional, ` +
        "which means the protocol has not yet given this account a stable address for them.",
      { statusCode: 409 },
    );
  }

  return {
    to: contact.key,
    matchedName: contact.pushName || contact.fullName || contact.businessName || null,
    exactMatch: exact.length === 1,
  };
}

/** Case- and whitespace-insensitive, so a line-wrapped or padded name still matches. */
function normaliseName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The HTTP client.
 *
 * `fetch` is injectable so the tests can assert on request SEQUENCE — the
 * ack-after-commit rule is a statement about ordering that no return value can
 * express.
 */
export function createTransport({
  baseUrl = process.env[ENV.url] || "http://127.0.0.1:8100",
  token = process.env[ENV.token] || "",
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, "");

  const request = async (path, { method = "GET", body } = {}) => {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.ok) return response.json();

    const detail = await errorDetail(response);

    // 401 has exactly one cause and one fix, and "401" alone sends the operator
    // looking through logs for it.
    if (response.status === 401) {
      throw new TransportError(
        `transport: rejected the bearer token (401). ${ENV.token} must be identical in the ` +
          `bridge and the transport; the transport refuses to start without it.`,
        { statusCode: 401 },
      );
    }

    throw new TransportError(`transport: ${method} ${path} failed (${response.status}): ${detail}`, {
      statusCode: response.status,
      // The send guard is default-deny, so a refusal is the expected outcome of a
      // correct configuration, not a failure of one.
      refused: response.status === 403,
    });
  };

  return {
    /** Pairing state, plus whether the transport itself will permit a send. */
    status: () => request("/status"),

    /** Connect an already-paired session. 409 means it is not paired yet. */
    connect: () => request("/connect", { method: "POST" }),

    /** Begin phone-number pairing; returns the code the operator types in. */
    pairPhone: (phone) => request("/pair/phone", { method: "POST", body: { phone } }),

    /**
     * The roster, keyed by identity — never by raw JID, so no phone number
     * crosses the boundary. This is where a send gets its `to`.
     */
    contacts: () => request("/contacts"),

    /** `to` must be a JID. Names are resolved by recipients.js, before this. */
    send: ({ to, message }) => request("/send", { method: "POST", body: { to, message } }),

    outbox: ({ limit = DEFAULT_DRAIN_LIMIT } = {}) => {
      const bounded = Math.max(1, Math.min(Number(limit) || DEFAULT_DRAIN_LIMIT, MAX_DRAIN_LIMIT));
      return request(`/outbox?limit=${bounded}`);
    },

    /**
     * Forget everything up to and including `through`.
     *
     * The transport treats a missing `through` as a 400 rather than as zero,
     * because acking zero would look like success and loop forever.
     */
    ack: (through) => request("/outbox/ack", { method: "POST", body: { through } }),
  };
}

async function errorDetail(response) {
  try {
    const body = await response.json();
    return body?.error ?? JSON.stringify(body);
  } catch {
    return response.statusText || "no detail";
  }
}

/**
 * Move one batch from the transport's queue into the archive.
 *
 * ── The ordering that matters ───────────────────────────────────────────────
 * Read, commit, then ack. If the ack went first, or went out after a failed
 * write, the transport would drop entries the archive never stored and that
 * correspondence would be gone permanently. So a write failure propagates with
 * no ack sent, and the same entries are redelivered on the next drain — which is
 * safe because `messages.key` is UNIQUE and a redelivery is counted as a
 * duplicate.
 *
 * A malformed payload is counted and skipped rather than thrown, for the same
 * reason the store skips unwritable rows: one bad entry must not wedge the queue
 * behind it forever.
 */
export async function drainOnce({ transport, store, limit = DEFAULT_DRAIN_LIMIT }) {
  const { entries = [], depth = 0, dropped = 0 } = await transport.outbox({ limit });

  if (entries.length === 0) {
    return { fetched: 0, inserted: 0, duplicates: 0, rejected: 0, acked: null, depth, dropped, chats: [] };
  }

  const rows = [];
  let rejected = 0;
  for (const entry of entries) {
    try {
      rows.push(toArchiveRow(entry.payload));
    } catch {
      rejected++;
    }
  }

  // Throws on a write failure, and deliberately does not ack.
  const written = store.upsertTransportMessages(rows);

  const through = entries.reduce((highest, entry) => Math.max(highest, Number(entry.seq) || 0), 0);
  await transport.ack(through);

  return {
    fetched: entries.length,
    inserted: written.inserted,
    duplicates: written.duplicates,
    rejected: rejected + (written.rejected ?? 0),
    acked: through,
    depth,
    dropped,
    chats: written.chats ?? [],
  };
}

/**
 * Drain on an interval until stopped.
 *
 * ── Why a poll and not a stream ─────────────────────────────────────────────
 * The queue is durable and the archive is the slow side. A poll makes the
 * archive's availability irrelevant to whether messages are lost: the transport
 * keeps accepting them either way, and a bridge that was down for an hour
 * catches up in one drain.
 *
 * `dropped` is reported through `onGap` rather than logged and forgotten. It is
 * cumulative and it is the only evidence that the queue overflowed while the
 * archive was down — an absence in the archive must never read as a quiet period.
 */
export function startDrain({
  transport,
  store,
  intervalMs = 5_000,
  limit = DEFAULT_DRAIN_LIMIT,
  onDrain,
  onError,
  onGap,
} = {}) {
  let stopped = false;
  let running = false;
  let lastDropped = null;
  let timer;

  const tick = async () => {
    // A drain that outlives its interval must not have a second one started
    // beside it: both would read the same entries and race on the ack.
    if (stopped || running) return;
    running = true;
    try {
      const outcome = await drainOnce({ transport, store, limit });

      if (onGap && outcome.dropped > 0 && outcome.dropped !== lastDropped) {
        onGap(outcome.dropped);
        lastDropped = outcome.dropped;
      }
      if (onDrain && outcome.fetched > 0) onDrain(outcome);
    } catch (error) {
      // Swallowed on purpose: the transport being down, or the archive being
      // briefly unwritable, must not kill the loop that recovers from it. The
      // entries are still queued because nothing was acked.
      if (onError) onError(error);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  // Nothing here should hold the process open on its own.
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    // Exposed for tests and for a manual /transport/drain call: a drain the
    // operator asked for should not wait for the next tick.
    drainNow: () => drainOnce({ transport, store, limit }),
  };
}
