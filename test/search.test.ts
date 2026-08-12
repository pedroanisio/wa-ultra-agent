import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FRESHNESS,
  MAX_RESULTS,
  apiErrorMessage,
  braveKey,
  parseResults,
  search,
  searchRequest,
} from "../agent/lib/search.ts";

/**
 * Asking the web a question.
 *
 * The two things held down here are the request and the READING of the answer.
 * Brave's response is JSON from outside this system: a shape change, an empty
 * `web` object and a result with no URL are all things it can return with a 200,
 * and each of them becomes either a crash or a confidently-cited hallucination
 * if the parse assumes the documented shape is the one that arrived.
 *
 * The network is injected, so none of this costs a query against the quota.
 */

/** One well-formed answer, in the shape the API documents. */
function braveReply(results: unknown[] = [{ title: "Node 24", url: "https://nodejs.org", description: "LTS" }]) {
  return { query: { original: "node lts", more_results_available: true }, web: { results } };
}

function fakeBrave(payload: unknown = braveReply(), status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/* ── the request ───────────────────────────────────────────────────── */

test("the key travels in Brave's own header, never in the query string", () => {
  const request = searchRequest({ query: "node lts", key: "brave-secret" });
  const headers = request.init.headers as Record<string, string>;

  assert.match(request.url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
  assert.equal(headers["X-Subscription-Token"], "brave-secret");
  assert.equal(headers.Accept, "application/json");
  assert.equal(request.init.method, "GET");
  assert.ok(!request.url.includes("brave-secret"), "a key in a URL ends up in logs");
});

test("the query is encoded rather than concatenated", () => {
  const url = new URL(searchRequest({ query: "c++ & rust?", key: "k" }).url);

  assert.equal(url.searchParams.get("q"), "c++ & rust?");
});

test("the count is clamped to what the API accepts, not passed through", () => {
  const asked = (count: number) =>
    Number(new URL(searchRequest({ query: "x", key: "k", count }).url).searchParams.get("count"));

  assert.equal(asked(999), MAX_RESULTS);
  assert.equal(asked(0), 1);
  assert.equal(asked(5), 5);
});

test("freshness is named in plain words and sent in Brave's spelling", () => {
  const sent = (freshness: keyof typeof FRESHNESS) =>
    new URL(searchRequest({ query: "x", key: "k", freshness }).url).searchParams.get("freshness");

  assert.equal(sent("day"), "pd");
  assert.equal(sent("week"), "pw");
  assert.equal(sent("month"), "pm");
  assert.equal(sent("year"), "py");
  // Omitted entirely when not asked for: an empty `freshness` is a 422.
  assert.equal(new URL(searchRequest({ query: "x", key: "k" }).url).searchParams.get("freshness"), null);
});

/* ── the key ───────────────────────────────────────────────────────── */

test("both spellings of the key are read, and blank is the same as absent", () => {
  assert.equal(braveKey({ BRAVE_API_KEY: "one" }), "one");
  assert.equal(braveKey({ BRAVE_SEARCH_API_KEY: "two" }), "two");
  assert.equal(braveKey({ BRAVE_API_KEY: "   ", BRAVE_SEARCH_API_KEY: "two" }), "two");
  assert.equal(braveKey({}), "");
});

/* ── reading the answer ────────────────────────────────────────────── */

test("results are read out with the fields the API documents", () => {
  const parsed = parseResults(
    braveReply([
      { title: "Node 24", url: "https://nodejs.org", description: "LTS release", extra_snippets: ["more"] },
    ]),
  );

  assert.equal(parsed.hits.length, 1);
  assert.deepEqual(parsed.hits[0], {
    title: "Node 24",
    url: "https://nodejs.org",
    description: "LTS release",
    extraSnippets: ["more"],
  });
  assert.equal(parsed.moreAvailable, true);
});

test("a result with no URL is dropped, because a citation without a link is not one", () => {
  const parsed = parseResults(
    braveReply([
      { title: "Real", url: "https://example.test", description: "d" },
      { title: "No link", description: "d" },
      { title: "Not http", url: "javascript:alert(1)", description: "d" },
    ]),
  );

  assert.deepEqual(parsed.hits.map((hit) => hit.url), ["https://example.test/"]);
});

test("a search that found nothing is not the same as a response that made no sense", () => {
  assert.deepEqual(parseResults(braveReply([])).hits, []);
  // `web` missing entirely is a shape this code does not understand, and saying
  // "no results" for it reports a broken integration as a fact about the web.
  assert.throws(() => parseResults({ query: { original: "x" } }), /did not answer/i);
  assert.throws(() => parseResults(null), /did not answer/i);
});

/* ── the call ──────────────────────────────────────────────────────── */

test("a search returns what was found, with the query it was answered for", async () => {
  const fake = fakeBrave();
  const found = await search({ query: "node lts" }, { fetch: fake.fetchImpl, key: "k", retryDelayMs: 0 });

  assert.equal(found.hits.length, 1);
  assert.equal(found.query, "node lts");
  assert.equal(fake.calls.length, 1);
});

test("with no key nothing is attempted, and the missing variable is named", async () => {
  const fake = fakeBrave();

  await assert.rejects(
    search({ query: "x" }, { fetch: fake.fetchImpl, key: "", retryDelayMs: 0 }),
    /BRAVE_API_KEY/,
  );
  assert.equal(fake.calls.length, 0);
});

test("an empty query is refused before it is billed", async () => {
  const fake = fakeBrave();

  await assert.rejects(search({ query: "  " }, { fetch: fake.fetchImpl, key: "k", retryDelayMs: 0 }), /empty/i);
  assert.equal(fake.calls.length, 0);
});

test("a rate limit is retried; a rejected key is not", async () => {
  let attempts = 0;
  const throttled = (async () => {
    attempts += 1;
    if (attempts < 2) return new Response("{}", { status: 429 });
    return new Response(JSON.stringify(braveReply()), { status: 200 });
  }) as typeof fetch;

  const found = await search({ query: "x" }, { fetch: throttled, key: "k", retryDelayMs: 0 });
  assert.equal(attempts, 2);
  assert.equal(found.hits.length, 1);

  const refused = fakeBrave({ error: { detail: "subscription token invalid" } }, 401);
  await assert.rejects(
    search({ query: "x" }, { fetch: refused.fetchImpl, key: "bad", retryDelayMs: 0 }),
    /subscription token invalid/,
  );
  assert.equal(refused.calls.length, 1);
});

test("the API's own complaint survives, rather than the envelope around it", () => {
  assert.match(apiErrorMessage(422, JSON.stringify({ error: { detail: "bad freshness" } })), /bad freshness/);
  assert.match(apiErrorMessage(500, "<html>nope</html>"), /500/);
});
