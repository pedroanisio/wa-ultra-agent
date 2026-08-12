/**
 * Saying so when a turn dies.
 *
 * The user types into their own chat and the answer comes back as a self-note,
 * which means the *only* thing that reaches them is a tool call the model makes.
 * When the turn fails before that — the model API refuses, the key is wrong, the
 * balance is empty — nothing is written and the phone stays quiet. They are left
 * looking at a message that was read, understood by nobody, and never answered.
 *
 * Silence is the worst possible failure report, and it is the one this system
 * produces by default. This module composes the line that replaces it: what
 * broke, in the terms of the person holding the phone, plus the one thing they
 * can do about it.
 *
 * It is deliberately pure. The hook that sends it is four lines; everything that
 * can be got wrong — which errors read as what, and how often to repeat
 * yourself — is here, where it can be tested without a bridge or a model.
 */

/** The shape eve's `turn.failed` event carries. */
export interface TurnFailure {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/**
 * How long the same failure stays quiet after being reported once.
 *
 * A dead API key fails every scheduled turn, and a note per failure would bury
 * the chat in minutes — the second copy tells the user nothing the first did
 * not. Half an hour is long enough that a persistent fault reads as one event
 * and short enough that a fault fixed and returned is reported again.
 */
export const REPEAT_SILENCE_MS = 30 * 60 * 1000;

/** What the user is told, and the key that decides whether to tell them again. */
export interface FailureNote {
  readonly body: string;
  readonly signature: string;
}

function detail(details: Record<string, unknown> | undefined, key: string): string {
  const value = details?.[key];
  return typeof value === "string" ? value : "";
}

function statusOf(details: Record<string, unknown> | undefined): number | undefined {
  for (const key of ["upstreamStatusCode", "statusCode"]) {
    const value = details?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Turn a failed turn into one line for a phone.
 *
 * The provider's own words are used where they are already plain — "credit
 * balance is too low" needs no translation — and replaced where they are not.
 * What is never done is hiding the cause behind "something went wrong": the
 * user is the only one who can add credit, fix a key, or wait out a rate limit,
 * and they cannot do any of it from a shrug.
 */
export function explainFailure(failure: TurnFailure): FailureNote {
  const upstream = detail(failure.details, "apiErrorMessage") || detail(failure.details, "upstreamMessage");
  const text = `${upstream} ${failure.message}`.toLowerCase();
  const status = statusOf(failure.details);

  if (text.includes("credit balance") || text.includes("billing")) {
    return {
      signature: "model:credit",
      body:
        "I could not answer that: the model API refused the request because the account is out of " +
        "credit. Nothing I do will work until it is topped up — everything you send meanwhile is " +
        "waiting, not lost.",
    };
  }

  if (status === 401 || status === 403 || text.includes("invalid x-api-key") || text.includes("authentication")) {
    return {
      signature: "model:auth",
      body:
        "I could not answer that: the model API rejected the credentials. ANTHROPIC_API_KEY needs " +
        "checking on the agent — until then I cannot answer anything.",
    };
  }

  if (status === 429 || text.includes("rate limit")) {
    return {
      signature: "model:rate-limit",
      body: "I could not answer that: the model API is rate-limiting me. Try again in a few minutes.",
    };
  }

  if (status === 529 || text.includes("overloaded")) {
    return {
      signature: "model:overloaded",
      body: "I could not answer that: the model API is overloaded right now. Send it again shortly.",
    };
  }

  // Anything unrecognised is reported verbatim rather than smoothed over. A
  // message the user can paste to whoever maintains this beats a tidy sentence
  // that names nothing.
  const raw = (upstream || failure.message || "no reason given").trim().slice(0, 300);
  return {
    signature: `turn:${failure.code || "unknown"}`,
    body: `I could not answer that — the turn failed and nothing was sent. The reason given was: ${raw}`,
  };
}

/**
 * Whether this failure should be reported, given what has been reported before.
 *
 * Mutates `seen` on a yes, because the decision and the record of it are one
 * thing: a caller that could take the answer and forget to write it down is a
 * caller that reports every failure forever.
 */
export function shouldNotify(signature: string, now: number, seen: Map<string, number>): boolean {
  const last = seen.get(signature);
  if (last !== undefined && now - last < REPEAT_SILENCE_MS) return false;
  seen.set(signature, now);
  return true;
}
