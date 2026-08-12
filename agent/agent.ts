import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";

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
});
