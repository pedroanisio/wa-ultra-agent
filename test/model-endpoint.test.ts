import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODEL,
  MODELS,
  type ModelSpec,
  canCallTools,
  clientFor,
} from "../agent/lib/model.ts";

/**
 * Which API surface each model is reached through, for both providers.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 * The agent went silent for every request that needed a tool. "hello" answered
 * in 1.9s; "Send me a good morning voice note" ended `silent in 2.6s steps=0
 * tools=none`, with no error anywhere — not in the chat, not in the turn log,
 * not in the container output beyond one line reading `empty model response`.
 *
 * It was not empty. The provider had answered, in full sentences:
 *
 *   "Function tools with reasoning_effort are not supported for gpt-5.6-luna in
 *    /v1/chat/completions. To use function tools, use /v1/responses or set
 *    reasoning_effort to 'none'."
 *
 * `agent.ts` built the model with `openai(id)`, which resolves to Chat
 * Completions. Every tool call in the system — which is to say every capability
 * in the system — was being refused, and the refusal was being reported to the
 * user as nothing at all.
 *
 * ── What these tests hold ───────────────────────────────────────────────────
 * They are deterministic and offline on purpose: they assert the RULE, so a
 * model added to the registry without an endpoint, or wired to the endpoint
 * that cannot serve it, fails here rather than in somebody's chat. The live
 * counterpart — proof that the providers still behave this way — is
 * `provider-tools.live.test.ts`, which is opt-in because a test that needs the
 * network and a funded key cannot be a gate on every commit.
 */

const entries = Object.entries(MODELS);

test("every model in the registry declares an endpoint", () => {
  for (const [name, spec] of entries) {
    assert.ok(
      spec.endpoint,
      `${name} has no endpoint: the client cannot be chosen without one`,
    );
  }
});

test("the endpoint is one the model's own provider actually serves", () => {
  const legal: Record<ModelSpec["provider"], ReadonlyArray<ModelSpec["endpoint"]>> = {
    openai: ["responses", "chat"],
    anthropic: ["messages"],
  };

  for (const [name, spec] of entries) {
    assert.ok(
      legal[spec.provider].includes(spec.endpoint),
      `${name} is an ${spec.provider} model declaring "${spec.endpoint}"`,
    );
  }
});

/**
 * The regression itself, stated as a rule rather than as one model's name.
 *
 * An OpenAI model that accepts a reasoning effort cannot use function tools on
 * Chat Completions. Since every model here is sent an effort when it takes one
 * (`requestOptionsFor`), such a model MUST be reached through Responses.
 */
test("an OpenAI model with reasoning effort is reached through Responses", () => {
  for (const [name, spec] of entries) {
    if (spec.provider !== "openai" || !spec.supportsEffort) continue;
    assert.equal(
      spec.endpoint,
      "responses",
      `${name} takes a reasoning effort, so Chat Completions would refuse every tool call`,
    );
  }
});

test("gpt-5.6-luna specifically is never wired to chat completions", () => {
  const luna = MODELS["gpt-5.6-luna"];
  assert.ok(luna, "luna must stay in the registry: removing it loses why it broke");
  assert.equal(clientFor(luna), "openai.responses");
  assert.notEqual(clientFor(luna), "openai.chat");
});

test("every Anthropic model resolves to the messages client", () => {
  for (const [name, spec] of entries) {
    if (spec.provider !== "anthropic") continue;
    assert.equal(clientFor(spec), "anthropic.messages", `${name} must use the Anthropic client`);
  }
});

test("every model in the registry can call tools as configured", () => {
  for (const [name, spec] of entries) {
    assert.ok(
      canCallTools(spec),
      `${name} cannot call tools as configured, which makes every capability here unreachable`,
    );
  }
});

test("the configured model can call tools", () => {
  assert.ok(
    canCallTools(MODEL),
    `the running configuration (${MODEL.id}) cannot call tools`,
  );
});

/**
 * The bug, reconstructed.
 *
 * A spec identical to luna but pointed at Chat Completions must be rejected by
 * `canCallTools` — otherwise the rule is not being enforced, only described.
 */
test("luna on chat completions is recognised as unable to call tools", () => {
  const broken: ModelSpec = { ...MODELS["gpt-5.6-luna"], endpoint: "chat" };
  assert.equal(canCallTools(broken), false);
  assert.equal(clientFor(broken), "openai.chat");
});

/** An OpenAI model that sends no effort is fine on either surface. */
test("an OpenAI model without reasoning effort may use chat completions", () => {
  const plain: ModelSpec = {
    id: "gpt-legacy-test",
    provider: "openai",
    contextWindowTokens: 128_000,
    supportsEffort: false,
    effortLevels: [],
    endpoint: "chat",
  };
  assert.equal(canCallTools(plain), true);
  assert.equal(clientFor(plain), "openai.chat");
});
