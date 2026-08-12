import { test } from "node:test";
import assert from "node:assert/strict";

import { parseState, renderBoard } from "../agent/lib/tictactoe.ts";

/**
 * The glue between the engine and the bridge.
 *
 * The engine is tested next door; what is tested here is everything that can
 * only go wrong once a chat is involved — that a turn is written exactly once,
 * that a chat with nothing new in it writes nothing at all, and that what is
 * written back is a board the next turn can read.
 *
 * The bridge is faked at `fetch`, one level below the client, so the real
 * request paths and the real response parsing are both exercised. `bridge.ts`
 * reads its configuration at import time, hence the env assignment before the
 * dynamic import below.
 */

process.env.WA_BRIDGE_TOKEN ??= "test-token";
process.env.WA_BRIDGE_URL ??= "http://bridge.test";

const { default: tictactoe } = await import("../agent/tools/whatsapp_tictactoe.ts");

const SELF_CHAT = "Test Self Chat (You)";

interface FakeBridge {
  /** Every message the tool wrote, in order. */
  written: string[];
  calls: string[];
  restore: () => void;
}

/** Serve `/self/chat` and `/messages` from a scripted chat; capture `/send/self`. */
function fakeBridge(chatMessages: string[]): FakeBridge {
  const original = globalThis.fetch;
  const written: string[] = [];
  const calls: string[] = [];
  const transcript = [...chatMessages];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);

    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    if (url.pathname === "/self/chat") {
      return json({ chat: SELF_CHAT, source: "archive", via: "transport" });
    }

    // The archive IS the chat on the protocol transport. `newest` matters: the
    // default cuts the limit from the oldest end, which would hand the tool a
    // window with no board in it and make it start a new game every poll.
    if (url.pathname === "/archive/messages") {
      assert.equal(url.searchParams.get("chat"), SELF_CHAT, "reads the chat the bridge named");
      assert.equal(url.searchParams.get("newest"), "1", "must ask for the recent end");
      const limit = Number(url.searchParams.get("limit")) || 20;
      return json({
        chat: SELF_CHAT,
        messages: transcript.slice(-limit).map((text, i) => ({
          key: `k${i}`,
          chat: SELF_CHAT,
          kind: "text",
          text,
          outgoing: 1,
        })),
      });
    }

    if (url.pathname === "/messages") {
      throw new Error("the browser read path must not be used on the transport");
    }

    if (url.pathname === "/send/self") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: string[] };
      written.push(...body.messages);
      // A written note is also a new message in the chat, exactly as on a phone.
      transcript.push(...body.messages);
      return json({ sent: true, chat: SELF_CHAT, messages: body.messages, at: "2026-01-01T00:00:00Z" });
    }

    throw new Error(`unexpected bridge call: ${url.pathname}`);
  }) as typeof fetch;

  return { written, calls, restore: () => void (globalThis.fetch = original) };
}

const ctx = {} as never;

/** `execute` may return a value, a promise, or a stream; here it is a promise. */
const run = async (input: Parameters<typeof tictactoe.execute>[0]) =>
  (await tictactoe.execute(input, ctx)) as Record<string, unknown>;

test("a new game is opened and written to the user's own chat", async () => {
  const fake = fakeBridge(["a note about something else"]);
  try {
    const result = await run({ action: "new", level: "hard", mark: "x" });

    assert.equal(result.ok, true);
    assert.equal(result.played, true);
    assert.equal(result.chat, SELF_CHAT);
    assert.equal(fake.written.length, 1, "one message, not a burst");

    const state = parseState(fake.written[0]);
    assert.deepEqual(state?.board.filter(Boolean), [], "the user is X, so the board starts empty");
    assert.equal(state?.level, "hard");
    assert.equal(state?.user, "x");
  } finally {
    fake.restore();
  }
});

test("as O, the agent's opening move is already on the board", async () => {
  const fake = fakeBridge([]);
  try {
    await run({ action: "new", mark: "o" });
    const state = parseState(fake.written[0]);
    assert.equal(state?.user, "o");
    assert.equal(state?.board.filter(Boolean).length, 1, "X has opened");
  } finally {
    fake.restore();
  }
});

test("a square typed into the chat is played and answered", async () => {
  const board = renderBoard({ board: Array(9).fill(null), user: "x", level: "normal" });
  const fake = fakeBridge([board, "b2"]);
  try {
    const result = await run({ action: "auto" });

    assert.equal(result.played, true);
    assert.equal(result.userMove, "b2");
    assert.equal(typeof result.agentMove, "string", "the agent answered");

    const state = parseState(fake.written[0]);
    assert.equal(state?.board[4], "x", "the user's square is theirs");
    assert.equal(state?.board.filter(Boolean).length, 2, "one move each");
  } finally {
    fake.restore();
  }
});

test("a board with nothing typed after it writes nothing at all", async () => {
  // Idempotence: this is what makes a repeated call, or two overlapping
  // schedules, safe. A second answer to the same move would corrupt the game.
  const board = renderBoard({ board: Array(9).fill(null), user: "x", level: "normal" });
  const fake = fakeBridge([board]);
  try {
    const result = await run({ action: "auto" });

    assert.equal(result.played, false);
    assert.equal(fake.written.length, 0);
    assert.equal(fake.calls.includes("/send/self"), false, "the browser was never touched");
  } finally {
    fake.restore();
  }
});

test("playing the same turn twice is a no-op the second time", async () => {
  const board = renderBoard({ board: Array(9).fill(null), user: "x", level: "normal" });
  const fake = fakeBridge([board, "a1"]);
  try {
    const first = await run({ action: "auto" });
    const second = await run({ action: "auto" });

    assert.equal(first.played, true);
    assert.equal(second.played, false, "the move was already answered");
    assert.equal(fake.written.length, 1);
  } finally {
    fake.restore();
  }
});

