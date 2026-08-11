import { defineEvalConfig } from "eve/evals";

/**
 * These evals drive a real agent session, so they need the bridge running and a
 * linked WhatsApp account. They are the acceptance gate for behaviour that unit
 * tests cannot reach: whether the agent *chooses* the right tool, and whether it
 * tells the truth about what it does not know.
 *
 * The deterministic half of the system — classification, addressing, identity,
 * the store, the extraction normaliser — is covered by `npm test`, which needs
 * neither a model nor a browser.
 */
export default defineEvalConfig({
  judge: { model: "anthropic/claude-sonnet-5" },
  timeoutMs: 120_000,
});
