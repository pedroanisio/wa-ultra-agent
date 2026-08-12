import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

/**
 * The protocol send path, end to end through its own HTTP client.
 *
 * ── Why this is an integration test and not a unit test ─────────────────────
 * The defect it exists to prevent lived in the SEAM, not in either side of it.
 * `resolveRecipient` was correct — it refuses ambiguity and refuses provisional
 * keys — and `assertSendable` was correct: "We" really was on the allowlist. The
 * bug was that `sendViaTransport` composed them and then accepted a resolution
 * neither of them had approved, because a prefix match returned `exactMatch:
 * false` and the caller only attached a warning to it.
 *
 * Testing the two halves separately is exactly what missed it the first time. So
 * this drives the real function against a real socket, and asserts on what the
 * transport was actually asked to do.
 */

import {
  editViaTransport,
  pollVoteViaTransport,
  presenceViaTransport,
  pollViaTransport,
  reactViaTransport,
  revokeViaTransport,
  sendMediaViaTransport,
  sendViaTransport,
} from "../src/whatsapp.js";

/** What the fake transport was asked to send, most recent last. */
let sends = [];
/** Same, for `/send/media`. */
let mediaSends = [];
/** Reaction, revoke, edit and poll, which share one fake route. */
let others = [];
/** Swapped per test: the roster `GET /contacts` answers with. */
let roster = { contacts: [] };
let server;

const GROUP_KEY = "120363000000000001@g.us";

before(async () => {
  server = createServer((req, res) => {
    if (req.url.startsWith("/contacts")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(roster));
      return;
    }
    if (/^\/(send\/(reaction|revoke|edit|poll)|presence)/.test(req.url)) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        others.push({ url: req.url, body: JSON.parse(body) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "SENT-OTHER-1" }));
      });
      return;
    }
    if (req.url.startsWith("/send/media")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        mediaSends.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "SENT-MEDIA-1", bytes: 3 }));
      });
      return;
    }
    if (req.url.startsWith("/send")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        sends.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "SENT-1", to: JSON.parse(body).to }));
      });
      return;
    }
    res.writeHead(404).end("{}");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  // Set before the first call: the client is built once and cached.
  process.env.WA_TRANSPORT_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.WA_TRANSPORT_TOKEN = "test-token";
  process.env.WA_ALLOW_SEND = "true";
  process.env.WA_SEND_ALLOWLIST = '"We","Wesley Fixture","Fixture Contact"';
});

after(() => server?.close());

function beforeEach() {
  sends = [];
  mediaSends = [];
  others = [];
}

test("sendViaTransport: a group is addressable by its subject", async () => {
  beforeEach();
  roster = {
    contacts: [
      { key: GROUP_KEY, kind: "group", provisional: false, subject: "We" },
      { key: "fixture-a@lid", kind: "lid", provisional: false, pushName: "Fixture Contact" },
    ],
  };

  const result = await sendViaTransport({ to: "We", message: "Autopsicografia" });

  assert.equal(result.via, "transport");
  assert.equal(sends.length, 1, "exactly one send");
  assert.equal(sends[0].to, GROUP_KEY, "the group, not a person");
  assert.equal(sends[0].message, "Autopsicografia");
});

test("sendViaTransport: a near-miss refuses instead of sending to the wrong recipient", async () => {
  beforeEach();
  // The original defect, reproduced: the group is absent from the roster and a
  // person's name begins with the same two letters. Both are allowlisted, so the
  // allowlist cannot catch this — only requested-vs-resolved can.
  roster = {
    contacts: [
      { key: "fixture-b@lid", kind: "lid", provisional: false, pushName: "Wesley Fixture" },
    ],
  };

  await assert.rejects(
    () => sendViaTransport({ to: "We", message: "Autopsicografia" }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /"We".*"Wesley Fixture"|Wesley Fixture/);
      return true;
    },
  );
  assert.equal(sends.length, 0, "nothing was sent");
});

test("sendViaTransport: an exact person match still sends", async () => {
  beforeEach();
  roster = {
    contacts: [
      { key: "fixture-a@lid", kind: "lid", provisional: false, pushName: "Fixture Contact" },
    ],
  };

  await sendViaTransport({ to: "Fixture Contact", message: "hello" });

  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, "fixture-a@lid");
});

test("sendViaTransport: a recipient off the allowlist is refused before resolution matters", async () => {
  beforeEach();
  roster = {
    contacts: [
      { key: "fixture-c@lid", kind: "lid", provisional: false, pushName: "Not Allowlisted" },
    ],
  };

  await assert.rejects(
    () => sendViaTransport({ to: "Not Allowlisted", message: "hello" }),
    /WA_SEND_ALLOWLIST/,
  );
  assert.equal(sends.length, 0);
});

test("sendMediaViaTransport: an image reaches the group, base64-encoded", async () => {
  beforeEach();
  roster = {
    contacts: [{ key: GROUP_KEY, kind: "group", provisional: false, subject: "We" }],
  };

  const image = Buffer.from([0x89, 0x50, 0x4e]);
  const result = await sendMediaViaTransport({
    to: "We",
    image,
    mimetype: "image/png",
    caption: "Autopsicografia",
    width: 1080,
    height: 1350,
  });

  assert.equal(result.via, "transport");
  assert.equal(mediaSends.length, 1);
  assert.equal(mediaSends[0].to, GROUP_KEY);
  assert.equal(mediaSends[0].mimetype, "image/png");
  assert.equal(mediaSends[0].caption, "Autopsicografia");
  assert.equal(mediaSends[0].width, 1080);
  assert.deepEqual(Buffer.from(mediaSends[0].dataBase64, "base64"), image);
});

