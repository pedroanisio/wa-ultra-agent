/**
 * Turning a query string into archive filters, in exactly one place.
 *
 * This module exists because of a specific bug rather than a design instinct.
 * The search filters were named three times — parsed in `server.js`, forwarded
 * by hand in `whatsapp.js`, implemented in `store.js` — and the middle copy
 * listed only `chat` and `limit`. So `sender`, `since`, `until`, `kind`,
 * `outgoing` and `order` were accepted by the HTTP layer, dropped on the floor,
 * and never reached the SQL that implements them.
 *
 * The failure had no symptom. A narrowed search returned an unnarrowed result,
 * which looks exactly like an answer: "what did Helena say about the trip in
 * June" came back with every mention of the trip, and nothing anywhere said the
 * date had been ignored. Every filter was individually tested at the store, and
 * every test passed.
 *
 * So the fix is not another forwarding list to keep in sync. Parsing happens
 * here, the resulting object is passed through whole, and `store.search`
 * destructures it. There is no hand-copied field list left to fall out of date.
 */

/** Filters `store.search` understands, and nothing else, so a stray query parameter cannot become one. */
export const SEARCH_FILTERS = ["chat", "sender", "since", "until", "kind", "order"];

/**
 * `URLSearchParams` → the object `searchArchive` takes.
 *
 * Absent parameters come back `undefined` rather than `null` or `""`, because
 * `store.search` tests each filter for truthiness and an empty string would
 * read as "filter by the empty chat name".
 */
export function parseSearchParams(params) {
  const text = (name) => params.get(name) || undefined;

  // `outgoing` is the one filter with a meaningful `false`: unset means "either
  // direction", false means "only messages from other people". Coercing the two
  // together would make "what did I promise" unanswerable.
  const outgoing = params.get("outgoing");

  const limit = Number(params.get("limit"));

  const query = { query: text("q") };
  for (const filter of SEARCH_FILTERS) query[filter] = text(filter);

  return {
    ...query,
    outgoing: outgoing === null ? undefined : outgoing === "true",
    // 0 is not a useful limit and NaN is a typo; both fall back to the store's default.
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  };
}
