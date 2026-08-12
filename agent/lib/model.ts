/**
 * Which model this agent runs on, and the facts that travel with it.
 *
 * ── Why the limits live beside the id ───────────────────────────────────────
 *
 * Changing one string — `claude-sonnet-5` to `claude-haiku-4-5` — moved the
 * context window from 1,000,000 tokens to 200,000. Every guard sized against
 * the old window kept its old number, so a per-tool byte budget that had been a
 * fraction of the window silently became the whole of it. Nothing failed at the
 * moment of the change; it would have failed later, as a 400 with no attribution.
 *
 * A model's context window and its parameter support are not incidental to the
 * model — they change with it. So they are declared here, together, and every
 * limit elsewhere derives from this table rather than restating a number.
 *
 * ── What belongs in this table ──────────────────────────────────────────────
 *
 * Only facts that change behaviour or bounds: the window, whether the model
 * accepts `effort`, and which levels it accepts. Pricing and capability prose
 * belong in the vendor's documentation, which stays current in a way a table
 * here cannot.
 */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Who serves the model.
 *
 * One more fact that changes with the id, and the one with the least forgiving
 * failure: asking the wrong client for a model is a 404 that reads as a typo in
 * the model name rather than as the wrong provider.
 */
export type Provider = "anthropic" | "openai";

export interface ModelSpec {
  /** The alias, never the alias plus a date — a date on an alias is a 404. */
  id: string;
  /** Which client to reach it with. */
  provider: Provider;
  /** The whole window, in tokens. Every context guard is a fraction of this. */
  contextWindowTokens: number;
  /**
   * Whether `effort` may be sent at all.
   *
   * Haiku 4.5 and Sonnet 4.5 reject it outright rather than ignoring it, so
   * this is a hard gate and not a preference.
   */
  supportsEffort: boolean;
  /** The levels this model accepts. Empty when it accepts none. */
  effortLevels: EffortLevel[];
}

/**
 * The models this codebase knows enough about to run on.
 *
 * A model absent from here is not forbidden — it is unmeasured, which is worse:
 * the guards would fall back to whatever default was written for a different
 * window. `MODEL` below fails loudly rather than guessing.
 */
export const MODELS: Record<string, ModelSpec> = {
  /**
   * The default, and the reason the provider dimension exists.
   *
   * A fifth of Haiku 4.5's input price ($0.20 vs $1.00 per MTok) on a workload
   * whose cost is almost entirely re-sent input — an agentic loop resends the
   * conversation every turn, so output price barely participates.
   *
   * The window is the *input* ceiling, 922,000, not the 1,050,000 total that
   * counts output alongside it. The guards elsewhere budget input, so the input
   * number is the honest one to derive them from.
   */
  "gpt-5.6-luna": {
    id: "gpt-5.6-luna",
    provider: "openai",
    contextWindowTokens: 922_000,
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    // A fifth of Sonnet 5's window. This is the number that mattered.
    contextWindowTokens: 200_000,
    // Errors when sent, rather than ignoring it.
    supportsEffort: false,
    effortLevels: [],
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    provider: "anthropic",
    contextWindowTokens: 1_000_000,
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  "claude-opus-5": {
    id: "claude-opus-5",
    provider: "anthropic",
    contextWindowTokens: 1_000_000,
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
};

/** What the operator asked for; the table decides whether it is usable. */
const CONFIGURED = process.env.WA_MODEL_ID || "gpt-5.6-luna";

/**
 * The model in force.
 *
 * An unknown id throws at import time — at boot, with a list of what is known —
 * rather than at the first request with a number nobody derived.
 */
export const MODEL: ModelSpec = (() => {
  const spec = MODELS[CONFIGURED];
  if (spec) return spec;

  throw new Error(
    `WA_MODEL_ID is "${CONFIGURED}", which this codebase has no limits for. ` +
      `Add it to agent/lib/model.ts with its context window and effort support, or use one of: ` +
      `${Object.keys(MODELS).join(", ")}. The limits are not optional — the context guards are ` +
      "fractions of the window, and a model without one has no guards.",
  );
})();

/**
 * The default effort for a model, or nothing when it accepts none.
 *
 * `medium` rather than the API's `high` default: this agent's turns are mostly
 * one tool call and a short answer, and the levels above medium buy reasoning
 * depth that a chat digest does not use.
 */
const PREFERRED_EFFORT: EffortLevel = "medium";

/**
 * The provider options to send with a request on this model.
 *
 * Returns an object rather than a value so that adding a second model-gated
 * parameter later does not change every call site — and so the "send nothing"
 * case is the natural shape rather than a special one.
 */
export function requestOptionsFor(spec: ModelSpec = MODEL): { effort?: EffortLevel } {
  if (!spec.supportsEffort) return {};

  const effort = spec.effortLevels.includes(PREFERRED_EFFORT)
    ? PREFERRED_EFFORT
    : spec.effortLevels[0];

  return effort ? { effort } : {};
}
