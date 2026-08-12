import { test } from "node:test";
import assert from "node:assert/strict";

import type { AttentionDigest, ExtractionRow, ProposalRow } from "../agent/lib/bridge.ts";
import { SETTINGS, settingSpec } from "../agent/lib/ui-settings.ts";
import {
  buildQueue,
  needsUserWording,
  pendingRestarts,
  preferenceRows,
  sendConsequences,
  setupGates,
} from "../agent/lib/ui-model.ts";

/**
 * What the five screens decide, tested without a browser.
 *
 * The rules worth holding down are the ones that are invisible when they work:
 * a quiet day produces an empty queue rather than four zeroes, a saved
 * preference is reported as NOT YET IN FORCE rather than as applied, and a
 * draft that names a price is the operator's to word even when the model that
 * wrote it thought otherwise.
 */

function extraction(id: number, over: Partial<ExtractionRow> = {}): ExtractionRow {
  return {
    id,
    type: "promise",
    statement: `statement ${id}`,
    status: "open",
    source_message_key: `msg-${id}`,
    source_text: "…",
    source_chat: "Ana Paula",
    ...over,
  };
}

function proposal(id: number, over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id,
    chat: "Ana Paula",
    kind: "deliver",
    headline: `headline ${id}`,
    rationale: "she cannot book the tiler until she has the price",
    needs_user_wording: 0,
    basis: ["msg-8241"],
    status: "open",
    created_at: "2026-08-01T00:00:00.000Z",
    last_proposed_at: "2026-08-01T00:00:00.000Z",
    times_proposed: 1,
    ...over,
  };
}

function digest(over: Partial<AttentionDigest> = {}): AttentionDigest {
  return {
    asOf: "2026-08-12T09:00:00.000Z",
    horizonDays: 3,
    overdue: [],
    dueSoon: [],
    waitingOn: [],
    unanswered: [],
    total: 0,
    ...over,
  };
}

/* ── the queue ─────────────────────────────────────────────────────── */

test("a quiet day is an empty queue, not a row of zeroes", () => {
  assert.deepEqual(buildQueue(digest(), []), []);
  assert.deepEqual(buildQueue(null, []), []);
});

test("a proposal outranks an obligation, because it arrives with the move worked out", () => {
  const queue = buildQueue(digest({ overdue: [extraction(1)] }), [proposal(7)]);
  assert.equal(queue[0].kind, "proposal");
  assert.equal(queue[1].kind, "overdue");
});

test("within a kind the oldest waits first — this is not a notification feed", () => {
  const queue = buildQueue(
    digest({
      overdue: [
        extraction(1, { due_at: "2026-08-10T00:00:00.000Z" }),
        extraction(2, { due_at: "2026-07-01T00:00:00.000Z" }),
      ],
    }),
    [],
  );
  assert.deepEqual(queue.map((item) => item.ref), ["extraction:2", "extraction:1"]);
});

test("a resolved proposal is not queued", () => {
  const queue = buildQueue(digest(), [proposal(7, { status: "dismissed" })]);
  assert.deepEqual(queue, []);
});

test("what you owe and what you are owed stay separate rows", () => {
  // Merging them by person gives a backlog that reads as failure while burying
  // whichever half is actually somebody else's move.
  const queue = buildQueue(
    digest({ overdue: [extraction(1)], waitingOn: [extraction(2)] }),
    [],
  );
  assert.equal(queue.length, 2);
  assert.notEqual(queue[0].because, queue[1].because);
});

test("every row says why it is there, in words that are not the headline again", () => {
  const queue = buildQueue(
    digest({ overdue: [extraction(1)], unanswered: [extraction(2)], dueSoon: [extraction(3)] }),
    [proposal(9)],
  );
  for (const item of queue) {
    assert.ok(item.because.length > 10, `${item.ref} has no reason`);
    assert.notEqual(item.because, item.headline);
  }
});

test("a proposal carries its draft and the flag that says who must word it", () => {
  const queue = buildQueue(digest(), [
    proposal(7, { draft: "mando hoje", needs_user_wording: 1 }),
  ]);
  assert.equal(queue[0].draft, "mando hoje");
  assert.equal(queue[0].yoursToWord, true);
});

/* ── setup ─────────────────────────────────────────────────────────── */

const BARE = {
  env: {} as Record<string, string | undefined>,
  modelId: "gpt-5.6-luna",
  modelProvider: "openai",
  modelWindow: 922_000,
  bridgeReachable: false,
  transport: null,
  archivedMessages: 0,
  provisionalChats: 0,
};

test("exactly one gate is current, and it is the first unsatisfied one", () => {
  const gates = setupGates({ ...BARE, env: { OPENAI_API_KEY: "k" } });
  assert.equal(gates.filter((g) => g.state === "current").length, 1);
  assert.equal(gates.find((g) => g.state === "current")!.title, "Bridge");
  assert.equal(gates[0].state, "done");
});

test("later gates are todo even when they happen to be satisfiable", () => {
  // Four simultaneous "do this now" rows is how an operator does the one that
  // wastes the pairing.
  const gates = setupGates(BARE);
  const current = gates.findIndex((g) => g.state === "current");
  for (const gate of gates.slice(current + 1)) {
    assert.notEqual(gate.state, "current");
  }
});

test("the pairing gate carries the warning that costs a scan", () => {
  const gates = setupGates({
    ...BARE,
    env: { OPENAI_API_KEY: "k", WA_TRANSPORT_URL: "http://t:8100" },
    bridgeReachable: true,
    transport: { paired: false },
  });
  const pairing = gates.find((g) => g.title === "Link the account")!;
  assert.equal(pairing.state, "current");
  assert.match(pairing.detail, /Logging in/);
});

