import { crc32, deflateSync } from "node:zlib";

/**
 * Tic-tac-toe, played inside the user's own WhatsApp chat.
 *
 * ── Where the game state lives ──────────────────────────────────────────────
 *
 * In the chat, and nowhere else. Every board the agent writes carries a state
 * token as its last line — `#ttt xo..x.... x hard` — and that token is the
 * only save file. The next turn is played by reading the chat back, parsing the
 * newest token, and applying whatever the user typed after it.
 *
 * This is not a stylistic choice. The agent is a Nitro server that may be
 * replaced between two moves, it has no volume, and the bridge's SQLite belongs
 * to the archive rather than to a game. Every other place to keep a board is
 * either a process that dies or a schema that has to be migrated. The chat is
 * durable, already synchronised to the user's phone, and visible — a corrupted
 * game is a message the user can read and correct.
 *
 * ── Why the model never carries the board ───────────────────────────────────
 *
 * ARCHITECTURAL REQUIREMENT (PALS's LAW): LLMs will always produce some form of
 * error. Absence of output verification is a design defect, not a runtime bug.
 *
 * A model asked to remember a board across turns will eventually move a piece
 * that was never played, and a wrong-but-legal board passes every schema check
 * that could be written for it. So the model is not in the state path at all:
 * it decides *when* to take a turn, and this module decides what the board is,
 * whether the move is legal, and what the answer is. Both directions —
 * `renderBoard` and `parseState` — are pure and round-trip in tests.
 *
 * Kept free of any I/O so the rules can be tested without a bridge, a browser,
 * or a WhatsApp account.
 */

/** X always moves first; the user is not always X. */
export type Mark = "x" | "o";
export type Cell = Mark | null;

/** Row-major, indices 0..8: a1 a2 a3 / b1 b2 b3 / c1 c2 c3. */
export type Board = Cell[];

/** How hard the agent plays. Perfect play cannot lose, which is why it is opt-in. */
export type Level = "easy" | "normal" | "hard";

export const LEVELS: readonly Level[] = ["easy", "normal", "hard"] as const;

/** Written as the last line of every board message. The save file. */
export const STATE_PREFIX = "#ttt";

export interface GameState {
  board: Board;
  /** Which mark the user plays. The agent plays the other one. */
  user: Mark;
  level: Level;
}

export type Outcome =
  | { status: "playing"; turn: Mark }
  | { status: "won"; winner: Mark; line: number[] }
  | { status: "draw" };

/** Every line that wins, as board indices. */
export const LINES: readonly (readonly number[])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
] as const;

export const emptyBoard = (): Board => Array<Cell>(9).fill(null);

const other = (mark: Mark): Mark => (mark === "x" ? "o" : "x");

/**
 * Whose turn it is, counted from the board rather than stored.
 *
 * Storing it would let the token disagree with the position it sits under —
 * two sources of truth for one fact, and the chat is not a database that can
 * enforce a constraint between them.
 */
export function turnOf(board: Board): Mark {
  const xs = board.filter((c) => c === "x").length;
  const os = board.filter((c) => c === "o").length;
  return xs === os ? "x" : "o";
}

export function legalMoves(board: Board): number[] {
  const moves: number[] = [];
  for (let i = 0; i < 9; i += 1) if (board[i] === null) moves.push(i);
  return moves;
}

export function outcome(board: Board): Outcome {
  for (const line of LINES) {
    const [a, b, c] = line;
    const mark = board[a];
    if (mark && board[b] === mark && board[c] === mark) {
      return { status: "won", winner: mark, line: [...line] };
    }
  }
  if (legalMoves(board).length === 0) return { status: "draw" };
  return { status: "playing", turn: turnOf(board) };
}

export const isOver = (board: Board): boolean => outcome(board).status !== "playing";

/**
 * Play a move, or say why it cannot be played.
 *
 * Returns a new board — the caller's is never mutated, because the same
 * position is searched thousands of times by the engine below.
 */
export function applyMove(
  board: Board,
  index: number,
  mark: Mark,
): { ok: true; board: Board } | { ok: false; error: string } {
  if (!Number.isInteger(index) || index < 0 || index > 8) {
    return { ok: false, error: `${index} is not a square on the board.` };
  }
  if (isOver(board)) return { ok: false, error: "That game is already finished." };
  if (turnOf(board) !== mark) return { ok: false, error: `It is not ${mark.toUpperCase()}'s turn.` };
  if (board[index] !== null) {
    return { ok: false, error: `${squareName(index)} is already taken by ${board[index]!.toUpperCase()}.` };
  }

  const next = [...board];
  next[index] = mark;
  return { ok: true, board: next };
}

