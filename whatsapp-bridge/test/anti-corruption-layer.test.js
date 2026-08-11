import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

/**
 * Where this project is allowed to know what WhatsApp's DOM looks like.
 *
 * ── The pattern, and its name ───────────────────────────────────────────────
 * The DOM seam is this system's single largest fragility: WhatsApp Web is not an
 * API, ships no version number, and can be redesigned without notice. The
 * mitigation already in place is an isolation layer — `selectors.js` holds every
 * candidate hook and asserts the critical ones before anything walks the tree,
 * `message-kind.js` turns a rendered row into `{key, kind, outgoing, sent_at_iso}`,
 * and `history.js` turns a scrollback into content-addressed messages.
 *
 * That pattern has a name and it is thirty years old:
 *
 *   "Anti-Corruption Layer: Create an isolating layer to provide clients with
 *    functionality in terms of their own domain model." — Evans, Domain-Driven
 *    Design lineage
 *
 * Naming it matters because it converts a coincidence into a commitment, and it
 * gives review a rule: WhatsApp's vocabulary on one side, this project's on the
 * other, and the translation happens in one place.
 *
 * ── Why this is a ratchet and not a clean assertion ─────────────────────────
 * The honest state of the tree is that the rule does NOT hold. `whatsapp.js`
 * imports `SELECTORS` and `first()` — so the entry points do go through the
 * layer — but it also performs 73 inline DOM walks inside `page.evaluate` and
 * `$$eval` callbacks, and `session.js` reaches for `#pane-side` directly.
 *
 * An audit suggested asserting that nothing outside the layer knows a selector.
 * Asserting that today would fail, and the two ways to make it pass are both
 * worse than this file: delete the test, or perform a large speculative refactor
 * of the most fragile code in the repository in the same change that introduces
 * its first test.
 *
 * So the invariant is expressed as a ratchet, which is weaker but true:
 *
 *   1. The set of files permitted to know the DOM is CLOSED. A new module cannot
 *      quietly start parsing WhatsApp's markup — that is the failure mode that
 *      turns one fragile seam into five.
 *   2. The debt in each file may only DECREASE. Every count below is a ceiling.
 *      Moving a DOM walk into the layer lowers it; adding one fails the test.
 *
 * When a ceiling reaches 0, delete that entry. When only the three layer files
 * remain, replace this file with the clean assertion the audit asked for.
 */

const SOURCE_DIR = new URL("../src/", import.meta.url);

/**
 * What counts as knowing the DOM.
 *
 * Deliberately syntactic. A semantic check would need to parse the file, and the
 * point here is to be impossible to argue with: these are the constructs that
 * only exist because somebody is addressing WhatsApp's markup.
 */
const DOM_KNOWLEDGE =
  /querySelector(?:All)?\(|\$\$?eval\(|\[data-testid=|\[aria-label|\[role=|\[title\]|contenteditable/g;

/**
 * The Anti-Corruption Layer proper. These files exist to know the DOM, and a
 * count here is not debt.
 */
const LAYER = new Set(["selectors.js", "message-kind.js", "history.js"]);

/**
 * Files outside the layer that still address the DOM, with the ceiling each is
 * held to. Ratchet only: lower these when work moves into the layer, never raise
 * them.
 */
const CEILINGS = {
  // The bulk of it: DOM walks inside page.evaluate callbacks. The target state is
  // that each becomes a named reader in selectors.js returning this project's
  // vocabulary, at which point this number falls.
  "whatsapp.js": 73,
  // One reference: `#pane-side`, to attach the pane-change observer. Small enough
  // to move in a single change, and the obvious first entry to retire.
  "session.js": 1,
};

function domKnowledgeCounts() {
  const counts = {};
  for (const file of readdirSync(SOURCE_DIR).filter((f) => f.endsWith(".js")).sort()) {
    const text = readFileSync(new URL(file, SOURCE_DIR), "utf8");
    const hits = text.match(DOM_KNOWLEDGE)?.length ?? 0;
    if (hits > 0) counts[file] = hits;
  }
  return counts;
}

test("ACL: no new module learns what WhatsApp's DOM looks like", () => {
  const counts = domKnowledgeCounts();
  const permitted = new Set([...LAYER, ...Object.keys(CEILINGS)]);
  const trespassers = Object.keys(counts).filter((f) => !permitted.has(f));

  assert.deepEqual(
    trespassers,
    [],
    `${trespassers.join(", ")} started addressing WhatsApp's markup directly. That belongs in the ` +
      "anti-corruption layer — selectors.js for hooks, message-kind.js for rows, history.js for " +
      "scrollback — so a redesign breaks one place instead of several. If this is genuinely a " +
      "fourth layer file, add it to LAYER and say why in its header.",
  );
});

test("ACL: the DOM debt outside the layer only ever shrinks", () => {
  const counts = domKnowledgeCounts();
  const regressions = [];

  for (const [file, ceiling] of Object.entries(CEILINGS)) {
    const actual = counts[file] ?? 0;
    if (actual > ceiling) regressions.push(`${file}: ${actual} DOM references, ceiling is ${ceiling}`);
  }

  assert.deepEqual(
    regressions,
    [],
    `DOM knowledge outside the anti-corruption layer grew:\n  ${regressions.join("\n  ")}\n\n` +
      "Put the new selector in selectors.js and read it through first()/SELECTORS instead. These " +
      "ceilings are a ratchet: they exist to be lowered, never raised.",
  );
});

test("ACL: a retired ceiling is deleted rather than left at zero", () => {
  // Housekeeping with a point. A ceiling of 0 left in place reads as "this file
  // is allowed to know the DOM", which is the opposite of what it means, and it
  // keeps the file in the permitted set for the closed-set test above.
  const counts = domKnowledgeCounts();
  const retired = Object.keys(CEILINGS).filter((f) => (counts[f] ?? 0) === 0);

  assert.deepEqual(
    retired,
    [],
    `${retired.join(", ")} no longer addresses the DOM. Remove it from CEILINGS — leaving it at 0 ` +
      "keeps it permitted, which is backwards.",
  );
});

test("ACL: the layer files are still present and still doing the job", () => {
  // Guards the case where the layer is dismantled rather than extended: if
  // selectors.js stopped holding selectors, both tests above would pass while the
  // boundary had ceased to exist.
  const counts = domKnowledgeCounts();
  for (const file of ["selectors.js"]) {
    assert.ok(
      (counts[file] ?? 0) > 0,
      `${file} is the anti-corruption layer and no longer contains any selector. Either the ` +
        "boundary moved without this test being updated, or it has been dismantled.",
    );
  }
  // message-kind.js and history.js translate rows and scrollback into this
  // project's vocabulary; they are deliberately NOT asserted to contain
  // selectors, because doing their job through passed-in handles is correct.
  for (const file of ["message-kind.js", "history.js"]) {
    assert.ok(
      readdirSync(SOURCE_DIR).includes(file),
      `${file} is part of the anti-corruption layer and has gone missing.`,
    );
  }
});
