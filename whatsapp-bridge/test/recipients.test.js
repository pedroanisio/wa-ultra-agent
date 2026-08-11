import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertResolvedMatches,
  assertSendConfigured,
  assertSendable,
  normalizeName,
  parseAllowlist,
  resolveAlias,
  splitAllowlistEntries,
} from "../src/recipients.js";

/**
 * Regression tests for the send guards.
 *
 * Each block below corresponds to a defect that actually reached a live
 * session, not a hypothetical. The names say which.
 */

const env = (allowlist, allow = "true") => ({
  WA_ALLOW_SEND: allow,
  WA_SEND_ALLOWLIST: allowlist,
});

const REAL = "Joao Vitor Almeida Rocha,We,Helena Braga";

function statusOf(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.statusCode;
  }
}

/* ------------------------------------------------------------------ *
 * REGRESSION: a short allowlist entry authorised unrelated chats.
 *
 * Matching was `resolved.includes(entry)`, so an entry of "We" — a real
 * group — also permitted every chat whose name contains those two letters.
 * ------------------------------------------------------------------ */

test("a short entry does not authorise names that merely contain it", () => {
  const e = env(REAL);
  assert.doesNotThrow(() => assertSendable("We", e), "the configured group is still allowed");

  for (const impostor of ["Wesley", "Wesley Snipes", "Powell", "Sweet Home", "Weber Group"]) {
    assert.equal(statusOf(() => assertSendable(impostor, e)), 403, `${impostor} must be refused`);
  }
});

test("a longer entry is not a prefix licence either", () => {
  const e = env("Helena Braga");
  assert.equal(statusOf(() => assertSendable("Helena Braga Costa", e)), 403);
  assert.equal(statusOf(() => assertSendable("Helena", e)), 403);
});

/* ------------------------------------------------------------------ *
 * REGRESSION: search opened a different chat than the one requested.
 *
 * "Helena Braga" resolves to the group "We", which was allowlisted — so the
 * permission check passed and a message meant for one person would have been
 * delivered to a group.
 * ------------------------------------------------------------------ */

test("an allowlisted chat is still refused when it is not the one requested", () => {
  const e = env(REAL);
  // The resolved chat passes the allowlist on its own...
  assert.doesNotThrow(() => assertSendable("We", e));
  // ...but it is not who was asked for.
  assert.equal(statusOf(() => assertResolvedMatches("Helena Braga", "We")), 409);
});

test("the match check accepts the same chat and rejects a near neighbour", () => {
  assert.doesNotThrow(() => assertResolvedMatches("Sam + Folks", "Sam + Folks"));
  assert.equal(statusOf(() => assertResolvedMatches("Ana", "Ana Paula")), 409);
});

/* ------------------------------------------------------------------ *
 * Normalisation: WhatsApp decorates the user's own chat with "(You)", and a
 * hand-edited .env arrives with stray quotes and casing.
 * ------------------------------------------------------------------ */

test("a trailing parenthetical is ignored, so the self chat matches its plain name", () => {
  const e = env("Joao Vitor Almeida Rocha");
  assert.doesNotThrow(() => assertSendable("Joao Vitor Almeida Rocha (You)", e));
  assert.doesNotThrow(() => assertResolvedMatches("Joao Vitor Almeida Rocha", "Joao Vitor Almeida Rocha (You)"));
});

test("case, padding and stray quotes do not change who is permitted", () => {
  const e = env('  "joao vitor almeida rocha" , WE ');
  assert.doesNotThrow(() => assertSendable("Joao Vitor Almeida Rocha", e));
  assert.doesNotThrow(() => assertSendable("we", e));
});

test("normalizeName collapses only what is safe to collapse", () => {
  assert.equal(normalizeName("  Sam + Folks "), "sam + folks");
  assert.equal(normalizeName('"We"'), "we");
  assert.equal(normalizeName("Joao (You)"), "joao");
  // A parenthetical in the MIDDLE is part of the name, not a decoration.
  assert.equal(normalizeName("Familia (Braga) Grupo"), "familia (braga) grupo");
  assert.equal(normalizeName(undefined), "");
});

/* ------------------------------------------------------------------ *
 * REGRESSION: per-item quoting in .env.
 *
 * `WA_SEND_ALLOWLIST="A","B"` is rejected outright by docker compose, but a
 * value that survives with quotes still round-trips to the right entries.
 * ------------------------------------------------------------------ */

test("the allowlist parses whether or not entries carry quotes", () => {
  assert.deepEqual(parseAllowlist({ WA_SEND_ALLOWLIST: "A,B,C" }), ["a", "b", "c"]);
  assert.deepEqual(parseAllowlist({ WA_SEND_ALLOWLIST: '"A","B"' }), ["a", "b"]);
  assert.deepEqual(parseAllowlist({ WA_SEND_ALLOWLIST: "A, ,B," }), ["a", "b"]);
  assert.deepEqual(parseAllowlist({}), []);
});

/* ------------------------------------------------------------------ *
 * REGRESSION: a chat name containing the delimiter.
 *
 * "Kiko, Tuca, Zé" is a real group. Unquoted, it splits into three entries — the
 * group is not permitted, and "Kiko", "Tuca" and "Zé" each silently become their
 * own whole-name permission.
 * ------------------------------------------------------------------ */

