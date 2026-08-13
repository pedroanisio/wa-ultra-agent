/**
 * How much of a finite context window one step may spend, decided from how much
 * of it is already gone.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * A turn died with `prompt is too long: 1570042 tokens > 1000000 maximum`. That
 * is 157% of the window and 670,042 tokens PAST the threshold where compaction
 * was supposed to fire. A prompt does not drift that far past a guard. It
 * arrives there in one step, and two defects let it.
 *
 * The first was that the ceiling on one tool result was a fraction of the WHOLE
 * window, computed once at import. 187,500 tokens is a modest ask of an empty
 * context and a fatal one at 850K, and a constant cannot tell those apart. The
 * budget here is a FUNCTION of what is left, so the same result is admitted
 * early in a conversation and refused late in one — which is the correct
 * behaviour, because the same result really is affordable early and ruinous
 * late.
 *
 * The second was that compaction was evaluated against `lastKnownInputTokens` —
 * the size of the PREVIOUS request. Nothing measured the step that actually
 * crossed the line, so the check was a rear-view mirror. `shouldCompactBefore`
 * is the forward-looking one: it is given what is pending and answers before
 * the request is built.
 *
 * ── Why all of it is pure ───────────────────────────────────────────────────
 *
 * A guard against context overflow has to be checkable without the context it
 * guards. Everything below is arithmetic over numbers, so the case that broke
 * production is a unit test rather than a story about a model.
 */

import { MODEL } from "./model.ts";

/** Roughly four characters per token, for English and for base64 alike. */
const CHARS_PER_TOKEN = 4;

/** What base64 does to a payload: three bytes become four characters. */
const BASE64_INFLATION = 4 / 3;

/**
 * The ceiling on one result as a fraction of the WHOLE window.
 *
 * This is the cap that binds when the context is nearly empty, and it is
 * deliberately unchanged from the constant it replaces: a result may never
 * claim more than a quarter of the window, however much room there appears to
 * be. Raising it would loosen a safety constant to make a curve look tidier.
 */
export const ABSOLUTE_SHARE = 0.25;

/**
 * The ceiling on one result as a fraction of what is LEFT.
 *
 * Half, not all of it. A result that takes every remaining token leaves nothing
 * for the model's own reply, so the request fits and the turn still fails —
 * which is the same outcome by a longer route.
 */
export const HEADROOM_SHARE = 0.5;

/**
 * Where the pre-flight decides to compact, as a fraction of the window.
 *
 * Below eve's own 0.9 on purpose. eve's threshold is reactive — it reads the
 * previous request — so acting only where eve acts means acting exactly one
 * step too late. Compacting earlier costs a summary; compacting later costs the
 * turn.
 *
 * `WA_COMPACT_AT` tunes it. Lower is safer and loses detail sooner; the
 * research on context rot argues the quality threshold is far below the
 * survival one, so a deployment that values answers over transcript may want
 * 0.6 here.
 */
export const COMPACT_AT = Number(process.env.WA_COMPACT_AT) || 0.75;

/**
 * How many windows one session may spend before eve stops it.
 *
 * eve's inherited default is 40,000,000 tokens, which against a 1M window is
 * forty windows — not a backstop, a rounding error. Eight is enough for a
 * genuinely long working session, including several compactions, and small
 * enough to stop a loop that has started paying for the same context over and
 * over.
 *
 * Expressed as a multiple of the window rather than a number, because a number
 * written beside its use is the defect this repository keeps re-learning: it
 * survives the model swap that invalidates it.
 */
export const SESSION_WINDOW_MULTIPLE = Number(process.env.WA_SESSION_WINDOW_MULTIPLE) || 8;

/** The absolute ceiling on one session's input tokens. */
export const MAX_INPUT_TOKENS_PER_SESSION =
  MODEL.contextWindowTokens * SESSION_WINDOW_MULTIPLE;

/**
 * The guards `agent.ts` declares, in one place that can be tested.
 *
 * `agent.ts` is declarative and imports a model client, so asserting against it
 * directly would mean constructing a provider in a unit test. These are the same
 * values, exported from where the window they derive from is already known.
 */
export function agentGuards(): {
  compaction: { thresholdPercent: number };
  limits: { maxInputTokensPerSession: number };
} {
  return {
    compaction: { thresholdPercent: COMPACT_AT },
    limits: { maxInputTokensPerSession: MAX_INPUT_TOKENS_PER_SESSION },
  };
}

