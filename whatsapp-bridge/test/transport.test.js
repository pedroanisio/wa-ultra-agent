import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/store.js";
import { createTransport, drainOnce, resolveRecipient, toArchiveRow } from "../src/transport.js";

/**
 * The boundary between the Go transport and the archive.
 *
 * Two properties are load-bearing here and neither is visible by inspection:
 *
 *   1. The ack happens AFTER the archive commits. Delivery is at-least-once, so
 *      acking first turns any write failure into permanent message loss — the
 *      transport has already forgotten the entry. Every test that writes checks
 *      the ordering, not just the outcome.
 *
 *   2. `dropped` is never discarded. It is cumulative and it is the only record
 *      that correspondence was lost because the queue filled while the archive
 *      was down. An absence must never read as a quiet period (SPEC §5.8).
 *
 * ── Why the fixtures use `fixture-a@lid` and not digits ─────────────────────
 * `identity-guard.js` fails the build on `\d{6,20}@lid`, because a LID is stable
 * per person and publishing one links all of their messages together. A digit
 * LID in this file would be a real leak the moment the file is committed, so the
 * fixtures use non-digit stand-ins. The store treats the key as an opaque
 * string, so nothing under test is weakened by that.
 */

const CHAT = { key: "fixture-a@lid", kind: "lid", provisional: false };

/** One outbox payload, in the shape `internal/event.Message` marshals. */
const payload = (over = {}) => ({
  key: "3EB0FIXTURE01",
  chat: CHAT,
  sender: CHAT,
  pushName: "Fixture Contact",
  outgoing: false,
  sentAt: "2026-08-11T09:15:00Z",
  kind: "text",
  text: "o azulejista confirmou quinta",
  recognised: true,
  fromHistory: false,
  ...over,
});

const entry = (seq, over = {}) => ({ seq, payload: payload(over) });

const store = () =>
  openStore(":memory:", { now: () => "2026-08-11T12:00:00.000Z", dateOrder: "day-first" });

/**
 * A transport whose HTTP is a recorded script rather than a socket.
 *
 * `calls` is the assertion surface for ordering: the ack-after-commit property
 * is a statement about the SEQUENCE of requests, which a return value cannot
 * express.
 */
function fakeTransport({ outbox = { entries: [], depth: 0, dropped: 0 }, onAck } = {}) {
  const calls = [];
  const transport = {
    async outbox({ limit } = {}) {
      calls.push({ call: "outbox", limit });
      return outbox;
    },
    async ack(through) {
      calls.push({ call: "ack", through });
      if (onAck) onAck(through);
      return { removed: 1 };
    },
  };
  return { transport, calls };
}

// ── toArchiveRow: the anti-corruption layer ────────────────────────────────

test("toArchiveRow: a real timestamp is used as-is, never guessed at", () => {
  // The DOM path had to infer a date from strings like "8/3/2026" and could fail.
  // The protocol gives an unambiguous instant, so `parseSentAt` must not be
  // involved at all — and a row that arrives dated must never land undated.
  const row = toArchiveRow(payload({ sentAt: "2026-08-11T09:15:00Z" }));
  assert.equal(row.sentAtIso, "2026-08-11T09:15:00.000Z");
  assert.equal(row.sentAt, "2026-08-11T09:15:00Z", "the raw evidence is kept alongside");
});

test("toArchiveRow: media arrives with no text and gets the archive's own placeholder", () => {
  // The transport deliberately does not render placeholders — that vocabulary
  // lives in message-kind.js and duplicating it in Go would let the two drift.
  // So an empty `text` on a media row is expected, and rendering it is this
  // layer's job. A row stored with "" would read as an empty message.
  const row = toArchiveRow(payload({ kind: "voice", text: "", durationSeconds: 222 }));
  assert.equal(row.kind, "voice");
  assert.match(row.text, /voice/i);
  assert.match(row.text, /3:42/, "the duration is rendered, so a voice note is not a blank row");
});

test("toArchiveRow: a caption is preserved as the body and as the caption", () => {
  const row = toArchiveRow(payload({ kind: "image", text: "", caption: "a bancada ficou pronta" }));
  assert.equal(row.caption, "a bancada ficou pronta");
  assert.match(row.text, /bancada/, "a captioned image is readable, not just '[image]'");
});

