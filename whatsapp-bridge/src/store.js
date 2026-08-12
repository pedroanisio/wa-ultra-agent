import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { interactionMetrics, twinCoverage } from "./twin.js";

/**
 * Where read messages are kept.
 *
 * SQLite through `node:sqlite` — built into Node 24, so this adds no dependency
 * and no container. The file lives on the same volume as the session profile,
 * which is already treated as a credential; a searchable archive of someone's
 * private correspondence deserves exactly the same handling.
 *
 * ── Why not eve's defineState ───────────────────────────────────────────────
 * Because it is per-session working memory that dies with the session and is
 * never shared with subagents. Personal state outlives every session by
 * definition, so it has to be a real store. eve's own guidance says as much.
 *
 * ── The one property that is enforced, not documented ───────────────────────
 * Every derived row cites a message that was actually read. `facts` and
 * `transcripts` both carry a foreign key onto `messages(key)` and the connection
 * runs with `PRAGMA foreign_keys = ON`, so a fact with no source is rejected by
 * SQLite rather than by a code review. That is what makes "why do you think the
 * meeting is at 14:00?" answerable.
 *
 * ── Known limit ─────────────────────────────────────────────────────────────
 * FTS5 gives keyword search, not semantic search. Phrase and word queries work
 * today; embeddings do not. If vector search becomes the requirement, that is
 * the migration to Postgres + pgvector, and it is why SPEC §8.1 stays open.
 */

/**
 * Which direction an extracted item points, by type.
 *
 * Exported because the split is a semantic claim about the data, and two copies
 * of it drift: `attention()` and the per-person dossier both have to agree that
 * a `waiting` item is somebody else's move, or the same obligation shows up as
 * the user's problem in one view and theirs in the other.
 */
export const OWED_BY_USER_TYPES = ["commitment", "request", "deadline"];
export const OWED_TO_USER_TYPES = ["waiting"];
export const UNANSWERED_TYPES = ["question"];

/**
 * The vocabularies of the interaction twin.
 *
 * Enforced here rather than validated at the edge, for the same reason the
 * provenance foreign keys are: a status the store will accept is a status that
 * eventually appears, and a twin whose arcs are half `resolved` and half
 * `closed` cannot be queried for either.
 */
export const ARC_STATUSES = ["open", "stalled", "resolved", "abandoned"];
export const GOAL_HOLDERS = ["user", "them", "shared"];
export const GOAL_STATUSES = ["open", "met", "blocked", "dropped"];
export const CONTEXT_DIMENSIONS = [
  "language", // what is actually written, and by whom
  "register", // how formal, how short, how much joking
  "relationship", // who these two are to each other
  "cadence", // when and how often they talk
  "constraint", // something that limits what can be proposed
  "sensitivity", // a subject to handle carefully or not at all
  "setting", // where this conversation sits — work, family, a group
];
export const PROPOSAL_KINDS = [
  "reply", // answer something already said
  "follow_up", // chase something owed to the user
  "deliver", // make good on something the user owes
  "ask_user", // the agent needs a decision before anything can be proposed
  "wait", // the correct move is to leave it alone, for a stated reason
];
export const PROPOSAL_STATUSES = ["open", "accepted", "dismissed", "expired"];

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS chats (
  id         INTEGER PRIMARY KEY,
  -- The chat's ADDRESS, and the only handle anything above this file has on a
  -- conversation. On the DOM path it is the name rendered in the sidebar; on the
  -- protocol path it is the identity key (a LID, a group JID, or a pn: digest).
  -- UNIQUE is load-bearing: every query and every agent tool passes one string
  -- and expects it to mean one chat.
  --
  -- (No backticks anywhere in this block: SCHEMA is a template literal, so one
  -- would end it and the rest of the file would be parsed as JavaScript.)
  name       TEXT NOT NULL UNIQUE,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  -- The human-readable label, when the transport offers one. Deliberately NOT
  -- the address: pushName is asserted by the sender's own device and changes
  -- whenever they edit it, and two people can advertise the same one. Keying on
  -- it would split a person's history the first time they renamed themselves.
  display_name         TEXT,
  -- Which kind of address the name column holds, or NULL for a chat that
  -- predates the transport and is therefore addressed by a rendered display
  -- name. This is what distinguishes the two eras in one table.
  identity_kind        TEXT,
  -- Set when the address is a pn: digest, meaning no LID was known when the chat
  -- was first seen. Such a chat may be the same person as a LID-keyed one, and
  -- the archive cannot tell -- see provisionalChats.
  identity_provisional INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY,
  -- Content-addressed (see history.js). UNIQUE is what makes re-ingesting a
  -- window free, and what the provenance foreign keys point at.
  key              TEXT NOT NULL UNIQUE,
  chat_id          INTEGER NOT NULL REFERENCES chats(id),
  sender           TEXT,
  sent_at          TEXT,
  sent_at_iso      TEXT,
  kind             TEXT NOT NULL,
  text             TEXT NOT NULL,
  outgoing         INTEGER,
  duration_seconds INTEGER,
  filename         TEXT,
  caption          TEXT,
  ingested_at      TEXT NOT NULL,

  -- Everything below arrived by ALTER TABLE, and SQLite appends such a column to
  -- the END of the table. So a fresh database built from this block and an old
  -- one walked through MIGRATIONS agree on column ORDER only if the additions
  -- are listed here in migration order, last. migrations.test.js compares the
  -- two databases column by column and fails when they drift apart.
  --
  -- Backticks are a syntax error in here: this whole block is a JS template
  -- literal, so one would end it mid-SQL.

  -- The message this one is ABOUT: what a reaction was aimed at, which poll was
  -- voted in, what was pinned. Not a foreign key: the target regularly predates
  -- this archive's coverage, and a constraint would reject the reaction rather
  -- than record that it happened.
  target_key       TEXT,
  -- The protobuf arm behind an "unknown" row, and null for everything else.
  -- Without it, "unknown" is a dead end and the only way to learn what the
  -- archive is missing is to read the protocol by hand.
  unknown_type     TEXT
);