test("a quoted entry keeps its commas instead of becoming three permissions", () => {
  const e = env('"Kiko, Tuca, Zé",We');
  assert.deepEqual(parseAllowlist(e), ["kiko, tuca, zé", "we"]);
  assert.doesNotThrow(() => assertSendable("Kiko, Tuca, Zé", e));
  assert.doesNotThrow(() => assertSendable("We", e));

  // The pieces must NOT have become permissions of their own.
  for (const fragment of ["Kiko", "Tuca", "Zé"]) {
    assert.equal(statusOf(() => assertSendable(fragment, e)), 403, `${fragment} must not be permitted`);
  }
});

test("a JSON array is accepted for awkward names", () => {
  const e = env('["Kiko, Tuca, Zé", "We"]');
  assert.deepEqual(parseAllowlist(e), ["kiko, tuca, zé", "we"]);
  assert.doesNotThrow(() => assertSendable("Kiko, Tuca, Zé", e));
});

test("malformed JSON degrades to delimiter parsing rather than crashing", () => {
  const e = env('["We", ');
  assert.doesNotThrow(() => parseAllowlist(e));
  assert.doesNotThrow(() => assertSendable("We", e));
});

test("splitAllowlistEntries handles quoting, spacing and empties", () => {
  assert.deepEqual(splitAllowlistEntries('"A, B",C'), ["A, B", "C"]);
  assert.deepEqual(splitAllowlistEntries("'A, B',C"), ["A, B", "C"]);
  assert.deepEqual(splitAllowlistEntries("A,B"), ["A", "B"]);
  assert.deepEqual(splitAllowlistEntries(""), [""]);
});

test("refusing a comma-containing name explains the quoting rule", () => {
  const e = env("We");
  try {
    assertSendable("Kiko, Tuca, Zé", e);
    assert.fail("should have refused");
  } catch (error) {
    assert.match(error.message, /contains a comma/);
    assert.match(error.message, /quoted in WA_SEND_ALLOWLIST/);
  }
});

/* ------------------------------------------------------------------ *
 * Nicknames. People say "tonhão", not "Antonio Carlos Moreira da Fonseca".
 * ------------------------------------------------------------------ */

const ANTONIO = "Antonio Carlos Moreira da Fonseca";
const aliasEnv = (extra = {}) => ({
  WA_ALLOW_SEND: "true",
  WA_SEND_ALLOWLIST: `"${ANTONIO}","We"`,
  WA_CONTACT_ALIASES: JSON.stringify({ "tonhão": ANTONIO, tonhao: ANTONIO }),
  ...extra,
});

test("an alias resolves to the real chat name", () => {
  const e = aliasEnv();
  assert.equal(resolveAlias("tonhão", e), ANTONIO);
  assert.equal(resolveAlias("Tonhão", e), ANTONIO, "case-insensitive");
  assert.equal(resolveAlias("tonhao", e), ANTONIO, "unaccented spelling");
});

test("a name that is not an alias passes through untouched", () => {
  const e = aliasEnv();
  assert.equal(resolveAlias("We", e), "We");
  assert.equal(resolveAlias("Someone Else", e), "Someone Else");
});

test("resolving an alias is what lets the requested-vs-resolved guard pass", () => {
  const e = aliasEnv();
  // Unresolved, the nickname can never equal the chat WhatsApp opens.
  assert.equal(statusOf(() => assertResolvedMatches("tonhão", ANTONIO)), 409);
  // Resolved first, it matches.
  assert.doesNotThrow(() => assertResolvedMatches(resolveAlias("tonhão", e), ANTONIO));
});

test("an alias is a lookup, never a permission", () => {
  // Aliased to someone who is NOT on the allowlist.
  const e = aliasEnv({
    WA_SEND_ALLOWLIST: "We",
    WA_CONTACT_ALIASES: JSON.stringify({ "tonhão": ANTONIO }),
  });
  assert.equal(resolveAlias("tonhão", e), ANTONIO);
  assert.equal(statusOf(() => assertSendable(resolveAlias("tonhão", e), e)), 403);
});

test("a malformed or absent alias map leaves names unchanged", () => {
  assert.equal(resolveAlias("tonhão", { WA_CONTACT_ALIASES: "{not json" }), "tonhão");
  assert.equal(resolveAlias("tonhão", { WA_CONTACT_ALIASES: "[]" }), "tonhão");
  assert.equal(resolveAlias("tonhão", {}), "tonhão");
});

/* ------------------------------------------------------------------ *
 * Fail-closed configuration.
 * ------------------------------------------------------------------ */

test("an empty allowlist permits no one, rather than everyone", () => {
  assert.equal(statusOf(() => assertSendConfigured(env("", "true"))), 403);
  assert.equal(statusOf(() => assertSendable("Anyone", env("", "true"))), 403);
});

test("sending stays off unless WA_ALLOW_SEND is exactly true", () => {
  for (const value of ["false", "TRUE", "1", "yes", ""]) {
    assert.equal(
      statusOf(() => assertSendConfigured({ WA_ALLOW_SEND: value, WA_SEND_ALLOWLIST: REAL })),
      403,
      `WA_ALLOW_SEND=${JSON.stringify(value)} must not enable sending`,
    );
  }
  // Absent entirely — built without the key rather than passing undefined
  // through a defaulted parameter, which would silently become "true".
  assert.equal(statusOf(() => assertSendConfigured({ WA_SEND_ALLOWLIST: REAL })), 403);

  assert.doesNotThrow(() => assertSendConfigured(env(REAL, "true")));
});

test("a disabled bridge reports configuration, not the allowlist", () => {
  // Ordering matters: the config error must not be masked by a later check.
  assert.match(
    (() => {
      try {
        assertSendable("We", env(REAL, "false"));
      } catch (error) {
        return error.message;
      }
    })(),
    /Sending is disabled/,
  );
});
