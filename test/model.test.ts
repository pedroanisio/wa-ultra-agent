import { test } from "node:test";
import assert from "node:assert/strict";

import { MODEL, MODELS, reasoningFor } from "../agent/lib/model.ts";
import { CONTEXT_WINDOW_TOKENS } from "../agent/lib/tool-output.ts";

/**
 * The model, and the facts that have to travel with it.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Changing one string in `agent.ts` moved the context window from 1M to 200K,
 * and every guard sized against the old window kept its old number — a byte
 * budget that had been a fraction of the window silently became the whole of
 * it. The model's limits are not incidental to the model; they change with it,
 * so they are declared with it and everything derives from here.
 */

test("the configured model is one this codebase knows the limits of", () => {
  assert.ok(MODELS[MODEL.id], `${MODEL.id} has no entry — add its limits before using it`);
});

test("model ids are aliases, never alias-plus-date", () => {
  // `claude-haiku-4-5-20251001` is a real id but the alias is what should be
  // pinned; a date appended to an alias is a 404, and the two forms look alike.
  for (const id of Object.keys(MODELS)) {
    assert.doesNotMatch(id, /-\d{8}$/, `${id} looks like an alias with a date suffix`);
  }
});

test("every model declares a context window", () => {
  for (const [id, spec] of Object.entries(MODELS)) {
    assert.ok(spec.contextWindowTokens > 0, `${id} must declare a context window`);
  }
});

test("Haiku's window is recorded as smaller than Sonnet's", () => {
  // The specific fact that broke the guards. If these ever compare equal, the
  // table has been filled in carelessly.
  assert.ok(
    MODELS["claude-haiku-4-5"].contextWindowTokens < MODELS["claude-sonnet-5"].contextWindowTokens,
  );
});

/* ── effort ────────────────────────────────────────────────────────── */

test("effort is not sent to a model that rejects it", () => {
  // Haiku 4.5 errors on `effort`. Nothing sets it today, which is exactly when
  // a guard is cheap to add and expensive to retrofit.
  assert.equal(MODELS["claude-haiku-4-5"].supportsEffort, false);
  assert.equal(reasoningFor(MODELS["claude-haiku-4-5"]), undefined);
});

test("effort is sent to a model that supports it", () => {
  assert.ok(
    reasoningFor(MODELS["claude-sonnet-5"]),
    "a model that supports effort should be given one",
  );
});

test("the effort level asked for is one the model actually accepts", () => {
  for (const spec of Object.values(MODELS)) {
    const level = reasoningFor(spec);
    if (!level) continue;
    assert.ok(
      spec.effortLevels.includes(level),
      `${spec.id} was asked for effort "${level}", which it does not accept`,
    );
  }
});

test("the level asked for is one eve can actually forward", () => {
  // `max` is a level the models accept and the framework has no word for: its
  // vocabulary ends at `xhigh`, and a provider without `xhigh` is sent `max` in
  // its place. Asking for it would be silently answered with something else.
  for (const spec of Object.values(MODELS)) {
    const level = reasoningFor(spec);
    if (!level) continue;
    assert.notEqual(level, "max", `${spec.id} was asked for a level eve cannot express`);
  }
});

/* ── the guards must follow the model ──────────────────────────────── */

test("the context budget is derived from the configured model, not a constant", () => {
  // The regression: a window hard-coded next to the guard rather than read from
  // the model drifts the moment the model changes, and drifts silently.
  assert.equal(CONTEXT_WINDOW_TOKENS, MODEL.contextWindowTokens);
});

/* ── a second provider ─────────────────────────────────────────────────
 *
 * The registry existed for one provider and one model. Adding OpenAI is the
 * first real test of whether "the limits travel with the model" survives the
 * model coming from somewhere else entirely — the provider is now one more
 * fact that changes with the id, and picking the wrong client for a model is
 * a 404 that looks like a bad model name.
 * ------------------------------------------------------------------ */

test("the configured model names its provider", () => {
  assert.ok(["anthropic", "openai"].includes(MODEL.provider), `unknown provider ${MODEL.provider}`);
});

test("every model in the table declares a provider", () => {
  for (const [id, spec] of Object.entries(MODELS)) {
    assert.ok(spec.provider, `${id} must say which provider serves it`);
  }
});

test("gpt-5.6-luna is known, with the window it actually has", () => {
  const luna = MODELS["gpt-5.6-luna"];
  assert.ok(luna, "the model being switched to must be in the table");
  assert.equal(luna.provider, "openai");
  // 922K usable input, not the 1,050,000 total that counts output too — the
  // guards budget INPUT, so the input ceiling is the honest number.
  assert.equal(luna.contextWindowTokens, 922_000);
});

test("luna accepts effort, so effort is sent to it", () => {
  // The opposite of Haiku, which errors on it. The registry has to carry the
  // difference or one of the two gets the wrong request.
  const luna = MODELS["gpt-5.6-luna"];
  assert.equal(luna.supportsEffort, true);
  assert.ok(luna.effortLevels.includes("medium"));
  assert.ok(reasoningFor(luna));
});

/* ── Opus 5 ────────────────────────────────────────────────────────────
 *
 * The first entry that thinks without being asked. Every model before it
 * treated an absent thinking parameter as off, so "send nothing" was a way of
 * saying no; here it is a way of saying `high` and meaning it.
 * ------------------------------------------------------------------ */

test("Opus 5 is known, with the window it actually has", () => {
  const opus = MODELS["claude-opus-5"];
  assert.ok(opus, "the model must be in the table before it can be configured");
  assert.equal(opus.provider, "anthropic");
  assert.equal(opus.contextWindowTokens, 1_000_000);
  assert.equal(opus.endpoint, "messages");
});

test("Opus 5 is asked to think at a level it accepts", () => {
  const opus = MODELS["claude-opus-5"];
  const level = reasoningFor(opus);
  assert.ok(level, "a model that thinks by default should be told how hard, not left at high");
  assert.ok(opus.effortLevels.includes(level));
});

test("switching provider moves the context guards with it", () => {
  // Haiku's 200K and luna's 922K are a 4.6× difference. A guard that stayed at
  // the Haiku number would refuse attachments the new model could easily hold;
  // one that stayed at Sonnet's would let a turn overflow. Neither is a number
  // anyone should have to remember to change.
  assert.equal(CONTEXT_WINDOW_TOKENS, MODEL.contextWindowTokens);
});