/* ------------------------------------------------------------------ *
 * Naming squares.
 *
 * Two spellings are accepted because two habits exist: "b2" is how a person
 * describes a grid, and "5" is where the finger goes on a phone keypad. Both
 * are unambiguous, so refusing either would only cost the user a retry.
 * ------------------------------------------------------------------ */

const ROWS = ["a", "b", "c"] as const;

/** `0` → `a1`. Used in prose the user reads, never in the state token. */
export function squareName(index: number): string {
  return `${ROWS[Math.floor(index / 3)]}${(index % 3) + 1}`;
}

/**
 * Read a square out of loose text: `b2`, `B2`, `2b`, or the keypad digit `1`–`9`.
 *
 * Returns `null` for anything else, including text that merely contains a
 * square somewhere inside a sentence. A self-chat is full of unrelated notes,
 * and a note reading "call b2b vendor" is not a move.
 */
export function parseSquare(text: string): number | null {
  const token = text.trim().toLowerCase().replace(/[.,!?;:]+$/, "");

  const grid = /^([a-c])\s*([1-3])$/.exec(token) ?? null;
  if (grid) return (grid[1].charCodeAt(0) - 97) * 3 + (Number(grid[2]) - 1);

  const flipped = /^([1-3])\s*([a-c])$/.exec(token);
  if (flipped) return (flipped[2].charCodeAt(0) - 97) * 3 + (Number(flipped[1]) - 1);

  const keypad = /^([1-9])$/.exec(token);
  if (keypad) return Number(keypad[1]) - 1;

  return null;
}

/* ------------------------------------------------------------------ *
 * The engine.
 *
 * `hard` is exhaustive minimax over a game whose whole tree is 255 168 leaves,
 * so there is no reason to approximate: it is solved, and it never loses.
 * That is exactly why it is not the default — a game you cannot win at best
 * ends in a draw, and the user asked for something to play, not a proof.
 * ------------------------------------------------------------------ */

/** Injected so tests are deterministic; `pickRandom` is the runtime default. */
export type Chooser = (choices: number[]) => number;

export const pickRandom: Chooser = (choices) => choices[Math.floor(Math.random() * choices.length)];

/** First by index. Makes every `easy`/`normal` test reproducible. */
export const pickFirst: Chooser = (choices) => choices[0];

/** Score from `mark`'s point of view: win late is worth less than win now. */
function minimax(board: Board, mark: Mark, depth: number): number {
  const result = outcome(board);
  if (result.status === "won") return result.winner === mark ? 10 - depth : depth - 10;
  if (result.status === "draw") return 0;

  const turn = result.turn;
  const scores = legalMoves(board).map((index) => {
    const next = [...board];
    next[index] = turn;
    return minimax(next, mark, depth + 1);
  });

  return turn === mark ? Math.max(...scores) : Math.min(...scores);
}

/** Squares that immediately complete a line for `mark`. */
function winningSquares(board: Board, mark: Mark): number[] {
  return legalMoves(board).filter((index) => {
    const next = [...board];
    next[index] = mark;
    const result = outcome(next);
    return result.status === "won" && result.winner === mark;
  });
}

/**
 * The agent's move, or `null` when the game is already over.
 *
 * - `easy` plays a legal square and nothing more — it will miss its own win.
 * - `normal` takes a win, blocks a loss, and otherwise plays by preference
 *   (centre, corner, edge). It has no lookahead, so a fork beats it. That is
 *   the point: it is beatable by a person who is paying attention.
 * - `hard` is solved play.
 */
export function chooseMove(
  board: Board,
  mark: Mark,
  level: Level,
  pick: Chooser = pickRandom,
): number | null {
  const moves = legalMoves(board);
  if (moves.length === 0 || isOver(board)) return null;
  if (turnOf(board) !== mark) return null;

  if (level === "easy") return pick(moves);

  if (level === "normal") {
    const win = winningSquares(board, mark);
    if (win.length) return pick(win);

    const block = winningSquares(board, other(mark));
    if (block.length) return pick(block);

    for (const group of [[4], [0, 2, 6, 8], [1, 3, 5, 7]]) {
      const available = group.filter((index) => moves.includes(index));
      if (available.length) return pick(available);
    }
    return pick(moves);
  }

  let best = -Infinity;
  let bestMoves: number[] = [];
  for (const index of moves) {
    const next = [...board];
    next[index] = mark;
    const score = minimax(next, mark, 1);
    if (score > best) {
      best = score;
      bestMoves = [index];
    } else if (score === best) {
      bestMoves.push(index);
    }
  }
  return pick(bestMoves);
}

