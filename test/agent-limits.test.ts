import { test } from "node:test";
import assert from "node:assert/strict";

import { COMPACT_AT, MAX_INPUT_TOKENS_PER_SESSION, agentGuards } from "../agent/lib/context-budget.ts";
import { MODEL } from "../agent/lib/model.ts";

/**
 * The two settings that decide when eve acts, rather than when we notice.
 *
 * ── Why these are asserted at all ───────────────────────────────────────────
 *
 * `agent.ts` is declarative, so nothing fails when a guard is simply absent —
 * and absent is exactly what these were. eve's compaction default is 0.9 of the
 * window, evaluated against the PREVIOUS request's size, and its session ceiling
 * default is 40,000,000 tokens. Both were inherited rather than chosen, and the
 * turn that died at 1,570,042 tokens died under both of them.
 *
 * A default that was never decided looks identical to a decision, which is why
 * these are pinned here: changing them should require changing a test that says
 * what the number is for.
 */

test("compaction is asked for BELOW eve's own default, not at it", () => {
  // eve compacts at 0.9 reactively — it reads `lastKnownInputTokens`, the size
  // of the request before this one. Acting only where eve acts is acting one
  // step too late, every time.
  assert.ok(COMPACT_AT < 0.9, `expected below eve's 0.9 default, got ${COMPACT_AT}`);
  assert.ok(COMPACT_AT > 0.4, "compacting under 40% would summarise away most conversations");
});

test("the agent declares its compaction threshold rather than inheriting one", () => {
  assert.equal(agentGuards().compaction.thresholdPercent, COMPACT_AT);
});

test("the session ceiling is a real limit, not eve's 40,000,000 default", () => {
  // 40M against a 1M window is not a backstop, it is a rounding error: a session
  // may spend forty windows before anything objects.
  assert.ok(
    MAX_INPUT_TOKENS_PER_SESSION < 40_000_000,
    "must be tighter than the inherited default",
  );
  assert.equal(agentGuards().limits.maxInputTokensPerSession, MAX_INPUT_TOKENS_PER_SESSION);
});

test("the ceiling still allows a genuinely long session", () => {
  // A guard that trips during ordinary use gets raised until it never trips,
  // which is the same as not having one. Several full windows is the target.
  assert.ok(MAX_INPUT_TOKENS_PER_SESSION >= MODEL.contextWindowTokens * 4);
});

test("both guards are derived from the model's window, never restated", () => {
  // The defect this repository keeps re-learning: a number copied next to its
  // use survives the model swap that invalidates it.
  const guards = agentGuards();
  assert.equal(
    guards.limits.maxInputTokensPerSession % MODEL.contextWindowTokens,
    0,
    "the ceiling should be a multiple of the window, so a model swap moves it",
  );
});
