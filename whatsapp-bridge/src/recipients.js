/**
 * Who may be messaged, and whether the chat that opened is the one asked for.
 *
 * Two independent questions, deliberately kept apart:
 *
 *   1. Is this recipient permitted?      -> assertSendable
 *   2. Is this the recipient requested?  -> assertResolvedMatches
 *
 * Conflating them is what made a real bug possible: searching "Helena Braga"
 * opens the group "We" (she is its most recent sender, so it outranks her own
 * chat), and because "We" was on the allowlist, checking only the resolved name
 * authorised delivering a message meant for one person into a group. The
 * allowlist bounds WHO may be written to; the match check bounds whether the
 * right one was found. Both must pass.
 *
 * Kept free of Playwright so the rules can be tested without a browser, the same
 * way `self-note.js` is. `env` is a parameter rather than a direct `process.env`
 * read for the same reason.
 */

/**
 * Compare names the way a person would.
 *
 * Lowercases, collapses whitespace, strips surrounding quotes left by a
 * hand-edited `.env`, and drops a trailing parenthetical — which is what lets
 * an entry of "Joao Vitor Almeida Rocha" match WhatsApp's own-chat title
 * "Joao Vitor Almeida Rocha (You)".
 */
export function normalizeName(value) {
  return (value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `normalizeName`, plus the differences that are not differences.
 *
 * ── Why this is separate ────────────────────────────────────────────────────
 * Two jobs that look identical and are not. `normalizeName` produces the form
 * an entry is RECORDED in, so it keeps what the operator wrote: an allowlist
 * that silently rewrites `Zé` to `Ze` is an allowlist whose contents no longer
 * match the file the operator is looking at.
 *
 * This produces the form two names are COMPARED in, where a circumflex nobody
 * types from a phone and an emoji WhatsApp renders as decoration must not be
 * the reason a message is refused. The bug that split them apart: the group
 * `Kim, Lu, Rê` could not be reached as `Kim, Lu, Re` — the resolver found it
 * and the allowlist check then rejected its own answer.
 *
 * Folding here can only ever make MORE names equal, never fewer, and every
 * caller that consumes it refuses ambiguity rather than picking a winner.
 */
export function foldName(value) {
  return normalizeName(
    String(value ?? "")
      .normalize("NFD")
      // Combining marks, once NFD has split them from their letters.
      .replace(/\p{M}+/gu, "")
      // Decoration in a chat name: `👥 Casa & Crianças` is said as "casa e criancas".
      .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]/gu, " "),
  );
}


/**
 * Split the allowlist into entries, honouring names that contain commas.
 *
 * The delimiter collides with legal content: "Kiko, Tuca, Zé" is a real group
 * name, and a naive split turns it into three entries — none of which match the
 * group, while each silently becomes its own whole-name permission. So a
 * double-quoted entry keeps its commas, and a JSON array is accepted outright
 * for anything gnarlier:
 *
 *   WA_SEND_ALLOWLIST='"Kiko, Tuca, Zé",We'
 *   WA_SEND_ALLOWLIST='["Kiko, Tuca, Zé", "We"]'
 *
 * An unquoted name containing a comma is genuinely ambiguous and still splits;
 * that is why `assertSendable` says so when it refuses one.
 */
