import { parseAliases, splitAllowlistEntries } from "./recipients.js";

/**
 * Which strings in this repository would identify a real person.
 *
 * Built after real contact names, real group names, a real document filename and the
 * operator's actual send allowlist were found committed to this repository — present
 * from its first push, and public until the repository was made private.
 *
 * ── The design constraint that shapes everything here ───────────────────────
 * A guard against leaking names must not contain the names. A hardcoded deny-list
 * would BE the leak — committed, public, and needing an edit every time the operator
 * gains a contact.
 *
 * So the forbidden set is derived at run time from the configuration that already
 * names the real people: `WA_SEND_ALLOWLIST`, `WA_SELF_CHAT_NAME`, `WA_CONTACT_ALIASES`.
 * Those live in `.env`, which is gitignored and was verified uncommitted during the
 * incident. Nothing identifying is ever written to a tracked file.
 *
 * ── Why it reuses recipients.js instead of parsing the env itself ───────────
 * `splitAllowlistEntries` already solves the hard part — an allowlist entry may
 * legally contain the delimiter, so `"Kiko, Tuca, Zé"` is one name and not three. A
 * second parser here would drift from the one the send guard uses, and then the guard
 * would protect a different set of names than the allowlist actually permits. The
 * store makes the same argument for `OWED_BY_USER_TYPES`: two copies of a semantic
 * claim disagree.
 *
 * This module is deliberately free of `process.env` reads and of the filesystem, for
 * the same reason `recipients.js` and `self-note.js` are: the rules are then testable
 * without a browser, a database or a configured machine.
 */

/**
 * Below this many characters, a configured name is not identifying enough to be worth
 * flagging — and flagging it would destroy the guard.
 *
 * "We" is a real group on the operator's allowlist. Treating a two-character entry as
 * a forbidden string would flag every file containing the word "we", the guard would
 * fail on its first run for a hundred innocent reasons, and it would be deleted or
 * skipped within a day. A noisy guard is a disabled guard.
 *
 * Five is chosen because the shortest nickname in the operator's own configuration that
 * actually did identify somebody is five characters long. Anything shorter is a bare
 * first name or an initialism, which cannot carry the identification on its own.
 *
 * The threshold is stated as a number and not as an example on purpose: quoting the
 * real nickname here would leak it. That is not hypothetical — an earlier draft of this
 * very docstring did quote it, and this guard failed on its own source file. See the
 * note above `collapse`.
 */
const MINIMUM_IDENTIFYING_LENGTH = 5;

/**
 * Collapse a string to the form matching compares in.
 *
 * Two shapes escaped a phrase-level scan of the scrubbed history and were caught only
 * by a failing test, and both are handled here (examples are synthetic — see below):
 *
 *   1. A name broken across a comment line-wrap:
 *          searching "Ana
 *        * Lucia Prado" opens the group
 *   2. A name written with irregular internal whitespace:
 *          normalizeName("  Sam   +  Folks ")
 *
 * ── Every example in this file is synthetic, and that is load-bearing ───────
 * The first version of this module quoted a real nickname and a real group name in its
 * own doc comments, and the guard failed on its own source file the moment those
 * comments became tracked. It was right to. Prose is the path that leaked the majority
 * of the identities in the first place, and a docstring is prose. Illustrate with
 * invented names or with a description, never with the thing being protected.
 *
 * So any run of whitespace — optionally carrying a comment continuation marker
 * (`*`, `//`, `#`) — collapses to exactly one space. That is what makes a wrapped name
 * and a spaced-out name both equal to the plain one.
 */
