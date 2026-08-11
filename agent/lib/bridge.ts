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
  chat: string;
  exactMatch: boolean;
  fromEnd: number;
  /**
   * The archive's id for this row. `fromEnd` expires the moment a message
   * arrives; this does not, so it is what a transcript is filed under.
   */
  key: string;
  kind: MessageKind;
  from?: string;
  time?: string;
  filename?: string;
  mediaType: string;
  sizeBytes: number;
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
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
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
    call<{ state: "logged_in" | "logged_out" | "loading"; reason?: string }>("/status", {}, signal),

  listChats: (limit: number, signal?: AbortSignal) =>
    call<{ chats: Array<{ name: string; preview: string; unread: number }>; note?: string }>(
      `/chats?limit=${limit}`,
      {},
      signal,
    ),

  readChat: (chat: string, limit: number, signal?: AbortSignal) =>
    call<{
      chat: string;
      resolvedFrom: string;
      exactMatch: boolean;
      /** How many messages of each kind are in this window. */
      counts?: Record<MessageKind, number | undefined>;
      messages: WhatsAppMessage[];
      note?: string;
    }>(`/messages?chat=${encodeURIComponent(chat)}&limit=${limit}`, {}, signal),

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
   * Walk a chat backwards and write it to the archive. Bounded on purpose —
   * call again while `hasMore` is true. Re-reading costs nothing, because
   * messages are identified by content.
   */
  ingest: (
    params: { chat: string; mode?: "top-up" | "backfill"; maxScrolls?: number },
    signal?: AbortSignal,
  ) => call<IngestResult>("/ingest", { method: "POST", body: JSON.stringify(params) }, signal),

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

  /** Stored messages for one chat, each with the key an extraction must cite. */
  archiveMessages: (params: { chat: string; limit?: number }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ chat: params.chat });
    if (params.limit) query.set("limit", String(params.limit));
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
   * Events.
   *
   * The bridge watches the chat list passively and queues what changed. It
   * owns every limit on reacting — per-chat cooldown, quiet hours, fan-out cap,
   * interaction budget — for the same reason it owns the send allowlist: a cap
   * the agent enforces is a cap a confused agent can talk itself out of.
   * ---------------------------------------------------------------- */

  /** Look at the queue, claiming nothing and reading no chats. */
  inboxEvents: (params: { limit?: number } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    return call<{
      events: Array<{
        key: string;
        chat: string;
        kind: InboxEvent["kind"];
        preview?: string;
        unread?: number;
        observed_at: string;
        attempts: number;
      }>;
      queue: { pending: number; handled: number; leased: number };
    }>(`/events?${query}`, {}, signal);
  },

  /** Whether the watcher is running, and what it has seen. */
  inboxStatus: (signal?: AbortSignal) =>
    call<{
      watching: boolean;
      observer: { installed: boolean; error?: string | null };
      baselineAt: string | null;
      counters: { snapshots: number; skipped: number; recorded: number; lastAt: string | null };
      queue: { pending: number; handled: number; leased: number };
      settings: {
        cooldownMinutes: number;
        maxChatsPerWake: number;
        maxScrolls: number;
        quietHours: string | null;
        quietHoursValid: boolean;
        inQuietHoursNow: boolean;
      };
      budgetRemaining: number;
      note?: string;
    }>("/events/status", {}, signal),

  /**
   * Claim pending events and let the bridge top up the archive for whichever
   * chats its own limits allow it to open.
   *
   * Claiming does not close the events out — `completeInboxEvents` does, after
   * the user has actually been told. A crash in between means the notification
   * is late, not lost.
   */
  reactToInbox: (params: { limit?: number } = {}, signal?: AbortSignal) =>
    call<ReactionResult>(
      "/events/react",
      { method: "POST", body: JSON.stringify(params) },
      signal,
    ),

  /** Acknowledge events, after the user has been told about them. */
  completeInboxEvents: (keys: string[], signal?: AbortSignal) =>
    call<{ handled: number }>(
      "/events/complete",
      { method: "POST", body: JSON.stringify({ keys }) },
      signal,
    ),

  /** Hand events back unhandled, for the next tick to reconsider. */
  releaseInboxEvents: (keys: string[], signal?: AbortSignal) =>
    call<{ released: number }>(
      "/events/release",
      { method: "POST", body: JSON.stringify({ keys }) },
      signal,
    ),

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
  fetchMedia: (
    params: {
      chat: string;
      fromEnd: number;
      kind?: MessageKind;
      from?: string;
      time?: string;
      maxBytes?: number;
    },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ chat: params.chat, fromEnd: String(params.fromEnd) });
    if (params.kind) query.set("kind", params.kind);
    if (params.from) query.set("from", params.from);
    if (params.time) query.set("time", params.time);
    if (params.maxBytes) query.set("maxBytes", String(params.maxBytes));
    return call<MediaPayload>(`/media?${query}`, {}, signal);
  },

  /**
   * Write to the user's own chat. The bridge owns the safety check: it refuses
   * unless the conversation open is exactly WA_SELF_CHAT_NAME, so there is no
   * recipient to get wrong and nothing for a human to confirm.
   */
  writeSelf: (messages: string[], signal?: AbortSignal) =>
    call<{ sent: boolean; chat: string; messages: string[]; at: string }>(
      "/send/self",
      { method: "POST", body: JSON.stringify({ messages }) },
      signal,
    ),

  prepareSend: (to: string, message: string, signal?: AbortSignal) =>
    call<{
      token: string;
      resolvedRecipient: string;
      requestedRecipient: string;
      exactMatch: boolean;
      preview: string;
      expiresInSeconds: number;
      warning?: string;
    }>("/send/prepare", { method: "POST", body: JSON.stringify({ to, message }) }, signal),

  commitSend: (token: string, signal?: AbortSignal) =>
    call<{ sent: boolean; to: string; message: string; at: string }>(
      "/send/commit",
      { method: "POST", body: JSON.stringify({ token }) },
      signal,
    ),
};
