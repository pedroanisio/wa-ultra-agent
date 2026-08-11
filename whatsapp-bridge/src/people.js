import { normalizeName } from "./recipients.js";
import { OWED_BY_USER_TYPES, OWED_TO_USER_TYPES, UNANSWERED_TYPES } from "./store.js";

/**
 * Deciding who a name refers to, without asking WhatsApp.
 *
 * WhatsApp's chat search ranks by recency. That is why searching "Helena
 * Braga" opens the group "We" — she is its most recent sender, so it outranks
 * her own conversation. `assertResolvedMatches` catches that after the fact;
 * this layer stops it happening at all.
 *
 * Two rules follow from that bug, and they are the whole design:
 *
 *   1. **Rank by name similarity only.** How busy or how recent a chat is says
 *      nothing about who was meant. Activity is never evidence here.
 *
 *   2. **Ambiguity is reported, never guessed.** Two plausible matches resolve
 *      nothing and hand both back. A wrong recipient is unrecallable, so the
 *      cost of asking is far below the cost of being confidently wrong.
 *
 * Matching is on whole words throughout, for the reason the allowlist gives:
 * substring matching means "We" also matches "Wesley".
 */

const words = (value) => normalizeName(value).split(" ").filter(Boolean);

/**
 * How well `query` names `candidate`, from 0 (not at all) to 1 (exactly).
 *
 * Whole words only. A query is a match when every one of its words appears in
 * the candidate; the score then reflects how much of the candidate it accounts
 * for, and whether it started at the beginning of the name.
 */
export function scoreCandidate(query, candidate) {
  const q = words(query);
  const c = words(candidate);
  if (q.length === 0 || c.length === 0) return 0;

  const normalizedQuery = q.join(" ");
  const normalizedCandidate = c.join(" ");
  if (normalizedQuery === normalizedCandidate) return 1;

  // Every query word must be a whole word of the candidate.
  const pool = new Set(c);
  if (!q.every((word) => pool.has(word))) return 0;

  // How much of the name the query accounts for: "fabio" explains half of
  // "fabio menezes", "souto helena" two thirds of "helena braga souto".
  const coverage = q.length / c.length;
  // A name that starts where the query starts is the likelier referent.
  const leading = c[0] === q[0] ? 0.15 : 0;

  return Math.min(0.99, coverage * 0.8 + leading);
}

/**
 * Resolve a name against the roster.
 *
 * Returns `{ exact, name?, via, candidates, ambiguous, reason? }`. `name` is set
 * only when there is exactly one best answer; `exact` distinguishes "this is
 * their name" from "this is who I think you meant".
 */
export function resolvePerson(query, { roster = [], aliases = new Map() } = {}) {
  const empty = { exact: false, name: undefined, candidates: [], ambiguous: false };

  const normalized = normalizeName(query);
  if (!normalized) return { ...empty, reason: "No name was given." };

  const byName = new Map(roster.map((entry) => [normalizeName(entry.name), entry]));

  // An alias is a decision someone already made; it outranks any inference.
  const aliasTarget = aliases.get(normalized);
  if (aliasTarget) {
    const hit = byName.get(normalizeName(aliasTarget));
    if (hit) {
      return { exact: true, name: hit.name, via: "alias", candidates: [], ambiguous: false };
    }
    return {
      ...empty,
      reason:
        `"${query}" is an alias for "${aliasTarget}", but no chat by that name is in the roster ` +
        "— it may have been renamed. Update the alias.",
    };
  }

  const scored = roster
    .map((entry) => {
      const score = scoreCandidate(normalized, entry.name);
      return {
        name: entry.name,
        kind: entry.kind,
        score,
        why: score === 1 ? "exact name" : "every word of the query appears in this name",
      };
    })
    .filter((entry) => entry.score > 0)
    // Name similarity only. Deliberately NOT by message count or recency.
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  if (scored.length === 0) {
    return { ...empty, reason: `Nothing in the roster matches "${query}".` };
  }

  const exact = scored[0].score === 1;
  if (exact) {
    return { exact: true, name: scored[0].name, via: "name", candidates: scored, ambiguous: false };
  }

  // A single best score resolves; a tie does not. Two people called Ana are a
  // question for the user, not a coin toss.
  const best = scored.filter((entry) => entry.score === scored[0].score);
  if (best.length === 1) {
    return { exact: false, name: best[0].name, via: "partial", candidates: scored, ambiguous: false };
  }

  return {
    exact: false,
    name: undefined,
    via: "partial",
    candidates: best,
    ambiguous: true,
    reason: `"${query}" matches ${best.length} chats equally well. Ask which one is meant.`,
  };
}

/**
 * Everything the archive knows about one person, in one answer.
 *
 * ── Why the identity is a chat name ─────────────────────────────────────────
 * The spec asked for stable person ids resolved from a contact roster. This
 * transport cannot supply either: WhatsApp Web renders no contact id, and there
 * is no endpoint that enumerates contacts — only conversations that have been
 * read. So the canonical chat name IS the identity, and `resolvePerson` above
 * is what makes it behave like one: aliases collapse the nicknames a user
 * actually says onto it, and an ambiguous name refuses rather than guessing.
 *
 * ── Why the two directions stay apart ───────────────────────────────────────
 * Same reason as the digest. "You owe Fabio the numbers" and "Fabio owes you
 * the numbers" need opposite actions, and a single merged list of six items is
 * read as six chores.
 *
 * Pure: the caller gathers the rows, this decides what they mean.
 */
export function buildDossier(resolution, { profile, aliases = [], facts = [], obligations = [] } = {}) {
  // Ambiguity is handed back untouched. Picking the highest-scoring of two
  // equal candidates here would undo the one guarantee resolvePerson makes.
  if (resolution?.ambiguous) {
    return {
      found: false,
      ambiguous: true,
      candidates: resolution.candidates,
      reason: resolution.reason,
    };
  }

  if (!resolution?.name) {
    return {
      found: false,
      ambiguous: false,
      candidates: resolution?.candidates ?? [],
      reason: resolution?.reason ?? "No name was given.",
    };
  }

  const has = (types) => (item) => types.includes(item.type);

  return {
    found: true,
    ambiguous: false,
    name: resolution.name,
    exact: resolution.exact,
    via: resolution.via,
    aliases,
    // Volume and recency are reported but were deliberately not used to resolve
    // the name (see above) — they describe the person, they do not identify them.
    activity: {
      messages: profile?.messages ?? 0,
      lastMessageAt: profile?.last_message_at,
    },
    facts,
    obligations: {
      theyOweUser: obligations.filter(has(OWED_TO_USER_TYPES)),
      userOwesThem: obligations.filter(has(OWED_BY_USER_TYPES)),
      unanswered: obligations.filter(has(UNANSWERED_TYPES)),
    },
  };
}
