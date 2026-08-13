import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_OPEN_SETS,
  closeResultSet,
  headSize,
  openResultSet,
  pageResultSet,
  resetResultSets,
} from "../agent/lib/result-set.ts";
import { resetUsage, observeUsage } from "../agent/lib/context-budget.ts";

/**
 * Load once, read in controlled pieces.
 *
 * ── Why a search tool needs a handle ────────────────────────────────────────
 *
 * `whatsapp_search_archive` had no ceiling of any kind. A broad query across an
 * archive of somebody's whole correspondence returns as much as the bridge will
 * give it, and every byte lands in the context window in one step. That is the
 * likeliest single source of the 770K-token step that took a prompt to
 * 1,570,042 tokens.
 *
 * The fix is not truncation. A silently shortened result set is the exact
 * failure the tool's own description warns about — "never claim someone did not
 * say something based on an empty result" — so a shortened one has to SAY it is
 * shortened, report how much it is holding back, and hand over a way to read the
 * rest.
 *
 * Everything here is in-process and synchronous, so the paging contract is
 * testable without an archive, a bridge or a model.
 */

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `k${i}`, text: `message ${i}` }));

/* ── Head sizing: the link back to the context budget ───────────────────── */

test("the head shrinks as the conversation fills — a search is a tool result like any other", () => {
  resetUsage();
  const empty = headSize({ sessionId: "s", rowBytes: 500 });
  observeUsage("s", { inputTokens: 900_000 });
  const crowded = headSize({ sessionId: "s", rowBytes: 500 });

  assert.ok(crowded < empty, `expected fewer rows when crowded: ${crowded} vs ${empty}`);
  assert.ok(crowded >= 1, "always at least one row, or the tool answers nothing at all");
});

test("a head is never zero rows, even in an exhausted context", () => {
  // Returning nothing would read as "no matches", which is the one thing this
  // tool must never say when there were matches.
  resetUsage();
  observeUsage("s", { inputTokens: 5_000_000 });
  assert.ok(headSize({ sessionId: "s", rowBytes: 10_000 }) >= 1);
});

test("wider rows mean fewer of them", () => {
  resetUsage();
  const narrow = headSize({ sessionId: "s", rowBytes: 100 });
  const wide = headSize({ sessionId: "s", rowBytes: 5_000 });
  assert.ok(wide < narrow);
});

/* ── Opening and paging ─────────────────────────────────────────────────── */

test("a set that fits entirely is not truncated and needs no handle", () => {
  resetResultSets();
  const opened = openResultSet(rows(5), { head: 20 });
  assert.equal(opened.truncated, false);
  assert.equal(opened.shown.length, 5);
  assert.equal(opened.retrieved, 5);
  assert.equal(opened.id, undefined, "no handle when there is nothing left to read");
});

test("a set larger than the head is truncated, SAYS so, and reports the true total", () => {
  resetResultSets();
  const opened = openResultSet(rows(120), { head: 10 });

  assert.equal(opened.shown.length, 10);
  assert.equal(opened.truncated, true);
  assert.equal(opened.retrieved, 120, "the total must be the real one, never the shown count");
  assert.equal(opened.remaining, 110);
  assert.ok(opened.id, "a truncated set must hand back a way to read the rest");
});

test("the handle pages the remainder in order, with no repeats and no gaps", () => {
  resetResultSets();
  const opened = openResultSet(rows(25), { head: 10 });
  const seen = opened.shown.map((r) => r.key);

  let cursor: number | undefined = undefined;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = pageResultSet(opened.id!, { after: cursor, limit: 5 });
    assert.equal(page.ok, true);
    if (page.ok === false) break;
    seen.push(...page.rows.map((r) => (r as { key: string }).key));
    if (page.rows.length === 0) break;
    cursor = page.nextAfter;
  }

  assert.deepEqual(seen, rows(25).map((r) => r.key), "every row exactly once, in order");
});

test("paging past the end is an empty page, not an error", () => {
  resetResultSets();
  const opened = openResultSet(rows(12), { head: 10 });
  const page = pageResultSet(opened.id!, { after: 999, limit: 5 });
  assert.equal(page.ok, true);
  if (page.ok) assert.deepEqual(page.rows, []);
});

test("each page reports what is still unread, so the model can stop deliberately", () => {
  resetResultSets();
  const opened = openResultSet(rows(30), { head: 10 });
  const page = pageResultSet(opened.id!, { after: undefined, limit: 5 });
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.equal(page.rows.length, 5);
    assert.equal(page.remaining, 15, "30 total − 10 head − 5 just read");
  }
});

/* ── Refusals that explain themselves ───────────────────────────────────── */

test("an unknown handle is refused with instructions, not a crash", () => {
  resetResultSets();
  const page = pageResultSet("rs_nonexistent", {});
  assert.equal(page.ok, false);
  if (page.ok === false) {
    assert.match(page.error, /search/i, "must tell the model to run the search again");
  }
});

test("a closed handle is refused the same way", () => {
  resetResultSets();
  const opened = openResultSet(rows(50), { head: 10 });
  closeResultSet(opened.id!);
  assert.equal(pageResultSet(opened.id!, {}).ok, false);
});

/* ── Bounded memory ─────────────────────────────────────────────────────── */

test("old sets are evicted, so a long session cannot accumulate result sets forever", () => {
  resetResultSets();
  const ids: string[] = [];
  for (let i = 0; i < MAX_OPEN_SETS + 5; i += 1) {
    const opened = openResultSet(rows(50), { head: 1 });
    ids.push(opened.id!);
  }

  // The oldest are gone; the newest survive. A cache that never evicts is a
  // leak, and this one holds somebody's correspondence.
  assert.equal(pageResultSet(ids[0], {}).ok, false, "oldest must have been evicted");
  assert.equal(pageResultSet(ids[ids.length - 1], {}).ok, true, "newest must survive");
});

test("resetResultSets clears everything, so tests cannot leak into each other", () => {
  const opened = openResultSet(rows(50), { head: 1 });
  resetResultSets();
  assert.equal(pageResultSet(opened.id!, {}).ok, false);
});