test("toArchiveRow: an unrecognised protobuf arm still stores, as unknown", () => {
  const row = toArchiveRow(payload({ kind: "unknown", text: "", recognised: false }));
  assert.equal(row.kind, "unknown");
  assert.ok(row.text.length > 0, "an undescribable message is still a message, not a blank");
  assert.equal(row.recognised, false);
});

test("toArchiveRow: the chat is keyed on identity and the push name is only a label", () => {
  const row = toArchiveRow(payload({ pushName: "Fixture Contact" }));
  assert.equal(row.chat.key, "fixture-a@lid", "the stable key addresses the chat");
  assert.equal(row.chat.displayName, "Fixture Contact", "the self-asserted name rides alongside");
});

test("toArchiveRow: a group is not renamed after whoever spoke in it last", () => {
  // The trap: `pushName` labels the SENDER. In a direct message the sender is the
  // chat partner, so it labels the chat too — but in a group it is one
  // participant, and hanging it on the chat would rename "Obra" to "Fixture Contact" and
  // then to whoever spoke next. Silent, and it corrupts every chat listing.
  const row = toArchiveRow(
    payload({
      chat: { key: "fixture-group@g.us", kind: "group", provisional: false },
      sender: { key: "fixture-a@lid", kind: "lid", provisional: false },
      pushName: "Fixture Contact",
    }),
  );
  assert.equal(row.chat.displayName, null, "a participant's name is not the group's name");
  assert.equal(row.sender.key, "fixture-a@lid", "the participant is still identified");
});

test("toArchiveRow: a direct message does take its label from the sender", () => {
  // The other half of the rule above — otherwise every DM would be unlabelled.
  const row = toArchiveRow(payload({ pushName: "Fixture Contact" }));
  assert.equal(row.chat.displayName, "Fixture Contact");
});

test("toArchiveRow: a message with no id is refused rather than stored", () => {
  // messages.key is UNIQUE and the provenance foreign keys cite it. A keyless row
  // does not degrade the archive, it collides with every other keyless row.
  assert.throws(() => toArchiveRow(payload({ key: "" })), /id/i);
});

// ── drainOnce: the hand-off ────────────────────────────────────────────────

test("drainOnce: the ack cites the highest sequence and happens after the commit", () => {
  const archive = store();
  const written = [];
  const { transport, calls } = fakeTransport({
    outbox: { entries: [entry(1), entry(2, { key: "3EB0FIXTURE02" })], depth: 2, dropped: 0 },
    onAck: () => written.push("ack-observed-at:" + archive.stats().messages),
  });

  const result = drainOnce({ transport, store: archive });
  return result.then((outcome) => {
    assert.equal(outcome.inserted, 2);
    assert.equal(outcome.acked, 2, "the ack cites the highest seq in the batch");

    assert.deepEqual(
      calls.map((c) => c.call),
      ["outbox", "ack"],
      "outbox is read, then the archive commits, then the ack is sent",
    );
    assert.deepEqual(
      written,
      ["ack-observed-at:2"],
      "both messages were already committed when the ack went out",
    );
    archive.close();
  });
});

test("drainOnce: a failing archive write sends no ack, so nothing is lost", async () => {
  // The property that makes at-least-once delivery safe. If the ack went out
  // anyway the transport would drop the entries and the messages would be gone
  // for good — there is no second copy anywhere.
  const broken = {
    upsertTransportMessages() {
      throw new Error("disk full");
    },
  };
  const { transport, calls } = fakeTransport({
    outbox: { entries: [entry(7)], depth: 1, dropped: 0 },
  });

  await assert.rejects(() => drainOnce({ transport, store: broken }), /disk full/);
  assert.deepEqual(
    calls.map((c) => c.call),
    ["outbox"],
    "the ack must not be sent when the write failed",
  );
});