/* ------------------------------------------------------------------ *
 * The state token, and the board around it.
 * ------------------------------------------------------------------ */

/**
 * A mark, as the chat draws it. There is deliberately no glyph for an empty
 * square: since the grid names its empty cells after the number that claims
 * them, a blank glyph has nothing left to mean, and leaving one here invites a
 * second way to draw a board that nothing keeps in step with `renderGrid`.
 */
const GLYPH: Record<Mark, string> = { x: "❌", o: "⭕" };

/** `#ttt <9 cells> <user mark> <level>` — the whole save file, on one line. */
export function encodeState({ board, user, level }: GameState): string {
  const cells = board.map((cell) => cell ?? ".").join("");
  return `${STATE_PREFIX} ${cells} ${user} ${level}`;
}

/**
 * Recover the game from a message, or `null` if this message is not a board.
 *
 * Strict on purpose. A token that has been half-edited by a fat thumb on a
 * phone is not a game to guess at: returning `null` starts a clean game, which
 * the user can see, where a lenient parse would silently resurrect a position
 * nobody played. Cell counts are checked against each other too, because
 * `xxxx.....` is well-formed text and an impossible board.
 */
export function parseState(text: string): GameState | null {
  const match = /#ttt\s+([xo.]{9})\s+([xo])\s+(easy|normal|hard)\b/i.exec(text ?? "");
  if (!match) return null;

  const board: Board = [...match[1].toLowerCase()].map((c) => (c === "." ? null : (c as Mark)));
  const xs = board.filter((c) => c === "x").length;
  const os = board.filter((c) => c === "o").length;
  // X moves first, so O can never lead and can never trail by more than one.
  if (xs - os !== 0 && xs - os !== 1) return null;

  return { board, user: match[2].toLowerCase() as Mark, level: match[3].toLowerCase() as Level };
}

/** True when this message is one of the agent's boards rather than a move. */
export const isBoardMessage = (text: string): boolean => parseState(text) !== null;

/**
 * The keypad digits, as emoji.
 *
 * An empty square is drawn as the number that claims it, which is what makes the
 * board playable with no legend: the footer says "reply with a square (a1–c3, or
 * 1–9)" and the grid now shows one of those notations in place. Drawn as a blank
 * glyph, the instruction had nothing on screen to point at.
 *
 * Emoji rather than the ASCII digits `1`–`9` for a reason that is visual, not
 * decorative: ❌ and ⭕ are emoji-width and `1` is not, so a mixed board's
 * columns drift apart as it fills up. Keycaps keep every cell one width.
 */
const KEYPAD = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"] as const;

function renderGrid(board: Board): string {
  const rows: string[] = [];
  for (let r = 0; r < 3; r += 1) {
    const row = board
      .slice(r * 3, r * 3 + 3)
      .map((cell, c) => (cell === null ? KEYPAD[r * 3 + c] : GLYPH[cell]));
    // Joined with nothing: keycaps and marks already carry their own spacing,
    // and a space between them widens the board past a phone's column on the
    // narrower renderings.
    rows.push(row.join(""));
  }
  return rows.join("\n");
}

/**
 * The message the agent writes: a heading, the grid, one line saying what
 * happens next, and the state token.
 *
 * `note` is where a rejected move is explained ("b2 is taken"), so the user
 * always gets the current board back with the reason attached rather than a
 * bare complaint they have to match up with a board scrolled off the screen.
 */
