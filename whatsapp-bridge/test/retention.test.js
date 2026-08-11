import assert from "node:assert/strict";
import { test } from "node:test";

import { openStore, retentionFromEnv } from "../src/store.js";

/**
 * That the archive forgets on a schedule.
 *
 * The corpus this project was audited against treats a retention schedule as a
 * restraint mechanism in its own right, alongside quiet hours and rate limiting —
 * not as housekeeping. The archive is the most sensitive artifact this system
 * creates and it was the only restraint layer with nothing behind it: SPEC §4
 * argues for not storing media bytes because there is "several orders of
 * magnitude more to lose", then kept message text, transcripts, facts and arcs
 * forever.
 *
 * ── The design question these tests settle ──────────────────────────────────
 * Foreign keys are ON, and every derived row cites a message. So pruning a
 * message that a fact cites either fails, or takes the fact with it. Refusing
 * would mean the archive can never shrink, since anything interesting has been
 * cited by something. So the prune CASCADES, and that is a deliberate epistemic
 * position rather than a convenience: a fact whose evidence has been deleted is
 * precisely the uncitable claim this codebase refuses to store in the first
 * place. Keeping it would leave a belief with a dangling receipt.
 *
 * Because that is destructive, the prune reports what it removed, and dry runs
 * are the default at the HTTP layer.
 */

const DAY = 86_400_000;

/**
 * A store with a fixed clock and three messages: two well over a year old, one
 * from two days ago.
 *
 * The timestamps go through the real ingestion path rather than being written
 * behind it. "27/07/2025" has a day above 12, which is what lets
 * `detectDateOrder` settle the whole window as day-first — so this fixture also
 * exercises the parsing that `prune` depends on. A prune driven by a
 * misread date would delete the wrong decade.
 */
function seed({ nowIso = "2026-08-11T12:00:00.000Z" } = {}) {
  const store = openStore(":memory:", { now: () => nowIso });
  store.upsertMessages("Helena Braga", [
    { key: "old-1", time: "07/07/2025 10:00", kind: "text", text: "ancient", outgoing: 0 }, // ~400d
    { key: "old-2", time: "27/07/2025 10:00", kind: "text", text: "also ancient", outgoing: 1 }, // ~380d
    { key: "new-1", time: "09/08/2026 10:00", kind: "text", text: "recent", outgoing: 0 }, // 2d
  ]);
  return store;
}

test("retention: nothing is deleted when no policy is configured", () => {
  const store = seed();
  const result = store.prune({});
  assert.equal(result.messages, 0, "an unconfigured retention policy must be a no-op");
  assert.equal(store.stats().messages, 3);
  assert.equal(result.skipped, true, "and it must say it did nothing rather than report success");
  store.close();
});

test("retention: messages older than the window go, newer ones stay", () => {
  const store = seed();
  const result = store.prune({ messageDays: 365 });
  assert.equal(result.messages, 2, "both 400- and 380-day-old messages are past a 365-day window");
  assert.equal(store.stats().messages, 1);
  assert.deepEqual(
    store.messagesFor("Helena Braga").map((m) => m.key),
    ["new-1"],
  );
  store.close();
});

test("retention: a dry run reports exactly what a real run would remove, and removes nothing", () => {
  const store = seed();
  const dry = store.prune({ messageDays: 365, dryRun: true });
  assert.equal(dry.messages, 2);
  assert.equal(dry.dryRun, true);
  assert.equal(store.stats().messages, 3, "a dry run must not touch the archive");

  const real = store.prune({ messageDays: 365 });
  assert.equal(real.messages, dry.messages, "the dry run must predict the real run exactly");
  store.close();
});

test("retention: pruning a cited message takes the belief that cited it", () => {
  // The cascade, and the reason for it. A fact whose evidence is gone is the
  // uncitable claim the store refuses to accept in the first place; keeping it
  // would leave a belief with a dangling receipt.
  const store = seed();
  store.addFact({ subject: "Helena", statement: "the tiler was cheap in January", sourceMessageKey: "old-1" });
  store.recordTranscript("old-2", "transcribed voice note");
  assert.equal(store.stats().facts, 1);
  assert.equal(store.stats().transcripts, 1);

  const result = store.prune({ messageDays: 365 });

  assert.equal(result.messages, 2);
  assert.equal(result.facts, 1, "the fact citing a pruned message went with it");
  assert.equal(result.transcripts, 1, "so did the transcript");
  assert.equal(store.stats().facts, 0);
  assert.equal(store.stats().transcripts, 0);
  store.close();
});

test("retention: a fact citing a message still inside the window is untouched", () => {
  const store = seed();
  store.addFact({ subject: "Helena", statement: "the tiler is free next week", sourceMessageKey: "new-1" });
  const result = store.prune({ messageDays: 365 });
  assert.equal(result.facts, 0, "a live citation is not collateral");
  assert.equal(store.stats().facts, 1);
  store.close();
});