function collapse(value) {
  return value.replace(/\s+(?:\*+|\/\/+|#+)?\s*/g, " ");
}

/**
 * The same collapse, but recording where each output character came from.
 *
 * Needed because a failure has to name a file and line. Without the offset map the
 * guard could say "this file leaks a name" but not where, and a finding nobody can
 * locate does not get fixed.
 */
function collapseWithOffsets(text) {
  let out = "";
  const offsets = [];
  let i = 0;

  while (i < text.length) {
    const rest = text.slice(i);
    const run = /^\s+(?:\*+|\/\/+|#+)?\s*/.exec(rest);
    if (run) {
      out += " ";
      offsets.push(i);
      i += run[0].length;
      continue;
    }
    out += text[i];
    offsets.push(i);
    i += 1;
  }

  return { collapsed: out, offsets };
}

/** 1-indexed line number of a character offset. */
function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every real identity string implied by an environment, each with what it is.
 *
 * `kind` exists so a failure can say "leaks a real group name" without printing the
 * name. The operator knows which of their groups is which; a CI log does not need to.
 *
 * @param env  An environment-shaped object. Passed in rather than read, so tests can
 *             supply a configuration without one existing on the machine.
 * @returns {{value: string, kind: string}[]}
 */
export function realIdentityStrings(env = {}) {
  const found = new Map(); // lowercased value -> {value, kind}

  const offer = (raw, kind) => {
    const value = String(raw ?? "")
      .trim()
      .replace(/^["']|["']$/g, "")
      // A self-chat name arrives as "Name (You)"; the name is the identifying part.
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
    if (value.length < MINIMUM_IDENTIFYING_LENGTH) return;
    const key = collapse(value).toLowerCase();
    if (!found.has(key)) found.set(key, { value: collapse(value), kind });
  };

  // Allowlist entries: a mix of people and groups, and the guard cannot tell which is
  // which — so both are reported as the neutral "allowlisted name".
  for (const entry of splitAllowlistEntries(env.WA_SEND_ALLOWLIST)) {
    offer(entry, "allowlisted name");
  }

  offer(env.WA_SELF_CHAT_NAME, "self-chat name");

  // Both halves of the alias map identify somebody: the canonical side is a contact's
  // real name, and the nickname side is what the operator actually calls them — which
  // in this repository's case included an intimate one. A nickname leaked as readily as
  // a full name did, so both sides are forbidden strings.
  for (const [alias, canonical] of parseAliases(env)) {
    offer(canonical, "contact name");
    offer(alias, "contact nickname");
  }

  return [...found.values()];
}

/**
 * Every real name the ARCHIVE knows, each with what it is.
 *
 * ── Why the configuration was never the whole set ───────────────────────────
 * `realIdentityStrings` says the operator's contacts' names "are only knowable
 * from .env". That was true of who may be WRITTEN to, and false of who is in the
 * archive: the allowlist holds a handful of people, and store.db holds everyone
 * the account has ever spoken to. A guard sourced from the allowlist is blind to
 * every other real name in the operator's life.
 *
 * It went on being blind while the leak it exists to prevent happened again, in
 * this repository, on 12 August 2026: nine group names and two people's names,
 * written into test fixtures and source comments by an agent debugging against
 * the live archive. The identifier half caught three `@lid` literals on the same
 * lines. Not one of the names was in `.env`, so the name half saw nothing.
 *
 * Fixtures built from live data are how this keeps happening, and the fix is not
 * "be careful": it is that the machine holding the data can check the tree
 * against it, which is what this function makes possible.
 *
 * ── Why single short words are not forbidden ────────────────────────────────
 * A group called "We" is a real group name and also an English word. Forbidding
 * it fails on ordinary prose in dozens of files, and a noisy guard is a disabled
 * guard — the same argument `MINIMUM_IDENTIFYING_LENGTH` and the bare-digit
 * exclusion already make. So a name qualifies when it is more than one word, or
 * one word long enough to be a name rather than a word. The gap is stated rather
 * than hidden: a short single-word group name is not covered here.
 *
 * @param chats  Rows shaped like `store.chats()`: `{ displayName }`.
 * @returns {{value: string, kind: string}[]}
 */
export function archiveIdentityStrings(chats = []) {
  const found = new Map();

  const offer = (raw) => {
    const value = collapse(String(raw ?? "")).trim();
    if (!value) return;
    if (value.length < MINIMUM_IDENTIFYING_LENGTH) return;

    const words = value.split(" ").filter(Boolean);
    if (words.length < 2 && value.length < 6) return;

    const key = value.toLowerCase();
    // "conversation name" rather than person-or-group: this side cannot tell them
    // apart, and the operator does not need to be told which of their chats it is.
    if (!found.has(key)) found.set(key, { value, kind: "archived conversation name" });
  };

  for (const chat of chats) {
    const name = String(chat?.displayName ?? "");
    offer(name);

    // ── Why the undecorated form is forbidden too ────────────────────────────
    // A group's name carries an emoji its members never type. The archive holds
    // "👥 Casa" and every mention of it in prose, in a fixture and in a test
    // assertion says "Casa" — so a guard that only knows the decorated form
    // watches the one spelling nobody writes. Caught the first time this rule
    // ran: the decorated name was replaced in a fixture and the same real name
    // survived, undecorated, four lines below.
    const bare = name.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/gu, " ");
    if (collapse(bare).trim() !== collapse(name).trim()) offer(bare);
  }

  return [...found.values()];
}

/**
 * The address forms a contact identifier can take in this tree.
 *
 * ── Why this rule is structural and the name rule is not ────────────────────
 * `realIdentityStrings` derives its forbidden set from configuration, because the
 * operator's contacts' NAMES are only knowable from `.env`. Phone numbers are
 * different: whatsmeow learns them from WhatsApp at run time, so there is nothing
 * in the configuration to derive. A number the operator never configured is still
 * a real person's number.
 *
 * So this half forbids the SHAPE. Two properties follow, and both are upgrades:
 * it needs no configuration, so it never skips the way the name half does on CI
 * and fresh clones; and it catches every contact rather than only the configured
 * ones.
 *
 * ── Why bare digit runs are excluded ────────────────────────────────────────
 * The same reasoning as `MINIMUM_IDENTIFYING_LENGTH`: a noisy guard is a disabled
 * guard. Epoch milliseconds are thirteen digits, and this repository is full of
 * them — as are byte counts, ids and version fragments. A rule matching any long
 * digit run would fail on dozens of innocent lines on its first run and would be
 * skipped within a day.
 *
 * The residual gap is real and is stated rather than hidden: `PhoneNumber()` in
 * `whatsapp-transport/internal/identity` returns bare digits, so a fixture
 * hand-built from its output would pass this scan. What closes that hole is the
 * containment on the Go side — the field is unexported, so no `json.Marshal`,
 * log line or `%#v` dump carries it by accident — not this regex.
 *
 * ── Why every pattern here is safe to write in this file ────────────────────
 * None of them match their own source. Each requires literal digits adjacent to
 * the address suffix, and the source text has metacharacters there instead. That
 * matters because `no-real-identities.test.js` forbids exempting this file.
 */
const CONTACT_IDENTIFIER_PATTERNS = [
  // The canonical whatsmeow user address, pre-LID. `c.us` is the legacy spelling
  // and still appears in history-sync payloads.
  { pattern: /\d{7,15}@(?:s\.whatsapp\.net|c\.us)\b/g, kind: "phone number" },

  // A LID is pseudonymous, not anonymous: it is stable per person, so publishing
  // one still links every message of theirs together. Reported under its own kind
  // because the disclosure is weaker than a number and worth distinguishing.
  { pattern: /\d{6,20}@lid\b/g, kind: "contact identifier" },

  // E.164 as a human writes it. The leading `+` is what makes this precise
  // enough to be worth having — it is absent from timestamps and byte counts.
  { pattern: /\+\d(?:[\s().-]?\d){6,17}\b/g, kind: "phone number" },
];

/**
 * Where `text` contains something that identifies a contact by address.
 *
 * Structural counterpart to `scanForRealIdentities`: same `{line, kind}` return,
 * same refusal to include the matched string, and no configuration required.
 *
 * Group JIDs (`…@g.us`) are deliberately not flagged. A group id is not derived
 * from anybody's number and reveals no person on its own, and flagging it would
 * make every legitimate reference to a group in a fixture a failure.
 *
 * @returns {{line: number, kind: string}[]}
 */
export function scanForContactIdentifiers(text) {
  if (!text) return [];

  const hits = [];
  for (const { pattern, kind } of CONTACT_IDENTIFIER_PATTERNS) {
    // Fresh regex per call: a shared /g pattern carries `lastIndex` between
    // calls, so the second file scanned would start mid-string and miss hits.
    for (const match of String(text).matchAll(new RegExp(pattern.source, pattern.flags))) {
      hits.push({ line: lineAt(text, match.index), kind });
    }
  }

  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Where `text` contains a real identity.
 *
 * Matching is case-insensitive, whitespace-collapsed (so line-wraps and irregular
 * spacing are caught) and bounded at word edges, so a five-character nickname cannot
 * match inside an unrelated longer word.
 *
 * Returns `{line, kind}` and deliberately NOT the matched string. Callers report
 * failures into logs, and a log is a publication surface: a guard that prints the name
 * it caught has re-leaked it.
 *
 * @returns {{line: number, kind: string}[]}
 */
export function scanForRealIdentities(text, forbidden) {
  if (!text || !forbidden?.length) return [];

  const { collapsed, offsets } = collapseWithOffsets(text);
  const hits = [];

  for (const { value, kind } of forbidden) {
    const needle = collapse(value).trim();
    if (!needle) continue;

    // \b only anchors next to word characters. A name ending in "é" or starting with a
    // quote still needs an edge test, so the boundary is asserted as "not adjacent to a
    // letter or digit" instead, which holds for accented names too.
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`,
      "giu",
    );

    for (const match of collapsed.matchAll(pattern)) {
      const origin = offsets[match.index] ?? 0;
      hits.push({ line: lineAt(text, origin), kind });
    }
  }

  return hits.sort((a, b) => a.line - b.line);
}