export function renderBoard(state: GameState, note?: string): string {
  const { board, user, level } = state;
  const agent = other(user);
  const result = outcome(board);

  const head = `🎮 Tic-tac-toe · you ${GLYPH[user]} · me ${GLYPH[agent]} · ${level}`;

  let footer: string;
  if (result.status === "won") {
    footer = result.winner === user ? "You win. 🏆 Say `ttt new` for another." : "I win. Say `ttt new` for another.";
  } else if (result.status === "draw") {
    footer = "Draw. Say `ttt new` for another.";
  } else if (result.turn === user) {
    footer = "Your move — reply with a square (a1–c3, or 1–9).";
  } else {
    footer = "My move next.";
  }

  const lines = [head, "", renderGrid(board), ""];
  if (note?.trim()) lines.push(note.trim(), "");
  lines.push(footer, encodeState(state));
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Drawing the board as an image.
 * ------------------------------------------------------------------ */

/**
 * What a drawn board looks like — once, for every renderer that draws one.
 *
 * ── Why this is extracted ───────────────────────────────────────────────────
 * The SVG and the PNG each began with their own copy, and the copies drifted:
 * a mark sat 24% inside its square in one and 26% in the other, with unrelated
 * stroke widths. Nothing failed. The board a person looked at and the board that
 * was sent to their chat were simply different pictures of the same position,
 * and no test could notice because each renderer was checked against itself.
 *
 * Two drawings of one game is a fact about the game, not about either renderer,
 * so it lives here and both derive from it.
 *
 * Stroke widths and the mark inset are FRACTIONS of a cell rather than pixel
 * counts, because that is what makes them portable: the SVG scales to whatever
 * the viewer's device gives it, and the raster is fixed at `size`. A shared
 * constant in pixels would only be shared at one of those two sizes.
 */
export const BOARD_ART = {
  /** The raster's edge, and the SVG's viewBox. */
  size: 480,
  pad: 24,
  get cell(): number {
    return (this.size - this.pad * 2) / 3;
  },
  /** How far inside its square a mark sits, as a fraction of the cell. */
  markInset: 0.26,
  strokes: {
    grid: 0.05,
    mark: 0.11,
    strike: 0.09,
  },
  palette: {
    background: "#f4f1ea",
    grid: "#c8bfa9",
    cross: "#c2410c",
    nought: "#1d4ed8",
    strike: "#2e2a24",
  },
} as const;

/** The middle of a square, in the drawing's own coordinates. */
function squareCentre(index: number, pad: number, cell: number): { x: number; y: number } {
  return {
    x: pad + (index % 3) * cell + cell / 2,
    y: pad + Math.floor(index / 3) * cell + cell / 2,
  };
}

/**
 * The board as an SVG.
 *
 * ── Why SVG and not a raster ────────────────────────────────────────────────
 * This module is imported by the agent and must stay dependency-free: it has no
 * image toolchain, and adding one to draw nine squares would be absurd. SVG is
 * text, so producing it costs nothing and rasterising is the caller's choice —
 * `whatsapp-transport` will only accept PNG or JPEG, so a caller sending one to
 * a chat converts first.
 *
 * ── Why it draws rather than writes ─────────────────────────────────────────
 * No `<text>`, no font, no external reference of any kind. A drawing that names
 * a font renders differently on every machine and collapses where that font is
 * missing — which, in a container built from scratch, is everywhere. Strokes and
 * a circle look the same everywhere and need nothing installed.
 *
 * ── Why every colour is an attribute and not a stylesheet ───────────────────
 * The first version put the styling in a `<style>` block, which browsers honour
 * and rasterisers largely do not: ImageMagick applied the single-class rules and
 * silently ignored the descendant selector, so every X rendered as a black
 * hairline instead of a thick orange cross. It looked fine as markup and wrong
 * as a picture.
 *
 * Presentation attributes are understood by every SVG renderer there is. The
 * `class` attributes are kept as labels — for a reader, and for the tests to
 * count marks by — and carry no styling.
 *
 * The emoji grid in `renderBoard` remains the board you reply to; this is the
 * board you look at. Both are pure functions of the same state, so they cannot
 * disagree about the position.
 */
export function renderBoardSvg(state: GameState): string {
  const { board } = state;
  const { size, pad, cell, markInset, strokes, palette } = BOARD_ART;
  const inset = cell * markInset;

  const centre = (index: number) => squareCentre(index, pad, cell);

  const GRID = `stroke="${palette.grid}" stroke-width="${Math.round(cell * strokes.grid)}" stroke-linecap="round"`;
  const CROSS = `stroke="${palette.cross}" stroke-width="${Math.round(cell * strokes.mark)}" stroke-linecap="round"`;
  const NOUGHT = `fill="none" stroke="${palette.nought}" stroke-width="${Math.round(cell * strokes.mark)}"`;
  const STRIKE =
    `stroke="${palette.strike}" stroke-width="${Math.round(cell * strokes.strike)}" stroke-linecap="round"`;

  const parts: string[] = [];
  parts.push(`<rect width="${size}" height="${size}" rx="18" fill="${palette.background}"/>`);

  // The grid: two lines each way, drawn short of the edges so the board reads as
  // a frame rather than a table.
  for (let i = 1; i < 3; i += 1) {
    const at = pad + i * cell;
    parts.push(
      `<line class="grid" ${GRID} x1="${at}" y1="${pad + 10}" x2="${at}" y2="${size - pad - 10}"/>`,
      `<line class="grid" ${GRID} x1="${pad + 10}" y1="${at}" x2="${size - pad - 10}" y2="${at}"/>`,
    );
  }

  board.forEach((mark, index) => {
    if (mark === null) return;
    const { x, y } = centre(index);
    if (mark === "o") {
      parts.push(`<circle class="o" ${NOUGHT} cx="${x}" cy="${y}" r="${cell / 2 - inset}"/>`);
      return;
    }
    const arm = cell / 2 - inset;
    parts.push(
      `<g class="x">` +
        `<line ${CROSS} x1="${x - arm}" y1="${y - arm}" x2="${x + arm}" y2="${y + arm}"/>` +
        `<line ${CROSS} x1="${x - arm}" y1="${y + arm}" x2="${x + arm}" y2="${y - arm}"/>` +
        `</g>`,
    );
  });

  // The winning line, struck through end to end. A finished game is the one most
  // worth drawing, and without this the image says less than the text does.
  const result = outcome(board);
  if (result.status === "won") {
    const from = centre(result.line[0]);
    const to = centre(result.line[2]);
    parts.push(
      `<line class="win" ${STRIKE} x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/>`,
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}">${parts.join("")}</svg>`
  );
}

/**
 * The board as a PNG.
 *
 * ── Why this exists next to the SVG ─────────────────────────────────────────
 * WhatsApp renders no SVG — `whatsapp-transport` refuses anything but PNG and
 * JPEG for exactly that reason — so a board that is to be SENT has to be a
 * raster. The agent's container has no image toolchain to convert one, and
 * adding a rasteriser as a dependency to draw nine squares would be absurd.
 *
 * So this draws pixels directly and compresses them with `node:zlib`, which is
 * built in. The whole PNG format used here is: a signature, IHDR, one IDAT of
 * zlib-deflated scanlines each prefixed with filter byte 0, and IEND. That is a
 * legal PNG and every reader accepts it.
 *
 * Anti-aliasing is deliberately absent. It would triple the code for a picture
 * of three straight lines, two crosses and a ring, and the board is rendered at
 * a size where the difference is invisible on a phone.
 */
export function renderBoardPng(state: GameState): Uint8Array {
  const { board } = state;
  const { size, pad, cell, markInset, strokes, palette } = BOARD_ART;
  const inset = cell * markInset;

  const canvas = new Uint8Array(size * size * 4);
  fill(canvas, size, rgb(palette.background));

  const centre = (index: number) => squareCentre(index, pad, cell);
  const width = (fraction: number) => Math.max(1, Math.round(cell * fraction));

  for (let i = 1; i < 3; i += 1) {
    const at = pad + i * cell;
    line(canvas, size, at, pad + 8, at, size - pad - 8, width(strokes.grid), rgb(palette.grid));
    line(canvas, size, pad + 8, at, size - pad - 8, at, width(strokes.grid), rgb(palette.grid));
  }

  board.forEach((mark, index) => {
    if (mark === null) return;
    const { x, y } = centre(index);
    const arm = cell / 2 - inset;
    if (mark === "o") {
      ring(canvas, size, x, y, arm, width(strokes.mark), rgb(palette.nought));
      return;
    }
    line(canvas, size, x - arm, y - arm, x + arm, y + arm, width(strokes.mark), rgb(palette.cross));
    line(canvas, size, x - arm, y + arm, x + arm, y - arm, width(strokes.mark), rgb(palette.cross));
  });

  const result = outcome(board);
  if (result.status === "won") {
    const from = centre(result.line[0]);
    const to = centre(result.line[2]);
    line(canvas, size, from.x, from.y, to.x, to.y, width(strokes.strike), rgb(palette.strike));
  }

  return encodePng(canvas, size, size);
}

/** `#rrggbb` to the triple the raster works in. */
function rgb(colour: string): RGB {
  return [
    Number.parseInt(colour.slice(1, 3), 16),
    Number.parseInt(colour.slice(3, 5), 16),
    Number.parseInt(colour.slice(5, 7), 16),
  ];
}

type RGB = readonly [number, number, number];

function fill(canvas: Uint8Array, width: number, [r, g, b]: RGB): void {
  for (let i = 0; i < canvas.length; i += 4) {
    canvas[i] = r;
    canvas[i + 1] = g;
    canvas[i + 2] = b;
    canvas[i + 3] = 255;
  }
}

function dot(canvas: Uint8Array, width: number, x: number, y: number, [r, g, b]: RGB): void {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  canvas[i] = r;
  canvas[i + 1] = g;
  canvas[i + 2] = b;
  canvas[i + 3] = 255;
}

/**
 * A thick straight line, drawn by stepping along it and stamping a square brush.
 *
 * Stepping in the longer axis rather than in x guarantees no gaps on a steep
 * line, which is what a naive `for (x...)` produces on the diagonals — and every
 * X on this board is two diagonals.
 */
function line(
  canvas: Uint8Array,
  width: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thickness: number,
  colour: RGB,
): void {
  const steps = Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))) * 2;
  const half = Math.max(1, Math.round(thickness / 2));

  for (let step = 0; step <= steps; step += 1) {
    const t = steps === 0 ? 0 : step / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    for (let dy = -half; dy <= half; dy += 1) {
      for (let dx = -half; dx <= half; dx += 1) {
        dot(canvas, width, x + dx, y + dy, colour);
      }
    }
  }
}

