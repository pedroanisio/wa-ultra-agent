import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { SCHEMA_VERSION, openStore } from "../src/store.js";

/**
 * That an existing archive survives a schema change.
 *
 * ── Why this file has to exist ──────────────────────────────────────────────
 * Every other test in this suite opens `:memory:`, so every other test sees a
 * database built from the CURRENT schema by definition. That makes them blind to
 * the one failure that matters here: `CREATE TABLE IF NOT EXISTS` does nothing to
 * a table that already exists, so adding a column to `SCHEMA` leaves a real
 * archive on disk without it. The tests go green, and the first query naming the
 * new column fails at runtime, on the operator's machine only, against the file
 * holding their correspondence.
 *
 * So the fixtures below build a database the way the OLD code did, then open it
 * with the current code, and check both that it was upgraded and that nothing in
 * it was lost.
 *
 * ── The test that actually prevents the bug ─────────────────────────────────
 * `migrated and fresh databases agree` is the important one. Keeping `SCHEMA`
 * (for new installs) and `MIGRATIONS` (for existing ones) in step is a chore that
 * humans reliably fail at, and the failure is silent: two code paths that produce
 * different schemas, where only one is ever exercised by tests. Comparing the two
 * resulting schemas directly is the only check that cannot be fooled by
 * remembering to update one and not the other.
 */

/**
 * The archive as it existed before schema versioning — i.e. what is on the
 * operator's disk right now.
 *
 * Only the tables this migration touches, plus the two they cite. Deliberately
 * hand-written rather than derived from `SCHEMA`: a baseline generated from the
 * current code would drift along with it and stop representing the past, which
 * is the one thing it is for.
 */
const BASELINE_V0 = `
CREATE TABLE IF NOT EXISTS chats (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY,
  key              TEXT NOT NULL UNIQUE,
  chat_id          INTEGER NOT NULL REFERENCES chats(id),
  sender           TEXT,
  sent_at          TEXT,
  sent_at_iso      TEXT,
  kind             TEXT NOT NULL,
  text             TEXT NOT NULL,
  outgoing         INTEGER,
  duration_seconds INTEGER,
  filename         TEXT,
  caption          TEXT,
  ingested_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facts (
  id                 INTEGER PRIMARY KEY,
  subject            TEXT,
  statement          TEXT NOT NULL,
  source_message_key TEXT NOT NULL REFERENCES messages(key),
  confidence         REAL,
  created_at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS aliases (
  alias      TEXT PRIMARY KEY,
  canonical  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "wa-migrate-"));
  test.after?.(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A pre-versioning archive with real rows in it, at `path`. */
function seedLegacyArchive(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(BASELINE_V0);
  db.prepare("INSERT INTO chats (name, first_seen, last_seen) VALUES (?, ?, ?)").run(
    "Helena Braga",
    "2026-07-01T10:00:00.000Z",
    "2026-08-01T10:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO messages (key, chat_id, sender, sent_at, sent_at_iso, kind, text, outgoing, ingested_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "msg-legacy-1",
    "Helena Braga",
    "01/08/2026 10:00",
    "2026-08-01T10:00:00.000Z",
    "text",
    "o azulejista pode semana que vem",
    0,
    "2026-08-01T10:05:00.000Z",
  );
  db.prepare(
    `INSERT INTO facts (subject, statement, source_message_key, confidence, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("Helena", "the tiler is free next week", "msg-legacy-1", 0.9, "2026-08-01T10:06:00.000Z");
  db.prepare("INSERT INTO aliases (alias, canonical, created_at) VALUES (?, ?, ?)").run(
    "nickname",
    "Helena Braga",
    "2026-08-01T10:07:00.000Z",
  );
  db.close();
}

/**
 * The EFFECTIVE schema — what the database can actually store.
 *
 * Deliberately not the text in `sqlite_master`. SQLite keeps the original
 * `CREATE TABLE` statement verbatim and `ALTER TABLE ADD COLUMN` appends to it,
 * so a migrated table's DDL can never be byte-identical to a freshly created
 * one: comments differ, whitespace differs, the trailing paren sits elsewhere.
 * Comparing that text reports drift on every migration forever, and a check that
 * always fails gets deleted.
 *
 * Column name, type, nullability, default and primary-key position — plus the
 * indexes — are what a query actually depends on. Two databases that agree on
 * these behave identically, whatever their DDL reads like.
 */