CREATE INDEX IF NOT EXISTS messages_by_chat ON messages(chat_id, sent_at_iso);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content='messages', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TABLE IF NOT EXISTS transcripts (
  message_key TEXT PRIMARY KEY REFERENCES messages(key),
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Durable beliefs about people and projects.
--
-- ── Provenance proves traceability, not truth ──────────────────────────────
-- The foreign key below guarantees every fact cites a message that was really
-- read. It cannot guarantee the message was true. Anyone in any group chat can
-- write a false statement, and a false statement that is genuinely present in
-- the archive passes every check this table makes — then reads back as a *cited*
-- fact with a receipt, which is more persuasive than an uncited one, not less.
-- That is the memory-poisoning surface, and provenance alone does not close it.
--
-- Two things follow, and both are columns here rather than documentation:
--
-- "retracted_at" makes the table revisable. A fact that was wrong, or planted,
-- must be removable — and removable WITHOUT deleting the row, because "this was
-- believed between 1 and 12 August" is itself worth knowing when working out
-- what a past decision rested on. Retraction is a tombstone, not a DELETE.
--
-- Direction is deliberately NOT stored. Whether a fact came from the user's own
-- words or from somebody else's is already recoverable — the cited message
-- carries "outgoing" — and a second copy of a derived truth is a second copy
-- that can disagree with the first. Reads join for it instead; see
-- "factsWithSource", which follows the precedent "extractions()" set.
CREATE TABLE IF NOT EXISTS facts (
  id                 INTEGER PRIMARY KEY,
  subject            TEXT,
  statement          TEXT NOT NULL,
  -- Not nullable, and a real foreign key: a fact with no source cannot exist.
  source_message_key TEXT NOT NULL REFERENCES messages(key),
  confidence         REAL,
  created_at         TEXT NOT NULL,
  retracted_at       TEXT,
  retraction_reason  TEXT
);

CREATE INDEX IF NOT EXISTS facts_by_source ON facts(source_message_key);
-- Recall is always "live facts about X", so the tombstone leads the index.
CREATE INDEX IF NOT EXISTS facts_live ON facts(retracted_at, subject);

-- What an extraction pass found in a conversation: commitments, requests,
-- deadlines, decisions, questions left unanswered. Same rule as facts — the
-- foreign key means an item with no source cannot be written.
CREATE TABLE IF NOT EXISTS extractions (
  id                 INTEGER PRIMARY KEY,
  -- Content-addressed over (type, statement, source), so re-running an
  -- extraction over the same messages writes nothing new.
  key                TEXT NOT NULL UNIQUE,
  type               TEXT NOT NULL,
  statement          TEXT NOT NULL,
  actor              TEXT,
  counterparty       TEXT,
  due_at            TEXT,
  confidence         REAL,
  status             TEXT NOT NULL DEFAULT 'open',
  source_message_key TEXT NOT NULL REFERENCES messages(key),
  created_at         TEXT NOT NULL
);

-- ── The interaction twin ──────────────────────────────────────────────────
--
-- An arc is a thread of purpose running through one conversation: "the
-- apartment renovation", "the Q3 numbers", "Saturday". It is what makes a chat
-- something other than a flat list of messages, and it is the unit the next
-- move is proposed against.
--
-- Same provenance rule as everything derived here, and it needs two keys rather
-- than one: an arc is a span, so it cites the message that opened it and the
-- last message that belongs to it. Both are real foreign keys, so an arc over
-- messages nobody read cannot be written.
--
-- key is content-addressed over (chat, normalised title). That is deliberate
-- and it is what stops a re-modelling pass from forking every arc it already
-- knows: continuing an arc means returning its title, not remembering an id,
-- and an id the model never sees is an id it cannot invent.
CREATE TABLE IF NOT EXISTS arcs (
  id                INTEGER PRIMARY KEY,
  key               TEXT NOT NULL UNIQUE,
  chat_id           INTEGER NOT NULL REFERENCES chats(id),
  title             TEXT NOT NULL,
  summary           TEXT,
  status            TEXT NOT NULL DEFAULT 'open',
  first_message_key TEXT NOT NULL REFERENCES messages(key),
  last_message_key  TEXT NOT NULL REFERENCES messages(key),
  confidence        REAL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS arcs_by_chat ON arcs(chat_id, status);

-- What each side is trying to get out of an arc. holder is the whole point:
-- "she wants the quote signed this week" and "I want to not commit to a price
-- yet" are the same arc and opposite goals, and a store that cannot tell them
-- apart cannot propose a move that serves the user.
CREATE TABLE IF NOT EXISTS goals (
  id                 INTEGER PRIMARY KEY,
  key                TEXT NOT NULL UNIQUE,
  arc_id             INTEGER NOT NULL REFERENCES arcs(id),
  holder             TEXT NOT NULL,
  statement          TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',
  confidence         REAL,
  source_message_key TEXT NOT NULL REFERENCES messages(key),
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS goals_by_arc ON goals(arc_id, status);

-- The standing frame of a conversation: which language it is actually written
-- in, how formal it is, who these two are to each other, what must not be
-- raised. Per chat rather than per arc, because it is the thing that does not
-- change when the subject does — and it is what a draft has to obey.
CREATE TABLE IF NOT EXISTS contexts (
  id                 INTEGER PRIMARY KEY,
  key                TEXT NOT NULL UNIQUE,
  chat_id            INTEGER NOT NULL REFERENCES chats(id),
  dimension          TEXT NOT NULL,
  statement          TEXT NOT NULL,
  confidence         REAL,
  source_message_key TEXT NOT NULL REFERENCES messages(key),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS contexts_by_chat ON contexts(chat_id, dimension);

-- When a conversation was last modelled, and how far through it the pass got.
--
-- This is the honesty column. Without it, a twin built three weeks ago is
-- indistinguishable from one built this morning, and the agent will describe a
-- conversation as it stood before the argument. through_message_key cites a
-- real message, so "how much has happened since" is a count, not a feeling.
CREATE TABLE IF NOT EXISTS twin_passes (
  chat_id             INTEGER PRIMARY KEY REFERENCES chats(id),
  through_message_key TEXT NOT NULL REFERENCES messages(key),
  considered          INTEGER NOT NULL,
  modelled_at         TEXT NOT NULL
);

-- Proposed next moves. Proposals, never actions: nothing in this table has been
-- sent, and writing to it costs no browser interaction and reaches nobody.
--
-- basis is a JSON array of message keys and it is not decorative — every key
-- in it is checked against messages before the row is written, so a proposal
-- assembled out of nothing cannot be stored. SQLite cannot express a foreign key
-- over a JSON array, so that check is code (see addProposals) rather than a
-- constraint, and it is the one place in this file where that is true.
--
-- status is why dismissal sticks. Re-proposing an identical move collides on
-- key and bumps times_proposed instead of resurrecting it: an assistant that
-- forgets it was told no is an assistant that nags.
CREATE TABLE IF NOT EXISTS proposals (
  id                 INTEGER PRIMARY KEY,
  key                TEXT NOT NULL UNIQUE,
  chat_id            INTEGER NOT NULL REFERENCES chats(id),
  arc_id             INTEGER REFERENCES arcs(id),
  kind               TEXT NOT NULL,
  headline           TEXT NOT NULL,
  draft              TEXT,
  rationale          TEXT NOT NULL,
  timing             TEXT,
  needs_user_wording INTEGER NOT NULL DEFAULT 0,
  confidence         REAL,
  basis              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',
  created_at         TEXT NOT NULL,
  last_proposed_at   TEXT NOT NULL,
  times_proposed     INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS proposals_by_chat ON proposals(chat_id, status);

-- Nicknames the user actually says, mapped to the chat name WhatsApp shows.
-- Learned at runtime, unlike WA_CONTACT_ALIASES which the operator hand-edits;
-- both feed the same resolution. An alias is a lookup convenience and never a
-- permission: the name it produces still has to pass the allowlist.
-- ── Why an alias carries provenance ────────────────────────────────────────
-- "facts" refuses a claim that cites no message. This table used to accept
-- anything, and that is a gap rather than a simplification: an alias learned
-- from chat text is message content influencing which chat gets opened, one step
-- removed — in tension with the rule that no message content may select a
-- recipient.
--
-- The allowlist still bounds the blast radius (the canonical name an alias
-- produces must pass "assertSendable", so an alias can never widen who may be
-- messaged). But "cannot widen the allowlist" is not the same as "trustworthy",
-- and at read time a nickname the user stated out loud was indistinguishable
-- from one the agent inferred from something it read.
--
-- "origin" makes the distinction legible:
--   session  the user said so, in conversation with the agent. Trusted.
--   message  read out of chat text. Must cite the message, and is surfaced as
--            derived so it can be reviewed.
--   unknown  predates this column. NOT back-filled as "session", because
--            nobody knows that, and a default that asserts trust is worse than
--            one that admits ignorance.
CREATE TABLE IF NOT EXISTS aliases (
  alias              TEXT PRIMARY KEY,
  canonical          TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  -- The default is "unknown", not "session", and never fires in practice:
  -- setAlias always supplies origin explicitly. It is set this way so that a
  -- column defaulted rather than stated can never be mistaken for a claim the
  -- user made -- and so the migrated and fresh schemas are identical, which is
  -- asserted in migrations.test.js.
  origin             TEXT NOT NULL DEFAULT 'unknown',
  source_message_key TEXT REFERENCES messages(key)
);

CREATE INDEX IF NOT EXISTS extractions_by_type ON extractions(type, status);
CREATE INDEX IF NOT EXISTS extractions_by_source ON extractions(source_message_key);

-- Changes the watcher saw in the chat list, queued for the agent to react to.
--
-- Deliberately NOT a foreign key onto chats(name), unlike everything else that
-- names a chat here. The entire value of an event is that it can concern a
-- conversation nobody has ever archived — "Fabio just messaged you" has to work
-- the first time, before any read has created a chats row. The provenance rule
-- that governs facts and extractions does not apply: an event is an observation
-- of the pane, not a claim derived from a message.
--
-- The lease columns are what make a dispatcher safe to run on a cadence. A
-- claim is an atomic UPDATE, so two overlapping ticks cannot both take the same
-- event and notify twice; an abandoned claim expires and the event is picked up
-- again rather than being lost with the process that took it.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  -- Content-addressed over what was observed (watch.js). UNIQUE is what makes a
  -- double-fired debounce, a reconnect replay and a retried claim all collapse
  -- onto one event instead of waking the agent three times.
  key         TEXT NOT NULL UNIQUE,
  chat        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  preview     TEXT,
  unread      INTEGER,
  observed_at TEXT NOT NULL,
  claimed_at  TEXT,
  lease_until TEXT,
  handled_at  TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS events_pending ON events(handled_at, lease_until, id);

-- When a chat last cost a browser interaction, and why.
--
-- Separate from chats.last_seen on purpose: that column tracks what the archive
-- knows, and is written by ingestion. This one tracks what the *account* did,
-- which is what the per-chat cooldown in watch.js has to reason about. Merging
-- them would let an archive write that involved no interaction reset a cooldown
-- that exists to keep the session from looking automated.
CREATE TABLE IF NOT EXISTS chat_touches (
  chat       TEXT PRIMARY KEY,
  touched_at TEXT NOT NULL,
  reason     TEXT
);
`;

/**
 * "10/08/2026 14:30" → ISO. Day-first, as WhatsApp renders it.
 *
 * Reading this as month-first silently reorders an entire history, so anything
 * that does not match exactly returns null rather than a guess.
 */
/**
 * A short, stable id for a row whose identity is its content.
 *
 * The NUL delimiter is deliberate: a space would let ("a b", "c") and ("a", "b c")
 * hash to the same id, which for an arc means two threads collapsing into one.
 *
 * It has one side effect worth knowing, because it has already cost two people an
 * afternoon: a NUL byte makes `grep` treat this whole file as binary, so it
 * returns nothing and exits 1 for strings that are plainly here. Use `grep -a`.
 *
 * Do not "fix" that by changing the delimiter. Every key in `arcs`, `goals`,
 * `contexts` and `proposals` is derived through here, so a different separator
 * silently re-keys all of them and the next modelling pass forks every stored
 * thread instead of continuing it. It is a one-way door; the comment is cheaper.
 */
export function contentKey(...parts) {
  return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 16);
}

/**
 * The form an arc title is compared in.
 *
 * "Q3 numbers" and "the Q3 numbers!" are the same arc, and treating them as two
 * is how a conversation ends up with nine copies of one thread after a month of
 * re-modelling. Case, punctuation and leading articles are noise here; the words
 * are the identity.
 */
export function normalizeArcTitle(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(the|a|an|o|a|os|as|um|uma)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const arcKeyFor = (chat, title) => contentKey("arc", chat, normalizeArcTitle(title));

/** "7/21/2026 19:41" — one or two digits per component, in either order. */
const STAMP = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/;

/**
 * Build an ISO string, refusing anything the calendar does not contain.
 *
 * `Date.UTC` rolls over silently — 31 February becomes 3 March — so the parts
 * are read back out and compared. A rolled-over date is not a slightly wrong
 * date; it is evidence the order was read the wrong way round.
 */
function toIso(year, month, day, hour, minute) {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString();
}

/**
 * Which number in "8/3/2026" is the month, decided from evidence.
 *
 * WhatsApp renders the date in the interface's locale and says nothing about
 * which order it used. Any sample with a component above 12 settles it for the
 * whole account — 21 is not a month, so "7/21/2026" proves month-first — and
 * one such row is enough to date every ambiguous row around it.
 *
 * Returns undefined when there is no evidence, and also when the evidence
 * contradicts itself. A majority vote would be worse than nothing here: it
 * would date the minority wrongly and report no doubt at all.
 */
export function detectDateOrder(samples = []) {
  let monthFirst = false;
  let dayFirst = false;

  for (const sample of samples) {
    const match = String(sample ?? "").match(/(\d{1,2})\/(\d{1,2})\/\d{4}/);
    if (!match) continue;

    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first > 12 && second <= 12) dayFirst = true;
    else if (second > 12 && first <= 12) monthFirst = true;
  }

  if (monthFirst && dayFirst) return undefined;
  if (monthFirst) return "month-first";
  if (dayFirst) return "day-first";
  return undefined;
}

/**
 * "7/21/2026 19:41" → ISO, once it is known which number is the month.
 *
 * ── Why this is not simply day-first ────────────────────────────────────────
 * It used to require `DD/MM/YYYY HH:MM`, zero-padded and day-first. A live
 * session renders `7/21/2026 19:41`, so every timestamp in the archive failed
 * to parse and was stored as null — which silently disabled `since`/`until`,
 * `order: "recent"`, `bounds`, and every due-date calculation, with nothing
 * anywhere reporting a problem.
 *
 * ── Why an ambiguous date still returns null ────────────────────────────────
 * `8/3/2026` is 3 August to a Brazilian and 8 March to an American. Guessing
 * does not produce a few wrong rows; it reorders a history by months, and a
 * reordered history looks exactly like a correct one. Evidence in the string
 * wins over any declared `order`; with neither, this returns null, and an
 * unparsed date is a visibly missing one.
 */
export function parseSentAt(text, { order } = {}) {
  const match = String(text || "").match(STAMP);
  if (!match) return null;

  const [, one, two, year, hour, minute] = match.map(Number);
  const ambiguous = one <= 12 && two <= 12;

  let month;
  let day;
  if (!ambiguous) {
    // The string settles it: whichever component cannot be a month is the day.
    if (one > 12 && two > 12) return null;
    [month, day] = one > 12 ? [two, one] : [one, two];
  } else if (order === "month-first") {
    [month, day] = [one, two];
  } else if (order === "day-first") {
    [month, day] = [two, one];
  } else {
    return null;
  }

  return toIso(year, month, day, hour, minute);
}

/**
 * The schema version this code expects. Bump it in the same commit as a new
 * entry in `MIGRATIONS`, never separately.
 */
export const SCHEMA_VERSION = 3;

export const ALIAS_ORIGINS = ["session", "message", "unknown"];

/**
 * The retention policy, read from the environment.
 *
 * ── Why absent means "keep forever" ────────────────────────────────────────
 * Because the alternative is deleting somebody's correspondence because they had
 * not heard of a setting. An unset window is no policy at all, not a default
 * policy — and a garbled window is treated the same way, since a typo in `.env`
 * turning into an aggressive prune is unrecoverable. `0` is honoured, because
 * "keep nothing" is a coherent thing to ask for and is spelled differently from
 * "I did not say".
 *
 * Windows are separate per kind because sensitivity is not uniform. A transcript
 * is a verbatim copy of somebody's voice; the fact that they sent a voice note is
 * not. Retracted facts get their own, shortest window: they are kept only so
 * "why did I believe that?" stays answerable, and that need has a shelf life.
 */
export function retentionFromEnv(env = process.env) {
  const policy = {};
  const read = (name, key) => {
    const raw = env[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") return;
    const days = Number(String(raw).trim());
    // NaN and negatives are configuration mistakes, and the safe reading of a
    // mistake is to retain rather than to delete.
    if (!Number.isFinite(days) || days < 0) return;
    policy[key] = days;
  };
  read("WA_RETAIN_MESSAGE_DAYS", "messageDays");
  read("WA_RETAIN_TRANSCRIPT_DAYS", "transcriptDays");
  read("WA_RETAIN_RETRACTED_FACT_DAYS", "retractedFactDays");
  return policy;
}

/**
 * How an archive that already exists on disk is brought up to `SCHEMA_VERSION`.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that is already there.
 * So adding a column to `SCHEMA` upgrades exactly one kind of database — a brand
 * new one — and every test in this suite opens `:memory:`, which means every test
 * builds one of those. A column added without a migration therefore goes green
 * everywhere and is missing only where it matters: the file on the operator's
 * volume, holding their correspondence, discovered at the first query that names
 * it.
 *
 * Index `i` upgrades a database at version `i` to version `i + 1`. Statements run
 * inside one transaction per step, so a step either lands whole or not at all —
 * a half-applied migration is how an archive gets bricked, because the retry then
 * fails on the column the first attempt already added.
 *
 * Entries are append-only and must never be edited once shipped. An operator's
 * database has already run the old text; changing it makes their schema
 * unreproducible and the drift test meaningless.
 */
const MIGRATIONS = [
  // 0 → 1: make durable memory revisable, and give aliases provenance.
  [
    "ALTER TABLE facts ADD COLUMN retracted_at TEXT",
    "ALTER TABLE facts ADD COLUMN retraction_reason TEXT",
    // No DEFAULT here, unlike SCHEMA. A row that predates the column has an
    // origin nobody knows, and back-filling it as 'session' would fabricate the
    // claim that the user stated it. Existing rows become 'unknown'.
    "ALTER TABLE aliases ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown'",
    "ALTER TABLE aliases ADD COLUMN source_message_key TEXT REFERENCES messages(key)",
    "CREATE INDEX IF NOT EXISTS facts_live ON facts(retracted_at, subject)",
  ],
  // 1 → 2: let a chat be addressed by a protocol identity instead of a rendered
  // name, now that `whatsapp-transport` supplies one.
  //
  // Additive on purpose. The obvious alternative — rebuild `chats` so `name` is a
  // non-unique label and a new `identity_key` column becomes the address — models
  // it more prettily and breaks everything above this file: `messagesFor(chat)`,
  // `search({chat})`, `twin(chat)` and every agent tool pass a single string and
  // could no longer resolve it to one row. The address stays unique; only what
  // may FILL it has widened.
  [
    "ALTER TABLE chats ADD COLUMN display_name TEXT",
    // No default and nullable: a chat that predates the transport has no identity
    // kind, and inventing one would assert it was protocol-addressed when it was
    // scraped from a sidebar.
    "ALTER TABLE chats ADD COLUMN identity_kind TEXT",
    // Defaulted, because "not provisional" is the truth for every existing row:
    // a DOM-era chat is not a placeholder awaiting a LID.
    "ALTER TABLE chats ADD COLUMN identity_provisional INTEGER NOT NULL DEFAULT 0",
  ],
  // 2 → 3: record what a message is ABOUT, and what an `unknown` row actually
  // was.
  //
  // Both arrive with the protocol layer's widened vocabulary. A reaction with no
  // target stores as "somebody reacted to something", which no query can use;
  // and an `unknown` row with no type is why 446 undescribed messages sat in
  // this archive with no way to ask what they were.
  //
  // Nullable with no default, because both are genuinely unknown for every row
  // that predates them. Back-filling either would fabricate a claim.
  [
    "ALTER TABLE messages ADD COLUMN target_key TEXT",
    "ALTER TABLE messages ADD COLUMN unknown_type TEXT",
  ],
];

/**
 * Bring `db` to `SCHEMA_VERSION`, whatever it is on now.
 *
 * Distinguishing "brand new" from "pre-versioning" is the one subtlety: both
 * report `user_version = 0`, because versioning did not exist when the older
 * archives were written. A new database has no tables, so that is the test —
 * a fresh file gets `SCHEMA` and is stamped current, while an existing one is
 * walked through the migrations it has not run.
 */
function migrate(db) {
  const version = () => db.prepare("PRAGMA user_version").get().user_version;

  const preexisting = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get();

  if (!preexisting) {
    // A new archive is created at the current shape; there is nothing to upgrade.
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }

  // ── Order matters, and getting it wrong is silent on a fresh database ────
  // Migrations run FIRST, then SCHEMA. The reverse ordering looks equivalent and
  // is not: SCHEMA declares indexes over the columns migrations add, so running
  // it first fails on an old archive with "no such column" — while passing on
  // every fresh one, because there the columns are already there. This exact
  // mistake was made here and was caught only by the legacy-archive fixture.
  //
  // Consequence for future migrations: a migration may not depend on a table
  // that only SCHEMA creates. It must create what it needs itself, which is the
  // usual rule for migrations anyway — they have to describe a world that
  // existed when they were written, not the one in the current SCHEMA.
  for (let from = version(); from < SCHEMA_VERSION; from++) {
    const steps = MIGRATIONS[from];
    if (!steps) {
      throw new Error(
        `No migration from schema version ${from} to ${from + 1}. This archive was written by a ` +
          "newer build than the one now opening it; upgrade the bridge rather than downgrading the file.",
      );
    }

    db.exec("BEGIN");
    try {
      for (const statement of steps) db.exec(statement);
      // Inside the transaction, so the stamp and the change land together. A
      // stamp that outlives a rolled-back step would skip the migration forever.
      db.exec(`PRAGMA user_version = ${from + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migrating the archive from version ${from} to ${from + 1} failed and was rolled back: ` +
          `${error.message}. The archive is unchanged and still readable by the previous build.`,
        { cause: error },
      );
    }
  }

  // Now that every column exists, pick up anything SCHEMA adds that is not a
  // column: new tables, new indexes, new triggers. All of these are
  // IF NOT EXISTS, so this is a no-op for everything the archive already has.
  db.exec(SCHEMA);
}

/**
 * @param dateOrder  Operator's answer to "which number is the month", used only
 *                   for windows whose own rows cannot settle it. Evidence in
 *                   the messages always wins over this.
 */
export function openStore(
  path = ":memory:",
  { now = () => new Date().toISOString(), dateOrder } = {},
) {
  // A missing directory is the difference between "no archive yet" and a crash
  // on first ingest, and the container's volume mount point may be the only
  // thing that exists.
  if (path !== ":memory:") {
    const directory = dirname(path);
    if (directory && directory !== ".") mkdirSync(directory, { recursive: true });
  }

  const db = new DatabaseSync(path);
  // Provenance is only guaranteed while this is on; SQLite defaults it off.
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  const chatId = (name) => {
    const at = now();
    db.prepare(
      `INSERT INTO chats (name, first_seen, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen`,
    ).run(name, at, at);
    return db.prepare("SELECT id FROM chats WHERE name = ?").get(name).id;
  };

  /**
   * The same upsert, for a chat the transport addressed by identity.
   *
   * Splitting this from `chatId` rather than widening it keeps the DOM path
   * incapable of writing an identity kind: a rendered sidebar name is not an
   * identity and must never be recorded as one.
   *
   * The display name is refreshed on every sighting because it is the sender's
   * current self-description and the archive has no better one. The identity
   * kind and the provisional flag are refreshed too — a chat first seen as a
   * `pn:` digest stays keyed on that digest, but if the transport ever resolves
   * it in place the row should stop claiming to be unsettled.
   */
  const identityChatId = ({ key, kind, provisional, displayName }) => {
    const at = now();
    db.prepare(
      `INSERT INTO chats (name, first_seen, last_seen, display_name, identity_kind, identity_provisional)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         last_seen            = excluded.last_seen,
         -- COALESCE, not a bare assignment: a payload that happens to carry no
         -- push name must not erase a label the archive already had.
         display_name         = COALESCE(excluded.display_name, chats.display_name),
         identity_kind        = COALESCE(excluded.identity_kind, chats.identity_kind),
         identity_provisional = excluded.identity_provisional`,
    ).run(key, at, at, displayName ?? null, kind ?? null, provisional ? 1 : 0);
    return db.prepare("SELECT id FROM chats WHERE name = ?").get(key).id;
  };

  /** Today, as a plain date, from the injected clock. */
  const today = () => now().slice(0, 10);

  /**
   * A caller mistake, not a fault. 400 keeps a rejected vocabulary out of the
   * error log and tells the caller which word it should have used.
   */
  const invalid = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
  };

  /**
   * The id of a chat that ALREADY EXISTS, refusing to invent one.
   *
   * ── The corruption this closes ──────────────────────────────────────────
   * `chatId` is an upsert, and that is correct where messages arrive: ingest
   * meets a conversation for the first time and files it. It is wrong
   * everywhere else. The interaction twin and the proposal writer passed the
   * agent's own string — a display name — and each pass MINTED a chat row
   * addressed by that name: nine of them in this archive, holding zero
   * messages, carrying every arc and proposal for conversations whose real
   * rows held thousands of messages and no model at all.
   *
   * Derived tables cannot create the thing they describe. A pass over a chat
   * nobody archived is a pass over nothing, and it is refused here rather than
   * silently given a chat of its own to be right about.
   */
  const existingChatId = (address) => {
    const row = db.prepare("SELECT id FROM chats WHERE name = ?").get(String(address ?? ""));
    if (!row) {
      const error = new Error(
        `No conversation is archived under "${address}", so nothing derived can be filed against ` +
          "it. Pass the chat's address as `/archive/chats` lists it — a display name that was " +
          "never resolved is not an address, and storing one creates a second, empty conversation.",
      );
      error.statusCode = 409;
      throw error;
    }
    return row.id;
  };

  const requireMessage = (key) => {
    const row = db.prepare("SELECT key FROM messages WHERE key = ?").get(key);
    if (!row) {
      const error = new Error(
        `No message with key "${key}" has been ingested, so nothing can cite it. Every stored ` +
          "fact must trace back to a message that was actually read.",
      );
      // Actionable, not a fault: the caller is citing a message from a chat
      // that was never archived, and the fix is to archive it. 409 keeps this
      // out of the error log and tells the caller what happened.
      error.statusCode = 409;
      throw error;
    }
  };

  return {
    /**
     * Write a window of messages. Idempotent: a key already present is counted
     * as a duplicate and left alone, which is what makes re-reading free.
     */
    upsertMessages(chat, messages) {
      const id = chatId(chat);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO messages
           (key, chat_id, sender, sent_at, sent_at_iso, kind, text, outgoing,
            duration_seconds, filename, caption, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      // Fill in a date that could not be resolved when the row was first read.
      //
      // Whether a timestamp can be read at all depends on the WINDOW it arrived
      // in: "8/3/2026" is undatable alone and unambiguous next to "7/21/2026".
      // Re-reading is free because messages are content-addressed, so a later
      // pass that reaches the evidence is exactly where the earlier rows get
      // their dates — without this they would stay null for the life of the
      // archive. Guarded on IS NULL so a resolved date is never re-decided.
      const backfillDate = db.prepare(
        "UPDATE messages SET sent_at_iso = ? WHERE key = ? AND sent_at_iso IS NULL",
      );

      // One order for the whole window, decided by the window's own rows and
      // falling back to the operator's setting only where they are silent.
      const order = detectDateOrder(messages.map((message) => message.time)) ?? dateOrder;

      let inserted = 0;
      db.exec("BEGIN");
      try {
        for (const message of messages) {
          const sentAtIso = parseSentAt(message.time, { order });

          const result = insert.run(
            message.key,
            id,
            message.from ?? null,
            message.time ?? null,
            sentAtIso,
            message.kind || "unknown",
            message.text || "",
            message.outgoing === undefined ? null : message.outgoing ? 1 : 0,
            message.media?.durationSeconds ?? null,
            message.media?.filename ?? null,
            message.media?.caption ?? null,
            now(),
          );

          if (result.changes > 0) inserted++;
          // Already stored, and this window can date it when the last one could
          // not. Counts as a duplicate either way: nothing new was recorded,
          // only something previously unreadable was read.
          else if (sentAtIso) backfillDate.run(sentAtIso, message.key);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return { inserted, duplicates: messages.length - inserted };
    },

    /**
     * Write a drained batch from `whatsapp-transport`.
     *
     * ── Why this is not `upsertMessages` ────────────────────────────────────
     * Three things differ, and each would be a silent corruption if the two paths
     * were merged:
     *
     *   1. A batch spans chats. A drain is a queue read, not a chat read, so the
     *      chat is a property of each row rather than of the call.
     *   2. The timestamp is real. `upsertMessages` runs `parseSentAt` over a
     *      rendered string like "8/3/2026" and may fail to date a row at all;
     *      the protocol supplies an instant, and passing it through the guesser
     *      would be a downgrade that can only lose.
     *   3. The key is the protocol's message id, not a content hash. It is stable
     *      across re-reads by construction, which is what `history.js` was
     *      approximating.
     *
     * A row that cannot be stored is counted in `rejected` and skipped rather
     * than aborting the batch: an entry drained from a queue of up to a thousand
     * cannot be allowed to block the nine hundred behind it, and the caller's ack
     * covers the whole range either way.
     *
     * @param rows  Output of `toArchiveRow` in transport.js — that function owns
     *              the protocol vocabulary, including placeholder rendering.
     */
    upsertTransportMessages(rows = []) {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO messages
           (key, chat_id, sender, sent_at, sent_at_iso, kind, text, outgoing,
            duration_seconds, filename, caption, target_key, unknown_type, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      let inserted = 0;
      let rejected = 0;
      const chats = new Set();

      db.exec("BEGIN");
      try {
        for (const row of rows) {
          // The archive's UNIQUE key and the target of every provenance foreign
          // key. A keyless row does not degrade the archive, it collides with
          // every other keyless row.
          if (!row?.key || !row?.chat?.key) {
            rejected++;
            continue;
          }

          const id = identityChatId(row.chat);
          chats.add(row.chat.key);

          const result = insert.run(
            row.key,
            id,
            row.sender?.key ?? null,
            row.sentAt ?? null,
            row.sentAtIso ?? null,
            row.kind || "unknown",
            row.text || "",
            row.outgoing === undefined ? null : row.outgoing ? 1 : 0,
            row.durationSeconds ?? null,
            row.filename ?? null,
            row.caption ?? null,
            row.targetKey ?? null,
            row.unknownType ?? null,
            now(),
          );
          if (result.changes > 0) inserted++;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return {
        inserted,
        duplicates: rows.length - inserted - rejected,
        rejected,
        chats: [...chats],
      };
    },

    /** What the archive knows about one identity-addressed chat. */
    chatIdentity(name) {
      return (
        db
          .prepare(
            `SELECT name, display_name, identity_kind, identity_provisional, first_seen, last_seen
             FROM chats WHERE name = ?`,
          )
          .get(name) ?? null
      );
    },

    /**
     * Chats still keyed on a `pn:` digest because no LID was known.
     *
     * These exist because the transport cannot tell the archive that a digest and
     * a LID are the same person — the payload carries no link between the two
     * forms. So both rows are kept and this method is how the gap gets stated.
     * Merging them on a matching `display_name` would be a guess, and the thing
     * being guessed at is whose correspondence belongs to whom.
     */
    provisionalChats({ limit = 100 } = {}) {
      return db
        .prepare(
          `SELECT c.name, c.display_name, c.identity_kind, COUNT(m.id) AS messages
           FROM chats c LEFT JOIN messages m ON m.chat_id = c.id
           WHERE c.identity_provisional = 1
           GROUP BY c.id
           ORDER BY c.last_seen DESC
           LIMIT ?`,
        )
        .all(limit);
    },

    /** The chat table's columns. For the migration tests, which must see the file. */
    chatColumns() {
      return db.prepare("SELECT name FROM pragma_table_info('chats')").all().map((r) => r.name);
    },

    /**
     * One chat's stored messages, oldest first.
     *
     * `newest` picks which END the limit cuts from, and the default cuts the
     * wrong one for anybody asking "what just happened": a limit of 20 over a
     * chat of 8000 returns the twenty oldest messages in it. That is right for
     * walking an archive forwards and wrong for reading a conversation, so the
     * caller now says which it wants. The ORDER of the result never changes —
     * `newest` reverses only the selection, then restores chronological order,
     * because every reader downstream assumes oldest-first.
     */
    messagesFor(chat, { limit = 200, newest = false } = {}) {
      if (!newest) {
        return db
          .prepare(
            `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id
             WHERE c.name = ? ORDER BY m.sent_at_iso, m.id LIMIT ?`,
          )
          .all(chat, limit);
      }

      return db
        .prepare(
          `SELECT * FROM (
             SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id
             WHERE c.name = ? ORDER BY m.sent_at_iso DESC, m.id DESC LIMIT ?
           ) ORDER BY sent_at_iso, id`,
        )
        .all(chat, limit);
    },

    /**
     * Where a top-up should stop, and how far back the archive reaches.
     * Ordered by message time, not by insertion: a backfill writes older
     * messages after newer ones.
     */
    chatBounds(chat) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count,
                  MIN(m.sent_at_iso) AS oldest_at,
                  MAX(m.sent_at_iso) AS newest_at
           FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.name = ?`,
        )
        .get(chat);

      const at = (column, direction) =>
        db
          .prepare(
            `SELECT m.key FROM messages m JOIN chats c ON c.id = m.chat_id
             WHERE c.name = ? AND m.sent_at_iso IS NOT NULL
             ORDER BY m.sent_at_iso ${direction}, m.id ${direction} LIMIT 1`,
          )
          .get(chat)?.key;

      return {
        count: row?.count ?? 0,
        oldestAt: row?.oldest_at ?? undefined,
        newestAt: row?.newest_at ?? undefined,
        oldestKey: at("sent_at_iso", "ASC"),
        newestKey: at("sent_at_iso", "DESC"),
      };
    },

    /** Keyword search over message bodies, including media placeholders. */
    search(query, { chat, sender, since, until, kind, outgoing, order = "relevance", limit = 50 } = {}) {
      const where = ["messages_fts MATCH ?"];
      const args = [query];

      if (chat) { where.push("c.name = ?"); args.push(chat); }
      if (sender) { where.push("m.sender = ?"); args.push(sender); }
      // Half-open on the right, so `until` reads as "up to that day" rather than
      // silently excluding everything after midnight.
      if (since) { where.push("m.sent_at_iso >= ?"); args.push(new Date(since).toISOString()); }
      if (until) { where.push("m.sent_at_iso < ?"); args.push(new Date(until).toISOString()); }
      if (kind) { where.push("m.kind = ?"); args.push(kind); }
      if (outgoing !== undefined) { where.push("m.outgoing = ?"); args.push(outgoing ? 1 : 0); }

      const ordering =
        order === "recent" ? "m.sent_at_iso DESC, m.id DESC" : "bm25(messages_fts), m.sent_at_iso DESC";

      args.push(limit);
      return db
        .prepare(
          `SELECT m.key, m.sender, m.sent_at, m.sent_at_iso, m.kind, m.text, m.outgoing,
                  c.name AS chat,
                  snippet(messages_fts, 0, '[', ']', '\u2026', 12) AS snippet
           FROM messages_fts f
           JOIN messages m ON m.id = f.rowid
           JOIN chats c ON c.id = m.chat_id
           WHERE ${where.join(" AND ")}
           ORDER BY ${ordering} LIMIT ?`,
        )
        .all(...args);
    },

    /**
     * The messages surrounding one hit, within its own conversation.
     *
     * A search result on its own is rarely an answer — "dia 28" means nothing
     * without the message before it. Ordered by message time, with insertion
     * order breaking ties for rows whose timestamp could not be parsed.
     */
    contextAround(key, { before = 5, after = 5 } = {}) {
      const anchor = db
        .prepare(
          `SELECT m.id, m.chat_id, m.sent_at_iso, c.name AS chat
           FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.key = ?`,
        )
        .get(key);

      if (!anchor) {
        throw new Error(
          `No message with key "${key}" is stored, so there is no context to show. It may not have ` +
            "been archived yet.",
        );
      }

      const columns = `m.key, m.sender, m.sent_at, m.sent_at_iso, m.kind, m.text, m.outgoing, c.name AS chat`;
      const neighbours = (comparison, direction, count) =>
        db
          .prepare(
            `SELECT ${columns}
             FROM messages m JOIN chats c ON c.id = m.chat_id
             WHERE m.chat_id = ?
               AND (m.sent_at_iso, m.id) ${comparison} (?, ?)
             ORDER BY m.sent_at_iso ${direction}, m.id ${direction} LIMIT ?`,
          )
          .all(anchor.chat_id, anchor.sent_at_iso, anchor.id, count);

      const self = db
        .prepare(`SELECT ${columns} FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.key = ?`)
        .get(key);

      return {
        chat: anchor.chat,
        key,
        messages: [
          ...neighbours("<", "DESC", before).reverse(),
          { ...self, matched: true },
          ...neighbours(">", "ASC", after),
        ],
      };
    },

    recordTranscript(messageKey, text) {
      requireMessage(messageKey);
      db.prepare(
        `INSERT INTO transcripts (message_key, text, created_at) VALUES (?, ?, ?)
         ON CONFLICT(message_key) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
      ).run(messageKey, text, now());
    },

    transcriptFor(messageKey) {
      return db.prepare("SELECT * FROM transcripts WHERE message_key = ?").get(messageKey);
    },

    addFact({ subject, statement, sourceMessageKey, confidence }) {
      // Checked here so the failure names the problem; the foreign key below is
      // what guarantees it even if this check is ever bypassed.
      requireMessage(sourceMessageKey);
      const result = db
        .prepare(
          `INSERT INTO facts (subject, statement, source_message_key, confidence, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(subject ?? null, statement, sourceMessageKey, confidence ?? null, now());
      return Number(result.lastInsertRowid);
    },

    /** The schema version of the archive actually open. */
    schemaVersion() {
      return db.prepare("PRAGMA user_version").get().user_version;
    },

    factsFor(messageKey) {
      return db
        .prepare("SELECT * FROM facts WHERE source_message_key = ? AND retracted_at IS NULL")
        .all(messageKey);
    },

    /**
     * Withdraw a fact without destroying the record that it was once believed.
     *
     * ── Why a tombstone and not a DELETE ───────────────────────────────────
     * Two different questions get asked of this table. "What do I know about
     * Helena?" must not return a retracted fact — that is the whole point. But
     * "why did I think the tiler was booked?" is asked *after* the belief turns
     * out to be wrong, and a DELETE makes it unanswerable: the fact that misled a
     * decision is exactly the fact that got removed.
     *
     * So retraction is a state, and `retraction_reason` is required. A fact
     * withdrawn for no stated reason cannot be distinguished later from one
     * withdrawn by mistake, and this operation exists precisely for the case
     * where somebody is auditing what the agent believed and why.
     *
     * The corpus calls the untreated version of this "difficult to detect and
     * reverse". Detection is the citation; this is the reverse.
     */
    retractFact(id, reason) {
      const stated = String(reason ?? "").trim();
      if (!stated) {
        throw invalid(
          "Retracting a fact needs a reason — 'wrong', 'stale', or 'not what the message said'. A " +
            "fact withdrawn silently cannot be told apart later from one withdrawn by mistake.",
        );
      }

      const row = db.prepare("SELECT id, retracted_at FROM facts WHERE id = ?").get(id);
      if (!row) throw new Error(`No fact with id ${id}.`);
      if (row.retracted_at) {
        // Idempotent rather than an error: two reviewers retracting the same
        // planted fact is the system working, not a conflict.
        return { id, retracted: true, at: row.retracted_at, alreadyRetracted: true };
      }

      const at = now();
      db.prepare("UPDATE facts SET retracted_at = ?, retraction_reason = ? WHERE id = ?").run(
        at,
        stated,
        id,
      );
      return { id, retracted: true, at, reason: stated };
    },

    /** Put a retracted fact back. Rare, and only for a retraction made in error. */
    restoreFact(id) {
      const result = db
        .prepare("UPDATE facts SET retracted_at = NULL, retraction_reason = NULL WHERE id = ?")
        .run(id);
      if (result.changes === 0) throw new Error(`No fact with id ${id}.`);
      return { id, retracted: false };
    },

    /**
     * Facts joined to the message they came from — the citation, resolved.
     *
     * `subject` is matched case-insensitively because it is a name a model
     * wrote, not an id: "Fabio" and "fabio" are the same person, and a fact
     * filed under one casing that cannot be recalled under the other is a fact
     * that has been lost.
     */
    /**
     * @param includeRetracted  Only for an audit of what was once believed. The
     *                          default excludes them, because a retracted fact
     *                          reaching a draft is the bug retraction exists to fix.
     */
    factsWithSource({ subject, chat, limit = 100, includeRetracted = false } = {}) {
      const where = [];
      const args = [];

      if (!includeRetracted) where.push("f.retracted_at IS NULL");
      if (subject) { where.push("LOWER(f.subject) = LOWER(?)"); args.push(subject); }
      if (chat) { where.push("c.name = ?"); args.push(chat); }

      args.push(limit);
      return db
        .prepare(
          // `source_outgoing` is the taint mark, and it is joined rather than
          // stored. Whether a belief came from the user's own words or from
          // somebody else's is the difference between a note to self and a claim
          // by a third party, and until it is on the row the two are
          // indistinguishable at read time. Following `extractions()`, which
          // already exposes exactly this.
          `SELECT f.*, m.text AS source_text, m.sender AS source_sender,
                  m.sent_at AS source_sent_at, m.outgoing AS source_outgoing,
                  c.name AS source_chat
           FROM facts f
           JOIN messages m ON m.key = f.source_message_key
           JOIN chats c ON c.id = m.chat_id
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY f.id DESC LIMIT ?`,
        )
        .all(...args);
    },

    /**
     * Write what an extraction pass found.
     *
     * All-or-nothing: one item citing a message that was never read rejects the
     * whole batch, because a half-written extraction is worse than none — the
     * caller cannot tell which half landed.
     */
    addExtractions(items) {
      if (!items?.length) return { inserted: 0, duplicates: 0 };

      const insert = db.prepare(
        `INSERT OR IGNORE INTO extractions
           (key, type, statement, actor, counterparty, due_at, confidence, source_message_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      let inserted = 0;
      db.exec("BEGIN");
      try {
        for (const it of items) {
          requireMessage(it.sourceMessageKey);
          const key = createHash("sha256")
            .update([it.type, it.statement, it.sourceMessageKey].join(" "))
            .digest("hex")
            .slice(0, 16);

          const result = insert.run(
            key,
            it.type,
            it.statement,
            it.actor ?? null,
            it.counterparty ?? null,
            it.dueAt ?? null,
            it.confidence ?? null,
            it.sourceMessageKey,
            now(),
          );
          if (result.changes > 0) inserted++;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return { inserted, duplicates: items.length - inserted };
    },

    /**
     * Extracted items, each joined to the message that produced it.
     *
     * Ordering is the useful part: dated items first and soonest-first, undated
     * ones last. A list that buries tomorrow's deadline under six "someday"
     * notes is not an answer to "what do I owe people".
     */
    extractions({ type, actor, status = "open", chat, overdue, dueBefore, since, until, limit = 100 } = {}) {
      const where = ["e.status = ?"];
      const args = [status];

      if (type) { where.push("e.type = ?"); args.push(type); }
      if (actor) { where.push("e.actor = ?"); args.push(actor); }
      if (chat) { where.push("c.name = ?"); args.push(chat); }
      // WHEN IT WAS SAID, not when it is due — the two are different questions
      // and only the first answers "check the last 45 days". `due_at` filters
      // below cannot serve it: most items carry no due date at all, so a window
      // applied to `due_at` silently drops everything that was merely promised.
      // Same column and same coercion as `search`, so one window means one thing.
      if (since) { where.push("m.sent_at_iso >= ?"); args.push(new Date(since).toISOString()); }
      if (until) { where.push("m.sent_at_iso <= ?"); args.push(new Date(until).toISOString()); }
      // An undated item is never overdue — it was never promised for a day.
      if (overdue) { where.push("e.due_at IS NOT NULL AND e.due_at < ?"); args.push(today()); }
      if (dueBefore) { where.push("e.due_at IS NOT NULL AND e.due_at < ?"); args.push(dueBefore); }

      args.push(limit);
      return db
        .prepare(
          `SELECT e.*, m.text AS source_text, m.sender AS source_sender,
                  m.sent_at AS source_sent_at, m.outgoing AS source_outgoing,
                  c.name AS source_chat
           FROM extractions e
           JOIN messages m ON m.key = e.source_message_key
           JOIN chats c ON c.id = m.chat_id
           WHERE ${where.join(" AND ")}
           ORDER BY e.due_at IS NULL, e.due_at ASC, e.id ASC LIMIT ?`,
        )
        .all(...args);
    },

    /** Close an item out. `done` when it happened, `dropped` when it will not. */
    resolveExtraction(id, status = "done") {
      if (!["done", "dropped", "open"].includes(status)) {
        throw new Error(`Unknown status "${status}". Use "done", "dropped", or "open".`);
      }

      const result = db.prepare("UPDATE extractions SET status = ? WHERE id = ?").run(status, id);
      if (result.changes === 0) {
        throw new Error(`No extracted item with id ${id}. It may already have been removed.`);
      }
      return { id, status };
    },

    /**
     * "What needs my attention?" — the question the whole system exists for.
     *
     * Four buckets, kept separate on purpose. What I owe and what I am owed are
     * not the same list: mixing them produces a backlog that feels like failure
     * and hides the follow-ups that are actually someone else's move.
     */
    attention({ horizonDays = 7 } = {}) {
      const horizon = new Date(Date.parse(`${today()}T00:00:00Z`) + horizonDays * 86_400_000)
        .toISOString()
        .slice(0, 10);

      const openItems = this.extractions({ limit: 500 });
      const isMine = (item) => OWED_BY_USER_TYPES.includes(item.type);

      const overdue = openItems.filter((i) => isMine(i) && i.due_at && i.due_at < today());
      const dueSoon = openItems.filter(
        (i) => isMine(i) && i.due_at && i.due_at >= today() && i.due_at < horizon,
      );
      const waitingOn = openItems.filter((i) => OWED_TO_USER_TYPES.includes(i.type));
      const unanswered = openItems.filter((i) => UNANSWERED_TYPES.includes(i.type));

      return {
        asOf: today(),
        horizonDays,
        overdue,
        dueSoon,
        waitingOn,
        unanswered,
        // Nothing to report is a normal day, and the caller needs to know that
        // without inspecting four arrays.
        total: overdue.length + dueSoon.length + waitingOn.length + unanswered.length,
      };
    },

    /**
     * Every chat known from the archive, with how much is stored about it.
     *
     * This is the candidate set for resolving a name. It is deliberately built
     * from what has actually been read rather than from WhatsApp's contact
     * list: a name nobody has ever messaged is not a plausible recipient.
     */
    roster() {
      return db
        .prepare(
          `SELECT c.name AS name, COUNT(m.id) AS messages,
                  MAX(m.sent_at_iso) AS last_message_at
           FROM chats c LEFT JOIN messages m ON m.chat_id = c.id
           GROUP BY c.id ORDER BY messages DESC, c.name ASC`,
        )
        .all()
        .map((row) => ({ ...row, kind: "chat" }));
    },

    /**
     * Learn a nickname.
     *
     * `origin` is required rather than defaulted, and that is the point of the
     * change: the caller is the only thing that knows whether the user said this
     * out loud or whether it was read out of a chat, and a default would let the
     * second masquerade as the first forever after.
     *
     * An alias with `origin: "message"` must cite the message, exactly as a fact
     * must. It is still permitted — a nickname read from chat text is often
     * correct and useful — but it is permitted *on the record*, so a reviewer can
     * find every alias the agent taught itself.
     */
    setAlias(alias, canonical, { origin = "session", sourceMessageKey } = {}) {
      const key = String(alias || "").trim().toLowerCase();
      const target = String(canonical || "").trim();
      if (!key || !target) throw new Error("An alias needs both a nickname and a chat name.");

      if (!ALIAS_ORIGINS.includes(origin)) {
        throw invalid(`Unknown alias origin "${origin}". Use one of: ${ALIAS_ORIGINS.join(", ")}.`);
      }
      // `unknown` exists only to describe rows that predate the column. Writing
      // one now would be choosing not to record something the caller knows.
      if (origin === "unknown") {
        throw invalid(
          'origin "unknown" is reserved for aliases that predate provenance and cannot be written. ' +
            'Use "session" when the user stated it, or "message" with sourceMessageKey when it was read.',
        );
      }
      if (origin === "message") {
        if (!sourceMessageKey) {
          throw invalid(
            "An alias learned from chat text must cite the message it was read from. Message content " +
              "influencing which chat gets opened is only acceptable on the record.",
          );
        }
        requireMessage(sourceMessageKey);
      }

      db.prepare(
        `INSERT INTO aliases (alias, canonical, created_at, origin, source_message_key)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical,
                                          created_at = excluded.created_at,
                                          origin = excluded.origin,
                                          source_message_key = excluded.source_message_key`,
      ).run(key, target, now(), origin, origin === "message" ? sourceMessageKey : null);
      return { alias: key, canonical: target, origin };
    },

    /**
     * Aliases with where each came from — the review surface.
     *
     * Exists because `aliasMap()` deliberately returns only the lookup, so the
     * resolution path cannot accidentally start making decisions on provenance.
     * Answering "which nicknames did the agent teach itself?" needs this instead.
     */
    aliasesWithProvenance({ origin } = {}) {
      const where = origin ? "WHERE a.origin = ?" : "";
      const args = origin ? [origin] : [];
      return db
        .prepare(
          `SELECT a.alias, a.canonical, a.created_at, a.origin, a.source_message_key,
                  m.text AS source_text, m.sender AS source_sender, m.outgoing AS source_outgoing
             FROM aliases a
             LEFT JOIN messages m ON m.key = a.source_message_key
             ${where}
            ORDER BY a.origin = 'session', a.alias`,
        )
        .all(...args);
    },

    removeAlias(alias) {
      const key = String(alias || "").trim().toLowerCase();
      const result = db.prepare("DELETE FROM aliases WHERE alias = ?").run(key);
      if (result.changes === 0) throw new Error(`No alias "${alias}" is stored.`);
      return { alias: key };
    },

    aliasMap() {
      return new Map(
        db.prepare("SELECT alias, canonical FROM aliases").all().map((r) => [r.alias, r.canonical]),
      );
    },

    /* -------------------------------------------------------------- *
     * The event queue.
     *
     * A queue rather than a direct call into the agent, for three reasons that
     * all cost nothing here and are expensive to retrofit: it survives an agent
     * restart, the UNIQUE key gives deduplication for free, and the bridge never
     * has to hold a credential for the agent — the flow of authority stays
     * one-directional, agent to bridge.
     * -------------------------------------------------------------- */

    /** Queue what the watcher saw. Re-recording an identical observation is free. */
    recordEvents(events) {
      if (!events?.length) return { inserted: 0, duplicates: 0 };

      const insert = db.prepare(
        `INSERT OR IGNORE INTO events (key, chat, kind, preview, unread, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );

      let inserted = 0;
      db.exec("BEGIN");
      try {
        for (const e of events) {
          const result = insert.run(
            e.key,
            e.chat,
            e.kind,
            e.preview ?? null,
            e.unread ?? null,
            e.observedAt ?? now(),
          );
          if (result.changes > 0) inserted++;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return { inserted, duplicates: events.length - inserted };
    },

    /**
     * Take up to `limit` unhandled events, under a lease.
     *
     * One statement, so it is atomic: two dispatcher ticks that overlap cannot
     * both claim the same event, which is what would otherwise turn one arriving
     * message into two self-notes. An expired lease is reclaimable — a claim that
     * died with its process comes back rather than being stranded — and
     * `attempts` is what lets a caller notice an event that keeps failing.
     */
    claimEvents({ limit = 25, leaseForMs = 5 * 60_000 } = {}) {
      const at = now();
      const until = new Date(Date.parse(at) + leaseForMs).toISOString();

      return db
        .prepare(
          `UPDATE events
              SET claimed_at = ?, lease_until = ?, attempts = attempts + 1
            WHERE id IN (
                    SELECT id FROM events
                     WHERE handled_at IS NULL
                       AND (lease_until IS NULL OR lease_until < ?)
                     ORDER BY id
                     LIMIT ?
                  )
          RETURNING *`,
        )
        .all(at, until, at, limit);
    },

    /** Close events out. Idempotent: completing an unknown key is not an error. */
    completeEvents(keys) {
      if (!keys?.length) return { handled: 0 };

      const update = db.prepare("UPDATE events SET handled_at = ? WHERE key = ? AND handled_at IS NULL");
      let handled = 0;
      db.exec("BEGIN");
      try {
        for (const key of keys) handled += update.run(now(), key).changes;
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { handled };
    },

    /**
     * Hand claimed events back unhandled.
     *
     * Deliberately drops the lease instead of setting a retry time. A deferred
     * event is not a failed one — `planReactions` defers on cooldown, quiet
     * hours and the fan-out cap, all of which are resolved by the next tick
     * arriving, not by a backoff.
     */
    releaseEvents(keys) {
      if (!keys?.length) return { released: 0 };

      const update = db.prepare(
        "UPDATE events SET claimed_at = NULL, lease_until = NULL WHERE key = ? AND handled_at IS NULL",
      );
      let released = 0;
      db.exec("BEGIN");
      try {
        for (const key of keys) released += update.run(key).changes;
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { released };
    },

    /** Look at the queue without claiming anything. */
    pendingEvents({ limit = 50 } = {}) {
      return db
        .prepare(
          `SELECT * FROM events WHERE handled_at IS NULL ORDER BY id DESC LIMIT ?`,
        )
        .all(limit);
    },

    /** Record that a chat cost an interaction. Feeds the per-chat cooldown. */
    touchChat(chat, reason = "read") {
      db.prepare(
        `INSERT INTO chat_touches (chat, touched_at, reason) VALUES (?, ?, ?)
         ON CONFLICT(chat) DO UPDATE SET touched_at = excluded.touched_at, reason = excluded.reason`,
      ).run(chat, now(), reason);
      return { chat, touchedAt: now(), reason };
    },

    /** chat → when it was last touched, in the shape `planReactions` expects. */
    lastTouched() {
      return new Map(
        db.prepare("SELECT chat, touched_at FROM chat_touches").all().map((r) => [r.chat, r.touched_at]),
      );
    },

    eventStats() {
      const one = (sql) => db.prepare(sql).get().n;
      return {
        pending: one("SELECT COUNT(*) AS n FROM events WHERE handled_at IS NULL"),
        handled: one("SELECT COUNT(*) AS n FROM events WHERE handled_at IS NOT NULL"),
        leased: one(
          "SELECT COUNT(*) AS n FROM events WHERE handled_at IS NULL AND lease_until IS NOT NULL",
        ),
      };
    },

    /* -------------------------------------------------------------- *
     * The interaction twin.
     *
     * Two halves that must not be confused. `interactionMetrics` counts what
     * the archive contains — reply times, who opens, how long it has been
     * quiet — and cannot be wrong about anything except by arithmetic. Arcs,
     * goals and contexts are a model's reading of the same messages, and every
     * one of them cites the message it was read from, for the same reason
     * `facts` does: a claim about someone's private conversation that cannot be
     * traced back to a message is a claim nobody can check.
     * -------------------------------------------------------------- */

    /**
     * Write one modelling pass over a conversation.
     *
     * All-or-nothing, like `addExtractions` and for the same reason: a
     * half-written twin is worse than none, because the caller cannot tell
     * which half landed. An arc whose title matches one already stored is
     * updated in place rather than forked — see `arcKeyFor`.
     */
    saveInteractionModel({ chat, throughMessageKey, considered = 0, arcs = [], contexts = [] }) {
      if (!chat) throw invalid("A modelling pass must say which conversation it describes.");
      if (!throughMessageKey) {
        throw invalid(
          "A modelling pass must cite the last message it considered, so staleness can be measured.",
        );
      }

      const id = existingChatId(chat);
      const at = now();
      const counts = {
        arcs: { inserted: 0, updated: 0 },
        goals: { inserted: 0, duplicates: 0 },
        contexts: { inserted: 0, updated: 0 },
      };

      db.exec("BEGIN");
      try {
        requireMessage(throughMessageKey);

        for (const arc of arcs) {
          const title = String(arc.title ?? "").trim();
          if (!title) throw invalid("An arc needs a title — it is the arc's identity.");

          const status = arc.status ?? "open";
          if (!ARC_STATUSES.includes(status)) {
            throw invalid(`Unknown arc status "${status}". Use one of: ${ARC_STATUSES.join(", ")}.`);
          }

          requireMessage(arc.firstMessageKey);
          requireMessage(arc.lastMessageKey);

          const key = arcKeyFor(chat, title);
          const existing = db.prepare("SELECT id FROM arcs WHERE key = ?").get(key);

          let arcId;
          if (existing) {
            db.prepare(
              `UPDATE arcs SET title = ?, summary = ?, status = ?, last_message_key = ?,
                               confidence = ?, updated_at = ?
                 WHERE id = ?`,
            ).run(
              title,
              arc.summary ?? null,
              status,
              arc.lastMessageKey,
              arc.confidence ?? null,
              at,
              existing.id,
            );
            arcId = existing.id;
            counts.arcs.updated++;
          } else {
            const result = db
              .prepare(
                `INSERT INTO arcs (key, chat_id, title, summary, status, first_message_key,
                                   last_message_key, confidence, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                key,
                id,
                title,
                arc.summary ?? null,
                status,
                arc.firstMessageKey,
                arc.lastMessageKey,
                arc.confidence ?? null,
                at,
                at,
              );
            arcId = Number(result.lastInsertRowid);
            counts.arcs.inserted++;
          }

          for (const goal of arc.goals ?? []) {
            const statement = String(goal.statement ?? "").trim();
            if (!statement) throw invalid("A goal needs a statement.");
            if (!GOAL_HOLDERS.includes(goal.holder)) {
              throw invalid(
                `Unknown goal holder "${goal.holder}". Use one of: ${GOAL_HOLDERS.join(", ")}.`,
              );
            }
            const goalStatus = goal.status ?? "open";
            if (!GOAL_STATUSES.includes(goalStatus)) {
              throw invalid(
                `Unknown goal status "${goalStatus}". Use one of: ${GOAL_STATUSES.join(", ")}.`,
              );
            }
            requireMessage(goal.sourceMessageKey);

            const result = db
              .prepare(
                `INSERT OR IGNORE INTO goals
                   (key, arc_id, holder, statement, status, confidence, source_message_key, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                contentKey("goal", key, goal.holder, statement),
                arcId,
                goal.holder,
                statement,
                goalStatus,
                goal.confidence ?? null,
                goal.sourceMessageKey,
                at,
              );
            if (result.changes > 0) counts.goals.inserted++;
            else counts.goals.duplicates++;
          }
        }

        for (const context of contexts) {
          const statement = String(context.statement ?? "").trim();
          if (!statement) throw invalid("A context observation needs a statement.");
          if (!CONTEXT_DIMENSIONS.includes(context.dimension)) {
            throw invalid(
              `Unknown context dimension "${context.dimension}". Use one of: ` +
                `${CONTEXT_DIMENSIONS.join(", ")}.`,
            );
          }
          requireMessage(context.sourceMessageKey);

          const key = contentKey("context", chat, context.dimension, statement);
          const existing = db.prepare("SELECT id FROM contexts WHERE key = ?").get(key);

          db.prepare(
            `INSERT INTO contexts
               (key, chat_id, dimension, statement, confidence, source_message_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET confidence = excluded.confidence,
                                            source_message_key = excluded.source_message_key,
                                            updated_at = excluded.updated_at`,
          ).run(
            key,
            id,
            context.dimension,
            statement,
            context.confidence ?? null,
            context.sourceMessageKey,
            at,
            at,
          );

          if (existing) counts.contexts.updated++;
          else counts.contexts.inserted++;
        }

        db.prepare(
          `INSERT INTO twin_passes (chat_id, through_message_key, considered, modelled_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET through_message_key = excluded.through_message_key,
                                              considered = excluded.considered,
                                              modelled_at = excluded.modelled_at`,
        ).run(id, throughMessageKey, considered, at);

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return { chat, modelledAt: at, ...counts };
    },

    /** Close an arc out, or reopen one. The vocabulary is enforced, not advisory. */
    resolveArc(id, status = "resolved") {
      if (!ARC_STATUSES.includes(status)) {
        throw invalid(`Unknown arc status "${status}". Use one of: ${ARC_STATUSES.join(", ")}.`);
      }
      const result = db
        .prepare("UPDATE arcs SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now(), id);
      if (result.changes === 0) throw new Error(`No arc with id ${id}.`);
      return { id, status };
    },

    /**
     * Record proposed next moves.
     *
     * The `basis` check is the whole safety of this table: every message key a
     * proposal claims to rest on must be one that was actually read. A move
     * argued from messages that do not exist is exactly the failure this
     * codebase spends a foreign key on everywhere else, and JSON is the only
     * reason it is enforced here in code instead.
     */
    addProposals(items = []) {
      if (!items.length) return { inserted: 0, repeated: 0 };

      const at = now();
      let inserted = 0;
      let repeated = 0;

      db.exec("BEGIN");
      try {
        for (const item of items) {
          if (!PROPOSAL_KINDS.includes(item.kind)) {
            throw invalid(
              `Unknown proposal kind "${item.kind}". Use one of: ${PROPOSAL_KINDS.join(", ")}.`,
            );
          }
          const headline = String(item.headline ?? "").trim();
          const rationale = String(item.rationale ?? "").trim();
          if (!headline) throw invalid("A proposal needs a headline.");
          if (!rationale) throw invalid("A proposal with no stated reasoning cannot be reviewed.");

          const basis = Array.isArray(item.basis) ? item.basis.filter(Boolean) : [];
          if (!basis.length) {
            throw invalid(
              "A proposal must cite at least one message it rests on. A move argued from nothing " +
                "is not reviewable.",
            );
          }
          for (const key of basis) requireMessage(key);

          const id = existingChatId(item.chat);
          const arc = item.arcTitle
            ? db.prepare("SELECT id FROM arcs WHERE key = ?").get(arcKeyFor(item.chat, item.arcTitle))
            : undefined;
          if (item.arcTitle && !arc) {
            throw invalid(
              `No arc titled "${item.arcTitle}" is modelled for "${item.chat}". A proposal cannot ` +
                "attach itself to a thread that was never found.",
            );
          }

          const key = contentKey(
            "proposal",
            item.chat,
            item.kind,
            arc?.id ?? "",
            item.draft ?? headline,
          );

          // A repeat collides here. `times_proposed` goes up, `status` does not
          // move: a proposal the user dismissed stays dismissed.
          const result = db
            .prepare(
              `INSERT INTO proposals
                 (key, chat_id, arc_id, kind, headline, draft, rationale, timing,
                  needs_user_wording, confidence, basis, created_at, last_proposed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET last_proposed_at = excluded.last_proposed_at,
                                              times_proposed = proposals.times_proposed + 1`,
            )
            .run(
              key,
              id,
              arc?.id ?? null,
              item.kind,
              headline,
              item.draft ?? null,
              rationale,
              item.timing ?? null,
              item.needsUserWording ? 1 : 0,
              item.confidence ?? null,
              JSON.stringify(basis),
              at,
              at,
            );

          // An upsert reports one change either way, so the counter has to come
          // from whether the row was already there.
          if (db.prepare("SELECT times_proposed FROM proposals WHERE key = ?").get(key).times_proposed > 1) {
            repeated++;
          } else if (result.changes > 0) {
            inserted++;
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return { inserted, repeated };
    },

    resolveProposal(id, status = "accepted") {
      if (!PROPOSAL_STATUSES.includes(status)) {
        throw invalid(
          `Unknown proposal status "${status}". Use one of: ${PROPOSAL_STATUSES.join(", ")}.`,
        );
      }
      const result = db.prepare("UPDATE proposals SET status = ? WHERE id = ?").run(status, id);
      if (result.changes === 0) throw new Error(`No proposal with id ${id}.`);
      return { id, status };
    },

    proposals({ chat, status = "open", limit = 50 } = {}) {
      const where = ["p.status = ?"];
      const args = [status];
      if (chat) { where.push("c.name = ?"); args.push(chat); }
      args.push(limit);

      return db
        .prepare(
          `SELECT p.*, c.name AS chat, a.title AS arc_title
             FROM proposals p
             JOIN chats c ON c.id = p.chat_id
             LEFT JOIN arcs a ON a.id = p.arc_id
            WHERE ${where.join(" AND ")}
            ORDER BY p.last_proposed_at DESC, p.id DESC LIMIT ?`,
        )
        .all(...args)
        .map((row) => ({ ...row, basis: JSON.parse(row.basis) }));
    },

    /**
     * The assembled twin: what is counted, what was read, and what is stale.
     *
     * Deliberately one call. The measured half and the modelled half are only
     * safe to act on together — habits without arcs propose nothing, and arcs
     * without a staleness figure propose confidently from a picture that may be
     * three weeks old.
     */
    twin(chat, { arcStatus, horizonDays = 7 } = {}) {
      const chatRow = db.prepare("SELECT id FROM chats WHERE name = ?").get(chat);
      if (!chatRow) {
        return {
          chat,
          found: false,
          reason:
            "no conversation by that name has been archived, so there is nothing to model or measure",
        };
      }

      const messages = this.messagesFor(chat, { limit: 2000 });
      const metrics = interactionMetrics(messages, { nowIso: now() });
      const pass = db.prepare("SELECT * FROM twin_passes WHERE chat_id = ?").get(chatRow.id);

      // How much has happened since the pass, counted against the message it
      // stopped at rather than against a wall clock.
      let messagesSince = 0;
      if (pass) {
        const anchor = db
          .prepare("SELECT id, sent_at_iso FROM messages WHERE key = ?")
          .get(pass.through_message_key);
        messagesSince = anchor
          ? db
              .prepare(
                `SELECT COUNT(*) AS n FROM messages
                  WHERE chat_id = ? AND (sent_at_iso, id) > (?, ?)`,
              )
              .get(chatRow.id, anchor.sent_at_iso, anchor.id).n
          : 0;
      }

      const arcWhere = arcStatus ? "AND status = ?" : "";
      const arcRows = db
        .prepare(
          `SELECT * FROM arcs WHERE chat_id = ? ${arcWhere}
            ORDER BY status = 'resolved', status = 'abandoned', updated_at DESC`,
        )
        .all(...(arcStatus ? [chatRow.id, arcStatus] : [chatRow.id]));

      /**
       * `source_outgoing` is the taint mark, and it is a join rather than a
       * column on purpose.
       *
       * Whether a claim was read out of the other person's words or the user's
       * own is exactly the distinction the injection boundary turns on (SPEC
       * §6.3) — "she wants the quote signed" read off her message is untrusted
       * third-party text; the same sentence read off the user's own message is
       * not. Storing it again on `goals` would duplicate a fact the citing
       * message already carries and let the two disagree; `extractions()`
       * already exposes it the same way.
       */
      const goalsFor = db.prepare(
        `SELECT g.*, m.text AS source_text, m.sender AS source_sender, m.sent_at AS source_sent_at,
                m.outgoing AS source_outgoing
           FROM goals g JOIN messages m ON m.key = g.source_message_key
          WHERE g.arc_id = ? ORDER BY g.holder, g.id`,
      );

      const openItems = this.extractions({ chat, limit: 200 });

      return {
        chat,
        found: true,
        metrics,
        coverage: twinCoverage({
          metrics,
          modelledAt: pass?.modelled_at,
          messagesSince,
          arcs: arcRows.length,
        }),
        arcs: arcRows.map((arc) => ({ ...arc, goals: goalsFor.all(arc.id) })),
        contexts: db
          .prepare(
            `SELECT c.*, m.text AS source_text, m.outgoing AS source_outgoing FROM contexts c
               JOIN messages m ON m.key = c.source_message_key
              WHERE c.chat_id = ? ORDER BY c.dimension, c.id`,
          )
          .all(chatRow.id),
        obligations: {
          userOwesThem: openItems.filter((i) => OWED_BY_USER_TYPES.includes(i.type)),
          theyOweUser: openItems.filter((i) => OWED_TO_USER_TYPES.includes(i.type)),
          unanswered: openItems.filter((i) => UNANSWERED_TYPES.includes(i.type)),
        },
        horizonDays,
        proposals: this.proposals({ chat, status: "open", limit: 20 }),
        // A proposal the user said no to is evidence about what not to suggest
        // again, so it travels with the twin rather than being hidden.
        dismissed: this.proposals({ chat, status: "dismissed", limit: 20 }),
      };
    },

    /** Chats whose archive has moved on since they were last modelled. */
    staleTwins({ limit = 20, minimumNew = 1 } = {}) {
      return db
        .prepare(
          `SELECT c.name AS chat,
                  p.modelled_at AS modelled_at,
                  COUNT(m.id) AS messages,
                  SUM(CASE WHEN p.through_message_key IS NULL THEN 1
                           WHEN (m.sent_at_iso, m.id) >
                                (SELECT a.sent_at_iso, a.id FROM messages a WHERE a.key = p.through_message_key)
                           THEN 1 ELSE 0 END) AS messages_since
             FROM chats c
             LEFT JOIN messages m ON m.chat_id = c.id
             LEFT JOIN twin_passes p ON p.chat_id = c.id
            GROUP BY c.id
           HAVING messages > 0 AND (modelled_at IS NULL OR messages_since >= ?)
            ORDER BY messages_since DESC, messages DESC LIMIT ?`,
        )
        .all(minimumNew, limit)
        .map((row) => ({
          ...row,
          messages_since: row.modelled_at ? row.messages_since : row.messages,
          neverModelled: !row.modelled_at,
        }));
    },

    /**
     * Forget what the policy says is past keeping.
     *
     * ── The cascade is the design, not a shortcut ──────────────────────────
     * Foreign keys are ON and every derived row cites a message, so deleting an
     * old message either fails or takes what cited it. Refusing would mean the
     * archive can never shrink — anything worth keeping has been cited by
     * something — so the prune cascades.
     *
     * That is an epistemic position and it is the same one the rest of this file
     * takes: a fact whose evidence has been deleted is exactly the uncitable
     * claim `addFact` refuses to accept. Keeping it would leave a belief holding
     * a receipt that goes nowhere, which is worse than not having the belief.
     *
     * ── Two safety properties ─────────────────────────────────────────────
     * A message with no resolvable date is never pruned. `sent_at_iso` is null
     * when a window's own rows could not settle day-first versus month-first, and
     * guessing there means deleting the wrong year.
     *
     * `dryRun` runs the identical statements and rolls back, so the preview
     * cannot disagree with the real thing — the alternative is a second counting
     * query that drifts from the deleting one and lies exactly when it matters.
     */
    prune({ messageDays, transcriptDays, retractedFactDays, dryRun = false } = {}) {
      const windows = { messageDays, transcriptDays, retractedFactDays };
      const configured = Object.values(windows).some((d) => Number.isFinite(d) && d >= 0);

      const removed = {
        messages: 0, transcripts: 0, facts: 0, extractions: 0,
        arcs: 0, goals: 0, contexts: 0, proposals: 0, twinPasses: 0, chats: 0,
      };

      // Say plainly that nothing happened. A caller cannot tell "policy ran and
      // found nothing" from "there was no policy" by counts alone.
      if (!configured) return { ...removed, skipped: true, dryRun };

      // Inclusive of the boundary, so a window of 0 means "retain nothing" rather
      // than "retain everything" — which is what an operator asking for 0 means,
      // and the opposite of what a strict `<` against a cutoff of exactly now does.
      const cutoff = (days) => new Date(Date.parse(now()) - days * 86_400_000).toISOString();
      const del = (sql, ...args) => db.prepare(sql).run(...args).changes;

      db.exec("BEGIN");
      try {
        // ── Transcripts, on their own window ───────────────────────────────
        if (Number.isFinite(transcriptDays)) {
          removed.transcripts += del(
            "DELETE FROM transcripts WHERE created_at <= ?",
            cutoff(transcriptDays),
          );
        }

        // ── Retracted facts, on theirs ─────────────────────────────────────
        if (Number.isFinite(retractedFactDays)) {
          removed.facts += del(
            "DELETE FROM facts WHERE retracted_at IS NOT NULL AND retracted_at <= ?",
            cutoff(retractedFactDays),
          );
        }

        // ── Messages, and everything that cited them ───────────────────────
        if (Number.isFinite(messageDays)) {
          const doomed = cutoff(messageDays);
          // Named so the intent survives: only dated messages are eligible.
          const eligible =
            "SELECT key FROM messages WHERE sent_at_iso IS NOT NULL AND sent_at_iso <= ?";

          // Children before parents, and arcs before the goals and proposals
          // hanging off them, or the foreign keys refuse mid-transaction.
          removed.goals += del(
            `DELETE FROM goals WHERE source_message_key IN (${eligible})
                OR arc_id IN (SELECT id FROM arcs
                               WHERE first_message_key IN (${eligible})
                                  OR last_message_key IN (${eligible}))`,
            doomed, doomed, doomed,
          );
          removed.proposals += del(
            `DELETE FROM proposals WHERE arc_id IN (SELECT id FROM arcs
                               WHERE first_message_key IN (${eligible})
                                  OR last_message_key IN (${eligible}))`,
            doomed, doomed,
          );
          removed.arcs += del(
            `DELETE FROM arcs WHERE first_message_key IN (${eligible})
                                 OR last_message_key IN (${eligible})`,
            doomed, doomed,
          );
          removed.contexts += del(
            `DELETE FROM contexts WHERE source_message_key IN (${eligible})`, doomed,
          );
          removed.facts += del(
            `DELETE FROM facts WHERE source_message_key IN (${eligible})`, doomed,
          );
          removed.transcripts += del(
            `DELETE FROM transcripts WHERE message_key IN (${eligible})`, doomed,
          );
          removed.extractions += del(
            `DELETE FROM extractions WHERE source_message_key IN (${eligible})`, doomed,
          );
          // Otherwise the next twin measures staleness against a message that no
          // longer exists, and reports a conversation as unmodelled forever.
          removed.twinPasses += del(
            `DELETE FROM twin_passes WHERE through_message_key IN (${eligible})`, doomed,
          );
          // The AFTER DELETE trigger keeps messages_fts in step. Bypassing it with
          // a bulk operation would leave pruned text searchable — the archive
          // would claim to have forgotten and would not have.
          removed.messages += del(
            "DELETE FROM messages WHERE sent_at_iso IS NOT NULL AND sent_at_iso <= ?", doomed,
          );

          // A chat with nothing left in it is still a record that you spoke to
          // somebody, which is the thing retention exists to remove.
          removed.chats += del(
            "DELETE FROM chats WHERE id NOT IN (SELECT DISTINCT chat_id FROM messages)",
          );
        }

        if (dryRun) db.exec("ROLLBACK");
        else db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return { ...removed, skipped: false, dryRun };
    },

    /**
     * Give a chat the name a person would call it.
     *
     * ── Why this exists at all ──────────────────────────────────────────────
     * A drained message carries an identity, not a name. For a direct message
     * the sender's `pushName` rides along and `chatDisplayName` uses it, but a
     * GROUP has no such field: naming one after whoever spoke last would rename
     * it every few minutes. So groups arrived nameless — 28 of 28 here — and
     * the agent, which looks conversations up by name, could not find a single
     * one. It reported them as non-existent while they sat in the roster.
     *
     * The subject comes from the roster instead, which reads it from the
     * server. This is the write side of that refresh.
     *
     * Returns the number of rows actually changed, so a refresh that found
     * nothing new is distinguishable from one that never ran.
     */
    renameChats(entries = []) {
      const update = db.prepare(
        `UPDATE chats SET display_name = ?
          WHERE name = ? AND (display_name IS NULL OR display_name <> ?)`,
      );
      let renamed = 0;
      // `db.exec("BEGIN")`, as everywhere else in this file: node:sqlite has no
      // better-sqlite3-style `transaction()` wrapper.
      db.exec("BEGIN");
      try {
        for (const { key, displayName } of entries) {
          if (!key || !displayName) continue;
          renamed += update.run(displayName, key, displayName).changes;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { renamed };
    },

    /**
     * Recent conversations, from the archive rather than from a rendered list.
     *
     * This replaces the old `/chats`, which walked WhatsApp Web's chat pane and
     * could therefore only report what was rendered — the visible tail of a
     * virtualised list, ordered by whatever the page had loaded. Reading it here
     * means the answer covers everything ever ingested, and `messages` is a real
     * count rather than "what was on screen".
     *
     * `display_name` may be null: a correspondent who is not in the contact list
     * has no name anywhere in the protocol, and inventing one from a phone
     * number is exactly what `internal/identity` exists to prevent. Callers
     * should fall back to `key`, which always identifies someone.
     */
    chats({ limit = 50 } = {}) {
      return db
        .prepare(
          `SELECT c.name          AS key,
                  c.display_name  AS displayName,
                  c.identity_kind AS kind,
                  c.identity_provisional AS provisional,
                  COUNT(m.id)     AS messages,
                  MAX(m.sent_at_iso) AS lastMessageAt
             FROM chats c
             LEFT JOIN messages m ON m.chat_id = c.id
            GROUP BY c.id
            ORDER BY lastMessageAt DESC NULLS LAST, c.id DESC
            LIMIT ?`,
        )
        .all(limit)
        .map((row) => ({ ...row, provisional: Boolean(row.provisional) }));
    },

    /**
     * How far back the archive actually reaches.
     *
     * ── The question this answers ───────────────────────────────────────────
     * "What period are you considering?" — asked, reasonably, of an assistant
     * that had just reported a pending item and could not say over what window
     * it had looked. Counts alone cannot answer it: 8,824 messages is not a
     * period, and an agent that knows only the count will either hedge or
     * invent one.
     *
     * `undated` is reported beside the bounds rather than folded into them. A
     * row whose timestamp failed to parse is stored with a null `sent_at_iso`,
     * and those rows are invisible to MIN/MAX — so a span computed from the
     * dated rows alone is a claim about *some* of the archive presented as a
     * claim about all of it. Saying how many rows the span cannot see is what
     * keeps "the oldest message is from 3 June" honest.
     */
    span() {
      const bounds = db
        .prepare(
          `SELECT MIN(sent_at_iso) AS oldest, MAX(sent_at_iso) AS newest, COUNT(*) AS dated
             FROM messages WHERE sent_at_iso IS NOT NULL AND sent_at_iso <> ''`,
        )
        .get();
      const undated = db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE sent_at_iso IS NULL OR sent_at_iso = ''`,
        )
        .get().n;

      const oldest = bounds.oldest ?? null;
      const newest = bounds.newest ?? null;
      const days =
        oldest && newest
          ? Math.max(1, Math.round((Date.parse(newest) - Date.parse(oldest)) / 86_400_000))
          : 0;

      return { oldest, newest, days, dated: bounds.dated, undated };
    },

    stats() {
      const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      return {
        span: this.span(),
        chats: count("chats"),
        messages: count("messages"),
        transcripts: count("transcripts"),
        facts: count("facts"),
        extractions: count("extractions"),
        arcs: count("arcs"),
        goals: count("goals"),
        contexts: count("contexts"),
        proposals: count("proposals"),
      };
    },

    close() {
      db.close();
    },
  };
}
