/**
 * How much of the model's context one tool result may spend.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * A turn failed with `prompt is too long: 1123860 tokens > 1000000 maximum`.
 * The user had asked for a voice note; the model never reached the point of
 * choosing a tool, so the symptom was "voice notes are broken" and the cause was
 * a payload nobody had measured.
 *
 * The window is a shared, finite resource that every tool draws on silently. A
 * 3 MB attachment — perfectly ordinary for a phone photo — base64-encodes to
 * about 4 MB of text, which is more than the entire window on its own. Nothing
 * refused it, because nothing was counting.
 *
 * ── Why a byte budget rather than a token count ─────────────────────────────
 *
 * Tokenising here would mean shipping a tokeniser to answer a question that only
 * needs an order of magnitude: is this payload a paragraph or a photograph? Four
 * characters per token is close enough to separate those two, and being
 * approximately right before the request is worth incomparably more than being
 * exactly right after it fails.
 */

import { budgetBytes, readUsage } from "./context-budget.ts";
import { MODEL } from "./model.ts";

/** Roughly four characters per token, for English and for base64 alike. */
const CHARS_PER_TOKEN = 4;

/** What base64 does to a payload: three bytes become four characters. */
const BASE64_INFLATION = 4 / 3;

/**
 * The model's context window, in tokens — read from the model, never restated.
 *
 * Every limit below is a FRACTION of this, so the number has to change when the
 * model does. It used to be a constant sitting beside the budget; a model swap
 * moved the real window from 1M to 200K and left the constant behind, which is
 * how a guard against context overflow becomes a cause of it.
 */
export const CONTEXT_WINDOW_TOKENS =
  Number(process.env.WA_CONTEXT_WINDOW_TOKENS) || MODEL.contextWindowTokens;

/**
 * How much of the window one tool result may claim.
 *
 * Deliberately a small fraction rather than most of it. A tool result is never
 * the only thing in a turn — there is the conversation, the system prompt, the
 * other tools' output and the model's own reasoning — so a single result that
 * fills the window has already broken the turn even when it technically fits.
 */
const BUDGET_SHARE = 0.25;

/**
 * The ceiling on ONE tool result, in bytes BEFORE encoding, for an EMPTY context.
 *
 * The share is applied to the encoded size and divided back out, so a quarter of
 * the window means a quarter of the window in the thing the model actually
 * reads — not a quarter of the file, which base64 would inflate past a third.
 *
 * ── This is now the ceiling, not the budget ─────────────────────────────────
 *
 * It used to be both, and that is what let a prompt reach 1,570,042 tokens
 * against a 1,000,000 window: a constant computed once from the window cannot
 * tell an empty context from a nearly-full one, so the same 187,500-token
 * result was admitted in both. `budgetFor` is the live figure; this remains the
 * cap that binds when the conversation has barely started.
 */
export const CONTEXT_BYTE_BUDGET =
  Number(process.env.WA_TOOL_BYTE_BUDGET) ||
  Math.floor((CONTEXT_WINDOW_TOKENS * BUDGET_SHARE * CHARS_PER_TOKEN) / BASE64_INFLATION);

/**
 * What this session may spend on one tool result, right now.
 *
 * An explicitly configured `WA_TOOL_BYTE_BUDGET` wins outright: an operator who
 * has pinned a number has said what they want, and silently scaling it would
 * make the setting a suggestion.
 */
export function budgetFor(sessionId?: string): number {
  if (Number(process.env.WA_TOOL_BYTE_BUDGET)) return CONTEXT_BYTE_BUDGET;
  const used = sessionId === undefined ? 0 : readUsage(sessionId);

  // Capped by the old constant, never merely replaced by the new arithmetic.
  //
  // The two do not measure quite the same thing: CONTEXT_BYTE_BUDGET divides by
  // the base64 inflation AND is compared against an already-inflated size, so it
  // has always been about a third stricter than the "quarter of the window" its
  // comment describes. Taking the headroom figure alone would therefore RAISE
  // the empty-context ceiling from 750 KB to 1 MB — a loosening, introduced by a
  // change whose entire purpose is to tighten. Taking the minimum keeps every
  // payload that was refused before refused now, and refuses more as the
  // conversation fills.
  return Math.min(CONTEXT_BYTE_BUDGET, budgetBytes({ used, window: CONTEXT_WINDOW_TOKENS }));
}

/** Bytes as something a person reads in an error message. */
export function describeSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** A rough token count for a payload of `bytes`, encoded or not. */
export function approximateTokens(bytes: number, { base64 = false } = {}): number {
  const characters = base64 ? bytes * BASE64_INFLATION : bytes;
  return Math.ceil(characters / CHARS_PER_TOKEN);
}

/**
 * Whether this payload may be put in front of the model.
 *
 * Returns a verdict rather than throwing, because every caller here is a tool
 * and a tool's job is to report a refusal the model can act on — "that photo is
 * 4.2 MB, ask for something smaller" is useful; an exception is not.
 */
export function fitsInContext(
  bytes: number,
  {
    base64 = false,
    what = "payload",
    sessionId,
    budget,
  }: { base64?: boolean; what?: string; sessionId?: string; budget?: number } = {},
): { ok: boolean; reason?: string; tokens: number } {
  // An explicit budget wins; otherwise the live one, which shrinks as the
  // conversation fills. Passing a session is what turns this from a fixed
  // ceiling into a guard that knows how much room is actually left.
  const limit = budget ?? budgetFor(sessionId);
  const effective = base64 ? Math.ceil(bytes * BASE64_INFLATION) : bytes;
  const tokens = approximateTokens(bytes, { base64 });

  if (effective <= limit) return { ok: true, tokens };

  // A refusal that happens only because the conversation is long is a different
  // fact from one that would happen in any conversation, and the model can act
  // on the difference — the first is "start a clean chat", the second is "ask
  // for something smaller".
  const crowded = limit < CONTEXT_BYTE_BUDGET;

  return {
    ok: false,
    tokens,
    reason:
      `That ${what} is ${describeSize(bytes)}${base64 ? ` (${describeSize(effective)} once encoded)` : ""}, ` +
      `and the limit for one tool result is ${describeSize(limit)} — roughly ` +
      `${tokens.toLocaleString("en-US")} tokens, which would spend most of the context this ` +
      "conversation is running in." +
      (crowded
        ? " That limit is lower than usual because this conversation has already used most of " +
          "its context; a fresh conversation would have room for it."
        : ""),
  };
}