// The guard chain is repeated in the media path rather than inherited, so it is
// asserted there too — an untested copy is how the first one went missing.
test("sendMediaViaTransport: a near-miss refuses, and uploads nothing", async () => {
  beforeEach();
  roster = {
    contacts: [
      { key: "fixture-b@lid", kind: "lid", provisional: false, pushName: "Wesley Fixture" },
    ],
  };

  await assert.rejects(
    () =>
      sendMediaViaTransport({
        to: "We",
        image: Buffer.from([0x89]),
        mimetype: "image/png",
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
  assert.equal(mediaSends.length, 0);
});

test("sendMediaViaTransport: an empty attachment is refused before the roster is read", async () => {
  beforeEach();
  roster = { contacts: [{ key: GROUP_KEY, kind: "group", provisional: false, subject: "We" }] };

  await assert.rejects(
    () => sendMediaViaTransport({ to: "We", image: Buffer.alloc(0), mimetype: "image/png" }),
    /empty attachment/i,
  );
  assert.equal(mediaSends.length, 0);
});

/**
 * Every outbound path, driven through the same near-miss.
 *
 * ── Why this is the test that matters ───────────────────────────────────────
 * The guard chain used to be written out per path, on the argument that a
 * visible copy is safer than a hidden wrapper. That held at two paths. At six —
 * text, media, reaction, revoke, edit, poll — it became six chances to omit one
 * check, and the omission would read exactly like the code around it. That is
 * precisely how `assertResolvedMatches` went missing the first time.
 *
 * So the chain is shared, and this drives EVERY exported send function through a
 * roster where "We" prefix-matches an allowlisted person. Each must refuse.
 * Adding a seventh send path without the gate makes this fail, which is the only
 * durable version of the promise.
 */
test("every send path refuses a near-miss, not just the first one written", async () => {
  const NEAR_MISS = {
    contacts: [
      { key: "fixture-b@lid", kind: "lid", provisional: false, pushName: "Wesley Fixture" },
    ],
  };

  const paths = [
    ["send", () => sendViaTransport({ to: "We", message: "hi" })],
    [
      "media",
      () => sendMediaViaTransport({ to: "We", image: Buffer.from([1]), mimetype: "image/png" }),
    ],
    ["reaction", () => reactViaTransport({ to: "We", messageId: "X", emoji: "👍" })],
    ["revoke", () => revokeViaTransport({ to: "We", messageId: "X" })],
    ["edit", () => editViaTransport({ to: "We", messageId: "X", message: "fixed" })],
    ["poll", () => pollViaTransport({ to: "We", name: "?", options: ["a", "b"] })],
    ["poll vote", () => pollVoteViaTransport({ to: "We", messageId: "X", options: ["a"] })],
    ["presence", () => presenceViaTransport({ to: "We", state: "composing" })],
  ];

  for (const [name, attempt] of paths) {
    beforeEach();
    roster = NEAR_MISS;

    await assert.rejects(
      attempt,
      (error) => {
        assert.equal(error.statusCode, 409, `${name} did not refuse with a conflict`);
        return true;
      },
      `${name} sent to a near-miss`,
    );
    assert.equal(sends.length + mediaSends.length + others.length, 0, `${name} sent something`);
  }
});

test("every send path reaches the group when the name is exact", async () => {
  const EXACT = {
    contacts: [{ key: GROUP_KEY, kind: "group", provisional: false, subject: "We" }],
  };

  const paths = [
    ["reaction", () => reactViaTransport({ to: "We", messageId: "X", emoji: "👍" })],
    ["revoke", () => revokeViaTransport({ to: "We", messageId: "X" })],
    ["edit", () => editViaTransport({ to: "We", messageId: "X", message: "fixed" })],
    ["poll", () => pollViaTransport({ to: "We", name: "?", options: ["a", "b"] })],
    ["poll vote", () => pollVoteViaTransport({ to: "We", messageId: "X", options: ["a"] })],
    ["presence", () => presenceViaTransport({ to: "We", state: "composing" })],
  ];

  for (const [name, attempt] of paths) {
    beforeEach();
    roster = EXACT;

    const result = await attempt();
    assert.equal(result.via, "transport", `${name} did not report its path`);
    assert.equal(others.length, 1, `${name} sent ${others.length} requests`);
    assert.equal(others[0].body.to, GROUP_KEY, `${name} addressed the wrong chat`);
  }
});

test("sendViaTransport: an unlistable group is reported as such, not as an unknown name", async () => {
  beforeEach();
  // Distinguishing these two is the whole point of `groupsUnavailable`: without
  // it, a group that exists but could not be listed is indistinguishable from a
  // name the operator invented, and the operator debugs the wrong problem.
  roster = { contacts: [], groupsUnavailable: "iq timed out" };

  await assert.rejects(
    () => sendViaTransport({ to: "We", message: "Autopsicografia" }),
    /group/i,
  );
  assert.equal(sends.length, 0);
});
