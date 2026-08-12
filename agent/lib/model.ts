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
  /**
   * The API surface this model must be reached through.
   *
   * ── Why this is a per-model fact and not a client-wide setting ─────────────
   * `gpt-5.6-luna` rejects function tools on Chat Completions outright:
   *
   *   "Function tools with reasoning_effort are not supported for gpt-5.6-luna
   *    in /v1/chat/completions. To use function tools, use /v1/responses or set
   *    reasoning_effort to 'none'."
   *
   * That is a 400, but the agent never saw one: eve's harness reported it as
   * `empty model response`, reissued once, and ended the turn with no words and
   * no tool call. Every turn that needed a tool died that way — a voice note
   * asked for at 07:29 produced nothing, no error and no warning, while "hello"
   * in the same session answered in 1.9s because it needed no tool.
   *
   * The endpoint therefore belongs beside the window and the effort levels: it
   * is one more thing that changes with the model and that nothing else can
   * infer. `messages` is Anthropic's only surface and is recorded for symmetry,
   * so a reader never has to know which providers have a choice.
   */
  endpoint: "responses" | "chat" | "messages";
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
    // Not a preference. Function tools are rejected on Chat Completions for
    // this model — see `endpoint` above for the provider's own wording.
    endpoint: "responses",
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    // A fifth of Sonnet 5's window. This is the number that mattered.
    contextWindowTokens: 200_000,
    // Errors when sent, rather than ignoring it.
    supportsEffort: false,
    effortLevels: [],
    endpoint: "messages",
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    provider: "anthropic",
    contextWindowTokens: 1_000_000,
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    endpoint: "messages",
  },
  /**
   * The one entry that thinks whether or not it is asked to.
   *
   * Sending no thinking parameter is not "off" here as it is on the models
   * before it: Opus 5 thinks by default, and `max_tokens` is a ceiling on the
   * thinking and the answer together — so a budget sized around the answer
   * alone truncates mid-reply rather than erroring.
   *
   * Turning it off is possible but capped: `thinking: disabled` is refused
   * above `high` effort. The levels below are therefore the levels this model
   * accepts *while thinking*, which is how it is run — see `reasoningFor`.
   */
  "claude-opus-5": {
    id: "claude-opus-5",
    provider: "anthropic",
    contextWindowTokens: 1_000_000,
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    endpoint: "messages",
  },
};

/**
 * What the operator asked for; the table decides whether it is usable.
 *
 * Back to Sonnet 5 after `gpt-5.6-luna` was found to reject function tools on
 * the endpoint it was being called through — an agent whose every tool call
 * returns nothing is not an agent. Luna stays in the table, with the endpoint
 * that works recorded against it, so switching back is a one-line change and
 * not a rediscovery of the same 400.
 */
const CONFIGURED = process.env.WA_MODEL_ID || "claude-sonnet-5";

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

/** Which SDK client a spec must be built with. */
export type ClientChoice = "openai.responses" | "openai.chat" | "anthropic.messages";

/**
 * The client for a spec, as a name rather than an instance.
 *
 * ── Why a name ──────────────────────────────────────────────────────────────
 * Returning the constructed model would make this module import both provider
 * SDKs, and would make the one decision that has already failed in production
 * untestable without network, keys and a live agent. A string is comparable,
 * so the rule "luna must never be reached through Chat Completions" is an
 * assertion rather than a comment. `agent.ts` maps it to the real client.
 */
export function clientFor(spec: ModelSpec = MODEL): ClientChoice {
  if (spec.provider === "anthropic") return "anthropic.messages";
  return spec.endpoint === "responses" ? "openai.responses" : "openai.chat";
}

/**
 * Whether a spec can call tools at all, as configured.
 *
 * The provider's rule, stated in its own error: function tools with a reasoning
 * effort are refused on Chat Completions. An agent that cannot call tools is
 * useless here — every capability this codebase has is a tool — so a spec that
 * fails this is a misconfiguration, not a limitation to work around.
 */
export function canCallTools(spec: ModelSpec = MODEL): boolean {
  if (spec.provider === "anthropic") return true;
  return spec.endpoint === "responses" || !spec.supportsEffort;
}

/**
 * The default effort for a model, or nothing when it accepts none.
 *
 * `medium` rather than the API's `high` default: this agent's turns are mostly
 * one tool call and a short answer, and the levels above medium buy reasoning
 * depth that a chat digest does not use.
 */
const PREFERRED_EFFORT: EffortLevel = "medium";

/**
 * The effort levels that survive the trip to a provider.
 *
 * `defineAgent` takes one provider-agnostic `reasoning` level, and the AI SDK
 * translates it per provider — on Anthropic into adaptive thinking plus an
 * `effort`, on OpenAI into its own reasoning effort. That vocabulary stops at
 * `xhigh`: there is no `max` in it, and a provider that has no `xhigh` is sent
 * `max` in its place. So a model may accept `max` and still not be askable for
 * it from here, which is why this type is narrower than `EffortLevel` rather
 * than the same list written twice.
 */
export type ReasoningLevel = Exclude<EffortLevel, "max">;

const FORWARDABLE: readonly EffortLevel[] = ["low", "medium", "high", "xhigh"];

const isForwardable = (level: EffortLevel): level is ReasoningLevel => FORWARDABLE.includes(level);

/**
 * The reasoning level to run a model at, or nothing when it accepts none.
 *
 * ── Why this is not `{ effort }` ────────────────────────────────────────────
 * This returned a provider options object for one release and nothing ever
 * called it, because there is no call site that takes one: eve reaches the
 * model through `defineAgent`, which accepts a `reasoning` level and nothing
 * else. A shape no caller can accept is not a smaller change than the right
 * shape — it is the same change, made twice, with a silent default in between.
 *
 * Nothing here decides *whether* the model thinks. On Opus 5 it thinks whether
 * or not a level is sent, so an omitted level is the API's `high`, not off.
 */
export function reasoningFor(spec: ModelSpec = MODEL): ReasoningLevel | undefined {
  if (!spec.supportsEffort) return undefined;

  const accepted = spec.effortLevels.filter(isForwardable);
  if (isForwardable(PREFERRED_EFFORT) && accepted.includes(PREFERRED_EFFORT)) {
    return PREFERRED_EFFORT;
  }

  return accepted[0];
}
