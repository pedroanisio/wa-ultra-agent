import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DELIVERING_TOOLS,
  REACHED_THE_MODEL_MS,
  type SilentTurn,
  silenceAction,
} from "../agent/lib/silent-turn.ts";

/**
 * What a turn that said nothing owes the user.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 * `turn.completed` delivered the model's reply with `if (reply)` and no else.
 * A turn that produced no reply therefore produced no notification, so the
 * phone stayed exactly as quiet as if the message had never been received.
 *
 * Observed three times in one morning, in two different faults: twice at 0.0s
 * with `steps=0` against a session eve had already closed, and once at 2.6s
 * with `steps=0` when the provider refused a tool call. In all three the user
 * saw an identical thing — nothing — and could not tell any of them apart from
 * being ignored.
 *
 * ARCHITECTURAL REQUIREMENT (PALS's LAW): the prompt asks the model never to be
 * silent. These tests exist because asking is not verifying.
 */

const base: SilentTurn = { steps: 1, elapsedMs: 3_000, tools: [], retried: false };

test("a turn that already wrote to the chat says nothing more", () => {
  for (const tool of DELIVERING_TOOLS) {
    const action = silenceAction({ ...base, steps: 0, elapsedMs: 0, tools: [tool] });
    assert.equal(action.kind, "none", `${tool} put something on the screen already`);
  }
});

test("an instant empty turn is a dead session, and is retried once", () => {
  const action = silenceAction({ ...base, steps: 0, elapsedMs: 0 });
  assert.equal(action.kind, "retry");
  assert.match(action.body, /already ended/);
});

test("a dead session that was already retried is reported, never retried again", () => {
  const action = silenceAction({ ...base, steps: 0, elapsedMs: 1, retried: true });
  assert.equal(action.kind, "report", "a second retry would loop on a session that cannot recover");
  assert.match(action.body, /restarting/);
});

test("a turn with no original request is reported rather than looped", () => {
  // The channel passes `retried: true` when it has nothing to resend, because
  // "cannot retry" and "already retried" are the same decision.
  const action = silenceAction({ ...base, steps: 0, elapsedMs: 0, retried: true });
  assert.equal(action.kind, "report");
});

test("an empty turn that took real time points at the model configuration", () => {
  // The 2.6s voice-note turn: the provider was reached and refused the request.
  const action = silenceAction({ ...base, steps: 0, elapsedMs: 2_600 });
  assert.equal(action.kind, "report", "a fresh session cannot fix a refused request");
  assert.match(action.body, /model configuration/);
});

test("the two zero-step silences are told apart by the clock alone", () => {
  const dead = silenceAction({ ...base, steps: 0, elapsedMs: REACHED_THE_MODEL_MS - 1 });
  const refused = silenceAction({ ...base, steps: 0, elapsedMs: REACHED_THE_MODEL_MS });

  assert.equal(dead.kind, "retry");
  assert.equal(refused.kind, "report");
  assert.notEqual(
    (dead as { body: string }).body,
    (refused as { body: string }).body,
    "two different faults must not produce one apology",
  );
});

test("a turn that ran and produced no words is reported", () => {
  const action = silenceAction({ ...base, steps: 2, tools: ["whatsapp_read_chat"] });
  assert.equal(action.kind, "report");
  assert.match(action.body, /no reply/);
});

test("a send to someone else still owes the user a word", () => {
  // The recipient is not knowable from the tool name, so a turn that messaged a
  // correspondent and told the operator nothing must not be treated as spoken.
  const action = silenceAction({ ...base, steps: 2, tools: ["whatsapp_send_message"] });
  assert.equal(action.kind, "report");
});

test("every action that is not `none` carries something a phone can display", () => {
  const cases: SilentTurn[] = [
    { ...base, steps: 0, elapsedMs: 0 },
    { ...base, steps: 0, elapsedMs: 0, retried: true },
    { ...base, steps: 0, elapsedMs: 5_000 },
    { ...base, steps: 3 },
  ];

  for (const turn of cases) {
    const action = silenceAction(turn);
    assert.notEqual(action.kind, "none");
    const body = (action as { body: string }).body;
    assert.ok(body.trim().length > 20, "a report the user cannot act on is still silence");
  }
});