test("drainOnce: an empty queue acks nothing", async () => {
  // Acking 0 would look like success forever. The transport treats a missing
  // `through` as a 400 for the same reason.
  const archive = store();
  const { transport, calls } = fakeTransport({
    outbox: { entries: [], depth: 0, dropped: 0 },
  });

  const outcome = await drainOnce({ transport, store: archive });
  assert.equal(outcome.inserted, 0);
  assert.equal(outcome.acked, null);
  assert.deepEqual(calls.map((c) => c.call), ["outbox"]);
  archive.close();
});

test("drainOnce: redelivery of an already-stored message is a duplicate, not an error", async () => {
  // At-least-once means the same entry can arrive twice — after a crash between
  // the commit and the ack, which is exactly when it is most likely.
  const archive = store();
  const first = fakeTransport({ outbox: { entries: [entry(1)], depth: 1, dropped: 0 } });
  await drainOnce({ transport: first.transport, store: archive });

  const again = fakeTransport({ outbox: { entries: [entry(1)], depth: 1, dropped: 0 } });
  const outcome = await drainOnce({ transport: again.transport, store: archive });

  assert.equal(outcome.inserted, 0);
  assert.equal(outcome.duplicates, 1);
  assert.equal(outcome.acked, 1, "a redelivered entry is still acked, or the queue never drains");
  assert.equal(archive.stats().messages, 1, "no second copy was written");
  archive.close();
});

test("drainOnce: a non-zero dropped count is reported, not swallowed", async () => {
  const archive = store();
  const { transport } = fakeTransport({
    outbox: { entries: [entry(9)], depth: 1, dropped: 12 },
  });

  const outcome = await drainOnce({ transport, store: archive });
  assert.equal(outcome.dropped, 12, "the gap is surfaced to the caller");
  assert.equal(outcome.depth, 1);
  archive.close();
});

// ── resolveRecipient: name to address ──────────────────────────────────────

const ROSTER = [
  { key: "fixture-a@lid", kind: "lid", provisional: false, pushName: "Fixture Contact", fullName: "Fixture Contact A." },
  { key: "fixture-b@lid", kind: "lid", provisional: false, pushName: "Fabio", fullName: "" },
  { key: "pn:9f2ac41b7e", kind: "phone", provisional: true, pushName: "Helena", fullName: "" },
];

test("resolveRecipient: an exact name resolves to that contact's address", () => {
  const resolved = resolveRecipient("Fixture Contact", ROSTER);
  assert.equal(resolved.to, "fixture-a@lid");
  assert.equal(resolved.exactMatch, true);
});

test("resolveRecipient: matching is insensitive to case and padding", () => {
  assert.equal(resolveRecipient("  fabio ", ROSTER).to, "fixture-b@lid");
});

test("resolveRecipient: an ambiguous name is refused with its candidates", () => {
  // The property that matters most in this file. Two people can advertise the
  // same push name, and picking either is a coin flip over who receives a private
  // message. The DOM path had a real bug of this shape.
  const twins = [
    { key: "fixture-a@lid", provisional: false, pushName: "Ana" },
    { key: "fixture-b@lid", provisional: false, pushName: "Ana" },
  ];
  assert.throws(() => resolveRecipient("Ana", twins), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /ambiguous/i);
    return true;
  });
});

test("resolveRecipient: an error never republishes the identity key", () => {
  // Errors get logged, and a LID is stable per person: printing one into a log
  // links every message of theirs together. The guard fails the build on digit
  // LIDs for the same reason.
  const twins = [
    { key: "fixture-a@lid", provisional: false, pushName: "Ana" },
    { key: "fixture-b@lid", provisional: false, pushName: "Ana" },
  ];
  try {
    resolveRecipient("Ana", twins);
    assert.fail("should have refused");
  } catch (error) {
    assert.doesNotMatch(error.message, /@lid/, "the message names people, not their addresses");
  }
});

test("resolveRecipient: a provisional identity is refused, because it is not an address", () => {
  // `pn:<digest>` exists precisely so a phone number is never used as a key. It
  // is not routable, and ParseJID on the Go side would simply 400.
  assert.throws(() => resolveRecipient("Helena", ROSTER), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /provisional|no routable address/i);
    return true;
  });
});