function schemaOf(path) {
  const db = new DatabaseSync(path);
  const objects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    .all();

  const lines = [];
  for (const { type, name } of objects) {
    if (type === "table") {
      const cols = db
        .prepare("SELECT name, type, [notnull], dflt_value, pk FROM pragma_table_info(?)")
        .all(name)
        .map((c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value ?? "-"} pk=${c.pk}`);
      lines.push(`table ${name}\n  ${cols.join("\n  ")}`);
    } else {
      lines.push(`${type} ${name}`);
    }
  }
  db.close();
  return lines.join("\n");
}

function userVersion(path) {
  const db = new DatabaseSync(path);
  const v = db.prepare("PRAGMA user_version").get().user_version;
  db.close();
  return v;
}

test("migration: a pre-versioning archive is upgraded in place", () => {
  const path = join(tempDir(), "legacy.db");
  seedLegacyArchive(path);
  assert.equal(userVersion(path), 0, "a pre-versioning archive reports version 0");

  const store = openStore(path);
  store.close();

  assert.equal(userVersion(path), SCHEMA_VERSION, "the archive is stamped with the current version");
});

test("migration: nothing already in the archive is lost", () => {
  const path = join(tempDir(), "keeps.db");
  seedLegacyArchive(path);

  const store = openStore(path);
  const stats = store.stats();
  assert.equal(stats.chats, 1, "the chat survived");
  assert.equal(stats.messages, 1, "the message survived");
  assert.equal(stats.facts, 1, "the fact survived");

  // And it is still readable through the normal query path, citation intact.
  const [fact] = store.factsWithSource({ subject: "Helena" });
  assert.equal(fact.statement, "the tiler is free next week");
  assert.equal(fact.source_text, "o azulejista pode semana que vem");
  assert.equal(store.aliasMap().get("nickname"), "Helena Braga");
  store.close();
});

test("migration: the columns the new features need are actually there", () => {
  const path = join(tempDir(), "columns.db");
  seedLegacyArchive(path);
  const store = openStore(path);
  store.close();

  const db = new DatabaseSync(path);
  const columns = (table) =>
    db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((r) => r.name);

  // Retraction: a fact that has gone stale or was planted must be removable
  // without deleting the row that proves it was ever believed.
  assert.ok(columns("facts").includes("retracted_at"), "facts.retracted_at exists");
  assert.ok(columns("facts").includes("retraction_reason"), "facts.retraction_reason exists");

  // Alias provenance: an alias learned from message text is message content
  // influencing recipient resolution, and has to be distinguishable from one the
  // user stated in session.
  assert.ok(columns("aliases").includes("origin"), "aliases.origin exists");
  assert.ok(columns("aliases").includes("source_message_key"), "aliases.source_message_key exists");
  db.close();
});

test("migration: an alias that predates provenance is marked as unknown, not as trusted", () => {
  // The dangerous default. Back-filling old rows with 'session' would silently
  // assert the user stated them, which nobody knows. Unknown is the truth.
  const path = join(tempDir(), "backfill.db");
  seedLegacyArchive(path);
  const store = openStore(path);
  const rows = store.aliasesWithProvenance();
  store.close();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].alias, "nickname");
  assert.equal(rows[0].origin, "unknown", "a pre-existing alias must not be back-filled as trusted");
});

test("migration: migrated and fresh databases agree", () => {
  // The drift check. SCHEMA builds new installs, MIGRATIONS upgrades old ones,
  // and the only way to know they still describe the same database is to compare
  // the databases they produce.
  const dir = tempDir();

  const migratedPath = join(dir, "migrated.db");
  seedLegacyArchive(migratedPath);
  openStore(migratedPath).close();

  const freshPath = join(dir, "fresh.db");
  openStore(freshPath).close();

  assert.equal(
    schemaOf(migratedPath),
    schemaOf(freshPath),
    "SCHEMA and MIGRATIONS have drifted: a migrated archive and a new one differ",
  );
  assert.equal(userVersion(freshPath), SCHEMA_VERSION, "a fresh archive is stamped too");
});

test("migration: opening an already-current archive changes nothing and does not fail", () => {
  const path = join(tempDir(), "idempotent.db");
  seedLegacyArchive(path);

  openStore(path).close();
  const afterFirst = schemaOf(path);

  // Re-running must not attempt the ALTERs again — SQLite would refuse a
  // duplicate column, which is how a half-written migration bricks an archive.
  assert.doesNotThrow(() => openStore(path).close(), "a second open must be a no-op");
  assert.equal(schemaOf(path), afterFirst, "the schema did not move on the second open");
  assert.equal(userVersion(path), SCHEMA_VERSION);
});

test("migration: a fresh in-memory store is at the current version", () => {
  // Guards the case every other test in the suite relies on.
  const store = openStore(":memory:");
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  store.close();
});