test("an unrelated self-note never triggers a move", async () => {
  const board = renderBoard({ board: Array(9).fill(null), user: "x", level: "normal" });
  const fake = fakeBridge([board, "remember to renew the passport"]);
  try {
    const result = await run({ action: "auto" });
    assert.equal(result.played, false);
    assert.equal(fake.written.length, 0);
  } finally {
    fake.restore();
  }
});

test("an illegal move is refused, and the unchanged board is posted back with the reason", async () => {
  const taken = renderBoard({
    board: ["x", "o", null, null, null, null, null, null, null],
    user: "x",
    level: "normal",
  });
  const fake = fakeBridge([taken, "a1"]);
  try {
    const result = await run({ action: "auto" });

    assert.equal(result.played, false);
    assert.match(String(result.note), /already taken/i);
    assert.equal(fake.written.length, 1, "the user is shown the board, not just told no");
    assert.deepEqual(
      parseState(fake.written[0])?.board,
      parseState(taken)?.board,
      "the position did not change",
    );
  } finally {
    fake.restore();
  }
});

test("a move asked for in conversation overrides what is in the chat", async () => {
  const board = renderBoard({ board: Array(9).fill(null), user: "x", level: "normal" });
  const fake = fakeBridge([board, "c3"]);
  try {
    const result = await run({ action: "auto", move: "a1" });
    assert.equal(result.userMove, "a1", "the user is talking to the agent, not to their phone");
    assert.equal(parseState(fake.written[0])?.board[0], "x");
  } finally {
    fake.restore();
  }
});

test("a move that is not a square is refused without touching WhatsApp", async () => {
  const fake = fakeBridge([]);
  try {
    const result = await run({ action: "auto", move: "north" });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /not a square/i);
    assert.equal(fake.written.length, 0);
  } finally {
    fake.restore();
  }
});

test("with no game running, an auto turn writes nothing", async () => {
  const fake = fakeBridge(["groceries", "call the dentist"]);
  try {
    const result = await run({ action: "auto" });
    assert.equal(result.played, false);
    assert.equal(result.hasGame, false);
    assert.equal(fake.written.length, 0);
  } finally {
    fake.restore();
  }
});

test("status re-posts the current board without advancing the game", async () => {
  const board = renderBoard({
    board: ["x", null, null, null, "o", null, null, null, null],
    user: "x",
    level: "normal",
  });
  const fake = fakeBridge([board]);
  try {
    const result = await run({ action: "status" });
    assert.equal(result.played, false);
    assert.equal(fake.written.length, 1);
    assert.deepEqual(parseState(fake.written[0])?.board, parseState(board)?.board);
  } finally {
    fake.restore();
  }
});

test("a queued second move is reported rather than swallowed", async () => {
  const board = renderBoard({ board: Array(9).fill(null), user: "x", level: "normal" });
  const fake = fakeBridge([board, "a1", "c3"]);
  try {
    const result = await run({ action: "auto" });
    assert.equal(result.userMove, "a1", "moves are played in the order they were typed");
    assert.equal(result.queued, 1, "c3 is still owed a turn");
  } finally {
    fake.restore();
  }
});

test("while the bridge console holds a session, this tool stands down", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    return new Response(
      JSON.stringify({ chat: SELF_CHAT, source: "archive", via: "transport", console: "game" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await run({ action: "auto" });
    assert.equal(result.played, false);
    assert.match(String(result.reason), /console is in `game` mode/i);
    assert.equal(calls.includes("/send/self"), false, "and it writes nothing over the console");
  } finally {
    globalThis.fetch = original;
  }
});

test("two turns started at once answer the move once, not twice", async () => {
  // The bug this exists for was visible in the chat: the same board twice, four
  // seconds apart, because two schedule ticks overlapped and each read a chat
  // that nobody had answered yet.
  const board = renderBoard({ board: Array(9).fill(null), user: "x", level: "normal" });
  const fake = fakeBridge([board, "a1"]);
  try {
    const [first, second] = await Promise.all([run({ action: "auto" }), run({ action: "auto" })]);

    const played = [first, second].filter((r) => r.played);
    assert.equal(played.length, 1, "exactly one of the two turns may play");
    assert.equal(fake.written.length, 1, "and exactly one board is written");
  } finally {
    fake.restore();
  }
});

test("a turn that was overtaken while it was being decided writes nothing", async () => {
  // The other writer here is a different process, which no in-process queue can
  // serialise — so the write is made conditional on the read still being true.
  const board = renderBoard({ board: Array(9).fill(null), user: "x", level: "normal" });
  const fake = fakeBridge([board, "a1"]);
  const original = globalThis.fetch;
  let reads = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    // The second archive read is the pre-write check. Answer it with a chat that
    // has moved on, as though another process had just posted its own board.
    if (url.pathname === "/archive/messages" && ++reads === 2) {
      return new Response(
        JSON.stringify({ chat: SELF_CHAT, messages: [{ key: "z", kind: "text", text: "something else" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return original(input as never, init);
  }) as typeof fetch;

  try {
    const result = await run({ action: "auto" });
    assert.equal(result.played, false);
    assert.match(String(result.reason), /moved while this turn was being decided/i);
    assert.equal(fake.written.length, 0, "nothing is written on top of the other writer");
  } finally {
    globalThis.fetch = original;
    fake.restore();
  }
});

test("a bridge that does not know which chat is the user's own reports it and writes nothing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "WA_SELF_CHAT_NAME is unset" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const result = await run({ action: "auto" });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /WA_SELF_CHAT_NAME/);
  } finally {
    globalThis.fetch = original;
  }
});