test("resolveRecipient: a name nobody in the roster has is refused, not guessed at", () => {
  assert.throws(() => resolveRecipient("Nobody At All", ROSTER), /no contact matches/i);
});

test("resolveRecipient: a group resolves by its subject", () => {
  // Groups carry `subject` and none of the three person-name fields, so a roster
  // reader that only knows about push names cannot address one at all.
  const roster = [
    ...ROSTER,
    { key: "120363000000000001@g.us", kind: "group", provisional: false, subject: "Fixture Group" },
  ];
  const resolved = resolveRecipient("Fixture Group", roster);
  assert.equal(resolved.to, "120363000000000001@g.us");
  assert.equal(resolved.matchedName, "Fixture Group");
  assert.equal(resolved.exactMatch, true);
});

test("resolveRecipient: an exact group subject beats a person it is a prefix of", () => {
  // The shape of the original defect. "We" is two characters, and while the
  // roster held no groups it prefix-matched a person and resolved to them.
  const roster = [
    { key: "fixture-b@lid", provisional: false, pushName: "Wesley Fixture" },
    { key: "120363000000000002@g.us", kind: "group", provisional: false, subject: "We" },
  ];
  assert.equal(resolveRecipient("We", roster).to, "120363000000000002@g.us");
});

test("resolveRecipient: a missing name says so differently when groups could not be listed", () => {
  // "no contact matches" is a true statement about a roster that is missing its
  // groups, and a misleading one: it reads as "this name does not exist".
  assert.throws(
    () => resolveRecipient("Fixture Group", ROSTER, { groupsUnavailable: "iq timed out" }),
    (error) => {
      assert.match(error.message, /group/i);
      assert.match(error.message, /iq timed out/);
      return true;
    },
  );
});

// ── createTransport: the HTTP client ───────────────────────────────────────

