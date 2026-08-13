import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMPACT_AT,
  MAX_INPUT_TOKENS_PER_SESSION,
  budgetBytes,
  observeUsage,
  projectedTokens,
  readUsage,
  resetUsage,
  shouldCompactBefore,
} from "../agent/lib/context-budget.ts";
import {
  CONTEXT_BYTE_BUDGET,
  CONTEXT_WINDOW_TOKENS,
  budgetFor,
  fitsInContext,
} from "../agent/lib/tool-output.ts";
import { assessStep } from "../agent/lib/context-alert.ts";
import { headSize, openResultSet, resetResultSets } from "../agent/lib/result-set.ts";

/**
 * The turn that died, reconstructed.
 *
 *     prompt is too long: 1570042 tokens > 1000000 maximum
 *
 * 157% of the window, 670,042 tokens past the threshold where compaction was
 * meant to fire. This file replays the exact state that produced it against the
 * guards that now exist, and asserts each one refuses.
 *
 * ── Why a whole file for one incident ───────────────────────────────────────
 *
 * Because the incident had four independent causes, and fixing any three of them
 * still leaves a system that crashes. The tests are therefore written per cause
 * rather than per module: each one names the defect it stands against, so a
 * future change that quietly reintroduces one of them fails here with a reason
 * rather than in production with a stack trace.
 */

const WINDOW = 1_000_000;
const OBSERVED_FAILURE = 1_570_042;

/* ── Cause 1: a budget that could not see how full the context was ──────── */

test("REGRESSION: the 187,500-token result is refused once the context is 80% full", () => {
  resetUsage();
  const session = "regression-1";
  observeUsage(session, { inputTokens: 800_000 });

  // 750,000 bytes is the old fixed ceiling — the largest thing the previous
  // code would admit, at any point in any conversation.
  const verdict = fitsInContext(750_000, { sessionId: session });

  assert.equal(verdict.ok, false, "the payload that overflowed the window must now be refused");
  assert.match(
    verdict.reason ?? "",
    /already used most of its context|fresh conversation/i,
    "the refusal must distinguish 'too big here' from 'too big anywhere'",
  );
});

test("REGRESSION: the same payload is still allowed at the start of a conversation", () => {
  // The guard must not become a blanket ban. A change that refuses everything
  // passes the test above and breaks the product.
  resetUsage();
  assert.equal(fitsInContext(700_000, { sessionId: "fresh" }).ok, true);
});

test("REGRESSION: the budget never exceeds what it was before this change", () => {
  // A safety change that loosens anything, anywhere, has failed at its purpose.
  resetUsage();
  for (const used of [0, 100_000, 500_000, 800_000, 999_999, OBSERVED_FAILURE]) {
    observeUsage("monotone", { inputTokens: used });
    assert.ok(
      budgetFor("monotone") <= 750_000,
      `budget rose above the old ceiling at used=${used}`,
    );
    resetUsage("monotone");
  }
});

/* ── Cause 2: a compaction check that looked backwards ──────────────────── */

test("REGRESSION: the exact step that produced 1,570,042 is caught before dispatch", () => {
  const verdict = shouldCompactBefore({
    used: 800_000,
    pendingTokens: OBSERVED_FAILURE - 800_000,
    window: WINDOW,
  });

  assert.equal(verdict.compact, true);
  assert.equal(verdict.projected, OBSERVED_FAILURE);
});

test("REGRESSION: the reactive check's blind spot is closed", () => {
  // The precise failure: a reading UNDER the threshold, and a pending step that
  // crosses it. The old check saw only the first number.
  const used = Math.floor(WINDOW * COMPACT_AT) - 1;
  assert.equal(
    shouldCompactBefore({ used, pendingTokens: 0, window: WINDOW }).compact,
    false,
    "under the line with nothing pending: proceed",
  );
  assert.equal(
    shouldCompactBefore({ used, pendingTokens: 2, window: WINDOW }).compact,
    true,
    "the same reading, with a step pending that crosses it: compact",
  );
});

test("REGRESSION: compaction is asked for before the API's hard ceiling, not at it", () => {
  assert.ok(Math.floor(WINDOW * COMPACT_AT) < WINDOW);
});

/* ── Cause 3: an unbounded search result ────────────────────────────────── */

test("REGRESSION: a large archive search cannot be admitted whole into a full context", () => {
  resetUsage();
  resetResultSets();
  const session = "regression-3";
  observeUsage(session, { inputTokens: 900_000 });

  // 2,000 hits of 400 bytes — an ordinary broad query over a real archive.
  const rows = Array.from({ length: 2_000 }, (_, i) => ({ key: `k${i}`, text: "x".repeat(400) }));
  const opened = openResultSet(rows, { head: headSize({ sessionId: session, rowBytes: 400 }) });

  assert.equal(opened.truncated, true);
  assert.ok(opened.shown.length < rows.length);
  assert.equal(opened.retrieved, 2_000, "the true total survives truncation");
  assert.ok(opened.id, "and the rest stays reachable");

  const shownBytes = JSON.stringify(opened.shown).length;
  assert.ok(
    projectedTokens(900_000, shownBytes) <= WINDOW,
    "what is shown must fit in what is left",
  );
});

/* ── Cause 4: no outer fuse ─────────────────────────────────────────────── */

