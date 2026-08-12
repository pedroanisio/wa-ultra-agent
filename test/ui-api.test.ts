import { test } from "node:test";
import assert from "node:assert/strict";

import { BridgeError } from "../agent/lib/bridge.ts";
import {
  UiError,
  preferencesScreen,
  queueScreen,
  resolveQueueItem,
  savePreferences,
  sendFromUi,
  setupScreen,
  toolsScreen,
} from "../agent/lib/ui-api.ts";
import type { UiDeps } from "../agent/lib/ui-api.ts";

/**
 * The screens, with the bridge injected.
 *
 * Two orderings are asserted here because getting either wrong is invisible in
 * a happy path and expensive in a real one. A send must land BEFORE its
 * obligation is closed — otherwise a failed send leaves the queue quiet about
 * something nobody delivered. And a resolve that fails AFTER a successful send
 * must not report the send as failed, because the message is already on
 * somebody's phone.
 */

/** A bridge that records what it was asked and answers with whatever is set. */
function fakeBridge(over: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string, impl: (...args: any[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(impl(...args));
    };

  const base = {
    status: () => ({ archive: { chats: 1, messages: 10 }, transport: "configured" }),
    attention: () => ({
      asOf: "2026-08-12T09:00:00.000Z",
      horizonDays: 3,
      overdue: [],
      dueSoon: [],
      waitingOn: [],
      unanswered: [],
      total: 0,
    }),
    listProposals: () => ({ proposals: [] }),
    resolveProposal: () => ({ id: 1, status: "accepted" }),
    resolveExtraction: () => ({ id: 1, status: "done" }),
    readChat: () => ({ chat: "Ana Paula", messages: [] }),
    twin: () => ({ metrics: { messages: 61 }, arcs: [], goals: [], contexts: [], coverage: {} }),
    sendMessage: () => ({
      id: "3EB0",
      sentAt: "2026-08-12T09:00:00.000Z",
      requestedRecipient: "Ana",
      resolvedName: "Ana Paula",
      via: "transport",
    }),
    writeSelf: () => ({ sent: true }),
    archiveStats: () => ({ chats: 3, messages: 128441, transcripts: 0, facts: 0 }),
    transportStatus: () => ({ session: { paired: true, connected: true } }),
    listChats: () => ({ chats: [] }),
    ...over,
  };

  const wrapped = Object.fromEntries(
    Object.entries(base).map(([name, impl]) => [name, record(name, impl as never)]),
  );
  return { bridge: wrapped as UiDeps["bridge"], calls };
}

function deps(over: Partial<UiDeps> = {}): UiDeps {
  const { bridge } = fakeBridge();
  let file = "WA_ALLOW_SEND=false\nWA_SEND_ALLOWLIST=\n";
  return {
    bridge,
    env: {},
    readEnvFile: async () => file,
    writeEnvFile: async (text: string) => {
      file = text;
    },
    turns: () => ({ running: [] }),
    ...over,
  };
}

/* ── the queue ─────────────────────────────────────────────────────── */

test("a section that fails to load does not take the whole queue down", async () => {
  // A queue that renders nothing because one of four reads failed is worse than
  // one missing a section — the operator is here to act on what IS available.
  const { bridge } = fakeBridge({
    attention: () => {
      throw new BridgeError("archive unavailable", 503);
    },
  });
  const screen = await queueScreen(deps({ bridge }));
  assert.deepEqual(screen.items, []);
  assert.equal(screen.status.archivedMessages, 128441);
});

test("the queue reports the send gate and the allowlist actually in force", async () => {
  const screen = await queueScreen(
    deps({ env: { WA_ALLOW_SEND: "true", WA_SEND_ALLOWLIST: "Mum, Ana Paula" } }),
  );
  assert.equal(screen.status.sendOn, true);
  assert.deepEqual(screen.status.allowlist, ["Mum", "Ana Paula"]);
});

/* ── resolving without sending ─────────────────────────────────────── */

test("accepting a proposal from the list does not send anything", async () => {
  const { bridge, calls } = fakeBridge();
  await resolveQueueItem(deps({ bridge }), "proposal:12", "accept");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["resolveProposal"],
  );
  assert.ok(!calls.some((c) => c.method === "sendMessage"));
});

test("a malformed ref is refused rather than guessed at", async () => {
  for (const ref of ["proposal:", "nonsense", "extraction:0", "extraction:-3"]) {
    await assert.rejects(() => resolveQueueItem(deps(), ref, "accept"), UiError, ref);
  }
});

test("the bridge's own status survives instead of becoming a 500", async () => {
  const { bridge } = fakeBridge({
    resolveProposal: () => {
      throw new BridgeError("no such proposal", 404);
    },
  });
  await assert.rejects(
    () => resolveQueueItem(deps({ bridge }), "proposal:9", "accept"),
    (error: UiError) => error.status === 404,
  );
});

/* ── sending ───────────────────────────────────────────────────────── */

