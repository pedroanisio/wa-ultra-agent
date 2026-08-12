import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALERT_BANDS,
  COMPACTION_FRACTION,
  CONTEXT_WINDOW_TOKENS,
  type AlertLedger,
  assessStep,
  composeAlert,
  usedTokens,
} from "../agent/lib/context-alert.ts";
import { MODEL } from "../agent/lib/model.ts";

/**
 * The `/eve` console is one long-lived session, so its context grows until eve
 * compacts it — silently, replacing older messages with a summary. What is
 * tested here is that the user hears about it first, hears about it once per
 * band, and that the number they are told is the real one: cached tokens are
 * context the model was given, and counting only `inputTokens` on a
 * cache-heavy agent under-reports a full conversation as an empty one.
 */

const WINDOW = 1_000_000;

test("cached prompt is context: every input class counts toward the window", () => {
  const used = usedTokens({ inputTokens: 12_000, cacheReadTokens: 780_000, cacheWriteTokens: 8_000 });

  assert.equal(used, 800_000);
});

test("output tokens are not context — they are counted when they come back as input", () => {
  assert.equal(usedTokens({ inputTokens: 1_000, outputTokens: 4_000 }), 1_000);
});

test("missing or empty usage measures nothing rather than guessing", () => {
  assert.equal(usedTokens(undefined), 0);
  assert.equal(usedTokens({}), 0);
});

test("the first notice comes at 80%, before eve compacts at 90%", () => {
  const ledger: AlertLedger = new Map();

  const quiet = assessStep({ sessionId: "s", usage: { inputTokens: 799_000 }, window: WINDOW, ledger });
  assert.equal(quiet, undefined, "79.9% is not yet worth a message");

  const alert = assessStep({ sessionId: "s", usage: { inputTokens: 801_000 }, window: WINDOW, ledger });
  assert.ok(alert, "80% is");
  assert.match(alert.alert, /80% of the context window/);
  assert.match(alert.alert, /801k of 1.0M tokens/);
  assert.ok(COMPACTION_FRACTION > ALERT_BANDS[0], "the first band must precede compaction");
});

test("a band speaks once, however many model calls follow it", () => {
  const ledger: AlertLedger = new Map();

  assert.ok(assessStep({ sessionId: "s", usage: { inputTokens: 820_000 }, window: WINDOW, ledger }));
  assert.equal(assessStep({ sessionId: "s", usage: { inputTokens: 830_000 }, window: WINDOW, ledger }), undefined);
  assert.equal(assessStep({ sessionId: "s", usage: { inputTokens: 899_000 }, window: WINDOW, ledger }), undefined);
});

test("...and a conversation that keeps climbing is warned again", () => {
  const ledger: AlertLedger = new Map();

  assessStep({ sessionId: "s", usage: { inputTokens: 820_000 }, window: WINDOW, ledger });

  const ninety = assessStep({ sessionId: "s", usage: { inputTokens: 910_000 }, window: WINDOW, ledger });
  assert.ok(ninety);
  assert.match(ninety.alert, /may already be gone/, "past compaction, the wording changes");

  assert.ok(assessStep({ sessionId: "s", usage: { inputTokens: 960_000 }, window: WINDOW, ledger }));
});

test("one session's warning does not silence another's", () => {
  const ledger: AlertLedger = new Map();

  assert.ok(assessStep({ sessionId: "console", usage: { inputTokens: 820_000 }, window: WINDOW, ledger }));
  assert.ok(assessStep({ sessionId: "schedule", usage: { inputTokens: 820_000 }, window: WINDOW, ledger }));
});

test("a jump straight past two bands reports the one it landed in, not both", () => {
  const ledger: AlertLedger = new Map();

  const first = assessStep({ sessionId: "s", usage: { inputTokens: 940_000 }, window: WINDOW, ledger });
  assert.ok(first);
  assert.equal(ledger.get("s"), 0.9);

  assert.ok(assessStep({ sessionId: "s", usage: { inputTokens: 951_000 }, window: WINDOW, ledger }));
});

test("the notice says what happens next, not just how full it is", () => {
  assert.match(composeAlert(800_000, WINDOW), /summarised to make room/);
  assert.match(composeAlert(800_000, WINDOW), /`\/quit` starts a clean one/);
});

test("the window is the RUNNING model's, not a copy of it", () => {
  // The bug this forecloses: a model swap moved the real window from 1M to
  // 200K, and every percentage measured against a private constant would have
  // kept reporting a full conversation as a fifth full — confidently.
  assert.equal(
    CONTEXT_WINDOW_TOKENS,
    Number(process.env.WA_CONTEXT_WINDOW_TOKENS) || MODEL.contextWindowTokens,
    "the alert must measure against lib/model.ts, via tool-output.ts",
  );
});

test("the band is a fraction of that window, whatever it happens to be", () => {
  const ledger: AlertLedger = new Map();
  const justOver = Math.ceil(CONTEXT_WINDOW_TOKENS * 0.81);

  const alert = assessStep({ sessionId: "s", usage: { inputTokens: justOver }, ledger });

  assert.ok(alert, "81% of the live window must alert with no window passed in");
  assert.equal(Math.round(alert.fraction * 100), 81);
});

test("a smaller window moves the alert with it", () => {
  const ledger: AlertLedger = new Map();

  const alert = assessStep({ sessionId: "s", usage: { inputTokens: 170_000 }, window: 200_000, ledger });

  assert.ok(alert);
  assert.match(alert.alert, /85% of the context window/);
  assert.match(alert.alert, /170k of 200k tokens/);
});
