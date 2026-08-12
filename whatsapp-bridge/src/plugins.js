/**
 * What the operator can do from their own chat.
 *
 * ── Why the bridge and not the agent ────────────────────────────────────────
 * `/menu` and a game of noughts and crosses are decidable: the same input must
 * produce the same output, every time, with no model in the loop. Routing them
 * through an LLM would make a menu that can hallucinate its own entries and a
 * game that can be argued out of a lost position. So commands are resolved here,
 * deterministically, and only `/eve` hands the conversation to the agent — which
 * is then an explicit, visible mode rather than an ambient one.
 *
 * ── The marker ──────────────────────────────────────────────────────────────
 * Every category carries an emoji and a colour, and every reply this module
 * produces is prefixed with the marker of whatever is answering. That is the
 * whole session indicator: in a chat that is otherwise a wall of text from
 * yourself, `🎮` at the head of a line says the game is replying, `🤖` says eve
 * is, and `📋` says the menu is. The colour travels with it for surfaces that
 * can render one — the agent's UI, a future image swatch — and costs nothing on
 * the phone, where the emoji is the marker.
 *
 * Kept free of transport and store specifics so the rules are testable: state is
 * passed in and returned, and sending is the caller's business.
 */

/**
 * The categories a capability can belong to.
 *
 * `color` is a hex triple for renderers that have one; `emoji` is what actually
 * reaches the phone. Both are part of the contract — a category that renders
 * differently in two places is worse than one that renders plainly in both.
 */
export const CATEGORIES = {
  session: { emoji: "📋", color: "#4C6EF5", label: "Session" },
  game: { emoji: "🎮", color: "#12B886", label: "Games" },
  agent: { emoji: "🤖", color: "#7950F2", label: "Agent" },
  archive: { emoji: "🗂", color: "#F08C00", label: "Archive" },
};

/**
 * Whether a message is one this module already wrote.
 *
 * Load-bearing, not cosmetic. Everything the bridge sends to the self chat comes
 * straight back through the transport as an outgoing message in that same chat,
 * so without this check the router reads its own replies. In game mode that is
 * not merely noisy: "Pick a cell from 1 to 9" is itself a message in the self
 * chat, and answering it produces another, forever.
 */
export function isOwnReply(text) {
  const body = String(text ?? "").trimStart();
  return Object.values(CATEGORIES).some((category) => body.startsWith(category.emoji));
}

/** Prefix a reply with its category marker. */
export function mark(categoryId, text) {
  const category = CATEGORIES[categoryId];
  return category ? `${category.emoji} ${text}` : text;
}

/* ------------------------------------------------------------------ *
 * Tic-tac-toe
 *
 * Nine characters are the entire match. Kept that small on purpose: a session
 * is persisted between events, and a state that round-trips as one string
 * cannot half-save.
 * ------------------------------------------------------------------ */

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export const EMPTY_BOARD = ".........";

export function renderBoard(board) {
  const cell = (i) => (board[i] === "." ? String(i + 1) : board[i]);
  const row = (a, b, c) => ` ${cell(a)} \u2502 ${cell(b)} \u2502 ${cell(c)} `;
  return [row(0, 1, 2), "\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u253c\u2500\u2500\u2500", row(3, 4, 5), "\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u253c\u2500\u2500\u2500", row(6, 7, 8)].join("\n");
}

export function winnerOf(board) {
  for (const [a, b, c] of LINES) {
    if (board[a] !== "." && board[a] === board[b] && board[b] === board[c]) return board[a];
  }
  return board.includes(".") ? null : "draw";
}

/**
 * Win if it can, block if it must, else take the best open cell. Deliberately
 * not minimax: a perfect opponent never loses, and a game you cannot win is not
 * a feature.
 */
export function bestMove(board, me = "O", you = "X") {
  const open = [...board].map((c, i) => (c === "." ? i : -1)).filter((i) => i >= 0);
  const wins = (piece, cell) => winnerOf(board.slice(0, cell) + piece + board.slice(cell + 1)) === piece;
  for (const cell of open) if (wins(me, cell)) return cell;
  for (const cell of open) if (wins(you, cell)) return cell;
  for (const cell of [4, 0, 2, 6, 8, 1, 3, 5, 7]) if (board[cell] === ".") return cell;
  return -1;
}

