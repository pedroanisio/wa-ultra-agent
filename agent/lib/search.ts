/**
 * Asking the web a question, through Brave.
 *
 * ── Why this exists when eve ships a web search ─────────────────────────────
 *
 * eve's built-in `web_search` is provider-managed: it selects an AI Gateway
 * search provider (`exa` or `parallel`), and a model reached through a direct
 * provider — which this agent is; see `lib/model.ts` for which one —
 * falls back to that provider's own server-side search instead. Neither path can
 * be pointed at a Brave subscription. So the key in `.env` needs a tool, and
 * this is it.
 *
 * ── What comes back is not a fact ───────────────────────────────────────────
 *
 * A result is a title, a link and a snippet somebody else wrote. It is evidence
 * that a page says something, never evidence that the something is true, and the
 * snippet is chosen by a ranking system rather than by an editor. This module
 * therefore returns results with their URLs attached and never flattens them
 * into prose: a claim the model repeats without its link has lost the only part
 * of a search result that can be checked.
 */

/** Brave's web search endpoint. */
const ENDPOINT = process.env.WA_SEARCH_URL || "https://api.search.brave.com/res/v1/web/search";

/**
 * The API's own ceiling on one page of results. Asking for more is a 422 rather
 * than a longer list, so the count is clamped here instead of being passed on.
 */
export const MAX_RESULTS = 20;

/** What a sensible default costs in a chat: enough to compare, few enough to read. */
const DEFAULT_RESULTS = 5;

/**
 * Recency, in words rather than in Brave's two-letter codes.
 *
 * The codes are the API's; the words are what a caller means. Translating here
 * keeps `pd` out of a tool schema, where it would be guessed at.
 */
export const FRESHNESS = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
} as const;

export type Freshness = keyof typeof FRESHNESS;

/** Typed, so a caller can tell a missing key from a rate limit. */
export class SearchError extends Error {
  /** `config` | `refused` | `provider` | `decode`. */
  readonly kind: string;

  constructor(message: string, kind: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * The key, under either name it is written under.
 *
 * Two spellings are in circulation — Brave's dashboard calls it a subscription
 * token, most .env files call it one of these — and a key that is present under
 * the other name is indistinguishable from no key at all at the point where it
 * fails, which is an HTTP 401 with nothing to say about configuration.
 */
export function braveKey(env: Record<string, string | undefined> = process.env): string {
  // Trimmed before it is chosen, not after. A variable left as whitespace is a
  // variable that is set as far as `||` is concerned, and it would win over the
  // other spelling and then fail as a 401 about a key nobody set.
  for (const value of [env.BRAVE_API_KEY, env.BRAVE_SEARCH_API_KEY]) {
    const key = (value ?? "").trim();
    if (key) return key;
  }
  return "";
}

/**
 * The request that asks the question.
 *
 * Split out so its shape can be asserted without spending a query: that the
 * count is clamped, that recency is translated, and that the key is in the
 * header where it will not be logged as part of a URL.
 */
export function searchRequest({
  query,
  key,
  count = DEFAULT_RESULTS,
  freshness,
  country = process.env.WA_SEARCH_COUNTRY,
  lang = process.env.WA_SEARCH_LANG,
  offset,
}: {
  query: string;
  key: string;
  count?: number;
  freshness?: Freshness;
  country?: string;
  lang?: string;
  offset?: number;
}) {
  // A count outside the range is clamped rather than sent. `Number.isFinite`
  // rather than `||` because zero is a number a caller can mean and NaN is not:
  // `count || DEFAULT` treats both as unset and quietly returns five results to
  // someone who asked for one.
  const wanted = Number.isFinite(count) ? Math.trunc(count) : DEFAULT_RESULTS;

  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(MAX_RESULTS, Math.max(1, wanted))),
    // Stated rather than inherited. It is Brave's own default, and a provider
    // changing it underneath us would change what this agent shows a user
    // without a line of this repository changing.
    safesearch: "moderate",
  });

  // Each of these is a 422 when sent empty, so an unset option is an absent
  // parameter rather than a blank one.
  if (freshness) params.set("freshness", FRESHNESS[freshness]);
  if (country) params.set("country", country);
  if (lang) params.set("search_lang", lang);
  if (offset) params.set("offset", String(Math.min(9, Math.max(0, Math.trunc(offset)))));

  return {
    url: `${ENDPOINT}?${params}`,
    init: {
      method: "GET",
      headers: {
        // Brave's own header name, capitalised as its documentation writes it.
        "X-Subscription-Token": key,
        Accept: "application/json",
      },
    } satisfies RequestInit,
  };
}

/**
 * What the API actually complained about.
 *
 * Brave nests its message under `error.detail`. Surfacing the envelope instead
 * is how "your subscription token is invalid" reaches the user as a bare 401.
 */
export function apiErrorMessage(status: number, body: string): string {
  try {
    const error = JSON.parse(body)?.error;
    const detail = typeof error === "string" ? error : error?.detail || error?.message;
    if (typeof detail === "string" && detail) return `${status}: ${detail}`;
  } catch {
    // Not JSON — something in front of the API answered. Fall through.
  }
  return `${status}: ${body.slice(0, 200)}`;
}

export interface SearchHit {
  title: string;
  url: string;
  description: string;
  /** Further excerpts from the same page, when they were asked for. */
  extraSnippets?: string[];
}

export interface SearchResults {
  query: string;
  hits: SearchHit[];
  moreAvailable: boolean;
}

/** Only schemes a person can open. A `javascript:` "citation" is not a source. */
const SAFE_SCHEME = /^https?:$/;

