import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

/**
 * The DOM seam is gone, and must stay gone.
 *
 * ── What this file used to be ───────────────────────────────────────────────
 * A ratchet. WhatsApp Web is not an API: it ships no version number and can be
 * redesigned without notice, so every selector in this repository was a standing
 * liability. The rule — WhatsApp's vocabulary on one side, this project's on the
 * other, translated in exactly one place — could not be asserted cleanly,
 * because `whatsapp.js` performed 73 inline DOM walks and `session.js` reached
 * for `#pane-side` directly. So the invariant was written as a ceiling per file
 * that could only decrease, and the file ended with its own exit condition:
 *
 *   "When only the three layer files remain, replace this file with the clean
 *    assertion the audit asked for."
 *
 * ── Why it is this instead ──────────────────────────────────────────────────
 * The ceilings reached zero the only way they ever realistically could: not by
 * refactoring the DOM driver, but by deleting it. `whatsapp-transport` (Go,
 * whatsmeow) speaks WhatsApp's multi-device protocol directly, which supplies
 * every fact the browser was scraped for — and supplies them better. A protocol
 * message carries its own id, an exact instant and a stable per-person key,
 * where a rendered row offered a hash of its text, `"8/3/2026"` parsed against a
 * guessed date order, and a fuzzy display name.
 *
 * So the assertion is now the clean one, and it is stronger than a boundary:
 * there is no boundary because there is nothing on the other side of it.
 *
 * This is a REGRESSION test, not an archaeology note. Reintroducing a browser
 * driver would reintroduce the entire class of fragility this project spent its
 * history containing, and it would do so quietly — one `querySelector` at a
 * time, in a file nobody was watching.
 */

const SOURCE_DIR = new URL("../src/", import.meta.url);

/**
 * What counts as knowing the DOM.
 *
 * Deliberately syntactic, unchanged from the ratchet this replaces. A semantic
 * check would need to parse the file, and the point is to be impossible to
 * argue with: these constructs exist only because somebody is addressing
 * WhatsApp's markup.
 */