test("REGRESSION: a session cannot spend forty windows before anything objects", () => {
  assert.ok(MAX_INPUT_TOKENS_PER_SESSION < 40_000_000);
  assert.ok(MAX_INPUT_TOKENS_PER_SESSION >= CONTEXT_WINDOW_TOKENS);
});

/* ── The integration path: alert → ledger → budget ──────────────────────── */

test("INTEGRATION: a step reported to the alert tightens the next tool's budget", () => {
  // The two used to be unrelated — one printed a warning, the other enforced a
  // constant. This is the wire between them, and it is the wire that turns an
  // observation into a guard.
  resetUsage();
  const session = "integration";
  const before = budgetFor(session);

  assessStep({
    sessionId: session,
    usage: { inputTokens: 950_000 },
    ledger: new Map(),
  });

  assert.ok(budgetFor(session) < before, "observing a large step must shrink the budget");
  assert.equal(readUsage(session), 950_000);
});

test("INTEGRATION: a step too small to WARN about is still RECORDED", () => {
  // The alert speaks only at 80%. If recording were tied to warning, everything
  // below 80% would go unmeasured — and the budget would then be computed from
  // a reading that stopped updating at the least convenient moment.
  resetUsage();
  const session = "quiet";
  const notice = assessStep({
    sessionId: session,
    usage: { inputTokens: 600_000 },
    ledger: new Map(),
  });

  assert.equal(notice, undefined, "60% is below every alert band, so nothing is said");
  assert.equal(readUsage(session), 600_000, "but it is recorded regardless");
});

test("INTEGRATION: the budget is unchanged until headroom binds, then falls with it", () => {
  // Below the crossover the absolute cap is the binding constraint, so the
  // budget is flat; past it, headroom is, and the budget tracks what is left.
  // Asserted explicitly because a flat stretch looks like a broken guard.
  resetUsage();
  const at = (used: number) => {
    resetUsage("curve");
    observeUsage("curve", { inputTokens: used });
    return budgetFor("curve");
  };

  assert.equal(at(600_000), 750_000, "cap still binding");
  assert.ok(at(700_000) < 750_000, "headroom now binding");
  assert.ok(at(905_000) < at(700_000));
  assert.ok(at(990_000) < at(905_000));
});

test("INTEGRATION: cache reads count toward the budget, not just billed input", () => {
  // A cache-heavy conversation reports a small `inputTokens` and a large
  // `cacheReadTokens`. Counting only the first reports a full context as empty.
  resetUsage();
  assessStep({
    sessionId: "cached",
    usage: { inputTokens: 5_000, cacheReadTokens: 900_000 },
    ledger: new Map(),
  });
  assert.equal(readUsage("cached"), 905_000);
  assert.ok(
    budgetFor("cached") < 750_000,
    "a conversation that is 90% cache is still 90% full",
  );
});

/* ── Edge cases ─────────────────────────────────────────────────────────── */

test("EDGE: an over-full context budgets zero rather than a negative number", () => {
  resetUsage();
  observeUsage("over", { inputTokens: OBSERVED_FAILURE });
  assert.equal(budgetFor("over"), 0);
  assert.equal(fitsInContext(1, { sessionId: "over" }).ok, false);
});

test("EDGE: a session that has never reported usage is not punished for it", () => {
  resetUsage();
  assert.equal(budgetFor("unseen"), 750_000);
});

test("EDGE: an explicitly configured budget is honoured, not scaled", () => {
  // An operator who pinned WA_TOOL_BYTE_BUDGET has said what they want. Scaling
  // it silently would make the setting a suggestion.
  const original = process.env.WA_TOOL_BYTE_BUDGET;
  process.env.WA_TOOL_BYTE_BUDGET = "1234";
  try {
    resetUsage();
    observeUsage("pinned", { inputTokens: 990_000 });

    // Pinned: the headroom scaling is bypassed entirely, so a nearly-full
    // context gets the operator's figure rather than the 20,000 bytes the
    // curve would have chosen. The value is the import-time constant, because
    // env is read once at module load like every other setting here.
    assert.equal(budgetFor("pinned"), CONTEXT_BYTE_BUDGET);
    assert.ok(budgetBytes({ used: 990_000, window: WINDOW }) < CONTEXT_BYTE_BUDGET,
      "and the scaling it bypassed really would have been tighter");
  } finally {
    if (original === undefined) delete process.env.WA_TOOL_BYTE_BUDGET;
    else process.env.WA_TOOL_BYTE_BUDGET = original;
  }
});

test("EDGE: base64 payloads are measured after inflation, where the model reads them", () => {
  resetUsage();
  observeUsage("b64", { inputTokens: 900_000 });
  const budget = budgetFor("b64");
  // A raw payload just under the budget still overflows once encoded.
  const raw = Math.floor(budget * 0.9);
  assert.equal(fitsInContext(raw, { base64: true, sessionId: "b64" }).ok, false);
  assert.equal(fitsInContext(raw, { base64: false, sessionId: "b64" }).ok, true);
});

test("EDGE: two sessions do not share a budget", () => {
  resetUsage();
  observeUsage("busy", { inputTokens: 990_000 });
  assert.ok(budgetFor("idle") > budgetFor("busy"));
});
