import { test } from "node:test";
import assert from "node:assert/strict";

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import { MODELS, type ModelSpec, clientFor } from "../agent/lib/model.ts";

/**
 * Proof that each registry entry can actually call a tool, against the real
 * provider, through the client this codebase would build for it.
 *
 * ── Why this is opt-in ──────────────────────────────────────────────────────
 * It needs the network and two funded keys, and it bills a few tokens per
 * model. A gate that cannot run on every commit is not a gate, so the rules
 * live in `model-endpoint.test.ts`, offline and deterministic, and this file
 * exists to answer the question those rules cannot: whether the PROVIDERS still
 * behave the way the registry claims.
 *
 * That question is not academic. The registry's claim about `gpt-5.6-luna` came
 * from a provider error message, and provider error messages change. Run this
 * when adding a model, changing an endpoint, or when tool calls go quiet:
 *
 *     WA_LIVE_MODEL_TEST=1 node --test test/provider-tools.live.test.ts
 *
 * ── What "works" means here ─────────────────────────────────────────────────
 * The model must either call the tool or answer in words. What must NOT happen
 * is the failure this was written for: no text, no tool call, no error — the
 * shape a refused request arrives in once the harness has swallowed it.
 */

const LIVE = process.env.WA_LIVE_MODEL_TEST === "1";

const KEYS: Record<ModelSpec["provider"], string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/** Deliberately trivial, and deliberately the shape the real tools have. */
const clock = tool({
  description: "Return the current time in a named city.",
  inputSchema: z.object({ city: z.string().describe("The city to read the clock in") }),
  execute: async ({ city }) => ({ city, time: "07:29" }),
});

function clientOf(spec: ModelSpec) {
  switch (clientFor(spec)) {
    case "openai.responses":
      return openai.responses(spec.id);
    case "openai.chat":
      return openai.chat(spec.id);
    case "anthropic.messages":
      return anthropic(spec.id);
  }
}

for (const [name, spec] of Object.entries(MODELS)) {
  test(`${name} (${spec.provider}) can call a tool through ${clientFor(spec)}`, async (t) => {
    if (!LIVE) return t.skip("set WA_LIVE_MODEL_TEST=1 to run against real providers");
    if (!process.env[KEYS[spec.provider]]) return t.skip(`${KEYS[spec.provider]} is not set`);

    const result = await generateText({
      model: clientOf(spec),
      prompt: "What time is it in Lisbon? Use the clock tool.",
      tools: { clock },
      stopWhen: stepCountIs(3),
    });

    const calls = result.steps.flatMap((step) => step.toolCalls ?? []);
    const said = (result.text ?? "").trim();

    assert.ok(
      calls.length > 0 || said.length > 0,
      `${name} returned no text and no tool call — this is exactly the silence the ` +
        `endpoint rule exists to prevent`,
    );
    assert.ok(
      calls.some((call) => call.toolName === "clock"),
      `${name} never called the tool it was asked to use`,
    );
  });
}

/**
 * The negative control: luna on Chat Completions must still be refused.
 *
 * If this ever passes, the provider has changed its rule and `canCallTools` is
 * now stricter than reality — which is a registry change, not a silent win.
 */
test("gpt-5.6-luna still refuses function tools on chat completions", async (t) => {
  if (!LIVE) return t.skip("set WA_LIVE_MODEL_TEST=1 to run against real providers");
  if (!process.env.OPENAI_API_KEY) return t.skip("OPENAI_API_KEY is not set");

  await assert.rejects(
    () =>
      generateText({
        model: openai.chat("gpt-5.6-luna"),
        prompt: "What time is it in Lisbon? Use the clock tool.",
        tools: { clock },
      }),
    /reasoning_effort|not supported|responses/i,
    "the provider used to reject this outright; if it no longer does, revisit the registry",
  );
});
