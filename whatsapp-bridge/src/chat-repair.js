/**
 * Repairing the archive after a display name was stored as a chat address.
 *
 * ── What went wrong, in rows ────────────────────────────────────────────────
 * The interaction twin and the proposal writer took the agent's own string for
 * a conversation and handed it to `store.chatId`, which is an upsert. Every pass
 * over a chat named rather than addressed therefore MINTED a chat:
 *
 *   id 211  name "Alpha + Pais"                  messages 0   arcs 19  contexts 10  proposals 4
 *   id 207  name "Duo"                          messages 0   arcs  5  contexts 10  proposals 7
 *   ... nine of them, on 12 August 2026 ...
 *
 * while the conversations those names belong to —
 * `120363000000000001@g.us` with 537 messages, `120363000000000002@g.us` with
 * 831 — carried no model at all. The reading side then matched the phantom
 * first, so eight groups reported themselves empty on the user's phone.
 *
 * ── What this does about it ─────────────────────────────────────────────────
 * Moves every derived row (arcs, their goals, contexts, proposals, the pass
 * record) onto the real conversation and deletes the phantom. The content keys
 * of all four tables are derived from the chat STRING, so each one is
 * recomputed against the address — a key left as it was would fork the arc the
 * next time the twin ran, which is the same defect wearing different clothes.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 * Name-keyed rows that hold MESSAGES are left exactly alone and reported. Those
 * are real conversations from before the transport existed (`identity_kind` is
 * null for them), not phantoms, and merging correspondence between two chats is
 * a different operation with a different risk: a message is evidence, and moving
 * evidence on a name match is how an archive starts lying. They are listed so
 * the decision stays with the operator.
 *
 * The plan is computed separately from the application so it can be printed,
 * read and disbelieved before anything is written.
 */

import { isProtocolAddress, resolveChatAddress } from "./chat-address.js";
import { arcKeyFor, contentKey } from "./store.js";

/** Every chat, with the counts that decide whether it is a phantom. */
function chatRows(db) {
  return db
    .prepare(
      `SELECT c.id, c.name, c.display_name AS displayName, c.identity_kind AS kind,
              (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messages,
              (SELECT COUNT(*) FROM arcs a WHERE a.chat_id = c.id) AS arcs,
              (SELECT COUNT(*) FROM contexts x WHERE x.chat_id = c.id) AS contexts,
              (SELECT COUNT(*) FROM proposals p WHERE p.chat_id = c.id) AS proposals,
              (SELECT COUNT(*) FROM twin_passes t WHERE t.chat_id = c.id) AS passes
         FROM chats c
        ORDER BY c.id`,
    )
    .all();
}

/**
 * What a repair would do, without doing any of it.
 *
 * @returns `{ merges, orphans, legacy }` — `merges` are phantoms with a real
 *          conversation to fold into, `orphans` are phantoms whose name matches
 *          nothing (nothing is deleted for those either: an unexplained row is
 *          evidence, and this prints it rather than tidying it away), `legacy`
 *          are name-keyed chats that hold messages and are none of this
 *          function's business.
 */
export function planPhantomChatRepair(db) {
  const rows = chatRows(db);
  const real = rows.filter((row) => isProtocolAddress(row.name));

  const merges = [];
  const orphans = [];
  const legacy = [];

  for (const row of rows) {
    if (isProtocolAddress(row.name)) continue;
    if (row.messages > 0) {
      legacy.push(row);
      continue;
    }

    let target = null;
    try {
      // Resolved against the ADDRESSED chats only: a phantom must never be
      // offered another phantom as its home. The resolver speaks in `key`, which
      // is this table's `name` column — the address.
      const { key } = resolveChatAddress(
        real.map((candidate) => ({ ...candidate, key: candidate.name })),
        row.name,
      );
      target = key ? real.find((candidate) => candidate.name === key) : null;
    } catch {
      // An ambiguous name is not repairable without a human deciding which
      // conversation it meant. It stays where it is and is reported.
      target = null;
    }

    if (!target) {
      orphans.push(row);
      continue;
    }
    merges.push({ phantom: row, into: target });
  }

  return { merges, orphans, legacy };
}

/**
 * Move one phantom's derived rows onto its real conversation and delete it.
 *
 * Returns what it moved, so the caller can print a receipt rather than a claim.
 */
