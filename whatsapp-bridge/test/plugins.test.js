import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORIES,
  IDLE,
  PLUGINS,
  STATES,
  isOwnReply,
  renderMenu,
  route,
} from "../src/plugins.js";

/**
 * The self chat is the one place the agent may write without an allowlist, so
 * everything here is really one question: does a message change state only when
 * the operator asked it to?
 */

/* ---------------------------------------------------------------- *
 * The menu
 * ---------------------------------------------------------------- */

test("menu: lists every registered plugin", () => {
  const menu = renderMenu();
  for (const plugin of PLUGINS) {
    assert.ok(menu.includes(plugin.command), `${plugin.command} is missing from the menu`);
  }
});

test("menu: carries a category marker for every category it shows", () => {
  const menu = renderMenu();
  for (const [id, category] of Object.entries(CATEGORIES)) {
    if (!PLUGINS.some((p) => p.category === id)) continue;
    assert.ok(menu.includes(category.emoji), `${id} has no marker in the menu`);
  }
});

test("menu: says which mode you are in, so the session is never ambiguous", () => {
  assert.match(renderMenu({ state: "eve" }), /\*eve\* state/);
  assert.doesNotMatch(renderMenu({ state: null }), /You are in/);
});

test("categories: every plugin belongs to a declared category", () => {
  for (const plugin of PLUGINS) {
    assert.ok(CATEGORIES[plugin.category], `${plugin.command} has an unknown category`);
  }
});

