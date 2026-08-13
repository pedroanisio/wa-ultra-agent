import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";

import { agentGuards } from "./lib/context-budget.ts";
import { MODEL, clientFor, reasoningFor } from "./lib/model.ts";

/**
 * The client for whichever provider serves the configured model.
 *
 * Both read their key from the environment — OPENAI_API_KEY or
 * ANTHROPIC_API_KEY — so switching provider is a registry entry and a key, not
 * a code change here.
 */
// Explicit, never the default export's choice: `openai(id)` resolves to Chat
// Completions, where this provider's newer models reject function tools
// outright. A tool-less agent is not a degraded agent, it is a silent one —
// see `endpoint` and `clientFor` in lib/model.ts.
const CLIENTS = {
  "openai.responses": () => openai.responses(MODEL.id),
  "openai.chat": () => openai.chat(MODEL.id),
  "anthropic.messages": () => anthropic(MODEL.id),
} as const;

const model = CLIENTS[clientFor(MODEL)]();

export default defineAgent({
  // Direct provider model, reaching the provider named by the registry.
  //
  // ── The id is not the only thing that changes with the model ────────────────
  //
  // A model's context window and its parameter support change with it, and the
  // guards elsewhere are fractions of that window. So the id comes from
  // `lib/model.ts`, where those facts are declared together — swapping the model
  // here alone once moved the window from 1M to 200K and left every guard
  // sized for the old one.
  model,

  // How hard it thinks, from the same table as the id.
  //
  // ── Why a level and not a thinking switch ───────────────────────────────────
  //
  // Thinking stays on. `reasoning` is the one knob eve forwards, and each
  // provider translates it — Anthropic into adaptive thinking plus that effort,
  // OpenAI into its own. There is no level here that means "off"; on Opus 5
  // leaving it unset is not off either, only the API's `high` chosen by nobody.
  //
  // The level is `medium` because the table says so, not because this line
  // does. A number restated next to its use is the same defect the model id
  // above is written to avoid.
  reasoning: reasoningFor(),

  // When older messages get summarised to make room.
  //
  // ── Why this is declared rather than inherited ──────────────────────────────
  //
  // eve's default is 0.9 of the window, and it is evaluated against
  // `lastKnownInputTokens` — the size of the PREVIOUS request. That makes it a
  // rear-view mirror: a step that adds more than the gap between the last
  // reading and the ceiling jumps straight over it. A turn died at 1,570,042
  // tokens against a 1,000,000 window that way, 670,042 past a threshold that
  // never saw it coming.
  //
  // Compacting earlier does not fix the reactivity, but it widens the margin the
  // reactive check has to be wrong by. The research on context rot argues the
  // same number from the other side: answers degrade long before the window is
  // full, so 0.9 was only ever a rule about not crashing.
  compaction: agentGuards().compaction,

  // The outer fuse. eve's inherited default is 40,000,000 input tokens per
  // session — forty windows — which does not bound anything a runaway loop
  // would do before someone noticed the bill.
  limits: agentGuards().limits,
});
