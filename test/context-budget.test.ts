import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ABSOLUTE_SHARE,
  HEADROOM_SHARE,
  COMPACT_AT,
  budgetBytes,
  observeUsage,
  projectedTokens,
  readUsage,
  remainingTokens,
  resetUsage,
  shouldCompactBefore,
} from "../agent/lib/context-budget.ts";

/**
 * The arithmetic that decides how much of a finite window one step may spend.
 *
 * ── The failure these tests exist for ───────────────────────────────────────
 *
 * A turn died with `prompt is too long: 1570042 tokens > 1000000 maximum` — 157%
 * of the window, and 670,042 tokens PAST the threshold where compaction was
 * supposed to have fired. A prompt does not drift that far past a guard; it
 * arrives there in one step.
 *
 * Two defects put it there, and both are arithmetic, so both are testable
 * without a model, a network or a session:
 *
 *   1. The per-result ceiling was a fraction of the WHOLE window, computed once.
 *      187,500 tokens is a modest ask of an empty context and a fatal one at
 *      850K, and the old constant could not tell those apart.
 *   2. Compaction was evaluated against the size of the PREVIOUS request, so
 *      nothing measured the step that actually crossed the line.
 *
 * Everything below is pure. The point is that a guard against context overflow
 * must be checkable without the context it guards.
 */

const WINDOW = 1_000_000;

/* ── Remaining headroom ─────────────────────────────────────────────────── */

test("headroom is what is left, not what the window holds", () => {
  assert.equal(remainingTokens(0, WINDOW), WINDOW);
  assert.equal(remainingTokens(800_000, WINDOW), 200_000);
  assert.equal(remainingTokens(WINDOW, WINDOW), 0);
});

test("an over-full context has no headroom, never negative headroom", () => {
  // The observed failure state. A negative budget would arithmetically invert
  // every comparison downstream and admit everything.
  assert.equal(remainingTokens(1_570_042, WINDOW), 0);
});

/* ── The budget ─────────────────────────────────────────────────────────── */

test("on an empty context the budget is the absolute cap, not the whole window", () => {
  // A tool result is never the only thing in a turn. Even with everything free,
  // one result may not claim the lot.
  const bytes = budgetBytes({ used: 0, window: WINDOW });
  const tokens = bytes / 4;
  assert.equal(tokens, WINDOW * ABSOLUTE_SHARE);
});

test("the budget SHRINKS as the context fills — the whole point", () => {
  const empty = budgetBytes({ used: 0, window: WINDOW });
  const most = budgetBytes({ used: 600_000, window: WINDOW });
  const nearlyFull = budgetBytes({ used: 900_000, window: WINDOW });

  assert.ok(most < empty, "a mostly-full context must budget less than an empty one");
  assert.ok(nearlyFull < most, "nearly-full must budget less than mostly-full");
});

test("the budget never increases as the context fills", () => {
  // Monotonicity is the property that matters; the curve is flat while the
  // absolute cap is the binding constraint and decays once headroom is.
  let previous = Infinity;
  for (let used = 0; used <= WINDOW; used += 50_000) {
    const budget = budgetBytes({ used, window: WINDOW });
    assert.ok(budget <= previous, `budget rose at used=${used}`);
    previous = budget;
  }
});

test("early on, the absolute cap binds rather than headroom", () => {
  // Below the crossover the context is empty enough that halving the remainder
  // would allow MORE than the cap, so the cap is what answers. Documented
  // because a flat stretch in a decreasing curve looks like a bug otherwise.
  assert.equal(budgetBytes({ used: 0, window: WINDOW }), budgetBytes({ used: 400_000, window: WINDOW }));
  assert.ok(budgetBytes({ used: 600_000, window: WINDOW }) < budgetBytes({ used: 400_000, window: WINDOW }));
});

test("at 800K of a 1M window one result may not take 187,500 tokens", () => {
  // The exact admission that produced the crash. Under the old constant this
  // was allowed; the sum overflowed the window and the API rejected the turn.
  const bytes = budgetBytes({ used: 800_000, window: WINDOW });
  const tokens = bytes / 4;

  assert.ok(
    tokens < 187_500,
    `expected less than the old fixed budget, got ${tokens.toLocaleString("en-US")}`,
  );
  // Half of the 200K that is actually left.
  assert.equal(tokens, 100_000);
});

test("a full context budgets nothing, so the next result is refused rather than sent", () => {
  assert.equal(budgetBytes({ used: WINDOW, window: WINDOW }), 0);
  assert.equal(budgetBytes({ used: 1_570_042, window: WINDOW }), 0);
});

