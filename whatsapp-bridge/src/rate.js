/**
 * How much this bridge is allowed to touch WhatsApp Web.
 *
 * A token bucket, and it is a safety device rather than a performance one. The
 * account is a real personal one and automating it already violates WhatsApp's
 * terms; what turns that from a risk into a ban is the *pattern* — a backfill
 * that scrolls a decade of history as fast as Chromium can render it looks like
 * nothing a person does.
 *
 * The ceiling lives here, in the bridge, because a cap the agent enforces is a
 * cap a confused agent can talk itself out of. Callers get a 429 and a wait, the
 * same as any rate-limited API, and ingestion is designed to be resumed rather
 * than to run to completion in one go.
 */

const HOUR_MS = 60 * 60 * 1000;

function refuse(message) {
  const error = new Error(message);
  error.statusCode = 429;
  return error;
}

function humanWait(seconds) {
  if (seconds < 90) return `${Math.ceil(seconds)} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

/**
 * @param maxPerHour  Interactions per hour, sustained. Also the burst capacity.
 * @param now         Injected clock, so the refill can be tested without sleeping.
 */
export function createBudget({ maxPerHour = 240, now = Date.now } = {}) {
  let tokens = maxPerHour;
  let last = now();

  const refill = () => {
    const at = now();
    const gained = ((at - last) / HOUR_MS) * maxPerHour;
    if (gained > 0) {
      tokens = Math.min(maxPerHour, tokens + gained);
      last = at;
    }
  };

  return {
    maxPerHour,

    /** Whole tokens available. A fraction of an interaction is not one. */
    remaining() {
      refill();
      return Math.floor(tokens);
    },

    /**
     * Spend `count` interactions, or refuse and spend nothing. Partial success
     * would leave the caller half-way through a scroll it cannot finish.
     */
    take(count = 1) {
      if (count > maxPerHour) {
        throw refuse(
          `A request for ${count} interactions can never be satisfied: the ceiling is ` +
            `${maxPerHour} per hour. Ask for less work per call.`,
        );
      }

      refill();
      if (tokens < count) {
        const shortfall = count - tokens;
        const seconds = (shortfall / maxPerHour) * 3600;
        throw refuse(
          `Interaction budget exhausted: ${Math.floor(tokens)} of ${count} available, ` +
            `${maxPerHour}/hour. Retry in about ${humanWait(seconds)}. This limit protects the ` +
            "account from looking automated; do not work around it.",
        );
      }

      tokens -= count;
      return { spent: count, remaining: Math.floor(tokens) };
    },
  };
}
