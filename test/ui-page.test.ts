import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PAGE } from "../agent/lib/ui-page.ts";

/**
 * The document itself.
 *
 * ── Why a served string needs tests at all ──────────────────────────────────
 * Because nothing else checks it. The page is assembled inside a template
 * literal, so a stray backtick is interpolated by the SERVER and never reaches
 * the browser; a syntax error in the client script produces a blank page with
 * one line in a console nobody has open; and the rule that keeps somebody's
 * correspondence from becoming markup on a page that can send messages is a
 * rule about which property is assigned, which no type checks.
 */

/** The client script, as the browser would receive it. */
const script = /<script>([\s\S]*)<\/script>/.exec(PAGE)?.[1] ?? "";
const styles = /<style>([\s\S]*?)<\/style>/.exec(PAGE)?.[1] ?? "";

test("the document has a script and a stylesheet in it", () => {
  assert.ok(script.length > 1000, "the client script is missing or truncated");
  assert.ok(styles.length > 500, "the stylesheet is missing or truncated");
});

test("nothing was left to be interpolated by the server", () => {
  // A `${` surviving into the output means the template literal boundaries are
  // wrong somewhere — the server would have substituted it, or thrown.
  assert.ok(!PAGE.includes("${"), "an un-interpolated ${ reached the page");
});

test("the client script parses", () => {
  // A syntax error here is a blank page and one line in a console nobody has
  // open. `node --check` is the same parser the browser's would agree with on
  // anything this file is allowed to contain.
  const directory = mkdtempSync(join(tmpdir(), "ui-page-"));
  const file = join(directory, "client.js");
  writeFileSync(file, script, "utf8");
  execFileSync(process.execPath, ["--check", file]);
});

test("no message ever becomes markup", () => {
  // Everything rendered on these screens is third-party text: correspondence,
  // display names people chose, a model's reading of both. One innerHTML on a
  // page that can send messages turns a message into script.
  // Assignments and calls, not the word: the script carries a comment naming
  // the rule, and a check that forbids writing the rule down is a check people
  // delete rather than satisfy.
  assert.ok(
    !/\.(inner|outer)HTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(script),
    "the client assigns HTML somewhere",
  );
});

test("the page loads nothing from anywhere", () => {
  // The channel serves a CSP with `default-src 'none'`, so an external
  // reference would not merely be a privacy leak — it would silently not load.
  assert.ok(!/https?:\/\//.test(PAGE.replace(/placeholder="[^"]*"/g, "")), "external reference in the page");
  assert.ok(!/<img|<link|<iframe|<script src/i.test(PAGE));
});

test("every screen the operator can reach is in the document", () => {
  for (const id of ["screen-queue", "screen-setup", "screen-prefs", "screen-tools"]) {
    assert.ok(PAGE.includes(id), `${id} is missing`);
  }
  // Edit & send is a moment rather than a place: a dialog, reachable only from
  // a conversation, which is why it has no tab.
  assert.ok(PAGE.includes('<dialog id="compose"'));
  assert.ok(!/data-screen="compose"/.test(PAGE));
});

test("every fetch the client makes is same-origin and under /ui", () => {
  const paths = [...script.matchAll(/(?:api|EventSource)\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= 8, `expected the client to call the API, found ${paths.length}`);
  for (const path of paths) {
    assert.match(path, /^\/ui\//, `${path} is outside the UI's namespace`);
  }
});

test("the queue's empty state is a sentence, not a zero", () => {
  assert.match(script, /A quiet day is a valid screen/);
});
