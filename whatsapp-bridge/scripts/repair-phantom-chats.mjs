#!/usr/bin/env node
/**
 * Fold phantom, name-keyed chat rows back into the conversations they shadow.
 *
 * Dry by default. Nothing is written unless `--apply` is passed, and `--apply`
 * makes a copy of the database beside it first — this rewrites content keys in
 * four tables, and a repair that cannot be undone is a worse bug than the one it
 * fixes.
 *
 *   node scripts/repair-phantom-chats.mjs                 # what it would do
 *   node scripts/repair-phantom-chats.mjs --apply         # do it, after a backup
 *   WA_STORE_PATH=/data/store.db node scripts/... --apply # in the container
 *
 * See src/chat-repair.js for what a phantom is and why it exists.
 */

import { DatabaseSync } from "node:sqlite";
import { copyFileSync } from "node:fs";

import { applyPhantomChatRepair, planPhantomChatRepair } from "../src/chat-repair.js";

const path = process.env.WA_STORE_PATH || "./data/store.db";
const apply = process.argv.includes("--apply");

const db = new DatabaseSync(path);
db.exec("PRAGMA foreign_keys = ON");

const plan = planPhantomChatRepair(db);

console.log(`archive: ${path}`);
console.log(`phantom chats to fold in: ${plan.merges.length}`);
for (const { phantom, into } of plan.merges) {
  console.log(
    `  "${phantom.name}" (0 messages, ${phantom.arcs} arcs, ${phantom.contexts} contexts, ` +
      `${phantom.proposals} proposals)\n    → ${into.name} ("${into.displayName}", ${into.messages} messages)`,
  );
}
if (plan.orphans.length) {
  console.log(`\nname-keyed rows with no conversation to fold into (left alone): ${plan.orphans.length}`);
  for (const row of plan.orphans) console.log(`  "${row.name}"`);
}
if (plan.legacy.length) {
  console.log(`\nname-keyed rows that hold messages (NOT touched — see chat-repair.js): ${plan.legacy.length}`);
  for (const row of plan.legacy) console.log(`  "${row.name}" — ${row.messages} messages`);
}

if (!apply) {
  console.log("\nDry run. Nothing was written. Pass --apply to carry this out.");
  process.exit(0);
}

if (plan.merges.length === 0) {
  console.log("\nNothing to do.");
  process.exit(0);
}

const backup = `${path}.before-phantom-repair-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(path, backup);
console.log(`\nbackup: ${backup}`);

const result = applyPhantomChatRepair(db, plan);
for (const receipt of result.receipts) {
  const m = receipt.moved;
  console.log(
    `merged "${receipt.from}" → ${receipt.into}: arcs ${m.arcs} moved / ${m.arcsMerged} folded, ` +
      `goals ${m.goals}, contexts ${m.contexts} (+${m.contextsDropped} duplicate), ` +
      `proposals ${m.proposals} (+${m.proposalsDropped} duplicate), passes ${m.passes}`,
  );
}
console.log(`\ndone: ${result.merged} phantom chat(s) removed.`);
