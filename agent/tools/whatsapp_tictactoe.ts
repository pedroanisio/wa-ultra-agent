import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";
import {
  type Command,
  type GameState,
  LEVELS,
  isOver,
  outcome,
  parseSquare,
  playTurn,
  readGame,
  renderBoard,
  renderBoardPng,
  squareName,
  startGame,
} from "../lib/tictactoe.ts";

/**
 * Play tic-tac-toe in the user's own WhatsApp chat.
 *
 * ── Why this tool holds the whole turn ──────────────────────────────────────
 *
 * ARCHITECTURAL REQUIREMENT (PALS's LAW): LLMs will always produce some form of
 * error. Absence of output verification is a design defect, not a runtime bug.
 *
 * Everything that could be got wrong is done here, in code: reading the board
 * out of the chat, deciding whether what the user typed is a move, checking it
 * is legal, choosing the answer, and writing the result back. The model's only
 * job is to decide that it is worth taking a turn at all — it never carries the
 * board between calls, never reports the score, and cannot play a square that
 * was already taken, because it does not choose squares.
 *
 * ── Why it reads the chat first ─────────────────────────────────────────────
 *
 * The self chat is the save file (see `lib/tictactoe.ts`). That also makes this
 * safely repeatable: a board with nothing typed after it is a finished turn, so
 * a second call — a retry, an overlapping schedule, an impatient user — reports
 * `played: false` and writes nothing rather than answering the same move twice.
 */

/** Enough history to find the last board and everything typed after it. */
const WINDOW = 20;

/**
 * The tail of the user's own chat, in chat order.
 *
 * Costs no WhatsApp traffic at all: it is a SQLite read on this machine, which
 * is what makes taking a turn cheap enough to do whenever the user asks.
 */
async function readSelfChat(self: { chat: string }, signal?: AbortSignal): Promise<string[]> {
  // The archive IS the chat. There is no conversation to open: the DOM path that
  // could have been read off a screen is gone, and `/self/chat` only ever
  // reports `archive` now. `newest` is not optional — without it the window is
  // the OLDEST twenty messages, which contains no board and reads as a new game.
  const stored = await bridge.archiveMessages(
    { chat: self.chat, limit: WINDOW, newest: true },
    signal,
  );
  return stored.messages.map((message) => message.text ?? "");
}

const describeMove = (square: number | null): string | null =>
  square === null ? null : squareName(square);

export default defineTool({
  description:
    "Play a turn of tic-tac-toe in the USER'S OWN WhatsApp chat. This is a real game the user plays " +
    "from their phone: they type a square such as `b2` (or `1`–`9`) into their own chat, and this tool " +
    "reads the chat, plays their move, answers it, and writes the new board back. " +
    "Call it with no arguments to take whatever turn is pending — that is the normal use, and it is " +
    "safe to repeat: when nothing has been typed since the last board it writes nothing and reports " +
    "`played: false`. You do NOT decide moves, track the board, or judge legality; this tool does all " +
    "of that and the game state lives in the chat itself. Use `move` only when the user asks you " +
    "directly, in conversation, to play a specific square for them.",
  inputSchema: z.object({
    action: z
      .enum(["auto", "new", "status", "resign"])
      .default("auto")
      .describe(
        "`auto` plays whatever the user typed in their chat — use this unless they asked you for " +
          "something else in conversation. `new` starts a fresh game, `status` re-posts the current " +
          "board, `resign` ends the game.",
      ),
    move: z
      .string()
      .optional()
      .describe(
        "A square to play on the user's behalf, as `a1`–`c3` or `1`–`9`. Only for when the user asks " +
          "you directly to play it. Leave empty to play the move they typed into WhatsApp themselves.",
      ),
    mark: z
      .enum(["x", "o"])
      .optional()
      .describe("Which mark the user plays in a new game. X moves first. Defaults to x."),
    level: z
      .enum(["easy", "normal", "hard"])
      .optional()
      .describe(
        "How hard to play a new game. `hard` is solved play and cannot be beaten, only drawn — do not " +
          "choose it unless the user asks for it. Defaults to normal.",
      ),
  }),
  /**
   * Turns are taken one at a time.
   *
   * eve can run a schedule while an earlier tick is still in flight — a slow
   * write, a container that just started, a user asking for a turn at the same
   * moment. Two overlapping turns both read a chat with no answer in it and both
   * answer it, which is how the same board arrived twice four seconds apart.
   *
   * This serialises them inside the process; `expect` below covers the rest,
   * where the other writer is a different process entirely.
   */
  async execute(input, ctx) {
    const run = turns.then(() => takeTurn(input, ctx));
    turns = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  },

  toModelOutput,
});

/** Serialises turns; see `execute`. */
let turns: Promise<void> = Promise.resolve();

