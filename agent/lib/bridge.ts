/**
 * Client for the whatsapp-bridge sidecar.
 *
 * The browser cannot live in this process. eve compiles to a Nitro server that
 * may be replaced at any time, while a linked WhatsApp Web session is a
 * long-lived, stateful browser profile that survives exactly one login. So the
 * session runs in its own container and this module speaks to it over the
 * internal network.
 */

const BASE = process.env.WA_BRIDGE_URL || "http://127.0.0.1:8099";
const TOKEN = process.env.WA_BRIDGE_TOKEN || "";

/**
 * What a rendered row turned out to be. Anything that is not `text` had no
 * readable body: the bridge reports it as a placeholder rather than dropping it,
 * so a chat full of voice notes no longer reads as a quiet chat.
 */
export type MessageKind =
  | "text"
  | "voice"
  | "audio"
  | "image"
  | "video"
  | "gif"
  | "sticker"
  | "document"
  | "location"
  | "contact"
  | "poll"
  | "deleted"
  | "system"
  | "unknown";

export interface WhatsAppMessage {
  /** Position counted from the newest message; 0 is the last in the chat. */
  fromEnd: number;
  kind: MessageKind;
  time?: string;
  from?: string;
  /** Always non-empty: the body, or a placeholder such as `[voice note · 3:42]`. */
  text: string;
  outgoing?: boolean;
  media?: {
    kind: MessageKind;
    durationSeconds?: number;
    filename?: string;
    caption?: string;
    /** Whatever label was found on a row whose kind could not be identified. */
    label?: string;
  };
}

export interface ArchiveHit {
  key: string;
  chat: string;
  sender?: string;
  sent_at?: string;
  sent_at_iso?: string;
  kind: MessageKind;
  text: string;
  outgoing?: number;
  /** FTS5 excerpt with the matched terms bracketed. Search results only. */
  snippet?: string;
}

export interface ArchiveSearchParams {
  query: string;
  chat?: string;
  sender?: string;
  since?: string;
  until?: string;
  kind?: MessageKind;
  outgoing?: boolean;
  order?: "relevance" | "recent";
  limit?: number;
}

export interface ExtractionRow {
  id: number;
  type: string;
  statement: string;
  actor?: string;
  counterparty?: string;
  due_at?: string;
  confidence?: number;
  status: string;
  source_message_key: string;
  source_text: string;
  source_sender?: string;
  source_sent_at?: string;
  source_chat: string;
  /** 1 when the citing message was one the user sent. */
  source_outgoing?: number;
}

export interface FactRow {
  id: number;
  subject?: string;
  statement: string;
  confidence?: number;
  created_at: string;
  source_message_key: string;
  source_text: string;
  source_sender?: string;
  source_sent_at?: string;
  source_chat: string;
  /**
   * 1 when the user wrote the citing message, 0 when somebody else did.
   *
   * The same taint mark `TwinGoal` carries, and for the same reason: a belief
   * read off a third party's words in a group chat is a different epistemic
   * object from one read off the user's own message, and until this is on the row
   * the two are indistinguishable at read time. Resolved by joining the cited
   * message rather than stored, so it cannot drift from its own citation.
   */
  source_outgoing?: number;
  /**
   * Set when the fact has been withdrawn. Retracted facts are excluded from
   * recall by default and only appear in an explicit audit, so a row carrying
   * this should never reach a draft.
   */
  retracted_at?: string | null;
  retraction_reason?: string | null;
}

/**
 * What the archive knows about one person.
 *
 * `found: false` covers both "nothing matched" and `ambiguous: true`, which are
 * different answers: the second one carries the candidates and must be put back
 * to the user as a question rather than resolved by picking one.
 */
export interface Dossier {
  query: string;
  found: boolean;
  ambiguous: boolean;
  reason?: string;
  candidates?: Array<{ name: string; score: number; why: string }>;
  name?: string;
  exact?: boolean;
  via?: "alias" | "name" | "partial";
  aliases?: string[];
  activity?: { messages: number; lastMessageAt?: string };
  facts?: FactRow[];
  obligations?: {
    theyOweUser: ExtractionRow[];
    userOwesThem: ExtractionRow[];
    unanswered: ExtractionRow[];
  };
}

