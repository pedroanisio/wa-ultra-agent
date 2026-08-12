import { test } from "node:test";
import assert from "node:assert/strict";

import { stepCompleted, toolStarted, turnEnded, turnStarted } from "../agent/lib/turn-log.ts";

/**
 * The record a finished turn hands back.
 *
 * `turnEnded` used to return nothing, which meant the channel closing a turn
 * had no way to ask what had just happened in it — and answering a silent turn
 * correctly depends entirely on that: whether the model ran at all (`steps`)
 * and whether anything already reached the user (`tools`). Without it the only
 * available reaction to silence was more silence.
 */

test("a finished turn returns its own steps and tools", () => {
  const id = "test-turn-returns";
  turnStarted(id, 12);
  toolStarted(id, "whatsapp_send_voice");
  stepCompleted(id);
  stepCompleted(id);

  const record = turnEnded(id, "silent", { replyChars: 0 });

  assert.ok(record, "a turn that was opened must hand its record back");
  assert.equal(record.steps, 2);
  assert.deepEqual(
    record.tools.map((tool) => tool.name),
    ["whatsapp_send_voice"],
  );
  assert.equal(record.outcome, "silent");
  assert.ok(record.endedAt !== undefined, "the elapsed time is what tells the two silences apart");
});

test("closing a turn that was never opened returns nothing rather than throwing", () => {
  // Telemetry must never break a turn — including when the turn is a stranger.
  assert.equal(turnEnded("test-turn-never-started", "failed"), undefined);
});

test("a turn cannot be closed twice", () => {
  const id = "test-turn-double-close";
  turnStarted(id, 1);
  assert.ok(turnEnded(id, "answered", { replyChars: 5 }));
  assert.equal(turnEnded(id, "answered", { replyChars: 5 }), undefined);
});