test("the send lands before the row is closed", async () => {
  const { bridge, calls } = fakeBridge();
  await sendFromUi(deps({ bridge }), {
    to: "Ana",
    message: "mando hoje",
    ref: "proposal:77",
  });
  const order = calls.map((c) => c.method);
  assert.deepEqual(order, ["sendMessage", "resolveProposal"]);
});

test("a refused send closes nothing", async () => {
  // The queue going quiet about a message nobody delivered is the failure this
  // whole screen exists to prevent.
  const { bridge, calls } = fakeBridge({
    sendMessage: () => {
      throw new BridgeError("not allowlisted", 403);
    },
  });
  await assert.rejects(
    () => sendFromUi(deps({ bridge }), { to: "Stranger", message: "hi", ref: "proposal:77" }),
    (error: UiError) => error.status === 403,
  );
  assert.ok(!calls.some((c) => c.method === "resolveProposal"));
});

test("a resolve that fails after a delivered send still reports the send as sent", async () => {
  const { bridge } = fakeBridge({
    resolveProposal: () => {
      throw new BridgeError("gone", 404);
    },
  });
  const result = await sendFromUi(deps({ bridge }), {
    to: "Ana",
    message: "mando hoje",
    ref: "proposal:77",
  });
  assert.equal(result.sent, true);
  assert.equal(result.resolved, undefined);
});

test("a fuzzy match is reported on the result", async () => {
  const result = await sendFromUi(deps(), { to: "Ana", message: "oi" });
  assert.equal(result.resolvedName, "Ana Paula");
  assert.equal(result.exactMatch, false);
  assert.ok(result.consequences.some((c) => /fuzzy/.test(c.text)));
});

test("an empty message is refused before it reaches the bridge", async () => {
  const { bridge, calls } = fakeBridge();
  await assert.rejects(() => sendFromUi(deps({ bridge }), { to: "Ana", message: "   " }), UiError);
  assert.deepEqual(calls, []);
});

test("sending to your own chat needs no recipient", async () => {
  const { bridge, calls } = fakeBridge();
  const result = await sendFromUi(deps({ bridge }), { to: "", message: "note", toSelf: true });
  assert.equal(result.sent, true);
  assert.deepEqual(calls.map((c) => c.method), ["writeSelf"]);
});

/* ── setup ─────────────────────────────────────────────────────────── */

test("an unreachable bridge is a failed gate, not a failed page", async () => {
  const { bridge } = fakeBridge({
    status: () => {
      throw new BridgeError("connection refused", 0);
    },
    transportStatus: () => {
      throw new BridgeError("connection refused", 0);
    },
    archiveStats: () => {
      throw new BridgeError("connection refused", 0);
    },
  });
  const screen = await setupScreen(deps({ bridge, env: { OPENAI_API_KEY: "k" } }));
  assert.equal(screen.gates.find((g) => g.title === "Bridge")!.state, "current");
  assert.equal(screen.paired, false);
});

/* ── preferences ───────────────────────────────────────────────────── */

test("with no file mounted, the screen says so instead of offering to save", async () => {
  const screen = await preferencesScreen(deps({ readEnvFile: async () => null }));
  assert.equal(screen.writable, false);
});

test("saving without a file is refused loudly rather than reported as saved", async () => {
  await assert.rejects(
    () => savePreferences(deps({ readEnvFile: async () => null }), { WA_ALLOW_SEND: "true" }),
    (error: UiError) => error.status === 409,
  );
});

test("a save writes the file and names what must restart", async () => {
  let written = "";
  const result = await savePreferences(
    deps({
      readEnvFile: async () => "WA_ALLOW_SEND=false\n",
      writeEnvFile: async (text) => {
        written = text;
      },
    }),
    { WA_ALLOW_SEND: "true" },
  );
  assert.match(written, /^WA_ALLOW_SEND=true$/m);
  assert.deepEqual(result.saved, ["WA_ALLOW_SEND"]);
  // The process is still running with the old value, so the change is pending.
  assert.deepEqual(result.restarts, ["bridge"]);
});

test("a key outside the allowlist is a 400, and nothing is written", async () => {
  let wrote = false;
  await assert.rejects(
    () =>
      savePreferences(
        deps({
          readEnvFile: async () => "",
          writeEnvFile: async () => {
            wrote = true;
          },
        }),
        { WA_BRIDGE_TOKEN: "stolen" },
      ),
    (error: UiError) => error.status === 400,
  );
  assert.equal(wrote, false);
});

/* ── tools ─────────────────────────────────────────────────────────── */

test("the tools screen groups by what a call costs, and every group is present", async () => {
  const screen = toolsScreen(deps({ env: { WA_ALLOW_SEND: "true" } }));
  assert.deepEqual(
    screen.groups.map((g) => g.group),
    ["reading", "writing", "remembering", "making"],
  );
  assert.equal(
    screen.groups.reduce((total, group) => total + group.tools.length, 0),
    screen.tally.total,
  );
});
