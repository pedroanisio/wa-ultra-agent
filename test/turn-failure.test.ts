import { test } from "node:test";
import assert from "node:assert/strict";

import { REPEAT_SILENCE_MS, explainFailure, shouldNotify } from "../agent/lib/turn-failure.ts";

/**
 * The failure the user actually experienced: three messages typed into their own
 * chat, and no answer to any of them, because the model API had refused every
 * turn for want of credit. Nothing was broken enough to notice — the agent was
 * up, the bridge was healthy, the messages were delivered and read.
 *
 * So what is tested here is that each cause produces a line a person can act on,
 * and that a fault which repeats for hours reports once.
 */

const CREDIT = {
  code: "model_error",
  message: "AI_APICallError",
  details: {
    statusCode: 400,
    upstreamStatusCode: 400,
    apiErrorMessage:
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
};

test("an empty balance says so, and says nothing will work until it is fixed", () => {
  const note = explainFailure(CREDIT);

  assert.equal(note.signature, "model:credit");
  assert.match(note.body, /out of credit/i);
  assert.match(note.body, /waiting, not lost/i);
});

test("a rejected key names the variable, not 'an error occurred'", () => {
  const note = explainFailure({
    code: "model_error",
    message: "AI_APICallError",
    details: { statusCode: 401, apiErrorMessage: "invalid x-api-key" },
  });

  assert.equal(note.signature, "model:auth");
  assert.match(note.body, /ANTHROPIC_API_KEY/);
});

test("a rate limit is transient and the line says to retry", () => {
  const note = explainFailure({
    code: "model_error",
    message: "rate limit exceeded",
    details: { statusCode: 429 },
  });

  assert.equal(note.signature, "model:rate-limit");
  assert.match(note.body, /again in a few minutes/i);
});

test("an overloaded API is not confused with a broken one", () => {
  const note = explainFailure({ code: "model_error", message: "Overloaded", details: { statusCode: 529 } });

  assert.equal(note.signature, "model:overloaded");
});

test("an unrecognised failure is quoted verbatim rather than smoothed away", () => {
  const note = explainFailure({
    code: "tool_error",
    message: "ECONNREFUSED talking to the bridge",
    details: {},
  });

  assert.equal(note.signature, "turn:tool_error");
  assert.match(note.body, /ECONNREFUSED talking to the bridge/);
});

test("a reason longer than a phone screen is cut, not sent whole", () => {
  const note = explainFailure({ code: "x", message: "y".repeat(5000), details: {} });

  assert.ok(note.body.length < 400, `note was ${note.body.length} chars`);
});

test("the same fault reports once, not once per failed turn", () => {
  const seen = new Map<string, number>();
  const t = 1_000_000;

  assert.equal(shouldNotify("model:credit", t, seen), true);
  assert.equal(shouldNotify("model:credit", t + 1_000, seen), false);
  assert.equal(shouldNotify("model:credit", t + REPEAT_SILENCE_MS - 1, seen), false);
});

test("...and reports again once the silence has run out", () => {
  const seen = new Map<string, number>();
  const t = 1_000_000;

  shouldNotify("model:credit", t, seen);

  assert.equal(shouldNotify("model:credit", t + REPEAT_SILENCE_MS, seen), true);
});

test("a different fault is not silenced by the first one", () => {
  const seen = new Map<string, number>();
  const t = 1_000_000;

  shouldNotify("model:credit", t, seen);

  assert.equal(shouldNotify("model:rate-limit", t + 1_000, seen), true);
});