export function splitAllowlistEntries(raw) {
  let trimmed = (raw || "").trim();

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
    } catch {
      // Malformed JSON falls through to the delimiter parse rather than
      // throwing: a broken list must not take the bridge down at boot. Strip
      // the brackets first, or the leftover "[" becomes part of the first
      // entry and quietly stops it matching.
      trimmed = trimmed.replace(/^\[/, "").replace(/\]$/, "");
    }
  }

  const entries = [];
  let current = "";
  let inQuotes = false;
  for (const character of trimmed) {
    if (character === '"' || character === "'") {
      inQuotes = !inQuotes;
      continue;
    }
    if (character === "," && !inQuotes) {
      entries.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  entries.push(current);
  return entries;
}

/** The configured allowlist, normalized. Empty when unset. */
export function parseAllowlist(env = process.env) {
  return splitAllowlistEntries(env.WA_SEND_ALLOWLIST).map(normalizeName).filter(Boolean);
}

/**
 * Map a nickname onto the chat name WhatsApp actually shows.
 *
 * People do not call each other by their contact-card names: "tonhão" is
 * Antonio Carlos Moreira da Fonseca. Without a mapping that request fails twice
 * over — the chat search does not match a nickname, and the requested-vs-resolved
 * guard would refuse the result even if it did, because "tonhão" is not equal to
 * the resolved name.
 *
 * Configured as JSON so a name may contain anything, including commas:
 *
 *   WA_CONTACT_ALIASES={"tonhão":"Antonio Carlos Moreira da Fonseca"}
 *
 * Aliases are a lookup convenience, never a permission: the canonical name they
 * produce still has to be on the allowlist.
 */
export function parseAliases(env = process.env) {
  const raw = (env.WA_CONTACT_ALIASES || "").trim();
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).map(([alias, real]) => [foldName(alias), String(real)]));
  } catch {
    // A malformed map must not stop the bridge from starting; it just means no
    // aliases resolve.
    return new Map();
  }
}

/** The canonical chat name for `name`, or `name` unchanged when not an alias. */
export function resolveAlias(name, env = process.env) {
  return parseAliases(env).get(foldName(name)) ?? name;
}

function refuse(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Config-level checks, cheap and browser-free.
 *
 * Run before opening a chat: otherwise a bridge with sending switched off
 * reports "not linked to WhatsApp", and the login error masks the real cause.
 */
export function assertSendConfigured(env = process.env) {
  if (env.WA_ALLOW_SEND !== "true") {
    throw refuse("Sending is disabled. Set WA_ALLOW_SEND=true on the bridge to enable it.", 403);
  }
  // An empty allowlist means "no one", never "everyone": the failure mode of
  // the opposite default is messaging a stranger.
  if (parseAllowlist(env).length === 0) {
    throw refuse(
      "WA_SEND_ALLOWLIST is empty, so no recipient is permitted. Add the contacts you allow.",
      403,
    );
  }
}

/**
 * Is this chat permitted at all?
 *
 * Whole-name equality, NOT substring. Substring matching looks convenient until
 * a short entry is added: with it, "We" (a real group) would also authorise
 * "Wesley", "Powell" and anything else containing those two letters, silently
 * widening the allowlist far past what was configured.
 */
export function assertSendable(name, env = process.env) {
  assertSendConfigured(env);
  if (!parseAllowlist(env).map(foldName).includes(foldName(name))) {
    // A comma in the requested name is the likeliest cause of a surprising
    // refusal, because an unquoted entry was split into pieces. Say so rather
    // than leaving the operator to rediscover it.
    const commaHint = name.includes(",")
      ? ` Note that "${name}" contains a comma, so it must be quoted in WA_SEND_ALLOWLIST ` +
        `(e.g. '"${name}",Someone Else') or the list given as a JSON array.`
      : "";
    throw refuse(
      `"${name}" is not on WA_SEND_ALLOWLIST. Refusing to send. ` +
        "Entries must match the whole chat name as WhatsApp shows it." +
        commaHint,
      403,
    );
  }
}

/**
 * Is the chat that opened the one that was asked for?
 *
 * Chat search is fuzzy and ranks by recency, so the first result is regularly a
 * different conversation than the name implies. Being allowlisted is not
 * evidence of being correct.
 */
export function assertResolvedMatches(requested, resolved) {
  if (foldName(requested) !== foldName(resolved)) {
    throw refuse(
      `Asked to message "${requested}" but the search opened "${resolved}". ` +
        "Refusing to send. Use the exact chat name from the chat list.",
      409,
    );
  }
}