const DOM_KNOWLEDGE =
  /querySelector(?:All)?\(|\$\$?eval\(|\[data-testid=|\[aria-label|\[role=|\[title\]|contenteditable/g;

/** Driving a browser, as opposed to merely describing one. */
const BROWSER_DRIVER = /\bplaywright\b|\bchromium\b|page\.evaluate\(|page\.goto\(|browser\.newPage\(/g;

/**
 * What marks a comment as recording history rather than describing the present.
 *
 * The two prose checks below both need it, and both need it GENEROUS. The
 * removal of the browser is the most important thing this codebase has to
 * explain, so a comment that cannot name what went is a comment that cannot
 * explain why anything is shaped the way it is. Past tense counts: "a chat that
 * predates the transport … was scraped from a sidebar" (store.js) is a true
 * statement about rows already in the archive, not a claim about what runs.
 */
const IS_HISTORY =
  /\b(remove\w*|delete\w*|gone|went with|no longer|supersed\w*|replac\w*|used to|once\b|obsolete|historical|instead of|rather than|predates?|was|were|had\b|without a browser|browser[- ]free)\b|~~/i;

function sourceFiles() {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, body: readFileSync(new URL(name, SOURCE_DIR), "utf8") }));
}

function offenders(pattern) {
  const found = {};
  for (const { name, body } of sourceFiles()) {
    const hits = body.match(pattern);
    if (hits) found[name] = hits.length;
  }
  return found;
}

test("ACL: no source file addresses WhatsApp's markup", () => {
  const found = offenders(DOM_KNOWLEDGE);
  assert.deepEqual(
    found,
    {},
    "A selector reappeared in the bridge. Reception, sending, media and history all run " +
      "through whatsapp-transport now; anything needing a new fact should ask the protocol " +
      "for it rather than scrape a rendering of it.",
  );
});

test("ACL: no source file drives a browser", () => {
  const found = offenders(BROWSER_DRIVER);
  assert.deepEqual(
    found,
    {},
    "A browser driver reappeared in the bridge. The Playwright path was removed deliberately: " +
      "it duplicated the transport with weaker identity, weaker timestamps and a far larger " +
      "automation footprint.",
  );
});

test("ACL: the browser driver's modules are gone and stay gone", () => {
  // Named individually rather than inferred: a test that only counted selectors
  // would pass against an empty session.js left behind as a stub.
  const present = readdirSync(SOURCE_DIR);
  for (const gone of ["session.js", "selectors.js", "lifecycle.js", "watch.js"]) {
    assert.ok(
      !present.includes(gone),
      `${gone} belonged to the browser driver and has come back. If a genuine need for it ` +
        "returned, the transport is the place to answer it.",
    );
  }
});

test("ACL: no module explains itself in terms of the browser", () => {
  // The code stopped driving a browser; several module headers did not. `serial.js`
  // opened "One browser, one keyboard" and justified itself by a `commitSend`
  // function that no longer exists anywhere in the tree — so the one artefact that
  // explains why every send is serialised explained it with a reason that is not
  // true. That is worse than no comment: the next person to touch it reasons from
  // a mechanism that was deleted, and the tests cannot contradict them.
  //
  // A header may still SAY the browser is gone. What it may not do is describe it
  // in the present tense as this module's setting.
  //
  // The triggers are deliberately narrow, and each exclusion is a real sentence
  // this had to stop failing on. "a browser that navigated away" (transport.js)
  // and "closed the page" (server.js) are about the OPERATOR's browser reading
  // the QR stream — a browser this service does not drive and never did. Only
  // the definite article carries the claim: "the browser" is this bridge's.
  const CLAIMS_A_BROWSER = /\b(the browser|one browser|the composer|rendered rows?|scrap(e|es|ed|ing))\b/i;

  const offences = [];
  for (const { name, body } of sourceFiles()) {
    const lines = body.split("\n");
    lines.forEach((line, i) => {
      // Comments only. Live code naming a variable `page` is the ACL tests above.
      if (!/^\s*(\/\/|\/\*|\*)/.test(line)) return;
      if (!CLAIMS_A_BROWSER.test(line)) return;
      const window = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
      if (IS_HISTORY.test(window)) return;
      offences.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offences,
    [],
    "A module comment describes the browser as this bridge's setting. It has none — " +
      "the transport speaks the protocol and this service reads its outbox. Rewrite the " +
      "comment around what the module actually does, or mark the mention as history:\n" +
      offences.join("\n"),
  );
});

test("ACL: no comment cites a departed function as if it were still there", () => {
  // `serial.js` cited `commitSend` — from the prepare/commit send dance that went
  // with the DOM path — to explain why sends are serialised. A cross-reference
  // that resolves to nothing is the most confidently wrong kind of comment there
  // is: it reads as a pointer, and the reader spends their time looking.
  //
  // Naming one while SAYING it is gone is the opposite, and is why three of these
  // still appear in this tree. "`readChat` once ended in `.filter((m) => m.text)`"
  // is the clearest available explanation of why nothing may be dropped, and
  // deleting the name would leave the rule with no reason attached to it.
  const DEPARTED_SYMBOLS = ["commitSend", "prepareSend", "openChatTitle", "openChat", "ingestChat", "readChat"];
  const DEFINED = (symbol) =>
    new RegExp(
      `(function\\s+${symbol}\\b|const\\s+${symbol}\\b|${symbol}\\s*[,}].*from|export\\s+(async\\s+)?function\\s+${symbol}\\b|${symbol}\\s*[:=]\\s*(async\\s*)?\\()`,
    );

  const whole = sourceFiles().map((f) => f.body).join("\n");
  const dangling = [];

  for (const { name, body } of sourceFiles()) {
    const lines = body.split("\n");
    lines.forEach((line, i) => {
      for (const symbol of DEPARTED_SYMBOLS) {
        if (!new RegExp(`\\b${symbol}\\b`).test(line)) continue;
        if (DEFINED(symbol).test(whole)) continue; // live symbol, not a ghost
        const window = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
        if (IS_HISTORY.test(window)) continue; // named as gone — the point of naming it
        dangling.push(`${name}:${i + 1} cites ${symbol}`);
      }
    });
  }

  assert.deepEqual(
    dangling,
    [],
    "Comments point at functions that no longer exist:\n" + dangling.join("\n") +
      "\nCite something a reader can open, say plainly that it was removed, or drop the name.",
  );
});

test("ACL: the bridge does not depend on Playwright", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  assert.ok(
    !Object.keys(deps).some((name) => /playwright/i.test(name)),
    "Playwright is back in the bridge's dependencies. The image no longer ships a browser, " +
      "so this would install one that nothing can use.",
  );
  assert.ok(
    !/xvfb/i.test(JSON.stringify(pkg.scripts ?? {})),
    "An Xvfb script is back. There is no browser to give a display to.",
  );
});