export interface ContactResolution {
  /** True only when the query *is* the chat's name. */
  exact: boolean;
  /** Set only when exactly one answer is defensible. */
  name?: string;
  via?: "alias" | "name" | "partial";
  candidates: Array<{ name: string; kind?: string; score: number; why: string }>;
  /** Several matched equally well — ask, never guess. */
  ambiguous: boolean;
  reason?: string;
}

export interface AttentionDigest {
  asOf: string;
  horizonDays: number;
  /** Mine, past their stated date. */
  overdue: ExtractionRow[];
  /** Mine, landing within the horizon. */
  dueSoon: ExtractionRow[];
  /** Someone else's move — what they owe me. */
  waitingOn: ExtractionRow[];
  /** Asked of me and never answered. */
  unanswered: ExtractionRow[];
  /** Zero means a quiet day, and a quiet day should send nothing. */
  total: number;
}

/* ------------------------------------------------------------------ *
 * The interaction twin.
 *
 * Two halves, and the split is the design. `metrics` is counted from the
 * archive: reply times, who opens, how long it has been quiet. `arcs`,
 * `goals` and `contexts` are a model's reading of the same messages, and every
 * one of them carries the key of the message it was read from.
 *
 * `coverage` is what keeps the second half honest. A twin modelled three weeks
 * ago is otherwise indistinguishable from one modelled this morning, and the
 * agent would describe the conversation as it stood before the argument.
 * ------------------------------------------------------------------ */

export type ArcStatus = "open" | "stalled" | "resolved" | "abandoned";
export type ProposalStatus = "open" | "accepted" | "dismissed" | "expired";

export interface TwinGoal {
  id: number;
  holder: "user" | "them" | "shared";
  statement: string;
  status: "open" | "met" | "blocked" | "dropped";
  confidence?: number;
  source_message_key: string;
  source_text: string;
  source_sender?: string;
  source_sent_at?: string;
  /**
   * 1 when the citing message was one the user sent, 0 when it came from the
   * other side. The taint mark: a goal read off someone else's words is
   * untrusted third-party content, and the same sentence read off the user's
   * own message is not. Resolved by joining the cited message, never stored
   * twice.
   */
  source_outgoing?: number;
}

export interface TwinArc {
  id: number;
  key: string;
  title: string;
  summary?: string;
  status: ArcStatus;
  first_message_key: string;
  last_message_key: string;
  confidence?: number;
  updated_at: string;
  goals: TwinGoal[];
}

export interface TwinContext {
  id: number;
  dimension: string;
  statement: string;
  confidence?: number;
  source_message_key: string;
  source_text: string;
  /** 1 when the user wrote the citing message, 0 when the other side did. */
  source_outgoing?: number;
}

export interface ProposalRow {
  id: number;
  chat: string;
  arc_title?: string;
  kind: string;
  headline: string;
  draft?: string;
  rationale: string;
  timing?: string;
  /** 1 when the draft commits the user and is theirs to word. */
  needs_user_wording: number;
  confidence?: number;
  basis: string[];
  status: ProposalStatus;
  created_at: string;
  last_proposed_at: string;
  /** Above 1 means the agent has suggested this before. */
  times_proposed: number;
}

/** Counted, not inferred. Every figure carries the sample it came from. */
export interface InteractionMetrics {
  messages: number;
  /** How many had a readable timestamp. Only these can be ordered. */
  timed: number;
  directionKnown: number;
  firstAt?: string;
  lastAt?: string;
  spanDays?: number;
  silentDays?: number;
  outgoingShare?: number;
  medianCharsUser?: number;
  medianCharsThem?: number;
  medianReplyMinutesUser?: number;
  medianReplyMinutesThem?: number;
  replySampleUser: number;
  replySampleThem: number;
  initiationsUser: number;
  initiationsThem: number;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  /** Who owes the next message, by who spoke last. */
  ballWith?: "user" | "them";
  activeHours: Array<{ hour: number; count: number }>;
  kinds: Record<string, number>;
  /** True when the medians rest on too few exchanges to be called a habit. */
  habitsAreThin: boolean;
}