/** What is left of the window, floored at zero. */
export function remainingTokens(used: number, window: number): number {
  // Never negative. An over-full context is the state this module exists to
  // handle, and a negative remainder would invert every comparison downstream
  // and admit everything at the exact moment nothing should be admitted.
  return Math.max(0, window - used);
}

/**
 * The ceiling on one tool result, in characters the model would read.
 *
 * Returns bytes-of-text, not tokens, because every caller is measuring a
 * payload. Divide by four for the token figure.
 */
export function budgetBytes({ used, window }: { used: number; window: number }): number {
  const remaining = remainingTokens(used, window);
  const tokens = Math.min(window * ABSOLUTE_SHARE, remaining * HEADROOM_SHARE);
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

/** What the prompt would measure with `bytes` more in it. */
export function projectedTokens(
  used: number,
  bytes: number,
  { base64 = false }: { base64?: boolean } = {},
): number {
  const characters = base64 ? bytes * BASE64_INFLATION : bytes;
  return used + Math.ceil(characters / CHARS_PER_TOKEN);
}

/** The pre-flight verdict: dispatch, or compact first. */
export interface CompactionVerdict {
  readonly compact: boolean;
  readonly projected: number;
  readonly threshold: number;
  readonly reason: string;
}

/**
 * Would this step cross the line? Asked BEFORE the request is built.
 *
 * The whole point is the word "before". `used + pendingTokens` is the number
 * the API will see, and it is knowable here, where the reactive check could
 * only ever know `used`.
 */
export function shouldCompactBefore({
  used,
  pendingTokens,
  window,
  threshold = COMPACT_AT,
}: {
  used: number;
  pendingTokens: number;
  window: number;
  threshold?: number;
}): CompactionVerdict {
  const projected = used + pendingTokens;
  const limit = Math.floor(window * threshold);
  const compact = projected > limit;
  const n = (value: number) => value.toLocaleString("en-US");

  return {
    compact,
    projected,
    threshold: limit,
    reason: compact
      ? `This step would put the prompt at ${n(projected)} tokens, past the ${n(limit)} where ` +
        `older messages are summarised to make room. Compacting first.`
      : `${n(projected)} tokens projected, under the ${n(limit)} threshold.`,
  };
}

/** The usage numbers eve reports on `step.completed`. */
export interface StepUsage {
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/**
 * How much of the window one model call actually occupied.
 *
 * Cached tokens count. Prompt caching changes what is BILLED, not what is SENT:
 * a cache read is prompt the model still had to be given, and counting only
 * `inputTokens` on a cache-heavy agent reports a conversation at a fraction of
 * its real size — which is exactly the failure this module exists to prevent.
 * Output is excluded because it is not context until the next call carries it
 * back as input, where it is counted.
 */
export function usedTokens(usage: StepUsage | undefined): number {
  if (!usage) return 0;
  const parts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
  return parts.reduce<number>(
    (total, part) => total + (typeof part === "number" && part > 0 ? part : 0),
    0,
  );
}

/**
 * The highest reading seen per session.
 *
 * ── Why the highest and not the latest ──────────────────────────────────────
 * eve reports usage per step, and the step after a compaction reports a much
 * smaller prompt. Taking the latest would restore the full, too-large budget at
 * precisely the moment the conversation is most fragile — so the reading only
 * goes up, and only `resetUsage` brings it down. Compaction is the one event
 * entitled to do that, because there the prompt really did shrink.
 */
const ledger = new Map<string, number>();

/** Record a step's usage against its session. Keeps the highest. */
export function observeUsage(sessionId: string, usage: StepUsage | undefined): number {
  const used = usedTokens(usage);
  const previous = ledger.get(sessionId) ?? 0;
  const highest = Math.max(previous, used);
  ledger.set(sessionId, highest);
  return highest;
}

/**
 * What this session's prompt last measured, or 0 when nothing has reported.
 *
 * Zero is deliberately permissive. Failing closed on a missing observation
 * would refuse the first tool call of every session, which is the one moment
 * the context is provably empty.
 */
export function readUsage(sessionId: string): number {
  return ledger.get(sessionId) ?? 0;
}

/** Forget one session's reading, or all of them. */
export function resetUsage(sessionId?: string): void {
  if (sessionId === undefined) ledger.clear();
  else ledger.delete(sessionId);
}
