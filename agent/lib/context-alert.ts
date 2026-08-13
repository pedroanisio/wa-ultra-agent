/**
 * Warning the user before the conversation runs out of room.
 *
 * The `/eve` console is one continuation address, so a conversation there is
 * not a turn — it is a session that keeps growing for as long as the user keeps
 * typing. When it approaches the model's context window, eve compacts it:
 * older messages are replaced by a summary, and detail the user believed the
 * agent still had is gone. Compaction is the right behaviour and it is also
 * invisible, which is the problem — the conversation quietly stops remembering
 * and nothing says when that happened.
 *
 * This is the notice. It fires *before* eve's own threshold, so the choice —
 * carry on and let it summarise, or `/quit` and start clean — is still the
 * user's to make.
 *
 * Pure, so the bands and the arithmetic can be tested without a model.
 */

import { type StepUsage, observeUsage, usedTokens } from "./context-budget.ts";
import { MODEL } from "./model.ts";

import { CONTEXT_WINDOW_TOKENS } from "./tool-output.ts";


/**
 * Where eve compacts, as a fraction of the window.
 *
 * eve's own default: `thresholdPercent ?? .9` in its compaction config. It is
 * stated here so the alert can say what happens next; if the agent overrides
 * `compaction.thresholdPercent`, this line has to follow it.
 */
export const COMPACTION_FRACTION = 0.9;

/**
 * The window the tokens are measured against.
 *
 * Imported, never restated. `lib/tool-output.ts` derives it from `lib/model.ts`,
 * where the id and its window are declared together — a swap from Sonnet 5 to
 * Haiku 4.5 moved this from 1,000,000 to 200,000, and a percentage measured
 * against a stale copy of that number is a warning that arrives at the wrong
 * time while looking exactly as confident as one that does not.
 */
export { CONTEXT_WINDOW_TOKENS } from "./tool-output.ts";

/**
 * The fractions that get a notice, each once per session.
 *
 * One warning is not enough for a conversation that keeps climbing: the user
 * who ignores 80% deserves to hear about 95%, and a band that has already
 * spoken never speaks again.
 */
export const ALERT_BANDS = [0.8, 0.9, 0.95] as const;

/**
 * The usage numbers eve reports on `step.completed`, and how to total them.
 *
 * Both now live in `context-budget.ts`, because the same figure that decides
 * whether to WARN the user also decides what a tool may SPEND. Two copies of
 * this arithmetic would drift, and the half that drifted would be the half that
 * silently stopped protecting anything.
 */
export type { StepUsage } from "./context-budget.ts";
export { usedTokens } from "./context-budget.ts";

/** The highest band this usage has reached, or undefined below them all. */
export function bandReached(fraction: number): number | undefined {
  let reached: number | undefined;
  for (const band of ALERT_BANDS) if (fraction >= band) reached = band;
  return reached;
}

function short(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** One line for a phone: where the conversation is, and what happens next. */
export function composeAlert(used: number, window: number): string {
  const percent = Math.round((used / window) * 100);
  const size = `${short(used)} of ${short(window)} tokens`;

  if (used / window >= COMPACTION_FRACTION) {
    return (
      `This conversation is at ${percent}% of the context window (${size}) — past the point where ` +
      "older messages get summarised to make room, so detail from earlier may already be gone. " +
      "`/quit` starts a clean one."
    );
  }

  return (
    `This conversation is at ${percent}% of the context window (${size}). At ` +
    `${Math.round(COMPACTION_FRACTION * 100)}% the older messages are summarised to make room and ` +
    "some detail is lost. `/quit` starts a clean one if you would rather not reach that."
  );
}

/** What a session has already been warned about. */
export type AlertLedger = Map<string, number>;

/**
 * Decide whether this step earns a notice, and record it if so.
 *
 * The ledger holds the highest band already reported for a session, so each
 * band speaks once and a session that keeps growing is warned again as it
 * climbs. Deciding and recording are one act on purpose: a caller that could
 * take the answer and forget to write it down would warn on every model call.
 */
export function assessStep(input: {
  readonly sessionId: string;
  readonly usage: StepUsage | undefined;
  readonly window?: number;
  readonly ledger: AlertLedger;
}): { readonly alert: string; readonly used: number; readonly fraction: number } | undefined {
  const window = input.window ?? CONTEXT_WINDOW_TOKENS;
  const used = usedTokens(input.usage);

  // Record before deciding. The tool budget reads this ledger, so a step that
  // does not earn a NOTICE must still tighten what the next tool may spend —
  // the alert is advice, the ledger is the guard, and only one of them may be
  // skipped when nothing needs saying.
  if (used > 0) observeUsage(input.sessionId, input.usage);

  if (used <= 0 || window <= 0) return undefined;

  const fraction = used / window;
  const band = bandReached(fraction);
  if (band === undefined) return undefined;

  const reported = input.ledger.get(input.sessionId);
  if (reported !== undefined && reported >= band) return undefined;

  input.ledger.set(input.sessionId, band);
  return { alert: composeAlert(used, window), used, fraction };
}