export interface InteractionTwin {
  chat: string;
  found: boolean;
  reason?: string;
  metrics?: InteractionMetrics;
  coverage?: {
    archivedMessages: number;
    modelledAt?: string;
    /** Archived messages that arrived after the last modelling pass. */
    messagesSince: number;
    arcs: number;
    stale: boolean;
    reason?: string;
  };
  arcs?: TwinArc[];
  contexts?: TwinContext[];
  obligations?: {
    userOwesThem: ExtractionRow[];
    theyOweUser: ExtractionRow[];
    unanswered: ExtractionRow[];
  };
  proposals?: ProposalRow[];
  /** Moves the user has already said no to. Evidence about what not to repeat. */
  dismissed?: ProposalRow[];
}

export interface IngestResult {
  chat: string;
  mode: "top-up" | "backfill";
  scanned: number;
  inserted: number;
  duplicates: number;
  scrolls: number;
  /** The whole history has been reached — there is nothing older. */
  atTop: boolean;
  /** Stopped because it recognised a message already stored. */
  reachedKnown: boolean;
  /** Stopped because the bridge's interaction budget ran out. Resume later. */
  budgetExhausted: boolean;
  budgetRemaining: number;
  hasMore: boolean;
  bounds: { count: number; oldestAt?: string; newestAt?: string; oldestKey?: string; newestKey?: string };
}

export interface MediaPayload {
  /** The protocol's own message id — what the attachment is addressed by. */
  key: string;
  mediaType: string;
  /** The real byte length, measured before base64 inflated it by a third. */
  sizeBytes: number;
  filename?: string;
  base64: string;
}


/**
 * One observed change to the chat list.
 *
 * `preview` is the row's snippet, not the message — up to 160 characters, with a
 * group sender prefix when there is one. Enough to say what arrived and from
 * whom; never enough to quote. Anything more requires the archive.
 */
export interface InboxEvent {
  key: string;
  chat: string;
  kind: "message" | "mention" | "unread-cleared" | "own-message";
  preview: string;
  unread: number;
  observedAt: string;
  /** How many times this event has been claimed. Above 1 means a retry. */
  attempts?: number;
}

export interface ReactionResult {
  /** True when the bridge refused to act because it is inside quiet hours. */
  quiet: boolean;
  reason?: string;
  quietHours?: string;
  /** Everything the user should be told about. Empty means say nothing. */
  events: InboxEvent[];
  /** Chats the bridge topped up before returning, and how that went. */
  read: Array<{ chat: string; inserted?: number; scanned?: number; error?: string }>;
  /** Events held back from a read — never held back from being reported. */
  deferred: number;
  deferredWhy?: string[];
  budgetRemaining?: number;
  note?: string;
}

