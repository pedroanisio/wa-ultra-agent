import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";

import { MODEL } from "./lib/model.ts";

/**
 * The client for whichever provider serves the configured model.
 *
 * Both read their key from the environment — OPENAI_API_KEY or
 * ANTHROPIC_API_KEY — so switching provider is a registry entry and a key, not
 * a code change here.
 */
const model = MODEL.provider === "openai" ? openai(MODEL.id) : anthropic(MODEL.id);

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
});
