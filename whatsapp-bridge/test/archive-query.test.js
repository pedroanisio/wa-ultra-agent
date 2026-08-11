import assert from "node:assert/strict";
import test from "node:test";

import { SEARCH_FILTERS, parseSearchParams } from "../src/archive-query.js";
import { openStore } from "../src/store.js";

/**
 * The seam these tests guard.
 *
 * Every one of these filters was already implemented and individually tested at
 * the store, and every one of them was dropped in transit: the HTTP layer
 * parsed them, the bridge function forwarded a hand-written subset, and the
 * five that were not on that list vanished with no error. A narrowed search
 * returned an unnarrowed result, which reads as an answer.
 *
 * So the important test here is not that each filter parses — it is the
 * round-trip one at the bottom, which asserts the parsed object is a thing
 * `store.search` actually honours rather than a shape that merely looks right.
 */

const params = (query) => new URLSearchParams(query);

test("search params: every filter survives parsing", () => {
  const parsed = parseSearchParams(
    params(
      "q=proposta&chat=Fabio&sender=Fabio&since=2026-08-01&until=2026-09-01" +
        "&kind=document&outgoing=false&order=recent&limit=10",
    ),
  );

  assert.deepEqual(parsed, {
    query: "proposta",
    chat: "Fabio",
    sender: "Fabio",
    since: "2026-08-01",
    until: "2026-09-01",
    kind: "document",
    order: "recent",
    outgoing: false,
    limit: 10,
  });
});

test("search params: absent filters are undefined, never empty strings", () => {
  const parsed = parseSearchParams(params("q=proposta"));

  assert.equal(parsed.query, "proposta");
  for (const filter of SEARCH_FILTERS) {
    assert.equal(parsed[filter], undefined, `${filter} should be undefined when absent`);
  }
  // An empty string is falsy at the store, but "" as a chat name would be a
  // filter on the empty chat if anything ever tested it for presence instead.
  assert.equal(parseSearchParams(params("q=x&chat=")).chat, undefined);
});

test("search params: unset outgoing is not the same as outgoing=false", () => {
  assert.equal(parseSearchParams(params("q=x")).outgoing, undefined, "unset means either direction");
  assert.equal(parseSearchParams(params("q=x&outgoing=false")).outgoing, false);
  assert.equal(parseSearchParams(params("q=x&outgoing=true")).outgoing, true);
});

test("search params: a useless limit falls back to the store's default", () => {
  assert.equal(parseSearchParams(params("q=x&limit=0")).limit, undefined);
  assert.equal(parseSearchParams(params("q=x&limit=abc")).limit, undefined);
  assert.equal(parseSearchParams(params("q=x&limit=-5")).limit, undefined);
  assert.equal(parseSearchParams(params("q=x&limit=7")).limit, 7);
});

test("search params: a stray query parameter cannot become a filter", () => {
  const parsed = parseSearchParams(params("q=x&status=open&drop=table"));
  assert.equal("status" in parsed, false);
  assert.equal("drop" in parsed, false);
});

test("search params: the parsed object is one the store actually honours", () => {
  const db = openStore(":memory:", { dateOrder: "day-first" });
  db.upsertMessages("Fabio", [
    {
      key: "a",
      text: "mando a proposta amanhã",
      from: "Fabio",
      time: "01/08/2026 10:00",
      kind: "text",
      outgoing: false,
    },
    {
      key: "b",
      text: "proposta recebida, obrigado",
      from: "eu",
      time: "02/08/2026 10:00",
      kind: "text",
      outgoing: true,
    },
  ]);
  db.upsertMessages("Helena", [
    { key: "c", text: "viu a proposta?", from: "Helena", time: "03/08/2026 10:00", kind: "text" },
  ]);

  const search = (query) => {
    const { query: q, ...filters } = parseSearchParams(params(query));
    return db.search(q, filters);
  };

  // Each of these returned all three rows while the filters were being dropped.
  assert.equal(search("q=proposta").length, 3, "unfiltered");
  assert.equal(search("q=proposta&sender=Fabio").length, 1, "sender reached the SQL");
  assert.equal(search("q=proposta&outgoing=true").length, 1, "outgoing reached the SQL");
  assert.equal(search("q=proposta&chat=Helena").length, 1, "chat reached the SQL");
  assert.equal(search("q=proposta&since=2026-08-02").length, 2, "since reached the SQL");
  assert.equal(search("q=proposta&until=2026-08-02").length, 1, "until reached the SQL");
  assert.equal(search("q=proposta&limit=2").length, 2, "limit reached the SQL");
  assert.equal(search("q=proposta&order=recent")[0].key, "c", "order reached the SQL");

  db.close();
});