/** The named entities worth spelling out; everything else goes through the numeric path. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * A snippet as prose, rather than as a fragment of a results page.
 *
 * Brave marks the query's own terms with `<strong>` and escapes punctuation as
 * entities, because the response is built to be rendered as HTML. Nothing
 * downstream renders HTML: the snippet goes to a model that may quote it into a
 * WhatsApp message, and `Supported through &lt;strong&gt;April 2028` is what
 * that looks like when it arrives on somebody's phone.
 *
 * Tags come off before entities are decoded, never after — decoding first turns
 * an escaped `&lt;script&gt;` written in the page's own text into a tag this
 * function would then strip, quietly deleting words the source published.
 */
export function cleanSnippet(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      const key = name.toLowerCase();
      if (ENTITIES[key]) return ENTITIES[key];
      if (key.startsWith("#x")) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
      // An entity this code does not know is left exactly as it was written. It
      // is somebody's text, and guessing at it is worse than showing it.
      return whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ⚠ ARCHITECTURAL CONTRACT (PALS's LAW) — LLM OUTPUT IS UNVERIFIED BY DEFAULT
 *
 * LLMs statistically produce errors: omissions, hallucinations,
 * partial completions, schema violations, and silent failures.
 * These are properties of the model class, not exceptional conditions.
 *
 * Any caller of this function that skips output validation is
 * introducing an architectural omission — not a code bug downstream.
 *
 * Verification is mandatory. Treat all LLM output as untrusted input.
 *
 * ── Applied here, where the untrusted input is not the model's ──────────────
 *
 * The same rule runs in the other direction. This response is written by a
 * search engine indexing pages written by anyone, and the model downstream will
 * read every snippet as though it were part of the conversation. So a result
 * without an openable link is dropped rather than shown — a snippet the user
 * cannot check is a claim with a citation-shaped decoration on it — and a
 * response whose shape is not the documented one raises instead of parsing to
 * an empty list, because "nothing was found" and "this integration is broken"
 * are opposite facts and only one of them is about the web.
 */
export function parseResults(response: unknown): SearchResults {
  const body = response as { query?: { original?: string; more_results_available?: boolean }; web?: { results?: unknown } };
  const results = body?.web?.results;

  if (!Array.isArray(results)) {
    throw new SearchError(
      "Brave did not answer in the shape this agent understands — there is no `web.results` in the " +
        "response. This is an integration problem, not an empty search.",
      "decode",
    );
  }

  const hits: SearchHit[] = [];
  for (const entry of results as Array<Record<string, unknown>>) {
    const href = typeof entry?.url === "string" ? entry.url : "";
    if (!href) continue;

    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (!SAFE_SCHEME.test(url.protocol)) continue;

    const extraSnippets = Array.isArray(entry.extra_snippets)
      ? entry.extra_snippets
          .filter((snippet): snippet is string => typeof snippet === "string")
          .map(cleanSnippet)
      : undefined;

    hits.push({
      title: typeof entry.title === "string" ? cleanSnippet(entry.title) : url.hostname,
      // Parsed to validate the scheme, but reported EXACTLY as it was given.
      // `new URL(x).toString()` normalises — it appends a root slash, re-encodes
      // the path — and a citation the user pastes somewhere should be the string
      // the source published, not this code's rendering of it.
      url: href,
      description: typeof entry.description === "string" ? cleanSnippet(entry.description) : "",
      ...(extraSnippets?.length ? { extraSnippets } : {}),
    });
  }

  return {
    query: body?.query?.original ?? "",
    hits,
    moreAvailable: body?.query?.more_results_available === true,
  };
}

/** Transient by nature: worth another go. Anything else is an answer. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface SearchDeps {
  fetch?: typeof globalThis.fetch;
  key?: string;
  /** Backoff between retries. Zero in tests so they do not sleep. */
  retryDelayMs?: number;
}

/** Overridable defaults, for tests. Empty in normal use. */
export const searchDeps: SearchDeps = {};

export interface SearchInput {
  query: string;
  count?: number;
  freshness?: Freshness;
  country?: string;
  lang?: string;
  offset?: number;
}

/**
 * Ask the question. Returns the results, with their links.
 *
 * See the contract on {@link parseResults}: what comes back is verified as a
 * response, never as a set of facts.
 */
export async function search(input: SearchInput, deps: SearchDeps = {}): Promise<SearchResults> {
  const fetchImpl = deps.fetch ?? searchDeps.fetch ?? globalThis.fetch;
  const key = deps.key ?? searchDeps.key ?? braveKey();
  const delayMs = deps.retryDelayMs ?? searchDeps.retryDelayMs ?? 1000;

  const query = (input.query ?? "").trim();
  if (!query) throw new SearchError("There is nothing to search for: the query is empty.", "config");
  if (!key) {
    throw new SearchError(
      "BRAVE_API_KEY is not set on the agent, so the web cannot be searched. This is configuration, " +
        "not a network problem.",
      "config",
    );
  }

  const request = searchRequest({ ...input, query, key });

  let last = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetchImpl(request.url, request.init);

    if (response.ok) {
      const parsed = parseResults(await response.json().catch(() => null));
      // Brave echoes the query it interpreted; when it does not, the one that
      // was asked is still the honest label for the results.
      return { ...parsed, query: parsed.query || query };
    }

    last = apiErrorMessage(response.status, await response.text().catch(() => ""));

    // A 401 is the key and a 422 is the request. Retrying either turns a clear
    // error into a slow one — and every attempt is billed against the quota.
    if (!RETRYABLE.has(response.status) || attempt === 3) {
      throw new SearchError(
        `The search failed (${last})`,
        response.status === 401 || response.status === 403
          ? "config"
          : response.status < 500
            ? "refused"
            : "provider",
      );
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
  }

  throw new SearchError(`The search failed (${last})`, "provider");
}