test("categories: each one has both a marker and a colour", () => {
  for (const [id, category] of Object.entries(CATEGORIES)) {
    assert.ok(category.emoji, `${id} has no emoji`);
    assert.match(category.color, /^#[0-9A-Fa-f]{6}$/, `${id} has no usable colour`);
  }
});

/* ---------------------------------------------------------------- *
 * Routing
 * ---------------------------------------------------------------- */

test("route: an ordinary note is left alone", () => {
  const { reply, session } = route(null, "remember to call the accountant");
  assert.equal(reply, null, "answering every self-note would ruin the chat for notes");
  assert.equal(session.state, null);
});

test("route: /menu answers without entering a mode", () => {
  const { reply, session } = route(null, "/menu");
  assert.ok(reply.includes("/game"), "the menu must list the game");
  assert.equal(session.state, null);
});

test("route: /eve captures the conversation until /quit", () => {
  let state = route(null, "/eve").session;
  assert.equal(state.state, "eve");

  const spoken = route(state, "what did Rodrigo ask me?");
  assert.equal(spoken.reply, null, "eve answers, not the router");
  assert.equal(spoken.forward, "what did Rodrigo ask me?");

  state = route(spoken.session, "/quit").session;
  assert.equal(state.state, null);
});

test("route: /quit outside a mode says so rather than pretending", () => {
  const { reply } = route(null, "/quit");
  assert.match(reply, /Not in a state/);
});

test("route: commands are case-insensitive", () => {
  assert.ok(route(null, "/MENU").reply.includes("/game"));
});

test("route: /status defers to the caller, which is the only side that can answer", () => {
  const { reply, ask } = route(null, "/status");
  assert.equal(reply, null);
  assert.equal(ask, "status");
});

/* ---------------------------------------------------------------- *
 * States: entering, playing, leaving
 * ---------------------------------------------------------------- */

test("state: every declared state has the full lifecycle", () => {
  for (const [name, state] of Object.entries(STATES)) {
    for (const hook of ["enter", "handle", "exit"]) {
      assert.equal(typeof state[hook], "function", `${name} is missing ${hook}()`);
    }
    assert.ok(CATEGORIES[state.category], `${name} has no category to mark its replies with`);
  }
});

test("state: every state in the menu can actually be entered", () => {
  for (const plugin of PLUGINS.filter((p) => p.state)) {
    assert.ok(STATES[plugin.state], `${plugin.command} names a state that does not exist`);
  }
});

test("game: entering opens a fresh board and holds the session", () => {
  const { session, reply } = route(IDLE, "/game");
  assert.equal(session.state, "game");
  assert.equal(session.data.board, ".........");
  assert.match(reply, /1 \u2502 2 \u2502 3/);
});

test("game: a move is one event, and the session carries the board to the next", () => {
  const opened = route(IDLE, "/game");
  const played = route(opened.session, "5");
  assert.equal(played.session.data.board[4], "X");
  assert.equal([...played.session.data.board].filter((c) => c === "O").length, 1);
  assert.equal(played.session.state, "game", "the session must survive the event");
});

test("game: a taken cell is refused without consuming a turn", () => {
  const opened = route(IDLE, "/game");
  const first = route(opened.session, "5");
  const again = route(first.session, "5");
  assert.equal(again.session.data.board, first.session.data.board);
  assert.match(again.reply, /taken/);
});

test("game: nonsense is refused with instructions, not a crash", () => {
  const opened = route(IDLE, "/game");
  const { reply, session } = route(opened.session, "banana");
  assert.match(reply, /1 to 9/);
  assert.equal(session.data.board, ".........");
});

test("game: a finished match exits by itself, so the chat is a notebook again", () => {
  // X on 1 and 2; taking 3 wins and must end the session without /quit.
  const nearly = { state: "game", data: { board: "XX.OO...." } };
  const { session, reply } = route(nearly, "3");
  assert.equal(session.state, null, "a decided match must not stay open");
  assert.match(reply, /You win/);
});

test("game: /quit mid-match leaves and says so", () => {
  const opened = route(IDLE, "/game");
  const { session, reply } = route(opened.session, "/quit");
  assert.equal(session.state, null);
  assert.match(reply, /abandoned/i);
});

test("state: entering one state from another leaves the first", () => {
  const playing = route(route(IDLE, "/game").session, "5").session;
  const talking = route(playing, "/eve");
  assert.equal(talking.session.state, "eve");
  assert.equal(talking.session.data.board, undefined, "the match must not linger in the session");
});

test("state: a session round-trips through JSON, so a restart resumes it", () => {
  const played = route(route(IDLE, "/game").session, "5").session;
  const revived = JSON.parse(JSON.stringify(played));
  // Cell 3 rather than 1: the machine answered the centre by taking a corner,
  // and a resumed match must still refuse an occupied cell.
  const next = route(revived, "3");
  assert.equal(next.session.data.board[2], "X", "the resumed match must accept the next move");
  assert.equal(next.session.state, "game");
});

/* ---------------------------------------------------------------- *
 * The loop guard
 * ---------------------------------------------------------------- */

test("guard: a reply this module wrote is recognised as its own", () => {
  for (const command of ["/menu", "/eve", "/quit"]) {
    const { reply } = route(null, command);
    if (reply) assert.ok(isOwnReply(reply), `${command}'s reply must be recognisable`);
  }
});

test("guard: an ordinary note is not mistaken for a reply", () => {
  assert.equal(isOwnReply("remember the milk"), false);
  assert.equal(isOwnReply(""), false);
});

/* ---------------------------------------------------------------- *
 * The banner
 *
 * The emoji marks a line; the image marks the moment. Entering a state is when
 * the operator must not be confused, so it is the transition that gets a block.
 * ---------------------------------------------------------------- */

test("banner: entering a state asks for one, in that state's colour", () => {
  for (const [name, state] of Object.entries(STATES)) {
    const { banner } = route(IDLE, `/${name}`);
    assert.ok(banner, `entering ${name} must signal a banner`);
    assert.equal(banner.color, CATEGORIES[state.category].color);
    assert.equal(banner.label, name);
  }
});

test("banner: an event inside a state does not repeat it", () => {
  const opened = route(IDLE, "/game");
  assert.equal(route(opened.session, "5").banner, undefined, "one entry, one banner");
});

test("banner: leaving does not raise one", () => {
  const opened = route(IDLE, "/game");
  assert.equal(route(opened.session, "/quit").banner, undefined);
});

test("banner: /menu is a reply, not a state, so it raises none", () => {
  assert.equal(route(IDLE, "/menu").banner, undefined);
});

/* ---------------------------------------------------------------- *
 * /noop
 *
 * The one command whose contract is that nothing changes. A session outlives a
 * restart and an afternoon of not looking at your phone, and every other reply
 * here is a consequence of an action — so without this the only way to find out
 * whether the next `5` is a move or a shopping note is to type it and see, which
 * is a move you did not mean to play.
 * ---------------------------------------------------------------- */

test("noop: says the chat is idle when nothing is entered", () => {
  const { session, reply } = route(IDLE, "/noop");
  assert.equal(session.state, null);
  assert.match(reply, /idle/i);
});

test("noop: names the state you are in", () => {
  for (const name of Object.keys(STATES)) {
    const opened = route(IDLE, `/${name}`);
    const { reply } = route(opened.session, "/noop");
    assert.match(reply, new RegExp(name, "i"), `${name} must name itself`);
  }
});

test("noop: changes nothing — not the state, not the data", () => {
  const opened = route(IDLE, "/game");
  const played = route(opened.session, "5");
  const before = JSON.stringify(played.session);

  const after = route(played.session, "/noop");

  assert.equal(JSON.stringify(after.session), before, "the session must survive being described");
});

test("noop: inside a match it reports, it does not play", () => {
  // Every bare token in a match is read as a cell. A command that exists to say
  // where you are must never be the thing that moves a piece.
  const opened = route(IDLE, "/game");
  const { session, reply } = route(opened.session, "/noop");

  assert.equal(session.data.board, opened.session.data.board, "the board is untouched");
  assert.doesNotMatch(reply, /taken|Pick a cell/i, "and it was not read as a move");
});

test("noop: answers with the marker of whatever is currently listening", () => {
  assert.ok(route(IDLE, "/noop").reply.startsWith(CATEGORIES.session.emoji));

  const opened = route(IDLE, "/game");
  assert.ok(route(opened.session, "/noop").reply.startsWith(CATEGORIES.game.emoji));
});

test("noop: is listed in the menu, so it is discoverable", () => {
  assert.ok(PLUGINS.some((p) => p.command === "/noop"), "the registry lists it");
  assert.match(renderMenu(), /\/noop/, "and the menu prints it");
});

test("noop: raises no banner — nothing was entered", () => {
  assert.equal(route(IDLE, "/noop").banner, undefined);
});

test("noop: its own reply is recognised as ours, so it cannot echo", () => {
  assert.equal(isOwnReply(route(IDLE, "/noop").reply), true);
});
