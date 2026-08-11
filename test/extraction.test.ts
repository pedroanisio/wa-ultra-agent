import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIDENCE_FLOOR, MAX_ITEMS, normalizeExtraction } from "../agent/lib/extraction.ts";

/**
 * Between the model and the database.
 *
 * A model asked to extract commitments will occasionally cite a message key
 * that does not exist — it is generating an identifier, and identifiers are the
 * easiest thing to hallucinate. The store would reject the whole batch for it,
 * so anything uncitable is dropped here and reported, rather than poisoning a
 * pass that was otherwise good.
 *
 * The other half is the threshold. Most messages produce nothing, and an
 * extractor that finds a commitment in "kkkkk" is worse than one that finds
 * nothing at all.
 */

const keys = new Set(["k1", "k2"]);

const item = (over = {}) => ({
  type: "commitment",
  statement: "send the proposal",
  actor: "Joao",
  confidence: 0.9,
  sourceMessageKey: "k1",
  ...over,
});

test("keeps a well-formed item", () => {
  const { items } = normalizeExtraction([item()], keys);
  assert.equal(items.length, 1);
  assert.equal(items[0].statement, "send the proposal");
});

test("drops an item citing a message that was not in the batch", () => {
  const { items, dropped } = normalizeExtraction([item({ sourceMessageKey: "invented" })], keys);

  assert.deepEqual(items, []);
  assert.equal(dropped.uncited, 1);
});

test("a hallucinated citation does not take the valid items down with it", () => {
  const { items, dropped } = normalizeExtraction(
    [item(), item({ statement: "other", sourceMessageKey: "invented" })],
    keys,
  );

  assert.equal(items.length, 1);
  assert.equal(dropped.uncited, 1);
});

test("drops an item with no statement", () => {
  const { items, dropped } = normalizeExtraction([item({ statement: "   " })], keys);
  assert.deepEqual(items, []);
  assert.equal(dropped.empty, 1);
});

test("drops an item below the confidence floor", () => {
  const { items, dropped } = normalizeExtraction([item({ confidence: 0.1 })], keys);
  assert.deepEqual(items, []);
  assert.equal(dropped.lowConfidence, 1);
});

test("keeps an item exactly at the floor", () => {
  const { items } = normalizeExtraction([item({ confidence: CONFIDENCE_FLOOR })], keys);
  assert.equal(items.length, 1);
});

test("treats a missing confidence as unstated rather than certain", () => {
  const { items, dropped } = normalizeExtraction([item({ confidence: undefined })], keys);
  assert.deepEqual(items, []);
  assert.equal(dropped.lowConfidence, 1);
});

test("clamps a confidence the model exaggerated past 1", () => {
  const { items } = normalizeExtraction([item({ confidence: 4 })], keys);
  assert.equal(items[0].confidence, 1);
});

test("trims whitespace the model left in", () => {
  const { items } = normalizeExtraction([item({ statement: "  send it  ", actor: " Joao " })], keys);
  assert.equal(items[0].statement, "send it");
  assert.equal(items[0].actor, "Joao");
});

test("collapses items that are the same claim from the same message", () => {
  const { items, dropped } = normalizeExtraction([item(), item()], keys);
  assert.equal(items.length, 1);
  assert.equal(dropped.duplicate, 1);
});

test("the same claim from two different messages is two items", () => {
  const { items } = normalizeExtraction([item(), item({ sourceMessageKey: "k2" })], keys);
  assert.equal(items.length, 2);
});

test("rejects a type it does not know", () => {
  const { items, dropped } = normalizeExtraction([item({ type: "vibe" })], keys);
  assert.deepEqual(items, []);
  assert.equal(dropped.badType, 1);
});

test("normalises a due date to a plain ISO date", () => {
  const { items } = normalizeExtraction([item({ dueAt: "2026-08-11T00:00:00Z" })], keys);
  assert.equal(items[0].dueAt, "2026-08-11");
});

test("drops a due date it cannot parse rather than storing nonsense", () => {
  const { items } = normalizeExtraction([item({ dueAt: "sometime soon" })], keys);
  assert.equal(items[0].dueAt, undefined);
});

test("caps a runaway batch and says how many it cut", () => {
  const many = Array.from({ length: MAX_ITEMS + 5 }, (_, i) =>
    item({ statement: `thing ${i}` }),
  );
  const { items, dropped } = normalizeExtraction(many, keys);

  assert.equal(items.length, MAX_ITEMS);
  assert.equal(dropped.overflow, 5);
});

test("small talk produces nothing, and that is a success", () => {
  const { items, dropped } = normalizeExtraction([], keys);

  assert.deepEqual(items, []);
  assert.equal(Object.values(dropped).every((n) => n === 0), true);
});

test("tolerates a model returning null or junk instead of a list", () => {
  assert.deepEqual(normalizeExtraction(null as never, keys).items, []);
  assert.deepEqual(normalizeExtraction([null, undefined] as never, keys).items, []);
});