/** One turn, start to finish. Never called concurrently — `execute` queues it. */
async function takeTurn(
  { action, move, mark, level }: {
    action: "auto" | "new" | "status" | "resign";
    move?: string;
    mark?: "x" | "o";
    level?: "easy" | "normal" | "hard";
  },
  ctx: { abortSignal?: AbortSignal },
) {
  try {
    {
      const self = await bridge.selfChat(ctx.abortSignal);

      // The bridge's console answers the same chat, as each message arrives, and
      // its own game reads bare digits as moves. Two responders on one keyboard
      // is not a race to win — whoever is already in a session owns it.
      if (self.console) {
        return {
          ok: true as const,
          played: false,
          reason:
            `The bridge console is in \`${self.console}\` mode and is answering that chat itself. ` +
            "Left alone — tell the user to `/quit` first if they want this game instead.",
          hasGame: false,
        };
      }

      const texts = await readSelfChat(self, ctx.abortSignal);
      const expect = texts.at(-1) ?? null;
      const game = readGame(texts);

      // An explicit argument is the user speaking to the agent directly, which
      // outranks the chat: they are looking at this conversation, not at their
      // phone. Otherwise the chat decides, and `none` means there is nothing to do.
      let command: Command = game.command;
      if (action === "new") command = { kind: "new", user: mark, level };
      else if (action === "status") command = { kind: "status" };
      else if (action === "resign") command = { kind: "resign" };
      else if (move !== undefined) {
        const square = parseSquare(move);
        if (square === null) {
          return {
            ok: false as const,
            played: false,
            error: `"${move}" is not a square. Use a1–c3 or 1–9.`,
          };
        }
        command = { kind: "move", square };
      }

      if (command.kind === "none") {
        return {
          ok: true as const,
          played: false,
          reason: game.state
            ? "The board is up to date — the user has not moved since it was posted."
            : "No game is running and the user has not asked to start one.",
          hasGame: game.state !== null,
        };
      }

      if (command.kind === "new") {
        const opened = startGame({
          user: command.user ?? mark ?? "x",
          level: command.level ?? level ?? "normal",
        });
        return await post(opened.state, {
          agentSquare: opened.agentSquare,
          played: true,
          event: "new",
          signal: ctx.abortSignal,
        });
      }

      if (!game.state) {
        return {
          ok: true as const,
          played: false,
          reason: "There is no game in the chat to act on. Start one with action `new`.",
          hasGame: false,
        };
      }

      if (command.kind === "status") {
        return await post(game.state, {
          agentSquare: null,
          played: false,
          event: "status",
          signal: ctx.abortSignal,
        });
      }

      if (command.kind === "resign") {
        if (isOver(game.state.board)) {
          return {
            ok: true as const,
            played: false,
            reason: "That game had already finished; nothing to resign.",
            hasGame: true,
          };
        }
        return await post(game.state, {
          agentSquare: null,
          played: true,
          event: "resign",
          note: "Game abandoned. Say `ttt new` whenever you want another.",
          signal: ctx.abortSignal,
        });
      }

      const turn = playTurn(game.state, command.square);
      return await post(turn.state, {
        agentSquare: turn.agentSquare,
        played: turn.applied,
        event: turn.applied ? "move" : "rejected",
        note: turn.note,
        userSquare: command.square,
        queued: game.queued,
        expect,
        signal: ctx.abortSignal,
      });
    }
  } catch (error) {
    if (error instanceof BridgeError) {
      return { ok: false as const, played: false, error: error.message };
    }
    throw error;
  }
}

/**
   * The model is told what happened, never asked to reconstruct it. The board
   * itself is already on the user's phone, so repeating it here would only give
   * the model a second copy to get wrong in its reply.
   */
function toModelOutput(output: Awaited<ReturnType<typeof takeTurn>>) {
    if (!output.ok) {
      return {
        type: "text" as const,
        value: `The turn was NOT played: ${output.error}\n\nTell the user plainly; do not retry blindly.`,
      };
    }

    // No `event` means nothing was written: an up-to-date board, or no game.
    if (!("event" in output)) {
      return {
        type: "text" as const,
        value: `Nothing to do: ${output.reason} Say so in one line and do not write anything to WhatsApp.`,
      };
    }

    const parts: string[] = [];
    if (output.event === "new") parts.push("A new game is on the user's phone.");
    if (output.event === "status") parts.push("The current board was re-posted to the user's chat.");
    if (output.event === "resign") parts.push("The game was abandoned and the final board posted.");
    if (output.event === "rejected") {
      parts.push(`That move was refused (${output.note}) and the unchanged board was re-posted.`);
    }
    if (output.event === "move") {
      parts.push(
        `Played ${output.userMove} for the user; answered with ${output.agentMove ?? "nothing — the game ended"}.`,
      );
    }
    if (output.result) parts.push(`Result: ${output.result}.`);
    if (output.queued) {
      parts.push(
        `${output.queued} further move${output.queued === 1 ? "" : "s"} typed by the user are still ` +
          "pending — call this tool again to play the next one.",
      );
    }
    parts.push("The board is in their own WhatsApp chat; do not retype it here.");

  return { type: "text" as const, value: parts.join(" ") };
}