function mergeOne(db, phantom, into) {
  const moved = { arcs: 0, arcsMerged: 0, goals: 0, contexts: 0, contextsDropped: 0, proposals: 0, proposalsDropped: 0, passes: 0 };

  const arcs = db.prepare("SELECT id, key, title FROM arcs WHERE chat_id = ?").all(phantom.id);
  /** Old arc id → the arc id that now holds its thread. */
  const arcMap = new Map();

  for (const arc of arcs) {
    const key = arcKeyFor(into.name, arc.title);
    const existing = db.prepare("SELECT id FROM arcs WHERE key = ? AND id <> ?").get(key, arc.id);

    if (existing) {
      // The real chat already models this thread. Its row wins; the phantom's
      // goals are folded into it and the duplicate arc goes.
      arcMap.set(arc.id, existing.id);
      for (const goal of db.prepare("SELECT * FROM goals WHERE arc_id = ?").all(arc.id)) {
        const goalKey = contentKey("goal", key, goal.holder, goal.statement);
        const clash = db.prepare("SELECT id FROM goals WHERE key = ?").get(goalKey);
        if (clash) {
          db.prepare("DELETE FROM goals WHERE id = ?").run(goal.id);
        } else {
          db.prepare("UPDATE goals SET arc_id = ?, key = ? WHERE id = ?").run(existing.id, goalKey, goal.id);
          moved.goals++;
        }
      }
      db.prepare("UPDATE proposals SET arc_id = ? WHERE arc_id = ?").run(existing.id, arc.id);
      db.prepare("DELETE FROM arcs WHERE id = ?").run(arc.id);
      moved.arcsMerged++;
      continue;
    }

    db.prepare("UPDATE arcs SET chat_id = ?, key = ? WHERE id = ?").run(into.id, key, arc.id);
    arcMap.set(arc.id, arc.id);
    moved.arcs++;

    // A goal's key is derived from its ARC's key, so re-keying the arc re-keys
    // every goal under it. Left alone, the next pass would insert a second copy
    // of each goal it already knows.
    for (const goal of db.prepare("SELECT * FROM goals WHERE arc_id = ?").all(arc.id)) {
      const goalKey = contentKey("goal", key, goal.holder, goal.statement);
      if (goalKey === goal.key) continue;
      const clash = db.prepare("SELECT id FROM goals WHERE key = ?").get(goalKey);
      if (clash) {
        db.prepare("DELETE FROM goals WHERE id = ?").run(goal.id);
      } else {
        db.prepare("UPDATE goals SET key = ? WHERE id = ?").run(goalKey, goal.id);
        moved.goals++;
      }
    }
  }

  for (const context of db.prepare("SELECT * FROM contexts WHERE chat_id = ?").all(phantom.id)) {
    const key = contentKey("context", into.name, context.dimension, context.statement);
    const clash = db.prepare("SELECT id FROM contexts WHERE key = ? AND id <> ?").get(key, context.id);
    if (clash) {
      // The real chat already carries this observation, word for word.
      db.prepare("DELETE FROM contexts WHERE id = ?").run(context.id);
      moved.contextsDropped++;
      continue;
    }
    db.prepare("UPDATE contexts SET chat_id = ?, key = ? WHERE id = ?").run(into.id, key, context.id);
    moved.contexts++;
  }

  for (const proposal of db.prepare("SELECT * FROM proposals WHERE chat_id = ?").all(phantom.id)) {
    const arcId = proposal.arc_id === null ? null : (arcMap.get(proposal.arc_id) ?? proposal.arc_id);
    const key = contentKey("proposal", into.name, proposal.kind, arcId ?? "", proposal.draft ?? proposal.headline);
    const clash = db.prepare("SELECT id, times_proposed FROM proposals WHERE key = ? AND id <> ?").get(key, proposal.id);
    if (clash) {
      // The same move, already filed against the real chat. Keep the survivor —
      // and keep its status, which is what makes a dismissal stick — but count
      // the duplicate as a re-proposal rather than losing it.
      db.prepare("UPDATE proposals SET times_proposed = times_proposed + ? WHERE id = ?").run(
        proposal.times_proposed,
        clash.id,
      );
      db.prepare("DELETE FROM proposals WHERE id = ?").run(proposal.id);
      moved.proposalsDropped++;
      continue;
    }
    db.prepare("UPDATE proposals SET chat_id = ?, arc_id = ?, key = ? WHERE id = ?").run(
      into.id,
      arcId,
      key,
      proposal.id,
    );
    moved.proposals++;
  }

  const phantomPass = db.prepare("SELECT * FROM twin_passes WHERE chat_id = ?").get(phantom.id);
  if (phantomPass) {
    const realPass = db.prepare("SELECT * FROM twin_passes WHERE chat_id = ?").get(into.id);
    db.prepare("DELETE FROM twin_passes WHERE chat_id = ?").run(phantom.id);
    // The later pass is the honest one: staleness is the whole point of the row,
    // and taking the older of two would claim the twin is more out of date than
    // it is.
    if (!realPass || realPass.modelled_at < phantomPass.modelled_at) {
      db.prepare(
        `INSERT INTO twin_passes (chat_id, through_message_key, considered, modelled_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET through_message_key = excluded.through_message_key,
                                            considered = excluded.considered,
                                            modelled_at = excluded.modelled_at`,
      ).run(into.id, phantomPass.through_message_key, phantomPass.considered, phantomPass.modelled_at);
    }
    moved.passes++;
  }

  db.prepare("DELETE FROM chats WHERE id = ?").run(phantom.id);
  return moved;
}

/**
 * Carry out a plan.
 *
 * One transaction for the whole repair: a half-merged archive — arcs moved,
 * proposals not — is worse than an unrepaired one, because the second run would
 * be reasoning about rows the first left in an intermediate state.
 */
export function applyPhantomChatRepair(db, plan = planPhantomChatRepair(db)) {
  const receipts = [];
  db.exec("BEGIN");
  try {
    for (const { phantom, into } of plan.merges) {
      receipts.push({ from: phantom.name, into: into.name, moved: mergeOne(db, phantom, into) });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { merged: receipts.length, receipts, orphans: plan.orphans, legacy: plan.legacy };
}