export class BridgeError extends Error {
  /**
   * Assigned in the body rather than declared as a constructor parameter
   * property. The parameter-property form is TypeScript that *emits* code, and
   * Node runs these files by stripping types rather than compiling them — so
   * it made this module, and everything importing it, impossible to load under
   * `node --test`. Nothing that talks to the bridge could be tested at all.
   */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  if (!TOKEN) {
    throw new BridgeError(
      "WA_BRIDGE_TOKEN is not set on the agent, so it cannot authenticate to the WhatsApp bridge.",
      500,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal,
      headers: {
        ...init.headers,
        authorization: `Bearer ${TOKEN}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  } catch (cause) {
    // A dead sidecar is the common failure and says nothing about WhatsApp
    // itself, so name it rather than surfacing a bare fetch error.
    throw new BridgeError(
      `Cannot reach the WhatsApp bridge at ${BASE}. Is the whatsapp-bridge container running?`,
      503,
    );
  }

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new BridgeError(body.error || `bridge returned ${res.status}`, res.status);
  return body as T;
}

export const bridge = {
  status: (signal?: AbortSignal) =>
    call<{
      archive: { chats: number; messages: number };
      transport: "configured" | "unset";
    }>("/status", {}, signal),

  /**
   * Recent conversations, from the archive.
   *
   * `displayName` is null for anyone not in the contact list: the protocol
   * offers no name for them, and deriving one from a phone number is what
   * `internal/identity` exists to prevent. Fall back to `key`.
   */
  listChats: (limit: number, signal?: AbortSignal) =>
    call<{
      chats: Array<{
        key: string;
        displayName: string | null;
        kind: string | null;
        provisional: boolean;
        messages: number;
        lastMessageAt: string | null;
      }>;
    }>(`/archive/chats?limit=${limit}`, {}, signal),

  /**
   * One conversation's recent messages, from the archive.
   *
   * There is no `exactMatch` any more, and its absence is the point: this used
   * to type a name into WhatsApp's search box and report how well the first
   * result matched. A chat is now addressed by its key.
   */
  readChat: (chat: string, limit: number, signal?: AbortSignal) =>
    call<{
      chat: string;
      messages: WhatsAppMessage[];
      note?: string;
    }>(
      // `newest` is not optional here. Without it the archive cuts the limit
      // from the OLDEST end, so "the last 25 messages" answers with the first
      // 25 ever exchanged and a busy chat reads as a quiet one.
      `/archive/messages?chat=${encodeURIComponent(chat)}&limit=${limit}&newest=1`,
      {},
      signal,
    ),

  /* ---------------------------------------------------------------- *
   * Acting on a message that already exists.
   *
   * All four take the protocol's own `messageId` — the key the archive stores —
   * because a reaction or a revoke addresses one exact message and nothing else
   * identifies it. `sender` is needed only in a group, where the target may be
   * somebody else's message.
   * ---------------------------------------------------------------- */

  /** React, or pass an empty emoji to take a reaction back. */
  react: (
    params: { to: string; messageId: string; emoji: string; sender?: string },
    signal?: AbortSignal,
  ) => call<{ id: string; sentAt?: string }>(
    "/send/reaction",
    { method: "POST", body: JSON.stringify(params) },
    signal,
  ),

  /** Replace the text of a message already sent. */
  editMessage: (
    params: { to: string; messageId: string; message: string },
    signal?: AbortSignal,
  ) => call<{ id: string; sentAt?: string }>(
    "/send/edit",
    { method: "POST", body: JSON.stringify(params) },
    signal,
  ),

  /** Delete for everyone. The only undo this system has. */
  revokeMessage: (
    params: { to: string; messageId: string; sender?: string },
    signal?: AbortSignal,
  ) => call<{ id: string; sentAt?: string }>(
    "/send/revoke",
    { method: "POST", body: JSON.stringify(params) },
    signal,
  ),

  sendPoll: (
    params: { to: string; name: string; options: string[]; selectableCount?: number },
    signal?: AbortSignal,
  ) => call<{ id: string; sentAt?: string }>(
    "/send/poll",
    { method: "POST", body: JSON.stringify(params) },
    signal,
  ),

  votePoll: (
    params: { to: string; messageId: string; options: string[]; sender?: string },
    signal?: AbortSignal,
  ) => call<{ id: string; sentAt?: string }>(
    "/send/poll/vote",
    { method: "POST", body: JSON.stringify(params) },
    signal,
  ),

  /**
   * Typing and online indicators.
   *
   * The one call here that is about how the account LOOKS rather than what it
   * says: a considered answer that takes a minute reads as absence without it.
   */
  presence: (
    params: { to: string; state: "composing" | "recording" | "paused" | "available" | "unavailable"; media?: string },
    signal?: AbortSignal,
  ) => call<{ ok: boolean }>(
    "/presence",
    { method: "POST", body: JSON.stringify(params) },
    signal,
  ),

  /**
   * Re-resolve the chats the transport could only give a provisional key.
   *
   * Fixes the `pn:` digests the README documents: whatsmeow fills its LID cache
   * on first use, and a cache filled seconds after pairing is filled empty.
   */
  refreshNames: (signal?: AbortSignal) =>
    call<{ updated: number; remaining?: number }>(
      "/archive/names/refresh",
      { method: "POST" },
      signal,
    ),

  /** Pairing and connection state, straight from the transport. */
  transportStatus: (signal?: AbortSignal) =>
    call<{
      session?: { paired?: boolean; connected?: boolean; loggedIn?: boolean };
      send?: { enabled?: boolean; allowlistedSize?: number };
      archive?: { provisionalChats?: number };
    }>("/transport/status", {}, signal),

  sendMessage: (to: string, message: string, signal?: AbortSignal) =>
    call<{
      sent: boolean;
      to: string;
      message: string;
      at: string;
      requestedRecipient: string;
      exactMatch: boolean;
      warning?: string;
    }>("/send", { method: "POST", body: JSON.stringify({ to, message }) }, signal),

  /**
   * Ask the phone for messages older than the archive already holds.
   *
   * This replaces `ingest`, which scrolled a rendered conversation. Reachable
   * depth is whatever the PHONE still has, not whatever WhatsApp's servers have,
   * so a short answer is a fact about the phone rather than a failure.
   */
  requestHistory: (
    params: { chat: string; oldestId?: string; oldestTimestamp?: number; count?: number },
    signal?: AbortSignal,
  ) => call<{ requested: boolean }>("/history", { method: "POST", body: JSON.stringify(params) }, signal),

  /** Keyword search over everything ingested. Reads SQLite, never WhatsApp. */
  searchArchive: (params: ArchiveSearchParams, signal?: AbortSignal) => {
    const query = new URLSearchParams({ q: params.query });
    for (const field of ["chat", "sender", "since", "until", "kind", "order"] as const) {
      if (params[field]) query.set(field, String(params[field]));
    }
    if (params.outgoing !== undefined) query.set("outgoing", String(params.outgoing));
    if (params.limit) query.set("limit", String(params.limit));
    return call<{ query: string; hits: ArchiveHit[] }>(`/archive/search?${query}`, {}, signal);
  },

  /** The conversation around one hit — a result is rarely an answer alone. */
  archiveContext: (
    params: { key: string; before?: number; after?: number },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ key: params.key });
    if (params.before !== undefined) query.set("before", String(params.before));
    if (params.after !== undefined) query.set("after", String(params.after));
    return call<{ chat: string; key: string; messages: Array<ArchiveHit & { matched?: boolean }> }>(
      `/archive/context?${query}`,
      {},
      signal,
    );
  },

  /**
   * Stored messages for one chat, each with the key an extraction must cite.
   *
   * `newest` decides which end the limit cuts from. Leave it off and a small
   * limit returns the OLDEST messages in the chat, which is right for walking an
   * archive forwards and wrong for every question about what just happened.
   */
  archiveMessages: (
    params: { chat: string; limit?: number; newest?: boolean },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ chat: params.chat });
    if (params.limit) query.set("limit", String(params.limit));
    if (params.newest) query.set("newest", "1");
    return call<{ chat: string; messages: ArchiveHit[] }>(`/archive/messages?${query}`, {}, signal);
  },

  saveExtractions: (items: unknown[], signal?: AbortSignal) =>
    call<{ inserted: number; duplicates: number }>(
      "/archive/extractions",
      { method: "POST", body: JSON.stringify({ items }) },
      signal,
    ),

  /** A transcript already stored for this message, or `null`. */
  getTranscript: (key: string, signal?: AbortSignal) =>
    call<{ key: string; transcript: string | null; createdAt?: string }>(
      `/archive/transcript?key=${encodeURIComponent(key)}`,
      {},
      signal,
    ),

  /**
   * File a voice note's transcript against its message. Refused with 409 if
   * that chat was never archived — there is nothing for it to cite.
   */
  saveTranscript: (params: { key: string; text: string }, signal?: AbortSignal) =>
    call<{ stored: boolean; key: string }>(
      "/archive/transcript",
      { method: "POST", body: JSON.stringify(params) },
      signal,
    ),

  /** Record something durable, citing the message that says it. */
  saveFact: (
    params: { subject?: string; statement: string; sourceMessageKey: string; confidence?: number },
    signal?: AbortSignal,
  ) =>
    call<{ id: number; subject: string | null; sourceMessageKey: string }>(
      "/archive/facts",
      { method: "POST", body: JSON.stringify(params) },
      signal,
    ),

  listFacts: (params: { subject?: string; chat?: string; limit?: number }, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
    return call<{ facts: FactRow[] }>(`/archive/facts?${query}`, {}, signal);
  },

  /** Everything the archive knows about one person. Browser-free. */
  personDossier: (name: string, signal?: AbortSignal) =>
    call<Dossier>(`/people/dossier?name=${encodeURIComponent(name)}`, {}, signal),

  /** Who a name refers to, by name similarity — never by recency. */
  resolveContact: (name: string, signal?: AbortSignal) =>
    call<ContactResolution>(`/people/resolve?name=${encodeURIComponent(name)}`, {}, signal),

  peopleRoster: (signal?: AbortSignal) =>
    call<{
      roster: Array<{ name: string; messages: number; last_message_at?: string }>;
      aliases: Record<string, string>;
    }>("/people/roster", {}, signal),

  setAlias: (
    params: {
      alias: string;
      canonical?: string;
      forget?: boolean;
      /**
       * Where the nickname came from. "session" means the user said so while
       * talking to the agent; "message" means it was read out of chat text and
       * must cite the message, exactly as a fact must. The bridge rejects
       * "message" without a citation.
       */
      origin?: "session" | "message";
      sourceMessageKey?: string;
    },
    signal?: AbortSignal,
  ) =>
    call<{ alias: string; canonical?: string; origin?: string }>(
      "/people/alias",
      { method: "POST", body: JSON.stringify(params) },
      signal,
    ),

  /** Every alias with where it came from, for reviewing what the agent taught itself. */
  listAliases: (params: { origin?: string } = {}, signal?: AbortSignal) =>
    call<{
      aliases: Array<{
        alias: string;
        canonical: string;
        origin: "session" | "message" | "unknown";
        source_message_key: string | null;
        source_text: string | null;
        source_outgoing: number | null;
      }>;
    }>(
      `/people/aliases${params.origin ? `?origin=${encodeURIComponent(params.origin)}` : ""}`,
      {},
      signal,
    ),

  /**
   * Withdraw a stored fact. A tombstone, not a delete: the row stays so that
   * "why did I believe this?" is still answerable once the belief turns out to
   * be wrong. A reason is required.
   */
  retractFact: (params: { id: number; reason: string }, signal?: AbortSignal) =>
    call<{ id: number; retracted: boolean; at?: string; alreadyRetracted?: boolean }>(
      "/archive/facts/retract",
      { method: "POST", body: JSON.stringify(params) },
      signal,
    ),

  restoreFact: (params: { id: number }, signal?: AbortSignal) =>
    call<{ id: number; retracted: boolean }>(
      "/archive/facts/restore",
      { method: "POST", body: JSON.stringify(params) },
      signal,
    ),

  resolveExtraction: (params: { id: number; status?: "done" | "dropped" }, signal?: AbortSignal) =>
    call<{ id: number; status: string }>(
      "/archive/extractions/resolve",
      { method: "POST", body: JSON.stringify(params) },
      signal,
    ),

  /* ---------------------------------------------------------------- *
   * The self-chat console.
   *
   * The inbox-event queue that used to live here is gone with the browser. It
   * existed because detection was free but REACTING was not: topping up a chat
   * meant opening it in a real browser, so the bridge owned a cooldown, a
   * fan-out cap, a scroll cap and quiet hours to bound an interaction the
   * account could be banned for. Reception is push now — the transport holds the
   * socket and messages land in a durable outbox — so there is no queue to claim
   * from and no interaction to ration.
   * ---------------------------------------------------------------- */

  /**
   * What the operator typed in `/eve` mode, for this agent to answer.
   *
   * Drains on read: answer through `sendSelfNote`, because a message handed over
   * twice would be answered twice. Empty is the normal state — the console only
   * forwards while the operator has entered that state.
   */
  pendingForAgent: (params: { waitMs?: number } = {}, signal?: AbortSignal) =>
    call<{
      items: Array<{ text: string; at: string }>;
      count: number;
      /** `eve` while the user is in that state; null when they have left it. */
      state: string | null;
    }>(`/self/pending?waitMs=${params.waitMs ?? 0}`, {}, signal),

  /** The four buckets behind "what needs my attention". */
  attention: (params: { horizonDays?: number } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (params.horizonDays) query.set("horizonDays", String(params.horizonDays));
    return call<AttentionDigest>(`/archive/attention?${query}`, {}, signal);
  },

  listExtractions: (
    params: {
      type?: string;
      actor?: string;
      chat?: string;
      status?: string;
      overdue?: boolean;
      dueBefore?: string;
      limit?: number;
    },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
    return call<{ items: ExtractionRow[] }>(`/archive/extractions?${query}`, {}, signal);
  },

  /* ---------------------------------------------------------------- *
   * The interaction twin.
   *
   * Archive operations, all of them: they read and write SQLite and never open
   * a conversation, so none of them spends from the interaction budget or can
   * be refused for rate limits. Modelling a chat is free; reading one is not.
   * ---------------------------------------------------------------- */

  /** Write one modelling pass. Rejected whole if any item cites an unread message. */
  saveInteractionModel: (
    params: {
      chat: string;
      throughMessageKey: string;
      considered?: number;
      arcs?: unknown[];
      contexts?: unknown[];
    },
    signal?: AbortSignal,
  ) =>
    call<{
      chat: string;
      modelledAt: string;
      arcs: { inserted: number; updated: number };
      goals: { inserted: number; duplicates: number };
      contexts: { inserted: number; updated: number };
    }>("/twin/model", { method: "POST", body: JSON.stringify(params) }, signal),

  /** The assembled twin: measured behaviour, modelled threads, and staleness. */
  twin: (
    params: { chat: string; arcStatus?: ArcStatus; horizonDays?: number },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ chat: params.chat });
    if (params.arcStatus) query.set("arcStatus", params.arcStatus);
    if (params.horizonDays) query.set("horizonDays", String(params.horizonDays));
    return call<InteractionTwin>(`/twin?${query}`, {}, signal);
  },

  /** Conversations whose archive has moved on since they were last modelled. */
  staleTwins: (params: { limit?: number; minimumNew?: number } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
    return call<{
      chats: Array<{
        chat: string;
        messages: number;
        messages_since: number;
        modelled_at?: string;
        neverModelled: boolean;
      }>;
    }>(`/twin/stale?${query}`, {}, signal);
  },

  resolveArc: (params: { id: number; status: ArcStatus }, signal?: AbortSignal) =>
    call<{ id: number; status: string }>(
      "/twin/arcs/resolve",
      { method: "POST", body: JSON.stringify(params) },
      signal,
    ),

  /**
   * Record proposed next moves.
   *
   * This reaches nobody. A proposal is a row in the archive; sending is still
   * only `sendMessage` and `writeSelf`, behind the bridge's allowlist. Keeping
   * the two apart is what makes it safe for the agent to think about what to
   * say without any chance of saying it.
   */
  saveProposals: (items: unknown[], signal?: AbortSignal) =>
    call<{ inserted: number; repeated: number }>(
      "/twin/proposals",
      { method: "POST", body: JSON.stringify({ items }) },
      signal,
    ),

  listProposals: (
    params: { chat?: string; status?: ProposalStatus; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
    return call<{ proposals: ProposalRow[] }>(`/twin/proposals?${query}`, {}, signal);
  },

  resolveProposal: (params: { id: number; status: ProposalStatus }, signal?: AbortSignal) =>
    call<{ id: number; status: string }>(
      "/twin/proposals/resolve",
      { method: "POST", body: JSON.stringify(params) },
      signal,
    ),

  archiveStats: (signal?: AbortSignal) =>
    call<{
      chats: number;
      messages: number;
      transcripts: number;
      facts: number;
      budgetRemaining: number;
      budgetPerHour: number;
    }>("/archive/stats", {}, signal),

  /**
   * The payload behind one media message, addressed by position from the end of
   * the chat. `kind`/`from`/`time` are a fingerprint: the bridge refuses if the
   * row at that position is not the one that was read, because a message
   * arriving in between would otherwise redirect this to a different attachment.
   */
  /**
   * The payload behind one media message, by the protocol's own message id.
   *
   * The old signature took a position from the end of a rendered chat plus a
   * `kind`/`from`/`time` fingerprint to check that the row there was still the
   * one the caller had read. All of that existed because a position is not an
   * address. An id is.
   */
  fetchMedia: (params: { key: string }, signal?: AbortSignal) =>
    call<MediaPayload>(`/media?key=${encodeURIComponent(params.key)}`, {}, signal),

  /**
   * The name of the user's own chat, so it can be *read* as well as written to.
   *
   * Returned as the account's own identity key. There is no name involved on
   * either side any more: the transport addresses the account from its device
   * store, so nothing here can be fuzzy-matched to a stranger.
   */
  selfChat: (signal?: AbortSignal) =>
    call<{
      chat: string;
      /**
       * Where that chat can be READ. `archive` means the stored messages —
       * there is no conversation to open, because the protocol transport has no
       * screen. Anything that assumes otherwise addresses a component that no
       * longer exists.
       */
      source: "archive";
      via: "transport";
      /**
       * The bridge's own console session, when one is open — `"game"`, `"eve"`,
       * or `null` for none. While it is set the console is answering that chat
       * as each message arrives, and its game reads bare digits as moves. A
       * second responder has to stand down rather than answer the same keystroke
       * a few minutes later.
       */
      console?: string | null;
    }>("/self/chat", {}, signal),

  /**
   * Write to the user's own chat.
   *
   * No allowlist and no confirmation, because there is no recipient to get
   * wrong: the transport resolves the account's own JID itself and this call
   * carries no address at all.
   */
  writeSelf: (messages: string[], signal?: AbortSignal) =>
    call<{ sent: boolean; chat: string; messages: string[]; at: string }>(
      "/send/self",
      { method: "POST", body: JSON.stringify({ messages }) },
      signal,
    ),

  /**
   * An image to the user's own chat.
   *
   * Base64 over this hop because it is loopback between two processes we own,
   * and a JSON body keeps the bridge route, its tests and this client reading
   * the same shape. The encoding cost is nothing beside the media upload that
   * follows it.
   */
  writeSelfImage: (
    image: {
      bytes: Uint8Array;
      mimetype?: string;
      caption?: string;
      width?: number;
      height?: number;
      /** `document` for a PDF: WhatsApp shows a file row rather than a preview. */
      kind?: "image" | "document";
      /** What the file is called on the phone. Only meaningful for a document. */
      filename?: string;
    },
    signal?: AbortSignal,
  ) =>
    call<{ id: string; sentAt: string; chat: string; archived: boolean }>(
      "/send/self/media",
      {
        method: "POST",
        body: JSON.stringify({
          dataBase64: Buffer.from(image.bytes).toString("base64"),
          mimetype: image.mimetype ?? "image/png",
          caption: image.caption,
          width: image.width,
          height: image.height,
          kind: image.kind,
          filename: image.filename,
        }),
      },
      signal,
    ),

  /**
   * An image, for an allowlisted recipient.
   *
   * Protocol-only, and always was: the browser path had no attachment mechanism
   * at all.
   */
  sendMedia: (
    params: {
      to: string;
      bytes: Uint8Array;
      mimetype: string;
      caption?: string;
      kind?: "image" | "document";
      filename?: string;
      width?: number;
      height?: number;
    },
    signal?: AbortSignal,
  ) =>
    call<{ sent: boolean; to: string; at: string; exactMatch?: boolean }>(
      "/send/media",
      {
        method: "POST",
        body: JSON.stringify({
          to: params.to,
          // The route reads `dataBase64`; an `image` field would arrive as a
          // 400 saying the payload is missing, which is what it used to send.
          dataBase64: Buffer.from(params.bytes).toString("base64"),
          mimetype: params.mimetype,
          caption: params.caption,
          kind: params.kind,
          filename: params.filename,
          width: params.width,
          height: params.height,
        }),
      },
      signal,
    ),
};
