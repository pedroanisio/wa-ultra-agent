import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  realIdentityStrings,
  scanForContactIdentifiers,
  scanForRealIdentities,
} from "../src/identity-guard.js";

/**
 * The control that stops a leak of real identity data from happening twice.
 *
 * This repository committed, and published, the real full names of three third-party
 * WhatsApp contacts, two real group names, a real document filename with its page count
 * and size, and the operator's actual send allowlist — present from the first push.
 *
 * ── Why a test and not a lint rule or a capture-time scrub ──────────────────
 * Because only one of the three paths the data took was a paste from live DOM output.
 * The majority of occurrences were TYPED — real people used as running examples in
 * SPEC.md, in a skill description, in tool docstrings and in source comments. A scrub
 * at the capture boundary cannot see those, and a reviewer cannot either, because
 * nothing in the tree distinguishes a real name from a fixture.
 *
 * ── Why the forbidden set comes from the environment ────────────────────────
 * The obvious implementation — a hardcoded list of names not to write — IS the leak.
 * It would commit the very strings it exists to keep out, and it would have to be
 * updated (in the repository, in public) every time the operator gains a contact.
 *
 * So the set is derived at run time from the live configuration that already names the
 * real people: WA_SEND_ALLOWLIST, WA_SELF_CHAT_NAME and WA_CONTACT_ALIASES. Those live
 * in .env, which is gitignored and was verified uncommitted during the incident. The
 * guard therefore knows every real identity without storing any of them.
 *
 * ── What it means when this test SKIPS ──────────────────────────────────────
 * With no identity configuration present (CI, a fresh clone, a contributor who has not
 * written .env), there is nothing to check against and the test reports skipped rather
 * than passing. A guard that silently passes when it cannot see its inputs is worse
 * than absent, because it reads as evidence. The `arrives configured` test below is
 * what fails loudly if the configuration is missing on a machine that has an archive.
 */

/** Tracked files only. An untracked scratch file is not a publication risk. */
function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: new URL("../../", import.meta.url),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

const ROOT = new URL("../../", import.meta.url).pathname;

/**
 * Files exempt from the scan, each for a stated reason.
 *
 * Deliberately tiny. Every entry here is a hole in the control.
 */
const EXEMPT = new Set([
  // Lockfiles are generated and contain no prose.
  "package-lock.json",
  "whatsapp-bridge/package-lock.json",
]);

test("guard: real identities from the live config appear in no tracked file", (t) => {
  const forbidden = realIdentityStrings(process.env);

  if (forbidden.length === 0) {
    t.skip(
      "No WA_SEND_ALLOWLIST / WA_SELF_CHAT_NAME / WA_CONTACT_ALIASES configured, so there " +
        "is no real identity to scan for. Not a pass — there was nothing to check.",
    );
    return;
  }

  const offences = [];
  for (const file of trackedFiles()) {
    if (EXEMPT.has(file)) continue;
    let text;
    try {
      text = readFileSync(ROOT + file, "utf8");
    } catch {
      continue; // deleted in the index, or binary/unreadable — nothing to scan
    }
    for (const hit of scanForRealIdentities(text, forbidden)) {
      offences.push(`${file}:${hit.line} leaks a real ${hit.kind}`);
    }
  }

  // The message names the file and line but NEVER the matched string: a CI log is a
  // publication surface too, and a failure that prints the name re-leaks it.
  assert.deepEqual(
    offences,
    [],
    `Real identity data found in ${offences.length} place(s). These must be replaced with ` +
      `synthetic values before committing:\n  ${offences.join("\n  ")}\n\n` +
      "The matched strings are deliberately not printed: a CI log is a publication " +
      "surface, and a guard that prints what it caught has re-leaked it.",
  );
});