test("the budget never exceeds the absolute cap however empty the context", () => {
  const huge = budgetBytes({ used: 0, window: 10_000_000 });
  assert.equal(huge / 4, 10_000_000 * ABSOLUTE_SHARE);
});

test("headroom share is a real fraction, so a result cannot claim all that is left", () => {
  // Claiming 100% of the remainder leaves no room for the model's own reply.
  assert.ok(HEADROOM_SHARE > 0 && HEADROOM_SHARE < 1);
});

/* ── Pre-flight: the guard that looks forward ───────────────────────────── */

test("a step that would stay under the threshold is dispatched untouched", () => {
  const verdict = shouldCompactBefore({
    used: 400_000,
    pendingTokens: 50_000,
    window: WINDOW,
  });
  assert.equal(verdict.compact, false);
  assert.equal(verdict.projected, 450_000);
});

test("THE REGRESSION: the step that produced 1,570,042 is caught BEFORE dispatch", () => {
  // 800K already in, a 770K result pending. The old check compared 800K against
  // the 900K threshold, saw room, and sent 1.57M.
  const verdict = shouldCompactBefore({
    used: 800_000,
    pendingTokens: 770_042,
    window: WINDOW,
  });

  assert.equal(verdict.compact, true, "must compact before dispatching");
  assert.equal(verdict.projected, 1_570_042);
  assert.ok(
    verdict.reason.includes("1,570,042"),
    "the reason must name the projected size, so a log says why",
  );
});

test("the pre-flight fires on the PROJECTION, not on what has already been sent", () => {
  // Under the threshold on its own, over it once the pending result is counted.
  // This is precisely the case the reactive check cannot see.
  const used = Math.floor(WINDOW * COMPACT_AT) - 1_000;
  const verdict = shouldCompactBefore({ used, pendingTokens: 50_000, window: WINDOW });
  assert.equal(verdict.compact, true);
});

test("compaction is decided below the hard ceiling, not at it", () => {
  // Compacting only at 100% is compacting after the API has already refused.
  assert.ok(COMPACT_AT < 1);
});

/* ── Projection ─────────────────────────────────────────────────────────── */

test("projected size counts encoded bytes, because base64 is what is sent", () => {
  // 3 bytes become 4 characters. A photo measured raw looks a quarter smaller
  // than the thing the model is actually given.
  const raw = projectedTokens(0, 3_000, { base64: false });
  const encoded = projectedTokens(0, 3_000, { base64: true });
  assert.ok(encoded > raw);
  assert.equal(raw, 750);
  assert.equal(encoded, 1_000);
});

test("projection adds to what is already used", () => {
  assert.equal(projectedTokens(500_000, 4_000, { base64: false }), 501_000);
});

/* ── The usage ledger ───────────────────────────────────────────────────── */

test("usage is remembered per session, so two conversations do not share a budget", () => {
  resetUsage();
  observeUsage("a", { inputTokens: 100_000 });
  observeUsage("b", { inputTokens: 900_000 });

  assert.equal(readUsage("a"), 100_000);
  assert.equal(readUsage("b"), 900_000);
  assert.ok(budgetBytes({ used: readUsage("a"), window: WINDOW }) >
            budgetBytes({ used: readUsage("b"), window: WINDOW }));
});

test("cached tokens count: a cache read is prompt the model still had to be given", () => {
  resetUsage();
  observeUsage("s", { inputTokens: 10_000, cacheReadTokens: 400_000, cacheWriteTokens: 5_000 });
  assert.equal(readUsage("s"), 415_000);
});

test("output tokens are not context until the next call carries them back", () => {
  resetUsage();
  observeUsage("s", { inputTokens: 10_000, outputTokens: 50_000 } as never);
  assert.equal(readUsage("s"), 10_000);
});

test("an unknown session reads as zero, so a missing observation is permissive not fatal", () => {
  resetUsage();
  // Deliberate: a tool must still work when nothing has reported usage yet.
  // Failing closed here would break every first call of every session.
  assert.equal(readUsage("never-seen"), 0);
});

test("the ledger keeps the HIGHEST reading, not the most recent", () => {
  // eve reports per step, and a step after a compaction reports a smaller
  // prompt. Taking the latest would quietly restore the old, too-large budget
  // at exactly the moment the conversation is most fragile.
  resetUsage();
  observeUsage("s", { inputTokens: 800_000 });
  observeUsage("s", { inputTokens: 12_000 });
  assert.equal(readUsage("s"), 800_000);
});

test("a compaction resets the session's reading, because the prompt really did shrink", () => {
  resetUsage();
  observeUsage("s", { inputTokens: 800_000 });
  resetUsage("s");
  observeUsage("s", { inputTokens: 12_000 });
  assert.equal(readUsage("s"), 12_000);
});