test("createTransport: every authenticated call presents the bearer token", async () => {
  const seen = [];
  const transport = createTransport({
    baseUrl: "http://transport:8100",
    token: "fixture-token",
    fetch: async (url, options) => {
      seen.push({ url: String(url), auth: options?.headers?.Authorization, method: options?.method });
      return new Response(JSON.stringify({ entries: [], depth: 0, dropped: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await transport.outbox({ limit: 50 });
  assert.equal(seen[0].auth, "Bearer fixture-token");
  assert.match(seen[0].url, /\/outbox\?limit=50$/);
});

test("createTransport: ack sends `through` as a number in the body", async () => {
  let body;
  const transport = createTransport({
    baseUrl: "http://transport:8100",
    token: "t",
    fetch: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ removed: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await transport.ack(42);
  assert.deepEqual(body, { through: 42 }, "`through` is required; the API 400s without it");
});

test("createTransport: an unauthorised response names the token variable to fix", async () => {
  // A bare "401" here is a dead end for the operator. The two processes share a
  // secret and the fix is always the same variable.
  const transport = createTransport({
    baseUrl: "http://transport:8100",
    token: "wrong",
    fetch: async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(() => transport.status(), /WA_TRANSPORT_TOKEN/);
});

test("createTransport: a refused send is distinguishable from a broken socket", async () => {
  // 403 is the guard refusing, which is a correct outcome and must not read as an
  // outage; 502 is the socket failing, which is. The agent needs to tell them
  // apart to know whether retrying is sensible.
  const respond = (status, error) => async () =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json" },
    });

  const refused = createTransport({ baseUrl: "http://t", token: "t", fetch: respond(403, "sendguard: recipient is not allowlisted") });
  await assert.rejects(() => refused.send({ to: "fixture-a@lid", message: "hi" }), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.refused, true, "a refusal is flagged as a decision, not a fault");
    return true;
  });

  const broken = createTransport({ baseUrl: "http://t", token: "t", fetch: respond(502, "socket closed") });
  await assert.rejects(() => broken.send({ to: "fixture-a@lid", message: "hi" }), (error) => {
    assert.equal(error.statusCode, 502);
    assert.notEqual(error.refused, true);
    return true;
  });
});

test("createTransport: the outbox limit is capped at what the API accepts", async () => {
  // MaxDrainLimit is 1000 on the Go side and it clamps silently. Asking for more
  // and being given 1000 would make a caller believe it had drained everything.
  let requested;
  const transport = createTransport({
    baseUrl: "http://t",
    token: "t",
    fetch: async (url) => {
      requested = new URL(String(url)).searchParams.get("limit");
      return new Response(JSON.stringify({ entries: [], depth: 0, dropped: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await transport.outbox({ limit: 5000 });
  assert.equal(requested, "1000");
});

/* ---------------------------------------------------------------- *
 * Finding a chat by the name a person would actually type
 *
 * Every case below is a real miss against this account's roster. The bug that
 * prompted them: the group `Kim, Lu, Rê` could not be found as `Kim, Lu, Re`,
 * so the agent told the user no such group existed — while the group sat in the
 * roster, on the send allowlist.
 * ---------------------------------------------------------------- */

const SEARCH_ROSTER = [
  { key: "1@g.us", kind: "group", subject: "Kim, Lu, Rê" },
  { key: "2@g.us", kind: "group", subject: "👥 Sítio & Açaí" },
  { key: "3@g.us", kind: "group", subject: "Rex + Pals" },
  { key: "4@g.us", kind: "group", subject: "Vizinhos (Norte)" },
  { key: "5@lid", kind: "person", pushName: "Ana" },
  { key: "6@lid", kind: "person", pushName: "Ana Paula" },
];

test("search: a diacritic the user did not type still finds the chat", () => {
  assert.equal(resolveRecipient("Kim, Lu, Re", SEARCH_ROSTER).to, "1@g.us");
  assert.equal(resolveRecipient("Kim, Lu, Rê", SEARCH_ROSTER).to, "1@g.us");
});

test("search: separators are not part of anybody's name", () => {
  for (const typed of ["kim lu re", "Kim Lu Rê", "kim, lu, re"]) {
    assert.equal(resolveRecipient(typed, SEARCH_ROSTER).to, "1@g.us", typed);
  }
});

test("search: a decorative emoji in the chat name is ignored", () => {
  assert.equal(resolveRecipient("Sítio & Açaí", SEARCH_ROSTER).to, "2@g.us");
  assert.equal(resolveRecipient("sitio e acai", SEARCH_ROSTER).to, "2@g.us");
});

test("search: a conjunction written as a word matches one written as a symbol", () => {
  assert.equal(resolveRecipient("Rex e Pals", SEARCH_ROSTER).to, "3@g.us");
  assert.equal(resolveRecipient("rex pals", SEARCH_ROSTER).to, "3@g.us");
});

test("search: a parenthetical is reachable both with and without it", () => {
  assert.equal(resolveRecipient("Vizinhos", SEARCH_ROSTER).to, "4@g.us");
  assert.equal(resolveRecipient("Vizinhos Norte", SEARCH_ROSTER).to, "4@g.us");
});

test("search: an exact name beats a longer one that contains it", () => {
  // The safety property the tiers exist for: widening the fold must never make
  // "Ana" ambiguous just because "Ana Paula" is also in the roster.
  const hit = resolveRecipient("Ana", SEARCH_ROSTER);
  assert.equal(hit.to, "5@lid");
  assert.equal(hit.exactMatch, true);
});

test("search: a genuinely ambiguous name is refused, never guessed", () => {
  const roster = [
    { key: "a@lid", kind: "person", pushName: "Ana Fixture Souza" },
    { key: "b@lid", kind: "person", pushName: "Ana Fixture Lima" },
  ];
  assert.throws(
    () => resolveRecipient("Ana Fixture", roster),
    (e) => e.statusCode === 409 && /ambiguous/.test(e.message),
  );
});

test("search: a name that is not there is still not there", () => {
  assert.throws(
    () => resolveRecipient("Nao Existe Esse Grupo", SEARCH_ROSTER),
    (e) => e.statusCode === 404,
  );
});

test("search: a miss names the closest wordings, so a typo is correctable", () => {
  assert.throws(
    () => resolveRecipient("Sítio dos Meninos", SEARCH_ROSTER),
    (e) => /Closest by wording/.test(e.message) && /Sítio & Açaí/.test(e.message),
  );
});