/** An annulus: every pixel whose distance from the centre is within the stroke. */
function ring(
  canvas: Uint8Array,
  width: number,
  cx: number,
  cy: number,
  radius: number,
  thickness: number,
  colour: RGB,
): void {
  const outer = radius + thickness / 2;
  const inner = radius - thickness / 2;

  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y += 1) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance <= outer && distance >= inner) dot(canvas, width, x, y, colour);
    }
  }
}

/** RGBA pixels to a PNG file. Filter 0 on every scanline; one IDAT. */
function encodePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0; // filter: None
    Buffer.from(pixels.buffer, pixels.byteOffset + row * stride, stride).copy(
      raw,
      row * (stride + 1) + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 are compression, filter and interlace methods; 0 is the only value
  // PNG defines for each, and Buffer.alloc has already written them.

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);

  return Buffer.concat([length, body, crc]);
}

/* ------------------------------------------------------------------ *
 * Reading what the user typed.
 * ------------------------------------------------------------------ */

export type Command =
  | { kind: "new"; user?: Mark; level?: Level }
  | { kind: "move"; square: number }
  | { kind: "resign" }
  | { kind: "status" }
  | { kind: "none" };

/**
 * Classify one message from the self chat.
 *
 * The self chat is a notebook, not a game console: most of what is in it has
 * nothing to do with tic-tac-toe. So a bare square (`b2`) counts as a move only
 * when a game is already open — `inGame` — and everything else has to be
 * addressed to the game with `ttt` or `tic tac toe` first. Without that rule a
 * shopping note reading "3" would be a move.
 */