function finish(board, outcome) {
  const verdict = outcome === "X" ? "You win." : outcome === "O" ? "I win." : "A draw.";
  return `${renderBoard(board)}\n\n${verdict} \`/game\` to play again.`;
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/**
 * Everything `/menu` lists.
 *
 * `state` marks an entry you ENTER: it captures the conversation until it is
 * left, and its name keys into STATES. An entry without one answers a single
 * event and changes nothing — that is the difference between a command and a
 * place.
 */
export const PLUGINS = [
  {
    command: "/menu",
    category: "session",
    title: "Menu",
    summary: "List everything available here.",
  },
  {
    command: "/game",
    category: "game",
    title: "Tic-tac-toe",
    summary: "Enter a match. Reply with a cell number, 1–9. `/quit` abandons it.",
    state: "game",
  },
  {
    command: "/eve",
    category: "agent",
    title: "Talk to eve",
    summary: "Send what you type straight to the agent until you `/quit`.",
    state: "eve",
  },
  {
    command: "/status",
    category: "archive",
    title: "Archive status",
    summary: "How much correspondence is held, and whether the transport is live.",
  },
  {
    command: "/noop",
    category: "session",
    title: "Where am I",
    summary: "Say what state this chat is in, and change nothing.",
  },
  {
    command: "/quit",
    category: "session",
    title: "Leave",
    summary: "Exit the state you are in and come back to the notebook.",
  },
];

/**
 * What state the chat is in, in words.
 *
 * ── Why a command that does nothing is worth having ─────────────────────────
 * Every other reply here is a consequence of something: you entered a state, you
 * left one, you played a cell. That makes the state visible only in motion, and
 * a session survives a restart and an hour of not looking at your phone. Coming
 * back to the chat, the only way to find out whether the next `5` is a move or a
 * shopping note was to type something and watch what happened to it — which, if
 * you guessed wrong, is a move you did not mean to play.
 *
 * `/noop` answers that question without being an experiment. It is the one
 * command whose contract is that the session it describes is the session you
 * still have afterwards.
 */
export function describeSession({ state = null, data = {} } = {}) {
  if (!state) {
    return "Idle — this is a plain notebook. Nothing reads what you type here; `/menu` lists the states.";
  }

  const detail = STATES[state]?.describe?.(data);
  const base = `In *${state}*. Everything you type is read by it until \`/quit\`.`;
  return detail ? `${base}\n${detail}` : base;
}

/** The menu, grouped by category so the markers read as a legend. */
export function renderMenu({ state = null } = {}) {
  // No marker here: the caller marks the reply, and two would read as a stutter.
  const lines = ["*What I can do here*", ""];
  for (const [id, category] of Object.entries(CATEGORIES)) {
    const entries = PLUGINS.filter((p) => p.category === id);
    if (entries.length === 0) continue;
    lines.push(`${category.emoji} *${category.label}*`);
    for (const p of entries) lines.push(`  \`${p.command}\` — ${p.summary}`);
    lines.push("");
  }
  lines.push(
    state
      ? `You are in the *${state}* state. \`/quit\` leaves it.`
      : "Send a command to begin. Anything else stays a plain note.",
  );
  return lines.join("\n").trimEnd();
}

/**
 * Route one message from the operator's own chat.
 *
 * Pure: takes the current session and the text, returns the next session and
 * what to say. `null` for `reply` means this was an ordinary self-note and must
 * be left alone — the archive already has it, and answering every note would
 * make the chat unusable for its original purpose.
 */
/* ------------------------------------------------------------------ *
 * States
 *
 * The self chat is a console you ENTER and EXIT, and everything in between is
 * driven by events: one arriving message is one event, and a match is a session
 * that lives across many of them. So a state is not a flag to branch on — it is
 * an object with a lifecycle:
 *
 *   enter(state)  → the first reply, and the session data the state starts with
 *   handle(state, body) → one event: the next session, and what to say
 *   exit(state)   → what to say on the way out
 *
 * `handle` returning `{ done: true }` ends the session by itself, which is how a
 * finished match drops you back to the notebook without typing `/quit`.
 * ------------------------------------------------------------------ */

export const STATES = {
  game: {
    category: "game",
    enter: () => ({
      data: { board: EMPTY_BOARD },
      reply: `You are X. Reply with a cell number.\n\n${renderBoard(EMPTY_BOARD)}`,
    }),
    exit: () => "Game abandoned.",
    // Enough to resume by: the position, and whose move it is. Reading it must
    // not require remembering what the last message said.
    describe: ({ board }) => `You are X, and it is your move.\n\n${renderBoard(board)}`,
    handle: ({ board }, body) => {
      const cell = Number.parseInt(body, 10) - 1;
      if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
        return { data: { board }, reply: "Pick a cell from 1 to 9, or `/quit` to stop." };
      }
      if (board[cell] !== ".") {
        return { data: { board }, reply: `Cell ${cell + 1} is taken.\n${renderBoard(board)}` };
      }

      let next = board.slice(0, cell) + "X" + board.slice(cell + 1);
      let outcome = winnerOf(next);
      if (outcome) return { data: { board: next }, done: true, reply: finish(next, outcome) };

      const reply = bestMove(next);
      next = next.slice(0, reply) + "O" + next.slice(reply + 1);
      outcome = winnerOf(next);
      if (outcome) return { data: { board: next }, done: true, reply: finish(next, outcome) };

      return { data: { board: next }, reply: `${renderBoard(next)}\n\nYour move.` };
    },
  },

  eve: {
    category: "agent",
    enter: () => ({
      data: {},
      reply: "Talking to eve. Everything you send goes to the agent until `/quit`.",
    }),
    exit: () => "Left eve.",
    describe: () => "Anything you type goes to the agent, not into the notebook.",
    // Forwarded, not answered: the agent is the only thing that can reply here.
    handle: (data, body) => ({ data, reply: null, forward: body }),
  },
};