test("guard: the scanner catches the three shapes the incident actually took", () => {
  const forbidden = realIdentityStrings({
    WA_SEND_ALLOWLIST: '"Ana Lucia Prado","Kiko, Tuca, Zé"',
    WA_CONTACT_ALIASES: '{"nickname": "Ana Lucia Prado"}',
  });

  // 1. Pasted verbatim from live DOM output, as in the fixture that started it.
  assert.equal(
    scanForRealIdentities('ariaLabels: ["Ana Lucia Prado:"],', forbidden).length,
    1,
    "a name pasted into a fixture must be caught",
  );

  // 2. Typed into prose. This is the path a capture-time scrub cannot see, and it was
  //    the majority of occurrences in the incident.
  assert.equal(
    scanForRealIdentities(" * searching \"Ana Lucia Prado\" opens the group", forbidden).length,
    1,
    "a name typed into a source comment must be caught",
  );

  // 3. Broken across a comment line-wrap. A phrase-level scan reported the rewritten
  //    history CLEAN while exactly this shape survived in two files; only a failing
  //    test caught it.
  assert.equal(
    scanForRealIdentities(' * why searching "Ana\n * Lucia Prado" opens the group', forbidden).length,
    1,
    "a name wrapped across lines must be caught — this is the residual that escaped once",
  );

  // 4. Irregular internal whitespace, the other shape that escaped.
  assert.equal(
    scanForRealIdentities('normalizeName("  Kiko,   Tuca,  Zé ")', forbidden).length,
    1,
    "a group name with irregular spacing must be caught",
  );
});

test("guard: synthetic fixtures are not flagged, or the control would be turned off", () => {
  const forbidden = realIdentityStrings({ WA_SEND_ALLOWLIST: '"Ana Lucia Prado"' });

  for (const innocent of [
    'ariaLabels: ["Mariana de Souza e Lima:"]', // the synthetic replacement
    "const REAL = \"Joao Vitor Almeida Rocha,We,Helena Braga\"", // post-scrub constant
    " * Ana Paula and Ana Carolina disambiguate by surname", // shares a first name only
    "assert.equal(normalizeName('  Sam  +  Folks '), 'sam + folks')",
  ]) {
    assert.deepEqual(
      scanForRealIdentities(innocent, forbidden),
      [],
      `false positive on: ${innocent} — a noisy guard is a disabled guard`,
    );
  }
});

test("guard: a short or generic allowlist entry is not treated as an identity", () => {
  // "We" is a real group name, two characters long. Treating it as a forbidden string
  // would flag every file containing the word "we" and the guard would be deleted
  // within a day. Non-identifying entries are excluded by length, deliberately.
  const forbidden = realIdentityStrings({ WA_SEND_ALLOWLIST: '"We","Ana Lucia Prado"' });

  assert.ok(
    !forbidden.some((f) => f.value.toLowerCase() === "we"),
    "a two-character group name must not become a forbidden string",
  );
  assert.equal(
    scanForRealIdentities("we return the rows we were given", forbidden).length,
    0,
    "prose must not trip on a generic allowlist entry",
  );
});

test("guard: the guard's own files are in scope, because they leaked once", () => {
  // The first version of identity-guard.js quoted a real nickname and a real group name
  // in its own doc comments, to illustrate the threshold and the whitespace rule. The
  // guard failed on its own source the moment those files became tracked, which is
  // exactly correct: prose is the path that leaked most of the identities, and a
  // docstring is prose.
  //
  // The tempting fix was to exempt the two files. That would have converted a true
  // positive into a permanent blind spot in the one module most likely to quote a real
  // name, so this test fails if either is ever exempted.
  for (const own of [
    "whatsapp-bridge/src/identity-guard.js",
    "whatsapp-bridge/test/no-real-identities.test.js",
  ]) {
    assert.ok(
      !EXEMPT.has(own),
      `${own} must never be exempt — it is the file most likely to quote a real name ` +
        "while explaining why real names must not be quoted.",
    );
    assert.ok(
      trackedFiles().includes(own),
      `${own} must be tracked, or the guard is not guarding itself`,
    );
  }
});

