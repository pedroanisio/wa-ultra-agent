import { test } from "node:test";
import assert from "node:assert/strict";

import { commitsTheUser, sendApproval } from "../agent/lib/send-policy.ts";

/**
 * When a send has to be confirmed by a human.
 *
 * The allowlist answers WHO may be written to, and it lives in the bridge where
 * a confused agent cannot argue with it. It does not answer the other question:
 * whether *this* message is one the user would want to have worded themselves.
 * A message that agrees to pay, commits to a time, or apologises is theirs; a
 * message that says "on my way" is not worth interrupting for.
 *
 * Erring towards asking is cheap — one tap. Erring the other way sends a
 * promise in someone's name.
 */

test("money commits the user", () => {
  for (const text of [
    "I'll transfer R$ 500 tomorrow",
    "sure, 200 reais works",
    "I can pay the invoice on Friday",
    "deposito hoje",
  ]) {
    assert.equal(commitsTheUser(text), true, `${JSON.stringify(text)} commits`);
  }
});

test("agreeing to a time commits the user", () => {
  for (const text of [
    "yes, Tuesday at 3pm works for me",
    "confirmo a reunião de amanhã",
    "I'll be there at 9",
    "let's meet on the 14th",
  ]) {
    assert.equal(commitsTheUser(text), true, `${JSON.stringify(text)} commits`);
  }
});

test("apologies and promises commit the user", () => {
  for (const text of [
    "I'm so sorry about yesterday",
    "desculpa pelo atraso",
    "I promise it will be done",
    "you have my word",
  ]) {
    assert.equal(commitsTheUser(text), true, `${JSON.stringify(text)} commits`);
  }
});

test("ordinary messages do not", () => {
  for (const text of [
    "on my way",
    "haha true",
    "sent you the link",
    "bom dia",
    "did you see the game?",
    "the file is in the shared folder",
  ]) {
    assert.equal(commitsTheUser(text), false, `${JSON.stringify(text)} is ordinary`);
  }
});

test("a long message is treated as commitment-shaped whatever it says", () => {
  // Length is a proxy for substance. Nobody dictates four hundred characters of
  // small talk, and the cost of asking about one is a single tap.
  assert.equal(commitsTheUser("ok ".repeat(200)), true);
});

/* ── the policy eve actually calls ─────────────────────────────────── */

test("a commitment pauses for approval", () => {
  assert.equal(sendApproval({ toolInput: { to: "Tuca", message: "I'll pay on Friday" } }), "user-approval");
});

test("an ordinary message is not interrupted", () => {
  assert.equal(sendApproval({ toolInput: { to: "Tuca", message: "on my way" } }), "not-applicable");
});

test("a missing or malformed message asks rather than assumes", () => {
  // An input this tool cannot read is not one it may send unattended.
  assert.equal(sendApproval({ toolInput: {} }), "user-approval");
  assert.equal(sendApproval({}), "user-approval");
});

/**
 * The field-name mismatch that made voice notes impossible.
 *
 * `sendApproval` read `toolInput.message`. `whatsapp_send_voice` names its
 * field `text`. Every voice note therefore handed the policy an `undefined`,
 * `commitsTheUser` failed closed on it as designed, and the answer was always
 * `user-approval` — a gate the WhatsApp console cannot open, so the turn parked
 * and the user saw nothing at all. Neither model, endpoint nor session was
 * involved; it survived a provider switch untouched.
 */
test("a voice note to the user's own chat needs no approval", () => {
  assert.equal(sendApproval({ toolInput: { text: "Good morning!" } }), "not-applicable");
});

test("a voice note reads the field it actually declares", () => {
  // Innocuous words, addressed to a person: the gate must judge the WORDS, not
  // fail closed because it was looking for a field this tool does not have.
  assert.equal(
    sendApproval({ toolInput: { to: "Ana", text: "The shop opens at ten." } }),
    "not-applicable",
  );
});

test("a spoken commitment to another person still needs approval", () => {
  assert.equal(
    sendApproval({ toolInput: { to: "Ana", text: "Sorry, I'll be there tomorrow." } }),
    "user-approval",
  );
});

test("a text message keeps being judged on its own field", () => {
  assert.equal(
    sendApproval({ toolInput: { to: "Ana", message: "Sorry, I promise I'll pay Friday." } }),
    "user-approval",
  );
  assert.equal(
    sendApproval({ toolInput: { to: "Ana", message: "ok" } }),
    "not-applicable",
  );
});

test("an addressed send with no words at all still fails closed", () => {
  // The fail-closed default is right and stays: what was wrong was reading the
  // wrong field, not what happens when there genuinely are no words to read.
  assert.equal(sendApproval({ toolInput: { to: "Ana" } }), "user-approval");
  assert.equal(sendApproval({ toolInput: { to: "Ana", text: "" } }), "user-approval");
});

test("no approval gate can be satisfied from the WhatsApp console", () => {
  // Not an assertion about code — a note that `user-approval` on a console turn
  // is an unanswerable prompt. Every case above that returns it must therefore
  // be a case where a human at a browser or terminal is the intended approver.
  assert.equal(
    sendApproval({ toolInput: { to: "Ana", text: "I promise I'll send it tonight." } }),
    "user-approval",
  );
});