/**
 * The last thing seen in the chat when the turn was decided.
 *
 * A turn is read-then-write, and between those two steps the chat can move —
 * another tick of the schedule, a retry, the user typing again. This is what
 * makes the write conditional on the read still being true: if the newest
 * message is no longer the one the decision was based on, somebody else has
 * already acted and this turn is stale.
 *
 * Two boards, four seconds apart, is what its absence looked like.
 */
async function chatMoved(expect: string | null, signal?: AbortSignal): Promise<boolean> {
  const self = await bridge.selfChat(signal);
  const latest = await bridge.archiveMessages({ chat: self.chat, limit: 1, newest: true }, signal);
  return (latest.messages.at(-1)?.text ?? null) !== expect;
}

/** Render the board, write it to the self chat, and describe what happened. */
async function post(
  state: GameState,
  options: {
    agentSquare: number | null;
    played: boolean;
    event: "new" | "move" | "rejected" | "status" | "resign";
    note?: string;
    userSquare?: number;
    queued?: number;
    /** The newest message when this turn was decided; `undefined` skips the check. */
    expect?: string | null;
    signal?: AbortSignal;
  },
) {
  const result = outcome(state.board);

  if (options.expect !== undefined && (await chatMoved(options.expect, options.signal))) {
    return {
      ok: true as const,
      played: false,
      reason:
        "The chat moved while this turn was being decided — another tick has already answered it. " +
        "Nothing was written.",
      hasGame: true,
    };
  }

  const written = await bridge.writeSelf([renderBoard(state, options.note)], options.signal);

  // ── Why the picture only goes out at the end ──────────────────────────────
  // The emoji grid is the playable board: the user replies to it, and the state
  // token under it is the save file. An image is neither — it cannot be replied
  // to and it carries no token — so posting one every turn would put a second,
  // unplayable board between the user and the one they answer.
  //
  // A finished game has nothing left to reply to, which is exactly when a
  // picture is worth more than a grid. It is posted after the text so the token
  // stays the newest board in the chat and `readGame` keeps finding it.
  const drawn = await postFinalImage(state, result, options.signal);

  return {
    ok: true as const,
    played: options.played,
    event: options.event,
    chat: written.chat,
    image: drawn,
    board: state.board.map((cell) => cell ?? ".").join(""),
    userMark: state.user,
    level: state.level,
    userMove: describeMove(options.userSquare ?? null),
    agentMove: describeMove(options.agentSquare),
    note: options.note,
    queued: options.queued ?? 0,
    result:
      result.status === "won"
        ? result.winner === state.user
          ? "the user won"
          : "the agent won"
        : result.status === "draw"
          ? "a draw"
          : undefined,
  };
}

/**
 * Post the drawn board when the game has ended, and say whether it landed.
 *
 * ── Why a failure here is not a failed turn ─────────────────────────────────
 * The playable board is already in the chat by the time this runs. If the image
 * cannot be sent — the transport is disconnected, the self chat is not
 * configured, the upload is refused — the game is still correct and the user can
 * still read it. Throwing would turn a decoration into an outage, and would make
 * the tool report a turn as unplayed that was in fact played and written.
 *
 * So it is reported, never raised: `{ sent: false, reason }` is a fact the model
 * can mention in one line, and the next call will not replay the move because
 * the board in the chat already moved on.
 */
async function postFinalImage(
  state: GameState,
  result: ReturnType<typeof outcome>,
  signal?: AbortSignal,
): Promise<{ sent: boolean; reason?: string }> {
  if (result.status === "playing") return { sent: false, reason: "the game is still in play" };

  const caption =
    result.status === "draw"
      ? "Draw."
      : result.winner === state.user
        ? "You win. 🏆"
        : "I win.";

  try {
    await bridge.writeSelfImage(
      { bytes: renderBoardPng(state), mimetype: "image/png", caption, width: 480, height: 480 },
      signal,
    );
    return { sent: true };
  } catch (error) {
    return {
      sent: false,
      reason: error instanceof BridgeError ? error.message : "the board image could not be sent",
    };
  }
}

/** Re-exported so the schedule prompt and the skill cannot drift from the code. */
export const PLAYABLE_LEVELS = LEVELS;