test("guard: identity config arrives configured wherever an archive exists", () => {
  // The skip path above exists for CI and fresh clones. It must not become the normal
  // case on a machine that actually runs this agent: there, an unset allowlist means
  // the guard is inert while real data is flowing through the tree.
  const configured = realIdentityStrings(process.env).length > 0;
  const hasArchive = Boolean(process.env.WA_ARCHIVE_PATH || process.env.WA_SESSION_DIR);

  if (!hasArchive) return; // no archive on this machine; nothing to protect yet

  assert.ok(
    configured,
    "This machine has an archive configured but no WA_SEND_ALLOWLIST / WA_CONTACT_ALIASES, " +
      "so the identity guard cannot see what it is meant to protect. Set them in .env.",
  );
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * Contact identifiers — the half that needs no configuration
 *
 * The DOM transport knew display names and nothing else. The protocol transport
 * (`whatsapp-transport/`) knows every contact's phone number, because whatsmeow
 * addresses people as `<number>@s.whatsapp.net` before WhatsApp's LID migration
 * reaches them. That is a new class of identifier in this tree, and the name
 * guard above cannot see it: a number is not in `WA_SEND_ALLOWLIST`, so there is
 * nothing to derive a forbidden string from.
 *
 * So this half is STRUCTURAL. It forbids the shape rather than the value, which
 * has two consequences worth stating:
 *
 *   1. It needs no `.env`, so unlike the name half it never skips. On CI and on
 *      a fresh clone the number guard is fully armed while the name guard is
 *      inert.
 *   2. It cannot be defeated by a contact the operator has not configured. The
 *      name half only knows the people named in `.env`; every number is caught.
 *
 * Every fixture below is assembled from parts at run time. A literal
 * `<digits>@s.whatsapp.net` written in this file would be caught by the very
 * scan it tests — correctly, since `no-real-identities.test.js` may not be
 * exempted — so the shapes are built rather than typed.
 * ══════════════════════════════════════════════════════════════════════════ */

/** A documentation-range number (never routable), assembled so no literal appears. */
const SYNTHETIC = "1555" + "0001111";

test("guard: the canonical whatsmeow address forms are caught", () => {
  const cases = [
    [`${SYNTHETIC}@s.whatsapp.net`, "phone number"],
    [`${SYNTHETIC}@c.us`, "phone number"],
    [`${"9988" + "776655443322"}@lid`, "contact identifier"],
    [`+${SYNTHETIC}`, "phone number"],
    // Written the way a human pastes one, with separators.
    [`+${"55"} ${"11"} ${"98765"}-${"4321"}`, "phone number"],
  ];

  for (const [text, kind] of cases) {
    const hits = scanForContactIdentifiers(`a line\nwith ${text} in it\n`);
    assert.equal(hits.length, 1, `expected exactly one hit for a ${kind}, got ${hits.length}`);
    assert.equal(hits[0].kind, kind);
    assert.equal(hits[0].line, 2, "the reported line must locate the leak");
    // Same rule as the name half: a CI log is a publication surface.
    assert.ok(
      !JSON.stringify(hits).includes(SYNTHETIC.slice(0, 6)),
      "the scanner returned the matched digits; a failure log would re-leak them",
    );
  }
});

/**
 * The false positives that would get this guard deleted.
 *
 * `MINIMUM_IDENTIFYING_LENGTH` exists because a noisy guard is a disabled guard,
 * and a bare run of digits is far noisier than a short name: epoch milliseconds
 * are thirteen digits, and this repository is full of them.
 *
 * So a bare digit run is deliberately NOT an identifier, and the residual gap is
 * stated rather than papered over — `Identity.PhoneNumber()` in the Go transport
 * returns bare digits, and a fixture built from its output by hand would pass
 * this scan. What closes that hole is the containment on the Go side (the field
 * is unexported, so nothing serialises it by accident), not this regex.
 */
test("guard: shapes that merely look numeric are not identifiers", () => {
  const benign = [
    "1754870400000", // epoch milliseconds
    "2026-08-11T01:07:31Z", // a timestamp
    "d142ca3", // a short git SHA
    "protobuf v1.36.11", // a version
    "sha256-9f8b7a6c5d4e3f2a1b0c", // a hash fragment
    "120363000000000000@g.us", // a group, which is not a person's number
    "1000000", // a size in bytes
    `${SYNTHETIC}`, // the bare number, per the docstring above
  ];

  for (const text of benign) {
    assert.deepEqual(
      scanForContactIdentifiers(`x\n${text}\n`),
      [],
      `"${text}" was flagged as a contact identifier; a guard this noisy gets disabled`,
    );
  }
});

test("guard: no tracked file contains a contact identifier", () => {
  // No skip path, deliberately. This scan needs no configuration, so there is
  // never a state in which it "had nothing to check" — which makes it the one
  // identity control that is armed on every machine, including CI.
  const offences = [];

  for (const file of trackedFiles()) {
    if (EXEMPT.has(file)) continue;
    let text;
    try {
      text = readFileSync(ROOT + file, "utf8");
    } catch {
      continue;
    }
    for (const hit of scanForContactIdentifiers(text)) {
      offences.push(`${file}:${hit.line} leaks a ${hit.kind}`);
    }
  }

  assert.deepEqual(
    offences,
    [],
    `Contact identifiers found in ${offences.length} place(s):\n  ${offences.join("\n  ")}\n\n` +
      "Replace them with values assembled at run time from synthetic parts, the way this " +
      "test's own fixtures are. The matched strings are deliberately not printed.",
  );
});
