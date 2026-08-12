import { test } from "node:test";
import assert from "node:assert/strict";

import { createDeliveryGuard, DEFAULT_CAPACITY } from "../agent/lib/delivery-guard.ts";
import { deliveryKey } from "../agent/channels/console.ts";

/**
 * One answer per turn, however many times the turn is run.
 *
 * The first test is the incident of 12 August 2026 reduced to its shape: the
 * same turn completing twice because the runtime redelivered it after its own
 * 30-second delivery timeout, while the original was still running.
 */

test("a turn that completes twice is delivered once", () => {
  const guard = createDeliveryGuard();
  const key = "wrun_01KZTX2VB6ZSHQSMFMZBPD51R1:turn_0";

  assert.equal(guard.claim(key), true, "the first completion delivers");
  assert.equal(guard.claim(key), false, "the redelivered execution must not");
  assert.equal(guard.claim(key), false, "and not on the third attempt either");
});

test("two different turns both deliver", () => {
  const guard = createDeliveryGuard();

  assert.equal(guard.claim("session-a:turn_0"), true);
  assert.equal(guard.claim("session-a:turn_1"), true);
  assert.equal(guard.claim("session-b:turn_0"), true);
});

test("a turn with no id is delivered rather than silenced", () => {
  // A missing key means nothing is known about which turn this is, and a
  // duplicate answer is a smaller failure than a user left with no answer at
  // all — which is the failure `silent-turn.ts` exists to end.
  const guard = createDeliveryGuard();

  assert.equal(guard.claim(""), true);
  assert.equal(guard.claim(""), true);
  assert.equal(guard.claim(undefined as unknown as string), true);
  assert.equal(guard.size, 0, "an unusable key is not remembered");
});

test("claimed() reports without claiming", () => {
  const guard = createDeliveryGuard();

  assert.equal(guard.claimed("k"), false);
  assert.equal(guard.claim("k"), true);
  assert.equal(guard.claimed("k"), true);
  assert.equal(guard.claimed(""), false);
});

test("the memory is bounded, and evicts the oldest first", () => {
  const guard = createDeliveryGuard(3);

  for (const key of ["a", "b", "c"]) assert.equal(guard.claim(key), true);
  assert.equal(guard.size, 3);

  assert.equal(guard.claim("d"), true, "a fourth turn still delivers");
  assert.equal(guard.size, 3, "and the set stays bounded");

  // "a" was evicted, so its redelivery would slip through — which is why the
  // capacity is far larger than any burst. "b" through "d" are still guarded.
  for (const key of ["b", "c", "d"]) {
    assert.equal(guard.claim(key), false, `${key} is still remembered`);
  }
});

/* ---------------------------------------------------------------- *
 * The key the guard is fed. Getting this wrong turns a fix for saying
 * things twice into a cause of saying nothing.
 * ---------------------------------------------------------------- */

test("two turns in one session get different keys", () => {
  const ctx = { session: { id: "wrun_01KZTX2VB6ZSHQSMFMZBPD51R1" } };
  const first = deliveryKey({ turnId: "turn_0" }, ctx);
  const second = deliveryKey({ turnId: "turn_1" }, ctx);

  assert.notEqual(first, second);

  const guard = createDeliveryGuard();
  assert.equal(guard.claim(first), true);
  assert.equal(guard.claim(second), true, "the next turn in a session must still answer");
});

test("the same turn re-executed gets the same key, whichever shape the event arrives in", () => {
  const ctx = { session: { id: "wrun_01KZTX2VB6ZSHQSMFMZBPD51R1" } };
  // The runtime emits `turnId` at the top level for turn.completed and nested
  // under `data` elsewhere; both name the same turn.
  assert.equal(deliveryKey({ turnId: "turn_0" }, ctx), deliveryKey({ data: { turnId: "turn_0" } }, ctx));
});

test("a turn with no id yields no key, so it is answered rather than silenced", () => {
  const ctx = { session: { id: "wrun_x" } };
  assert.equal(deliveryKey({}, ctx), "");
  assert.equal(deliveryKey({ turnId: "" }, ctx), "");
  assert.equal(deliveryKey(null, ctx), "");

  const guard = createDeliveryGuard();
  assert.equal(guard.claim(deliveryKey({}, ctx)), true);
  assert.equal(guard.claim(deliveryKey({}, ctx)), true, "an unidentified turn is never suppressed");
});

test("the same turn id in two different sessions is two different turns", () => {
  // `turn_0` is the first turn of EVERY session, so the session must be in the key.
  assert.notEqual(
    deliveryKey({ turnId: "turn_0" }, { session: { id: "a" } }),
    deliveryKey({ turnId: "turn_0" }, { session: { id: "b" } }),
  );
});

test("the default capacity is large enough to be irrelevant to a burst", () => {
  // A redelivery follows its original by seconds. Anything in this range means
  // the guard never expires a key that could still be re-run.
  assert.ok(DEFAULT_CAPACITY >= 100);
});