test("retention: transcripts can expire sooner than the messages they describe", () => {
  // The point of a separate window. A transcript is a verbatim copy of somebody's
  // voice, which is more sensitive than the fact that they sent a voice note.
  const store = seed();
  store.recordTranscript("new-1", "verbatim words from a voice note");
  const result = store.prune({ transcriptDays: 0 });
  assert.equal(result.transcripts, 1, "the transcript expired on its own window");
  assert.equal(result.messages, 0, "the message it described is still inside its own");
  assert.equal(store.stats().messages, 3, "no message window was configured, so none expired");
  store.close();
});

test("retention: an emptied chat is not left behind as a bare name", () => {
  // A chat row with no messages is a record that you spoke to somebody, which is
  // the thing retention is supposed to remove.
  const store = seed();
  store.prune({ messageDays: 1 });
  assert.equal(store.stats().messages, 0);
  assert.equal(store.stats().chats, 0, "a chat with nothing left in it goes too");
  store.close();
});

test("retention: the search index does not keep the text after the row is gone", () => {
  // FTS5 external-content tables are only consistent because of the delete
  // trigger. If pruning bypassed it, the message body would remain searchable
  // after deletion — the archive would claim to have forgotten and would not have.
  const store = seed();
  assert.ok(store.search("ancient").length > 0, "the fixture is searchable before pruning");
  store.prune({ messageDays: 365 });
  assert.equal(store.search("ancient").length, 0, "pruned text must not remain searchable");
  store.close();
});

test("retention: a modelling pass that cited a pruned message does not survive it", () => {
  const store = seed();
  store.saveInteractionModel({
    chat: "Helena Braga",
    throughMessageKey: "old-2",
    considered: 2,
    arcs: [
      {
        title: "the tiler",
        status: "open",
        firstMessageKey: "old-1",
        lastMessageKey: "old-2",
        goals: [{ holder: "them", statement: "book the tiler", sourceMessageKey: "old-1" }],
      },
    ],
    contexts: [{ dimension: "language", statement: "pt-BR", sourceMessageKey: "old-1" }],
  });
  assert.equal(store.stats().arcs, 1);

  const result = store.prune({ messageDays: 365 });
  assert.equal(result.arcs, 1, "an arc spanning only pruned messages goes");
  assert.equal(result.goals, 1);
  assert.equal(result.contexts, 1);
  assert.equal(store.stats().arcs, 0);
  assert.equal(store.stats().goals, 0);
  // And the pass record itself, or the next twin would measure staleness against
  // a message that no longer exists. The chat survives — new-1 is still inside
  // the window — so this is checked on the pass, not on the chat.
  assert.equal(result.twinPasses, 1, "the modelling pass cited a pruned message and went with it");
  assert.ok(store.twin("Helena Braga").coverage.stale, "an unmodelled chat reports as stale");
  store.close();
});

test("retention: retracted facts expire on their own, shorter window", () => {
  // A retracted fact is kept only so "why did I believe this?" stays answerable.
  // That need has a shelf life, and the row is still a claim about a real person.
  const store = openStore(":memory:", { now: () => "2026-08-11T12:00:00.000Z" });
  store.upsertMessages("Helena Braga", [
    { key: "m1", time: "10/08/2026 10:00", kind: "text", text: "recent", outgoing: 0 },
  ]);
  const id = store.addFact({ subject: "Helena", statement: "wrong thing", sourceMessageKey: "m1" });
  store.retractFact(id, "planted by a group chat");

  const kept = store.prune({ retractedFactDays: 90 });
  assert.equal(kept.facts, 0, "a fresh retraction is still within its window");

  const gone = store.prune({ retractedFactDays: 0 });
  assert.equal(gone.facts, 1, "an expired retraction is removed for good");
  assert.equal(store.stats().facts, 0);
  store.close();
});

test("retention: config comes from the environment, and absent means keep forever", () => {
  assert.deepEqual(retentionFromEnv({}), {}, "no configuration is no policy, not a default policy");

  assert.deepEqual(
    retentionFromEnv({
      WA_RETAIN_MESSAGE_DAYS: "365",
      WA_RETAIN_TRANSCRIPT_DAYS: "90",
      WA_RETAIN_RETRACTED_FACT_DAYS: "30",
    }),
    { messageDays: 365, transcriptDays: 90, retractedFactDays: 30 },
  );

  // A misconfigured window must not silently become an aggressive one. Deleting
  // an archive because of a typo in .env is unrecoverable.
  assert.deepEqual(retentionFromEnv({ WA_RETAIN_MESSAGE_DAYS: "not a number" }), {});
  assert.deepEqual(retentionFromEnv({ WA_RETAIN_MESSAGE_DAYS: "-5" }), {});
  assert.deepEqual(retentionFromEnv({ WA_RETAIN_MESSAGE_DAYS: "0" }), { messageDays: 0 });
});