export function parseCommand(text: string, inGame: boolean): Command {
  const raw = (text ?? "").trim();
  if (!raw) return { kind: "none" };

  const lower = raw.toLowerCase();
  const addressed = /^(ttt|tic[\s-]?tac[\s-]?toe|jogo da velha)\b[:,]?\s*/i.exec(lower);
  const rest = addressed ? lower.slice(addressed[0].length).trim() : lower;

  if (addressed || inGame) {
    if (/^(new|start|restart|again|novo|nova)\b/.test(rest) || (addressed && rest === "")) {
      const level = LEVELS.find((l) => new RegExp(`\\b${l}\\b`).test(rest));
      // "I want O" — the mark the user asks for, not the one they mention.
      const mark = /\b(as|com|jogo(?: de)?)\s+([xo])\b/.exec(rest)?.[2] as Mark | undefined;
      return { kind: "new", user: mark, level };
    }
    if (/^(resign|quit|stop|give up|desisto)\b/.test(rest)) return { kind: "resign" };
    if (/^(status|board|show|placar)\b/.test(rest)) return { kind: "status" };
  }

  // A bare square only counts inside a game, or when addressed: "ttt b2".
  if (addressed || inGame) {
    const square = parseSquare(rest);
    if (square !== null) return { kind: "move", square };
  }

  return { kind: "none" };
}

