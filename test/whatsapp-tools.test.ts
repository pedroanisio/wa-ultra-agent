import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The tools that act on WhatsApp, checked against the bridge's actual routes.
 *
 * These are thin by design — the bridge owns every rule — so what is worth
 * testing is exactly the thin part: that each tool calls the route it claims to,
 * with the fields that route requires, and reports back what happened. A tool
 * that posts to the wrong path or drops `messageId` fails silently in a way no
 * type can catch, because both ends are JSON.
 */

process.env.WA_BRIDGE_TOKEN ??= "test-token";
process.env.WA_BRIDGE_URL ??= "http://bridge.test";

const tool = async (name: string) => (await import(`../agent/tools/${name}.ts`)).default;

interface Captured {
  path: string;
  body: Record<string, unknown>;
  query: URLSearchParams;
}

/** Capture the one request a tool makes, and answer it with `reply`. */
function capture(reply: unknown = { ok: true }) {
  const original = globalThis.fetch;
  const calls: Captured[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { calls, restore: () => void (globalThis.fetch = original) };
}

const ctx = {} as never;

/* ── the bug: reading a chat returned its oldest messages ──────────── */

test("read_chat asks for the RECENT end of the chat", async () => {
  // `/archive/messages` cuts the limit from the oldest end unless told
  // otherwise, so without `newest` this tool answered "what did they say
  // lately?" with the first messages ever exchanged — and a chat that has moved
  // on reads as a quiet one. Nothing errors; that is what makes it dangerous.
  const fake = capture({ chat: "Tuca", messages: [] });
  try {
    await (await tool("whatsapp_read_chat")).execute({ chat: "Tuca", limit: 25 }, ctx);

    assert.equal(fake.calls[0].path, "/archive/messages");
    assert.equal(fake.calls[0].query.get("newest"), "1", "must ask for the newest messages");
    assert.equal(fake.calls[0].query.get("limit"), "25");
  } finally {
    fake.restore();
  }
});

/* ── acting on a message ───────────────────────────────────────────── */

test("react posts the emoji to /send/reaction", async () => {
  const fake = capture({ id: "3EB0", sentAt: "2026-01-01T00:00:00Z" });
  try {
    const result = await (await tool("whatsapp_react")).execute(
      { to: "Tuca", messageId: "3EB0ABC", emoji: "👍" },
      ctx,
    );

    assert.equal(fake.calls[0].path, "/send/reaction");
    assert.deepEqual(fake.calls[0].body, { to: "Tuca", messageId: "3EB0ABC", emoji: "👍" });
    assert.equal(result.ok, true);
  } finally {
    fake.restore();
  }
});

test("an empty emoji removes a reaction rather than being rejected", async () => {
  const fake = capture({ id: "3EB0" });
  try {
    const result = await (await tool("whatsapp_react")).execute(
      { to: "Tuca", messageId: "3EB0ABC", emoji: "" },
      ctx,
    );
    assert.equal(fake.calls[0].body.emoji, "", "the protocol's own way of un-reacting");
    assert.equal(result.ok, true);
  } finally {
    fake.restore();
  }
});

test("edit sends the replacement text with the message it replaces", async () => {
  const fake = capture({ id: "3EB0" });
  try {
    await (await tool("whatsapp_edit_message")).execute(
      { to: "Tuca", messageId: "3EB0ABC", message: "tomorrow, not today" },
      ctx,
    );

    assert.equal(fake.calls[0].path, "/send/edit");
    assert.equal(fake.calls[0].body.messageId, "3EB0ABC");
    assert.equal(fake.calls[0].body.message, "tomorrow, not today");
  } finally {
    fake.restore();
  }
});

test("revoke deletes for everyone, and says so in the result", async () => {
  const fake = capture({ id: "3EB0" });
  try {
    const result = await (await tool("whatsapp_revoke_message")).execute(
      { to: "Tuca", messageId: "3EB0ABC" },
      ctx,
    );

    assert.equal(fake.calls[0].path, "/send/revoke");
    assert.equal(fake.calls[0].body.messageId, "3EB0ABC");
    assert.equal(result.ok, true);
  } finally {
    fake.restore();
  }
});

/* ── polls ─────────────────────────────────────────────────────────── */

test("a poll carries its question and options", async () => {
  const fake = capture({ id: "3EB0" });
  try {
    await (await tool("whatsapp_poll")).execute(
      { to: "Trip", name: "Which weekend?", options: ["14th", "21st"], selectableCount: 1 },
      ctx,
    );

    assert.equal(fake.calls[0].path, "/send/poll");
    assert.equal(fake.calls[0].body.name, "Which weekend?");
    assert.deepEqual(fake.calls[0].body.options, ["14th", "21st"]);
    assert.equal(fake.calls[0].body.selectableCount, 1);
  } finally {
    fake.restore();
  }
});

test("a poll with fewer than two options is refused without asking the bridge", async () => {
  const fake = capture();
  try {
    const result = await (await tool("whatsapp_poll")).execute(
      { to: "Trip", name: "Which weekend?", options: ["14th"] },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.equal(fake.calls.length, 0, "a poll of one is not a question");
  } finally {
    fake.restore();
  }
});

/* ── presence ──────────────────────────────────────────────────────── */

test("presence sends the state the transport expects", async () => {
  const fake = capture({ ok: true });
  try {
    await (await tool("whatsapp_presence")).execute({ to: "Tuca", state: "composing" }, ctx);

    assert.equal(fake.calls[0].path, "/presence");
    assert.equal(fake.calls[0].body.state, "composing");
    assert.equal(fake.calls[0].body.to, "Tuca");
  } finally {
    fake.restore();
  }
});

/* ── names ─────────────────────────────────────────────────────────── */

test("refresh_names asks the bridge to re-resolve provisional chats", async () => {
  const fake = capture({ updated: 3, remaining: 1 });
  try {
    const result = await (await tool("whatsapp_refresh_names")).execute({}, ctx);

    assert.equal(fake.calls[0].path, "/archive/names/refresh");
    assert.equal(result.ok, true);
    assert.equal(result.updated, 3);
  } finally {
    fake.restore();
  }
});

/* ── status ────────────────────────────────────────────────────────── */

test("status reports whether the account is actually linked", async () => {
  // The old status could only say the bridge was up. An unpaired transport is
  // the one failure that makes every other tool useless, so it belongs here.
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const body =
      url.pathname === "/transport/status"
        ? { session: { paired: true, connected: true, loggedIn: true }, send: { enabled: true } }
        : { archive: { chats: 201, messages: 8510 }, transport: "configured" };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await (await tool("whatsapp_status")).execute({}, ctx);
    assert.equal(result.linked, true);
    assert.equal(result.messages, 8510);
  } finally {
    globalThis.fetch = original;
  }
});

test("status says plainly when the account is not linked", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const body =
      url.pathname === "/transport/status"
        ? { session: { paired: false, connected: false, loggedIn: false }, send: { enabled: false } }
        : { archive: { chats: 0, messages: 0 }, transport: "configured" };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await (await tool("whatsapp_status")).execute({}, ctx);
    assert.equal(result.linked, false);
  } finally {
    globalThis.fetch = original;
  }
});

/* ── sending, and when it must be approved ─────────────────────────── */

test("send_message declares an approval policy", async () => {
  // The prepare/commit dance went with the DOM path; this is what replaces it.
  const send = await tool("whatsapp_send_message");
  assert.ok(send.approval, "sending must be gated by something");
});

/* ── every acting tool refuses an empty target ─────────────────────── */

test("no acting tool will address an empty recipient", async () => {
  const fake = capture();
  try {
    for (const name of ["whatsapp_react", "whatsapp_edit_message", "whatsapp_revoke_message"]) {
      const result = await (await tool(name)).execute(
        { to: "  ", messageId: "3EB0", emoji: "👍", message: "x" },
        ctx,
      );
      assert.equal(result.ok, false, `${name} must refuse an empty recipient`);
    }
    assert.equal(fake.calls.length, 0, "and none of them may reach the bridge");
  } finally {
    fake.restore();
  }
});
