import { test } from "node:test";
import assert from "node:assert/strict";

import { isProtocolAddress, resolveChatAddress } from "../src/chat-address.js";

/**
 * Resolving a conversation from whatever it was called.
 *
 * Every case here is a SHAPE that occurred in a live archive on 12 August 2026,
 * when eight groups reported themselves empty while holding thousands of
 * messages between them. The first test is the one that failed.
 *
 * ── Why none of these names or keys are real ────────────────────────────────
 * This repository is public, and a chat name is correspondence: "who is in a
 * group called X with whom" is exactly the thing an archive exists to keep
 * private. Every fixture below is invented, and every identity key is either a
 * documentation-range number or assembled from parts at run time — the way
 * `no-real-identities.test.js` builds its own. What the tests need is the shape
 * of a name (a plus sign, a comma, an emoji, an ampersand, an accent), never
 * anybody's actual group.
 */

const chat = (key, displayName, messages = 0) => ({ key, displayName, messages });

/** Group JIDs in the two forms the protocol issues, with synthetic digits. */
const GROUP_A = "120363000000000001@g.us";
const GROUP_B = "120363000000000002@g.us";
const GROUP_C = "120363000000000003@g.us";
const GROUP_D = "120363000000000004@g.us";
const GROUP_E = "120363000000000005@g.us";
/** The other legal group form: `<phone>-<timestamp>@g.us`, documentation range. */
const GROUP_PHONE = "15550001111" + "-1000000000@g.us";
/** A person. Assembled, so no `<digits>@lid` literal appears in a tracked file. */
const PERSON = `${"9988" + "776655443322"}@lid`;
const PERSON_PROVISIONAL = "pn:" + "0000aaaa1111bbbb2222";

/* ---------------------------------------------------------------- *
 * The regression: a phantom must never shadow the chat it names.
 * ---------------------------------------------------------------- */

test("a name-keyed phantom does not beat the address it shadows", () => {
  const chats = [
    // Minted by a twin pass that was handed a display name. Zero messages.
    chat("Amoras", null, 0),
    chat(GROUP_PHONE, "Amoras", 570),
  ];

  const { key, matched } = resolveChatAddress(chats, "Amoras");

  assert.equal(key, GROUP_PHONE);
  assert.equal(matched, "name");
});

test("every shape of group name that read as empty now resolves to its messages", () => {
  // The rows as they stood that morning, with the names replaced by invented
  // ones carrying the same punctuation, accents and decoration.
  const chats = [
    chat("Alpha + Pais", null, 0),
    chat(GROUP_A, "Alpha + Pais", 537),
    chat("Duo", null, 0),
    chat(GROUP_B, "Duo", 831),
    chat("Ana, Bia, Cauê", null, 0),
    chat(GROUP_C, "Ana, Bia, Cauê", 383),
    chat("Moradores do Bloco", null, 0),
    chat(GROUP_D, "Moradores do Bloco", 936),
    chat("👥 Sítio & Açaí", null, 0),
    chat(GROUP_E, "👥 Sítio & Açaí", 162),
  ];

  for (const [asked, expected] of [
    ["Alpha + Pais", GROUP_A],
    ["Duo", GROUP_B],
    ["Ana, Bia, Cauê", GROUP_C],
    ["Moradores do Bloco", GROUP_D],
    ["👥 Sítio & Açaí", GROUP_E],
    // The spellings that accidentally WORKED before the fix, because they
    // missed the phantom's key and fell through to the fuzzy match. They must
    // keep working.
    ["Ana/Bia/Cauê", GROUP_C],
    ["Sítio & Açaí", GROUP_E],
  ]) {
    assert.equal(resolveChatAddress(chats, asked).key, expected, `asked for ${asked}`);
  }
});

/* ---------------------------------------------------------------- *
 * The archive holds a shorter name than the user used.
 *
 * A user asked for their son by his full name and got "no chat under that
 * name has ever been archived", with 349 of his messages in the table under
 * the two-word push name his phone advertises. Referring to family by their
 * whole name is not an edge case; it is how people talk about family.
 * ---------------------------------------------------------------- */

test("a full name finds the chat WhatsApp knows by a shorter one", () => {
  const chats = [
    chat(PERSON, "Alpha Fixture", 349),
    chat(GROUP_A, "Familia (Fixture)", 196),
    chat(GROUP_B, "Aulas do Alpha", 1),
  ];

  const { key, matched } = resolveChatAddress(chats, "Alpha Fixture de Sousa e Lima");

  assert.equal(key, PERSON);
  assert.equal(matched, "short-name", "an approximate match must not pass for an exact one");
});

test("a surname shared with the question is not a reference to it", () => {
  // "…de Sousa e Lima" contains "Lima". A chat called "Lima" is a different
  // person, and one shared word is a coincidence rather than a reference.
  const chats = [chat(PERSON, "Lima", 40)];
  assert.equal(resolveChatAddress(chats, "Alpha Fixture de Sousa e Lima").key, null);
});

