import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SESSION_TURNS,
  SESSION_IDLE_MS,
  nextConsoleSession,
} from "../agent/channels/console.ts";

/**
 * When the `/eve` conversation starts again.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 * The console used ONE continuation address forever. That is right for keeping
 * a conversation continuous and wrong as the only rule, because a session that
 * never ends only grows: every message, every tool result and every piece of the
 * model's reasoning accumulates until a turn is rejected outright —
 * `prompt is too long: 1123860 tokens > 1000000 maximum`.
 *
 * The user experienced that as "the voice note did not work". Nothing in the
 * failure named the session, and only restarting the container cleared it.
 *
 * ── Why rotating is safe here, specifically ─────────────────────────────────
 * A cold session is refilled from the chat itself (`REHYDRATE_MESSAGES`), so a
 * new address does not start an amnesiac conversation — it starts one that
 * remembers what the chat says and forgets what the model said about it. In a
 * self chat, the chat IS the record, which is the same argument the tic-tac-toe
 * board rests on.
 */

const t0 = 1_760_000_000_000;

test("a burst of messages stays in one session", () => {
  let state = nextConsoleSession(undefined, t0);
  const first = state.address;

  for (let i = 1; i < 5; i += 1) state = nextConsoleSession(state, t0 + i * 30_000);

  assert.equal(state.address, first, "a conversation must not restart mid-thought");
  assert.equal(state.turns, 5);
});

test("the session rotates once it has run long enough to be large", () => {
  let state = nextConsoleSession(undefined, t0);
  const first = state.address;

  for (let i = 1; i <= MAX_SESSION_TURNS; i += 1) state = nextConsoleSession(state, t0 + i * 30_000);

  assert.notEqual(state.address, first, `a session must not run past ${MAX_SESSION_TURNS} turns`);
  assert.equal(state.turns, 1, "and the new one starts counting from itself");
});

test("a long silence starts a fresh session", () => {
  // Coming back hours later is a new conversation by any human reckoning, and
  // carrying the old one forward pays for it in context on every turn.
  const state = nextConsoleSession(nextConsoleSession(undefined, t0), t0 + SESSION_IDLE_MS + 1);
  assert.equal(state.turns, 1);
});

test("a short gap does not", () => {
  const first = nextConsoleSession(undefined, t0);
  const second = nextConsoleSession(first, t0 + SESSION_IDLE_MS - 1);
  assert.equal(second.address, first.address);
});

test("every address is distinct, so a rotation cannot resume the old session", () => {
  const seen = new Set<string>();
  let state = nextConsoleSession(undefined, t0);

  for (let i = 1; i <= MAX_SESSION_TURNS * 3; i += 1) {
    seen.add(state.address);
    state = nextConsoleSession(state, t0 + i * 30_000);
  }

  assert.ok(seen.size >= 3, `expected several sessions, saw ${seen.size}`);
});

test("a rotated session is cold, so it is refilled from the chat", () => {
  // `warmed` travelling with the address is what makes rotation safe: a new
  // session that believed itself warm would start with no transcript and no
  // memory, which is worse than either.
  let state = nextConsoleSession(undefined, t0);
  state = { ...state, warmed: true };

  const rotated = nextConsoleSession(state, t0 + SESSION_IDLE_MS + 1);
  assert.equal(rotated.warmed, false, "a fresh address has never been written to");
});

test("the address is stable within a turn — it is not time-derived per call", () => {
  const first = nextConsoleSession(undefined, t0);
  const again = nextConsoleSession(first, t0);
  assert.equal(again.address, first.address);
});
