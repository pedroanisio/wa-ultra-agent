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
