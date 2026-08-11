import { test } from "node:test";
import assert from "node:assert/strict";

import { createBudget } from "../src/rate.js";

/**
 * Rate is a safety parameter here, not a performance one.
 *
 * This bridge drives a real WhatsApp Web session on a personal account, and the
 * *pattern* of automation is what gets accounts banned — permanently, with no
 * appeal. Backfilling years of history is exactly the shape of traffic that
 * looks like a bot, so the ceiling is enforced in the bridge, where no caller
 * can talk its way past it, rather than in the agent.
 */

/** A clock the test drives by hand, so no test ever sleeps. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

test("starts full", () => {
  const budget = createBudget({ maxPerHour: 60, now: fakeClock().now });
  assert.equal(budget.remaining(), 60);
});

test("take spends from the bucket", () => {
  const budget = createBudget({ maxPerHour: 60, now: fakeClock().now });
  budget.take(10);
  assert.equal(budget.remaining(), 50);
});

test("take defaults to one interaction", () => {
  const budget = createBudget({ maxPerHour: 60, now: fakeClock().now });
  budget.take();
  assert.equal(budget.remaining(), 59);
});

test("refuses once the bucket is empty, and says how long to wait", () => {
  const budget = createBudget({ maxPerHour: 60, now: fakeClock().now });
  budget.take(60);

  assert.throws(
    () => budget.take(),
    (e) => e.statusCode === 429 && /second|minute/i.test(e.message),
  );
});

test("refuses a request larger than what is left, spending nothing", () => {
  const budget = createBudget({ maxPerHour: 60, now: fakeClock().now });
  budget.take(55);

  assert.throws(() => budget.take(10), (e) => e.statusCode === 429);
  assert.equal(budget.remaining(), 5, "a refused take must not consume anything");
});

test("refills over time", () => {
  const clock = fakeClock();
  const budget = createBudget({ maxPerHour: 3600, now: clock.now }); // one per second
  budget.take(3600);
  assert.equal(budget.remaining(), 0);

  clock.advance(10_000);
  assert.equal(budget.remaining(), 10);
});

test("never refills above its capacity", () => {
  const clock = fakeClock();
  const budget = createBudget({ maxPerHour: 60, now: clock.now });

  clock.advance(24 * 60 * 60 * 1000);
  assert.equal(budget.remaining(), 60);
});

test("a spent budget becomes usable again after enough time", () => {
  const clock = fakeClock();
  const budget = createBudget({ maxPerHour: 3600, now: clock.now });
  budget.take(3600);

  assert.throws(() => budget.take());
  clock.advance(5_000);
  assert.doesNotThrow(() => budget.take(5));
});

test("reports its own configuration, so a caller can pace itself", () => {
  const budget = createBudget({ maxPerHour: 120, now: fakeClock().now });
  assert.equal(budget.maxPerHour, 120);
});

test("a request larger than the whole capacity is refused as impossible", () => {
  const budget = createBudget({ maxPerHour: 10, now: fakeClock().now });
  assert.throws(() => budget.take(11), (e) => e.statusCode === 429 && /never/i.test(e.message));
});

test("remaining is reported whole: a partial token is not an interaction", () => {
  const clock = fakeClock();
  const budget = createBudget({ maxPerHour: 3600, now: clock.now });
  budget.take(3600);

  clock.advance(1500); // 1.5 tokens
  assert.equal(budget.remaining(), 1);
});