test("a single-word chat still matches when it is the name you led with", () => {
  const chats = [chat(PERSON, "Alpha", 349)];
  const { key, matched } = resolveChatAddress(chats, "Alpha Fixture de Sousa e Lima");
  assert.equal(key, PERSON);
  assert.equal(matched, "short-name");
});

test("two conversations with equal claim on a fuller name are refused", () => {
  const chats = [chat(PERSON, "Alpha Fixture", 349), chat(GROUP_A, "Alpha Fixture", 12)];
  assert.throws(
    () => resolveChatAddress(chats, "Alpha Fixture de Sousa e Lima"),
    (error) => error.statusCode === 409,
  );
});

/* ---------------------------------------------------------------- *
 * A refusal must say what it nearly matched.
 * ---------------------------------------------------------------- */

test("an ambiguous first name is refused BY NAME, not reported as unarchived", () => {
  const chats = [chat(PERSON, "Alpha Fixture", 349), chat(GROUP_B, "Aulas do Alpha", 1)];

  assert.throws(() => resolveChatAddress(chats, "Alpha"), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /Alpha Fixture/);
    assert.match(error.message, /Aulas do Alpha/);
    return true;
  });
});

test("a name that resolves to nothing carries its near misses", () => {
  const chats = [chat(PERSON, "Bia Fixture", 349), chat(GROUP_A, "Vizinhança", 12)];

  const { key, matched, candidates } = resolveChatAddress(chats, "Bia Nogueira Fernandes");

  assert.equal(key, null);
  assert.equal(matched, "none");
  assert.deepEqual(
    candidates.map((c) => c.displayName),
    ["Bia Fixture"],
    "the one that shares a word is worth naming; the one that shares none is not",
  );
});

/* ---------------------------------------------------------------- *
 * The properties that must survive the fix.
 * ---------------------------------------------------------------- */

test("a chat asked for by its own address resolves to itself", () => {
  const chats = [chat(GROUP_A, "G7XY2", 586)];
  const { key, matched } = resolveChatAddress(chats, GROUP_A);
  assert.equal(key, GROUP_A);
  assert.equal(matched, "key");
});

test("a chat that predates the transport is still reachable by its name-key", () => {
  // Not a phantom: it holds messages, and no addressed row answers to it. This
  // is what the protocol-first rule must not break.
  const chats = [chat("Ana Fixture Silva", null, 60)];
  const { key, matched } = resolveChatAddress(chats, "Ana Fixture Silva");
  assert.equal(key, "Ana Fixture Silva");
  assert.equal(matched, "key");
});

test("a name nobody answers to resolves to nothing, and says so", () => {
  const chats = [chat(GROUP_A, "G7XY2", 586)];
  const { key, matched } = resolveChatAddress(chats, "Rowing Club");
  assert.equal(key, null);
  assert.equal(matched, "none");
});

test("two real conversations with the same name are refused, not guessed", () => {
  const chats = [chat(GROUP_A, "Vizinhança", 10), chat(GROUP_B, "Vizinhança", 20)];
  assert.throws(() => resolveChatAddress(chats, "Vizinhança"), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /Refusing to choose/);
    return true;
  });
});

test("a provisional row with no messages does not shadow the address that has them", () => {
  const chats = [
    chat(PERSON_PROVISIONAL, "Bia Fixture", 0),
    chat(PERSON, "Bia Fixture", 48),
  ];
  assert.equal(resolveChatAddress(chats, "Bia Fixture").key, PERSON);
});

test("the fuzzy match still refuses to pick between two plausible chats", () => {
  const chats = [chat(GROUP_A, "Pais do Bloco", 80), chat(GROUP_B, "Moradores do Bloco", 936)];
  // "bloco" is a word in both names and an exact match for neither, so there is
  // no answer — and the busier chat is not it. Refused BY NAME, so the caller
  // can ask which one rather than reporting the word as unknown.
  assert.throws(() => resolveChatAddress(chats, "Bloco"), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /Pais do Bloco.*Moradores do Bloco|Moradores do Bloco.*Pais do Bloco/);
    return true;
  });
  // An exact fold match still wins outright over a name that merely contains it.
  assert.equal(resolveChatAddress(chats, "pais do bloco").key, GROUP_A);
});

test("an empty question resolves to nothing rather than to the first chat", () => {
  const chats = [chat(GROUP_A, "Duo", 831)];
  assert.equal(resolveChatAddress(chats, "   ").key, null);
  assert.equal(resolveChatAddress(chats, undefined).key, null);
});

test("isProtocolAddress separates the two eras of key", () => {
  for (const key of [GROUP_A, GROUP_PHONE, PERSON, "status@broadcast", PERSON_PROVISIONAL]) {
    assert.equal(isProtocolAddress(key), true, key);
  }
  for (const key of ["Duo", "Alpha + Pais", "Ana Fixture Silva"]) {
    assert.equal(isProtocolAddress(key), false, key);
  }
});