/**
 * What the chat says the game is, and what to do about it.
 *
 * `queued` is why this is not simply "the last thing they typed": if the user
 * sent `b2` and then `c3`, both are moves and both must be played, in order.
 * Taking the newest would silently swallow the first, and a swallowed move in a
 * game whose entire state is the transcript is indistinguishable from a bug.
 * So the *first* pending move is played and the rest are reported, for the
 * caller to come back for.
 *
 * A `new` supersedes anything before it, because restarting is a decision about
 * the whole game rather than a move within it.
 */
export interface ChatRead {
  /** The newest board found in the window, or `null` if there is no game. */
  state: GameState | null;
  command: Command;
  /** Further moves waiting behind this one. */
  queued: number;
}

/**
 * Recover the game from the tail of the self chat.
 *
 * `texts` are message bodies in chat order, oldest first — exactly what
 * `readChat` returns. Note that direction is useless here: in the user's own
 * chat every message is outgoing, the agent's boards included, so a board is
 * recognised by its state token and nothing else.
 */
export function readGame(texts: string[]): ChatRead {
  let boardIndex = -1;
  let state: GameState | null = null;
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const parsed = parseState(texts[i]);
    if (parsed) {
      boardIndex = i;
      state = parsed;
      break;
    }
  }

  const after = texts.slice(boardIndex + 1);
  const live = state !== null && !isOver(state.board);
  const commands = after.map((text) => parseCommand(text, live)).filter((c) => c.kind !== "none");

  const restarts = commands.filter((c) => c.kind === "new");
  if (restarts.length) return { state, command: restarts.at(-1)!, queued: 0 };

  const resign = commands.find((c) => c.kind === "resign");
  if (resign) return { state, command: resign, queued: 0 };

  const moves = commands.filter((c) => c.kind === "move");
  if (moves.length) return { state, command: moves[0], queued: moves.length - 1 };

  const status = commands.find((c) => c.kind === "status");
  return { state, command: status ?? { kind: "none" }, queued: 0 };
}

/**
 * A turn: the user's move, then the agent's reply, as one atomic step.
 *
 * Returned rather than written — the caller owns the bridge. `note` carries a
 * rejected move's reason; `board` is always the position to show, valid or not,
 * so the user is never told "no" without being shown what is actually there.
 */
export interface TurnResult {
  state: GameState;
  /** The agent's reply move, when it had one. */
  agentSquare: number | null;
  note?: string;
  /** False when the user's move was rejected: the position did not change. */
  applied: boolean;
}

export function playTurn(
  state: GameState,
  square: number,
  pick: Chooser = pickRandom,
): TurnResult {
  const agent = other(state.user);

  if (isOver(state.board)) {
    return { state, agentSquare: null, applied: false, note: "That game is over — say `ttt new` to start another." };
  }
  if (turnOf(state.board) !== state.user) {
    return { state, agentSquare: null, applied: false, note: "It is my turn, not yours." };
  }

  const played = applyMove(state.board, square, state.user);
  if (!played.ok) return { state, agentSquare: null, applied: false, note: played.error };

  let board = played.board;
  const reply = chooseMove(board, agent, state.level, pick);
  if (reply !== null) {
    const answered = applyMove(board, reply, agent);
    // Unreachable by construction: `chooseMove` only returns legal squares on a
    // live board. Kept because a silent no-op here would look like a lost move.
    if (!answered.ok) throw new Error(`engine chose an illegal square: ${answered.error}`);
    board = answered.board;
  }

  return { state: { ...state, board }, agentSquare: reply, applied: true };
}

/**
 * Open a game. When the agent is X it must move first, so that move is played
 * here — a board that says "my move next" and then waits is a game that looks
 * stuck for fifteen minutes.
 */
export function startGame(
  { user = "x", level = "normal" }: { user?: Mark; level?: Level } = {},
  pick: Chooser = pickRandom,
): { state: GameState; agentSquare: number | null } {
  const state: GameState = { board: emptyBoard(), user, level };
  if (user === "x") return { state, agentSquare: null };

  const first = chooseMove(state.board, "x", level, pick);
  if (first === null) return { state, agentSquare: null };
  const played = applyMove(state.board, first, "x");
  if (!played.ok) throw new Error(`engine chose an illegal opening square: ${played.error}`);
  return { state: { ...state, board: played.board }, agentSquare: first };
}