test("send being off is a satisfied gate, not an unfinished one", () => {
  const gates = setupGates(BARE);
  const sending = gates.find((g) => g.title === "Sending")!;
  assert.equal(sending.state, "done");
  assert.match(sending.detail, /right way to start/);
});

test("an empty allowlist with sending on is reported as permitting nobody", () => {
  const gates = setupGates({ ...BARE, env: { WA_ALLOW_SEND: "true" } });
  assert.match(gates.find((g) => g.title === "Sending")!.detail, /permits nobody/);
});

test("provisional chats keep the names gate open with the restart instruction", () => {
  const gates = setupGates({ ...BARE, archivedMessages: 100, provisionalChats: 6 });
  const names = gates.find((g) => g.title === "Names")!;
  assert.notEqual(names.state, "done");
  assert.match(names.detail, /Restart the transport ONCE/);
});

test("every gate says something, whatever its state", () => {
  for (const gate of setupGates(BARE)) {
    assert.ok(gate.detail.length > 20, `gate ${gate.n} has no detail`);
  }
});

/* ── preferences ───────────────────────────────────────────────────── */

test("a saved change is reported as not yet in force", () => {
  // The most dangerous lie this page could tell is that the send allowlist it
  // shows is the one being enforced.
  const rows = preferenceRows(
    [settingSpec("WA_SEND_ALLOWLIST")!],
    { WA_SEND_ALLOWLIST: "Mum" },
    { WA_SEND_ALLOWLIST: "Mum,Dad" },
  );
  assert.equal(rows[0].effective, "Mum");
  assert.equal(rows[0].pending, "Mum,Dad");
  assert.equal(rows[0].awaitingRestart, true);
  assert.deepEqual(pendingRestarts(rows), ["bridge"]);
});

test("a value that matches the file is not pending anything", () => {
  const rows = preferenceRows(
    [settingSpec("WA_ALLOW_SEND")!],
    { WA_ALLOW_SEND: "true" },
    { WA_ALLOW_SEND: "true" },
  );
  assert.equal(rows[0].awaitingRestart, false);
  assert.deepEqual(pendingRestarts(rows), []);
});

test("a secret is never returned, in either column", () => {
  const rows = preferenceRows(
    [settingSpec("BRAVE_API_KEY")!],
    { BRAVE_API_KEY: "BSA-secret-value" },
    { BRAVE_API_KEY: "BSA-secret-value" },
  );
  assert.ok(!JSON.stringify(rows).includes("secret-value"));
  assert.match(rows[0].effective, /^set · \d+ characters$/);
});

test("every setting produces a row", () => {
  assert.equal(preferenceRows(SETTINGS, {}, {}).length, SETTINGS.length);
});

/* ── edit & send ───────────────────────────────────────────────────── */

test("a send states the irreversible part first", () => {
  const consequences = sendConsequences({ recipient: "Ana Paula", exactMatch: true });
  assert.equal(consequences[0].irreversible, true);
  assert.match(consequences[0].text, /immediately/);
});

test("a fuzzy match is stated before the send, not reported after it", () => {
  const consequences = sendConsequences({ recipient: "Ana Paula", exactMatch: false });
  assert.ok(consequences.some((c) => /fuzzy match/.test(c.text)));
});

test("the invisible consequences are listed too", () => {
  const consequences = sendConsequences({
    recipient: "Ana Paula",
    exactMatch: true,
    closesObligation: "send Ana the tiler quote",
    resolvesProposal: 77,
  });
  const text = consequences.map((c) => c.text).join(" ");
  assert.match(text, /Closes: send Ana the tiler quote/);
  assert.match(text, /#77/);
});

/* ── whose words ───────────────────────────────────────────────────── */

test("the model's flag alone is enough", () => {
  assert.equal(needsUserWording("tudo bem", true), true);
});

test("a price, a time, or an apology raises the flag the model missed", () => {
  for (const draft of [
    "mando o valor R$ 4.200 hoje",
    "I'll send it tomorrow",
    "posso quinta às 14:30",
    "desculpa a demora",
    "sorry for the delay",
  ]) {
    assert.equal(needsUserWording(draft, false), true, draft);
  }
});

test("an ordinary sentence is not flagged", () => {
  // A flag that fires on everything routes every draft to the operator and
  // stops meaning anything.
  for (const draft of ["oi, tudo bem?", "vou ver e te falo", "thanks, got it"]) {
    assert.equal(needsUserWording(draft, false), false, draft);
  }
});

test("an unset file value running on a default is not a pending change", () => {
  // compose writes ${WA_IMAGE_MODEL:-gpt-image-1}, so the process has a value
  // the file never mentioned. Reporting that as "saved, restart to apply" fired
  // on a page nobody had touched — and a banner that cries wolf is worse than
  // no banner, because the one that matters is the send allowlist.
  const rows = preferenceRows(
    [settingSpec("WA_IMAGE_MODEL")!],
    { WA_IMAGE_MODEL: "gpt-image-1" },
    {},
  );
  assert.equal(rows[0].awaitingRestart, false);
  assert.equal(rows[0].defaulted, true);
  assert.deepEqual(pendingRestarts(rows), []);
});

test("a boolean that the file does not set carries its real default", () => {
  // WA_ALLOW_SELF_NOTE unset means TRUE. Rendering it as `false` shows the
  // opposite of what is running, and one Save switches self notes off.
  const rows = preferenceRows([settingSpec("WA_ALLOW_SELF_NOTE")!], {}, {});
  assert.equal(rows[0].pending, "");
  assert.equal(rows[0].defaultValue, "true");
});
