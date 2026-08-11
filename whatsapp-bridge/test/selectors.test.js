import assert from "node:assert/strict";
import test from "node:test";

import {
  CRITICAL_SELECTORS,
  SELECTORS,
  criticalKeys,
  summarizeSelectorHealth,
} from "../src/selectors.js";

/**
 * The failure this guards is silence, not breakage.
 *
 * If `messageRow` stops matching, reading a conversation returns zero rows.
 * Ingestion then writes nothing, reports `atTop: true`, and the agent tells the
 * user their chat is empty — a wrong answer delivered confidently, which is the
 * worst shape a scrape failure can take. So the health check exists to turn
 * that into a loud 503, and these tests cover the part of it that can be
 * decided without a browser.
 */

test("critical keys: every one names a selector that actually exists", () => {
  // A rename in SELECTORS without a matching rename here would make `first()`
  // throw "unknown selector key" at ingest time — from the health check that
  // was supposed to make failures legible.
  for (const key of criticalKeys("all")) {
    assert.ok(SELECTORS[key], `CRITICAL_SELECTORS names "${key}", which is not in SELECTORS`);
  }
});

test("critical keys: scope decides which hooks are probed", () => {
  assert.deepEqual(criticalKeys("list"), CRITICAL_SELECTORS.list);
  assert.deepEqual(criticalKeys("conversation"), CRITICAL_SELECTORS.conversation);
  assert.deepEqual(criticalKeys("all"), [
    ...CRITICAL_SELECTORS.list,
    ...CRITICAL_SELECTORS.conversation,
  ]);
  // An unrecognised scope must not silently check nothing and report health.
  assert.deepEqual(criticalKeys("nonsense"), criticalKeys("all"));
});

test("critical keys: the conversation scope covers reading a chat's messages", () => {
  // These three are what ingestion needs: the header to confirm which chat is
  // open, the rows to read, and the scroller to reach history.
  assert.deepEqual(CRITICAL_SELECTORS.conversation, [
    "conversationHeader",
    "messageRow",
    "conversationScroller",
  ]);
});

test("critical keys: debug-only hooks are not treated as critical", () => {
  // A broken download selector fails one fetch loudly, which is survivable.
  // Blocking every ingestion over it would be the wrong trade.
  const all = criticalKeys("all");
  for (const key of ["messageDownload", "messageMenu", "menuItem", "qrCanvas"]) {
    assert.equal(all.includes(key), false, `${key} should not gate ingestion`);
  }
});

test("health: all matching is healthy", () => {
  const health = summarizeSelectorHealth(
    [
      { key: "conversationHeader", ok: true, matchedBy: "#main header" },
      { key: "messageRow", ok: true, matchedBy: "#main [role='row']" },
    ],
    "conversation",
  );

  assert.equal(health.ok, true);
  assert.deepEqual(health.broken, []);
  assert.equal(health.scope, "conversation");
});

test("health: one dead hook names itself and fails the whole check", () => {
  const health = summarizeSelectorHealth([
    { key: "conversationHeader", ok: true, matchedBy: "#main header" },
    { key: "messageRow", ok: false, matchedBy: null },
    { key: "conversationScroller", ok: false, matchedBy: null },
  ]);

  assert.equal(health.ok, false);
  // Naming them is the point: "ingestion failed" sends someone reading code,
  // "messageRow no longer matches" sends them to selectors.js.
  assert.deepEqual(health.broken, ["messageRow", "conversationScroller"]);
});

test("health: nothing probed is not a clean bill of health", () => {
  // An empty probe list means the check did not run. "No broken selectors
  // found" would be true and useless — the same silent pass this mechanism
  // exists to remove.
  const health = summarizeSelectorHealth([]);
  assert.deepEqual(health.broken, []);
  assert.equal(health.ok, false);
});
