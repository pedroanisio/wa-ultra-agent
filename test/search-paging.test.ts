import { test } from "node:test";
import assert from "node:assert/strict";

process.env.WA_BRIDGE_URL ??= "http://bridge.test";
process.env.WA_BRIDGE_TOKEN ??= "test-token";

const { default: searchArchive } = await import("../agent/tools/whatsapp_search_archive.ts");
const { default: searchPage } = await import("../agent/tools/whatsapp_search_page.ts");
const { resetResultSets } = await import("../agent/lib/result-set.ts");
const { resetUsage, observeUsage } = await import("../agent/lib/context-budget.ts");

/**
 * The search tool's contract once it can no longer dump everything it found.
 *
 * ── What must remain true ───────────────────────────────────────────────────
 *
 * The tool's own description forbids reporting an absence it cannot prove. That
 * rule now has a second edge: having stopped showing every hit, the tool must
 * never let a partial answer look complete. So the assertions below are less
 * about paging mechanics than about what the MODEL is told — `truncated`, the
 * real total, and a handle — because those three are what stop ten of ninety
 * matches being summarised as "what was said".
 */

const ctx = { abortSignal: undefined, session: { id: "test-session" } } as never;

function stubBridge(hits: unknown[], stats = { messages: 5_000, chats: 40 }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/archive/stats") {
      return new Response(JSON.stringify(stats), { status: 200 });
    }
    return new Response(JSON.stringify({ hits }), { status: 200 });
  }) as typeof fetch;
  return () => void (globalThis.fetch = original);
}

/**
 * A realistically LARGE hit.
 *
 * Sized deliberately: 200 rows of a couple of hundred bytes really do fit in a
 * nearly-full window (~15K tokens), and a test built on those would assert that
 * the guard fires when it correctly should not. The step that overflowed
 * production was ~770K tokens, which is this shape — long messages, many of
 * them — so the fixture has to be long messages, many of them.
 */
const hit = (i: number) => ({
  key: `k${i}`,
  chat: "Someone",
  sender: "Someone",
  sent_at: "2026-08-01T10:00:00Z",
  text: `a long message about the thing, number ${i}. `.repeat(50),
  snippet: `a long message about [the thing], number ${i}`,
});

test("a small result set is returned whole, with no handle to chase", async () => {
  resetResultSets();
  resetUsage();
  const restore = stubBridge([hit(1), hit(2), hit(3)]);
  try {
    const out = (await searchArchive.execute({ query: "thing", order: "relevance", limit: 50 }, ctx)) as never;
    assert.equal((out as { ok: boolean }).ok, true);
    assert.equal((out as { truncated: boolean }).truncated, false);
    assert.equal((out as { hits: unknown[] }).hits.length, 3);
    assert.equal((out as { resultSetId?: string }).resultSetId, undefined);
  } finally {
    restore();
  }
});

test("THE REGRESSION: a large result set is capped, and the model is TOLD it was", async () => {
  // 200 long hits into an already-crowded conversation: the shape of the step
  // that carried a prompt to 1,570,042 tokens.
  resetResultSets();
  resetUsage();
  observeUsage("test-session", { inputTokens: 900_000 }); // a nearly-full conversation
  const restore = stubBridge(Array.from({ length: 200 }, (_, i) => hit(i)));
  try {
    const out = (await searchArchive.execute({ query: "thing", order: "relevance", limit: 200 }, ctx)) as {
      hits: unknown[];
      retrieved: number;
      remaining: number;
      truncated: boolean;
      resultSetId?: string;
    };

    assert.ok(out.hits.length < 200, "must not return all 200 into a nearly-full context");
    assert.equal(out.truncated, true);
    assert.equal(out.retrieved, 200, "the real total, not the shown count");
    assert.ok(out.remaining > 0);
    assert.ok(out.resultSetId, "a truncated answer must hand over a way to read the rest");
  } finally {
    restore();
  }
});

test("the model-facing text states the truncation in words, not just in fields", async () => {
  resetResultSets();
  resetUsage();
  observeUsage("test-session", { inputTokens: 900_000 });
  const restore = stubBridge(Array.from({ length: 200 }, (_, i) => hit(i)));
  try {
    const out = (await searchArchive.execute({ query: "thing", order: "relevance", limit: 200 }, ctx)) as never;
    const text = (searchArchive.toModelOutput!(out) as { value: string }).value;

    assert.match(text, /200/, "must name the true total");
    assert.match(text, /whatsapp_search_page/, "must name the tool that reads the rest");
    assert.match(
      text,
      /not the whole|only the first|more match/i,
      "must say in prose that this is a partial view",
    );
  } finally {
    restore();
  }
});

test("the same search in a FRESH conversation shows more", async () => {
  // The budget is the point: identical query, different context pressure.
  const rowsOf = async (used: number) => {
    resetResultSets();
    resetUsage();
    if (used) observeUsage("test-session", { inputTokens: used });
    const restore = stubBridge(Array.from({ length: 200 }, (_, i) => hit(i)));
    try {
      const out = (await searchArchive.execute(
        { query: "thing", order: "relevance", limit: 200 },
        ctx,
      )) as { hits: unknown[] };
      return out.hits.length;
    } finally {
      restore();
    }
  };

  const fresh = await rowsOf(0);
  const crowded = await rowsOf(950_000);
  assert.ok(fresh > crowded, `fresh ${fresh} should exceed crowded ${crowded}`);
});

test("the handle reads on, and reports what is still unread", async () => {
  resetResultSets();
  resetUsage();
  observeUsage("test-session", { inputTokens: 900_000 });
  const restore = stubBridge(Array.from({ length: 200 }, (_, i) => hit(i)));
  try {
    const first = (await searchArchive.execute({ query: "thing", order: "relevance", limit: 200 }, ctx)) as {
      resultSetId?: string;
      hits: unknown[];
    };

    const page = (await searchPage.execute({ resultSetId: first.resultSetId!, limit: 10 }, ctx)) as {
      ok: boolean;
      hits: unknown[];
      remaining: number;
    };

    assert.equal(page.ok, true);
    assert.equal(page.hits.length, 10);
    assert.equal(page.remaining, 200 - first.hits.length - 10);
  } finally {
    restore();
  }
});

test("an expired handle refuses in a way the model can recover from", async () => {
  resetResultSets();
  const page = (await searchPage.execute({ resultSetId: "rs_gone", limit: 10 }, ctx)) as { ok: boolean };
  assert.equal(page.ok, false);
  const text = (searchPage.toModelOutput!(page as never) as { value: string }).value;
  assert.match(text, /search again|run the search/i);
});

test("an empty archive still reports coverage rather than an absence", async () => {
  resetResultSets();
  resetUsage();
  const restore = stubBridge([], { messages: 0, chats: 0 });
  try {
    const out = (await searchArchive.execute({ query: "thing", order: "relevance", limit: 50 }, ctx)) as never;
    const text = (searchArchive.toModelOutput!(out) as { value: string }).value;
    assert.match(text, /archive is empty/i);
  } finally {
    restore();
  }
});