/** A session with nothing entered. */
export const IDLE = { state: null, data: {} };

/**
 * Route one event from the operator's own chat.
 *
 * Pure, and the whole state machine: takes the session and the message, returns
 * the next session and what to say. Purity is what lets the caller persist the
 * session however it likes — and what makes every transition testable without a
 * transport, a store or a clock.
 *
 * `reply: null` means this was an ordinary self-note and must be left alone. The
 * archive already has it, and answering every note would make the chat unusable
 * for the thing it was for.
 */
export function route(session, text) {
  const body = String(text ?? "").trim();
  const current = session?.state ? session : IDLE;
  const command = body.toLowerCase().split(/\s+/)[0];

  if (command === "/quit") {
    if (!current.state) return { session: IDLE, reply: mark("session", "Not in a state.") };
    const state = STATES[current.state];
    return {
      session: IDLE,
      reply: mark(state.category, state.exit(current.data)),
    };
  }

  if (command === "/menu") {
    return { session: current, reply: mark("session", renderMenu({ state: current.state })) };
  }

  // Deliberately above the state handler below: inside a match every bare token
  // is read as a cell, and a command that exists to tell you where you are must
  // not be the thing that plays a move. It is marked with the CURRENT state's
  // category, so the marker itself answers the question a second time.
  if (command === "/noop") {
    const category = current.state ? STATES[current.state].category : "session";
    return { session: current, reply: mark(category, describeSession(current)) };
  }

  if (command === "/status") {
    // Answered by the caller, which is the only side that can see the archive.
    return { session: current, reply: null, ask: "status" };
  }

  // Entering a state. Allowed from inside another one: the previous session is
  // left, because two open sessions in one chat would make the next bare `5`
  // ambiguous — and the marker on a reply could no longer say who is talking.
  const entry = Object.entries(STATES).find(([name]) => command === `/${name}`);
  if (entry) {
    const [name, state] = entry;
    const { data, reply } = state.enter();
    return {
      session: { state: name, data },
      reply: mark(state.category, reply),
      // Entering is the moment the operator must not be confused about, because
      // everything they type next is read by this state. The banner is the
      // signal; the caller renders and sends it. See swatch.js.
      banner: { category: state.category, color: CATEGORIES[state.category].color, label: name },
    };
  }

  if (current.state) {
    const state = STATES[current.state];
    const { data, reply, done, forward } = state.handle(current.data, body);
    return {
      session: done ? IDLE : { state: current.state, data },
      reply: reply === null || reply === undefined ? null : mark(state.category, reply),
      ...(forward === undefined ? {} : { forward }),
    };
  }

  // An ordinary self-note. Silence is the correct answer.
  return { session: IDLE, reply: null };
}
