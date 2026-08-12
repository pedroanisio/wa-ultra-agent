import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

import {
  BOARD_ART,
  type Board,
  type GameState,
  type Level,
  type Mark,
  applyMove,
  chooseMove,
  emptyBoard,
  encodeState,
  isBoardMessage,
  legalMoves,
  outcome,
  parseCommand,
  parseSquare,
  parseState,
  pickFirst,
  playTurn,
  readGame,
  renderBoard,
  renderBoardPng,
  renderBoardSvg,
  squareName,
  startGame,
  turnOf,
} from "../agent/lib/tictactoe.ts";

/**
 * The chat is the save file, so the two things that must never break are the
 * round trip (`renderBoard` → `parseState`) and the legality of every position
 * either side can reach. Everything else is a rule of the game.
 *
 * `pickFirst` is passed wherever the engine may choose between equal moves, so
 * no test here depends on Math.random.
 */

/** `"xo.|..x|..."` → a board. Reading a position beats writing nine nulls. */
function boardOf(sketch: string): Board {
  const cells = sketch.replace(/[|\s]/g, "");
  assert.equal(cells.length, 9, "a sketched board has nine cells");
  return [...cells].map((c) => (c === "." ? null : (c as Mark)));
}

const state = (sketch: string, user: Mark = "x", level: Level = "normal"): GameState => ({
  board: boardOf(sketch),
  user,
  level,
});

/* ── the rules ─────────────────────────────────────────────────────── */

test("X moves first, and the turn is counted from the board", () => {
  assert.equal(turnOf(emptyBoard()), "x");
  assert.equal(turnOf(boardOf("x..|...|...")), "o");
  assert.equal(turnOf(boardOf("xo.|...|...")), "x");
});

test("a completed line wins, and the line is reported", () => {
  const result = outcome(boardOf("xxx|oo.|..."));
  assert.equal(result.status, "won");
  assert.equal(result.status === "won" && result.winner, "x");
  assert.deepEqual(result.status === "won" ? result.line : null, [0, 1, 2]);
});

test("every one of the eight lines is recognised", () => {
  const lines = [
    "xxx|...|...", "...|xxx|...", "...|...|xxx",
    "x..|x..|x..", ".x.|.x.|.x.", "..x|..x|..x",
    "x..|.x.|..x", "..x|.x.|x..",
  ];
  for (const sketch of lines) {
    const result = outcome(boardOf(sketch));
    assert.equal(result.status, "won", `${sketch} is a win`);
  }
});

test("a full board with no line is a draw", () => {
  assert.equal(outcome(boardOf("xox|xxo|oxo")).status, "draw");
});

test("a move on a taken square, out of turn, or after the game is refused", () => {
  const open = boardOf("x..|...|...");
  assert.equal(applyMove(open, 0, "o").ok, false, "square is taken");
  assert.equal(applyMove(open, 1, "x").ok, false, "not X's turn");
  assert.equal(applyMove(boardOf("xxx|oo.|..."), 5, "o").ok, false, "game is over");
  assert.equal(applyMove(open, 9, "o").ok, false, "off the board");
});

test("applying a move never mutates the board it was given", () => {
  const before = emptyBoard();
  const result = applyMove(before, 4, "x");
  assert.equal(result.ok, true);
  assert.deepEqual(before, emptyBoard());
  assert.equal(result.ok && result.board[4], "x");
});

/* ── naming squares ────────────────────────────────────────────────── */

test("squares are named a1 through c3", () => {
  assert.equal(squareName(0), "a1");
  assert.equal(squareName(4), "b2");
  assert.equal(squareName(8), "c3");
});

test("a square is parsed from grid, reversed grid, or keypad notation", () => {
  assert.equal(parseSquare("a1"), 0);
  assert.equal(parseSquare("B2"), 4);
  assert.equal(parseSquare(" c3 "), 8);
  assert.equal(parseSquare("2b"), 4);
  assert.equal(parseSquare("5"), 4);
  assert.equal(parseSquare("9"), 8);
  assert.equal(parseSquare("b2."), 4, "trailing punctuation is typed by everyone");
});

test("text that merely contains a square is not a square", () => {
  for (const noise of ["call b2b vendor", "d4", "a4", "", "b", "22", "b2 later"]) {
    assert.equal(parseSquare(noise), null, `${JSON.stringify(noise)} is not a move`);
  }
});

/* ── the state token: the whole save file ──────────────────────────── */

test("a rendered board round-trips back to the same game", () => {
  for (const level of ["easy", "normal", "hard"] as const) {
    for (const user of ["x", "o"] as const) {
      const original = state("xo.|.x.|..o", user, level);
      const parsed = parseState(renderBoard(original));
      assert.deepEqual(parsed, original, `${user}/${level} must survive the chat`);
    }
  }
});

test("an empty game round-trips", () => {
  const original: GameState = { board: emptyBoard(), user: "x", level: "hard" };
  assert.deepEqual(parseState(renderBoard(original)), original);
});

test("the token is the last line, so it survives being quoted above", () => {
  const rendered = renderBoard(state("x..|...|..."));
  assert.match(rendered.split("\n").at(-1)!, /^#ttt /);
  assert.equal(encodeState(state("x..|...|...")), "#ttt x........ x normal");
});

test("an impossible or damaged token is refused rather than guessed at", () => {
  assert.equal(parseState("#ttt xxxx..... x hard"), null, "X cannot have four to O's none");
  assert.equal(parseState("#ttt oo....... x hard"), null, "O cannot lead");
  assert.equal(parseState("#ttt xo..... x hard"), null, "too few cells");
  assert.equal(parseState("#ttt xo....... z hard"), null, "no such mark");
  assert.equal(parseState("#ttt xo....... x brutal"), null, "no such level");
  assert.equal(parseState("just a note to myself"), null);
});

test("a board message is told apart from a move", () => {
  assert.equal(isBoardMessage(renderBoard(state("x..|...|..."))), true);
  assert.equal(isBoardMessage("b2"), false);
});

/* ── drawing the board ─────────────────────────────────────────────── */

/**
 * The board has to be readable as a board, on a phone, with no legend.
 *
 * The footer tells the player to reply with a square "a1–c3, or 1–9" — and the
 * grid used to be nine identical blank glyphs, so there was nothing on screen
 * connecting either notation to a position. Naming the empty squares in the grid
 * itself is what closes that gap: what you type is what you see.
 */
test("an empty square shows the number you would type to claim it", () => {
  const grid = boardLines(renderBoard(state("...|...|...")));

  assert.deepEqual(grid, ["1️⃣2️⃣3️⃣", "4️⃣5️⃣6️⃣", "7️⃣8️⃣9️⃣"]);
});

test("a played square shows its mark instead of its number", () => {
  const grid = boardLines(renderBoard(state("x.o|.x.|o..")));

  assert.deepEqual(grid, ["❌2️⃣⭕", "4️⃣❌6️⃣", "⭕8️⃣9️⃣"]);
});

// Keycaps and marks are both emoji-width, so the columns line up. A digit
// character would not, and a board whose columns wander is unreadable.
test("every cell is one emoji wide, so the columns line up", () => {
  for (const line of boardLines(renderBoard(state("xo.|.x.|..o")))) {
    assert.equal([...new Intl.Segmenter().segment(line)].length, 3, `"${line}" is not three cells`);
  }
});

test("the grid is exactly three rows, whatever the position", () => {
  for (const sketch of ["...|...|...", "xxx|oo.|...", "xox|oxo|xox"]) {
    assert.equal(boardLines(renderBoard(state(sketch))).length, 3);
  }
});

/* ── drawing the board as an image ─────────────────────────────────── */

/**
 * The emoji grid is the board a phone can reply to; the SVG is the board a
 * person can look at. Both are pure functions of the same state, so a drawing
 * can never disagree with the position it came from.
 *
 * SVG rather than a raster because this module must stay dependency-free — it is
 * imported by the agent, which has no image toolchain. Turning it into a PNG is
 * the caller's problem, and a text format keeps that optional.
 */
test("the board draws as a self-contained SVG sized to its viewBox", () => {
  const svg = renderBoardSvg(state("...|...|..."));

  assert.match(svg, /^<svg\b/);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<\/svg>\s*$/);
  // A drawing that reaches for a font, a stylesheet or an image is one that
  // renders differently everywhere and not at all offline.
  assert.doesNotMatch(svg, /<image|<use|href=|@import|<text/);
});

/**
 * The bug this pins actually shipped: the first version styled the marks from a
 * `<style>` block, and ImageMagick applied the single-class rules while silently
 * ignoring the descendant selector. Every X rasterised as a black hairline. The
 * markup looked right and the picture was wrong, which no assertion about
 * structure would have caught.
 *
 * Presentation attributes are understood by every renderer, so the rule is: no
 * stylesheet, and every stroke carries its own paint.
 */
test("marks are painted by attributes, so a rasteriser cannot drop the styling", () => {
  const svg = renderBoardSvg(state("xox|...|..."));

  assert.doesNotMatch(svg, /<style/, "a stylesheet is not honoured by every rasteriser");
  for (const stroked of svg.match(/<(line|circle)\b[^>]*>/g) ?? []) {
    assert.match(stroked, /stroke="#[0-9a-f]{6}"/i, `unpainted: ${stroked}`);
    assert.match(stroked, /stroke-width="\d+"/, `no width: ${stroked}`);
  }
});

test("an empty board draws the grid and nothing else", () => {
  const svg = renderBoardSvg(state("...|...|..."));

  assert.equal(countOf(svg, "<circle"), 0, "no O was played");
  assert.equal(countOf(svg, 'class="x"'), 0, "no X was played");
});

test("each played square draws its own mark, and only its own", () => {
  const svg = renderBoardSvg(state("xox|...|..."));

  assert.equal(countOf(svg, 'class="x"'), 2, "two X strokes-groups, one per X");
  assert.equal(countOf(svg, "<circle"), 1, "one O");
});

// A finished game is the one most worth drawing, and the line is the whole
// story of it. Leaving it unmarked makes the image strictly worse than the text.
test("a won board strikes through the winning line", () => {
  const svg = renderBoardSvg(state("xxx|oo.|..."));

  assert.match(svg, /class="win"/);
});

test("an unfinished or drawn board has no winning line to strike", () => {
  assert.doesNotMatch(renderBoardSvg(state("x..|...|...")), /class="win"/);
  assert.doesNotMatch(renderBoardSvg(state("xox|xxo|oxo")), /class="win"/);
});

/* ── drawing the board as a PNG ─────────────────────────────────────── */

/**
 * WhatsApp renders no SVG, so a board that is to be SENT has to be a raster —
 * and the agent's container has no image toolchain to convert one. So the PNG is
 * drawn directly, with `node:zlib` doing the compression, and the module stays
 * dependency-free.
 *
 * These assertions decode the file rather than trusting its header: a PNG with a
 * correct IHDR and garbage pixels is exactly the failure the SVG stylesheet bug
 * already taught this module to test for.
 */
test("the board renders as a decodable PNG of the declared size", () => {
  const png = renderBoardPng(state("...|...|..."));

  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
  const { width, height, pixels } = decodePng(png);
  assert.equal(width, height, "the board is square");
  assert.equal(pixels.length, width * height * 4, "every pixel decoded");
});

test("an empty square is background and a played square is not", () => {
  const png = renderBoardPng(state("x..|...|..."));
  const { width, pixels } = decodePng(png);

  const at = (col: number, row: number) => {
    const cell = width / 3;
    const x = Math.round(cell * col + cell / 2);
    const y = Math.round(cell * row + cell / 2);
    const i = (y * width + x) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2]].join(",");
  };

  // Dead centre of a1 sits on the crossing of the X's two strokes.
  assert.notEqual(at(0, 0), at(2, 2), "the played square looks the same as an empty one");
});

/**
 * Stated as a shape property rather than by sampling coordinates, so the test
 * does not encode the renderer's padding and cell size — the first version did,
 * got them wrong, and failed against a picture that was correct.
 *
 * A ring has a hole: somewhere there is a horizontal run of ring, then not-ring,
 * then ring again. A filled disc never produces that.
 */
test("an O is drawn as a ring, not a filled disc", () => {
  const { width, height, pixels } = decodePng(renderBoardPng(state("xo.|...|...")));
  const NOUGHT = "29,78,216";

  const colourAt = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
  };

  let holed = false;
  for (let y = 0; y < height && !holed; y += 1) {
    const runs: string[] = [];
    for (let x = 0; x < width; x += 1) {
      const isRing = colourAt(x, y) === NOUGHT ? "ring" : "gap";
      if (runs.at(-1) !== isRing) runs.push(isRing);
    }
    // ring, gap, ring — the hole — somewhere in the row.
    holed = runs.join(" ").includes("ring gap ring");
  }

  assert.ok(holed, "no row crosses the ring twice, so the O is filled");
});

test("a won board draws a strike that an unfinished one does not", () => {
  const won = distinctColours(renderBoardPng(state("xxx|oo.|...")));
  const open = distinctColours(renderBoardPng(state("xx.|oo.|...")));

  assert.ok(won > open, `a win added no ink (${won} colours vs ${open})`);
});

/* ── the two drawings are one board ────────────────────────────────── */

/**
 * The SVG and the PNG draw the same game, so they must draw it the same way.
 *
 * They did not. Each carried its own geometry — a mark sat 24% inside its square
 * in the SVG and 26% in the PNG, with unrelated stroke widths — so the board a
 * person looked at and the board that got sent were subtly different pictures of
 * the same position. Nothing failed; they just disagreed.
 *
 * `BOARD_ART` is now the single description both derive from, and this measures
 * the rendered output against it rather than trusting that they read the same
 * constant.
 */
test("both renderers draw a mark at the same size", () => {
  const svg = renderBoardSvg(state(".o.|...|..."));
  const radius = Number(/<circle[^>]*\br="([\d.]+)"/.exec(svg)![1]);
  const svgStroke = Number(/<circle[^>]*\bstroke-width="([\d.]+)"/.exec(svg)![1]);
  // The ring's outer edge, which is what the eye measures.
  const svgOuter = (radius + svgStroke / 2) / BOARD_ART.cell;

  const { width, height, pixels } = decodePng(renderBoardPng(state(".o.|...|...")));
  let minX = Infinity;
  let maxX = -Infinity;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const colour = `#${[pixels[i], pixels[i + 1], pixels[i + 2]].map(hex).join("")}`;
      if (colour !== BOARD_ART.palette.nought) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  const pngOuter = (maxX - minX) / 2 / BOARD_ART.cell;

  assert.ok(
    Math.abs(svgOuter - pngOuter) < 0.02,
    `the two renderers disagree about mark size: svg ${svgOuter.toFixed(3)} vs png ${pngOuter.toFixed(3)}`,
  );
});

test("both renderers use the one declared palette", () => {
  // A won board, because the strike colour exists only on a finished game.
  const svg = renderBoardSvg(state("xxx|oo.|..."));
  for (const colour of Object.values(BOARD_ART.palette)) {
    assert.ok(svg.includes(colour), `${colour} is declared but the SVG does not use it`);
  }

  const { pixels } = decodePng(renderBoardPng(state("xxx|oo.|...")));
  const seen = new Set<string>();
  for (let i = 0; i < pixels.length; i += 4) {
    seen.add(`#${[pixels[i], pixels[i + 1], pixels[i + 2]].map(hex).join("")}`);
  }
  // Every colour in the raster is one the palette named: no renderer-local ink.
  for (const colour of seen) {
    assert.ok(
      Object.values(BOARD_ART.palette).includes(colour as never),
      `the PNG contains ${colour}, which the palette does not declare`,
    );
  }
});

const hex = (n: number) => n.toString(16).padStart(2, "0");

/** How many distinct RGB values a rendered board contains. */
function distinctColours(png: Uint8Array): number {
  const { pixels } = decodePng(png);
  const seen = new Set<string>();
  for (let i = 0; i < pixels.length; i += 4) {
    seen.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
  }
  return seen.size;
}

/**
 * A minimal PNG reader, for the tests only.
 *
 * Deliberately not a dependency and deliberately not shared with the writer:
 * a decoder built from the encoder's own assumptions would agree with it about
 * a file no other reader accepts.
 */
function decodePng(png: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];

  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4);
      assert.equal(data[8], 8, "8 bits per channel");
      assert.equal(data[9], 6, "RGBA");
    }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;

    offset += 12 + length; // length + type + data + CRC
  }

  const raw = inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk))));
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);

  // Undo the per-scanline filter. Only filter 0 (None) and 1 (Sub) are handled,
  // which is all the writer emits; anything else fails loudly rather than
  // quietly producing wrong pixels.
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    assert.ok(filter === 0 || filter === 1, `unsupported PNG filter ${filter}`);
    for (let i = 0; i < stride; i += 1) {
      const left = filter === 1 && i >= 4 ? pixels[row * stride + i - 4] : 0;
      pixels[row * stride + i] = (line[i] + left) & 0xff;
    }
  }
  return { width, height, pixels };
}

/** How many times `needle` occurs in `haystack`. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The grid, pulled out of a rendered message: the lines made only of cells. */
function boardLines(rendered: string): string[] {
  return rendered
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && /^[❌⭕0-9️⃣]+$/u.test(line));
}

/* ── reading what the user typed ───────────────────────────────────── */

test("a bare square is a move only inside a game", () => {
  assert.deepEqual(parseCommand("b2", true), { kind: "move", square: 4 });
  assert.deepEqual(parseCommand("b2", false), { kind: "none" });
  assert.deepEqual(parseCommand("ttt b2", false), { kind: "move", square: 4 });
});

test("an unrelated self-note is never a move", () => {
  for (const note of ["buy milk", "3 boxes for the office", "ligar amanha", "meeting at 5"]) {
    assert.deepEqual(parseCommand(note, true), { kind: "none" }, `${note} is not a move`);
  }
});

test("a game is started, optionally with a mark and a level", () => {
  assert.deepEqual(parseCommand("ttt", false), { kind: "new", user: undefined, level: undefined });
  assert.deepEqual(parseCommand("ttt new", false), { kind: "new", user: undefined, level: undefined });
  assert.deepEqual(parseCommand("tic tac toe new hard", false), { kind: "new", user: undefined, level: "hard" });
  assert.deepEqual(parseCommand("ttt new as o", false), { kind: "new", user: "o", level: undefined });
  assert.deepEqual(parseCommand("ttt new as o easy", false), { kind: "new", user: "o", level: "easy" });
});

test("resign and status are recognised, addressed or in game", () => {
  assert.deepEqual(parseCommand("ttt resign", false), { kind: "resign" });
  assert.deepEqual(parseCommand("stop", true), { kind: "resign" });
  assert.deepEqual(parseCommand("board", true), { kind: "status" });
  assert.deepEqual(parseCommand("status", false), { kind: "none" }, "not addressed, no game");
});

/* ── recovering the game from the chat ─────────────────────────────── */

test("the newest board in the window is the game", () => {
  const older = renderBoard(state("x..|...|...", "x"));
  const newer = renderBoard(state("xo.|.x.|...", "x"));
  const read = readGame(["buy milk", older, "b2", newer]);
  assert.deepEqual(read.state?.board, boardOf("xo.|.x.|..."));
  assert.deepEqual(read.command, { kind: "none" }, "nothing was typed after the newest board");
});

test("a chat with no board at all offers no game", () => {
  const read = readGame(["buy milk", "call the bank"]);
  assert.equal(read.state, null);
  assert.deepEqual(read.command, { kind: "none" });
});

test("an unaddressed game can still be started from a bare chat", () => {
  const read = readGame(["buy milk", "ttt new hard"]);
  assert.equal(read.state, null);
  assert.deepEqual(read.command, { kind: "new", user: undefined, level: "hard" });
});

test("a board followed by nothing is not replayed", () => {
  // The idempotence that makes it safe for two schedules to poll the same chat.
  const read = readGame([renderBoard(state("x..|...|...", "x"))]);
  assert.deepEqual(read.command, { kind: "none" });
});

test("the first pending move is played and the rest are reported", () => {
  const read = readGame([renderBoard(state("...|...|...", "x")), "a1", "c3"]);
  assert.deepEqual(read.command, { kind: "move", square: 0 });
  assert.equal(read.queued, 1, "c3 is still waiting and must not be lost");
});

test("notes between moves are ignored without breaking the queue", () => {
  const read = readGame([renderBoard(state("...|...|...", "x")), "remember the passport", "b2"]);
  assert.deepEqual(read.command, { kind: "move", square: 4 });
  assert.equal(read.queued, 0);
});

test("a restart supersedes moves typed before it", () => {
  const read = readGame([renderBoard(state("x..|...|...", "x")), "b2", "ttt new as o"]);
  assert.deepEqual(read.command, { kind: "new", user: "o", level: undefined });
  assert.equal(read.queued, 0);
});

test("once the game is finished a bare square is no longer a move", () => {
  // The board is won, so the chat is a notebook again until the user says `ttt`.
  const read = readGame([renderBoard(state("xxx|oo.|...", "x")), "5"]);
  assert.deepEqual(read.command, { kind: "none" });
});

/* ── the engine ────────────────────────────────────────────────────── */

test("normal blocks an immediate loss", () => {
  // X threatens a3; it is O's turn and O has nothing better to do.
  assert.equal(chooseMove(boardOf("xx.|o..|..."), "o", "normal", pickFirst), 2);
});

test("normal takes its own win rather than blocking", () => {
  // O finishes the top row at a3; X threatens b2. Winning ends the game, so the
  // block is worthless — an engine that blocks here has its priorities reversed.
  assert.equal(chooseMove(boardOf("oo.|x.x|x.."), "o", "normal", pickFirst), 2);
});

test("the engine never returns an illegal square", () => {
  for (const level of ["easy", "normal", "hard"] as const) {
    const board = boardOf("xox|.o.|x..");
    const move = chooseMove(board, turnOf(board), level, pickFirst);
    assert.notEqual(move, null);
    assert.ok(legalMoves(board).includes(move!), `${level} chose a free square`);
  }
});

test("the engine declines to move on a finished or full board", () => {
  assert.equal(chooseMove(boardOf("xxx|oo.|..."), "o", "hard", pickFirst), null);
  assert.equal(chooseMove(boardOf("xox|xxo|oxo"), "x", "hard", pickFirst), null);
  assert.equal(chooseMove(boardOf("x..|...|..."), "x", "hard", pickFirst), null, "not its turn");
});

/**
 * Perfect play is a claim that has to be checked exhaustively, not spot-checked:
 * a minimax with a sign error still passes every hand-written position.
 * This walks the entire game tree with the engine on one side and every legal
 * reply on the other, both as X and as O.
 */
test("hard never loses, from either side, against every possible opponent", () => {
  let games = 0;

  const walk = (board: Board, engine: Mark): void => {
    const result = outcome(board);
    if (result.status !== "playing") {
      games += 1;
      assert.notEqual(
        result.status === "won" && result.winner !== engine,
        true,
        `hard lost as ${engine}: ${board.map((c) => c ?? ".").join("")}`,
      );
      return;
    }

    if (result.turn === engine) {
      const move = chooseMove(board, engine, "hard", pickFirst);
      assert.notEqual(move, null);
      const played = applyMove(board, move!, engine);
      assert.equal(played.ok, true);
      walk(played.ok ? played.board : board, engine);
      return;
    }

    for (const index of legalMoves(board)) {
      const played = applyMove(board, index, result.turn);
      assert.equal(played.ok, true);
      walk(played.ok ? played.board : board, engine);
    }
  };

  walk(emptyBoard(), "x");
  walk(emptyBoard(), "o");
  // The engine's own replies are deterministic under `pickFirst`, so the tree
  // branches only on the opponent — a few hundred complete games, not the
  // 255 168 of a free-for-all. The floor is here to catch a walk that stopped
  // early and reported a pass it never earned.
  assert.ok(games > 500, `the whole tree was walked, not a corner of it (${games} games)`);
});

/* ── a turn ────────────────────────────────────────────────────────── */

test("a turn plays the user's move and answers it", () => {
  const result = playTurn(state("...|...|..."), 0, pickFirst);
  assert.equal(result.applied, true);
  assert.equal(result.state.board[0], "x");
  assert.notEqual(result.agentSquare, null);
  assert.equal(result.state.board[result.agentSquare!], "o");
  assert.equal(result.state.board.filter(Boolean).length, 2);
});

test("a rejected move changes nothing and says why", () => {
  const before = state("x..|...|...", "x");
  const result = playTurn({ ...before, board: boardOf("xo.|...|...") }, 0, pickFirst);
  assert.equal(result.applied, false);
  assert.match(result.note!, /already taken/i);
  assert.deepEqual(result.state.board, boardOf("xo.|...|..."), "the position is untouched");
});

test("the agent does not answer a move that ends the game", () => {
  // X plays c1 for the left column and wins; O must not add a tenth mark.
  const result = playTurn(state("xo.|xo.|...", "x"), 6, pickFirst);
  assert.equal(result.applied, true);
  assert.equal(result.agentSquare, null);
  assert.equal(outcome(result.state.board).status, "won");
  assert.equal(result.state.board.filter(Boolean).length, 5);
});

test("a move into a finished game is refused", () => {
  const result = playTurn(state("xxx|oo.|...", "x"), 5, pickFirst);
  assert.equal(result.applied, false);
  assert.match(result.note!, /over/i);
});

test("a move out of turn is refused", () => {
  const result = playTurn(state("x..|...|...", "x"), 1, pickFirst);
  assert.equal(result.applied, false);
  assert.match(result.note!, /my turn/i);
});

/* ── starting ──────────────────────────────────────────────────────── */

test("the user as X opens on an empty board", () => {
  const { state: opened, agentSquare } = startGame({ user: "x" }, pickFirst);
  assert.deepEqual(opened.board, emptyBoard());
  assert.equal(agentSquare, null);
  assert.equal(turnOf(opened.board), "x");
});

test("the user as O gets the agent's opening move immediately", () => {
  const { state: opened, agentSquare } = startGame({ user: "o", level: "hard" }, pickFirst);
  assert.notEqual(agentSquare, null);
  assert.equal(opened.board.filter(Boolean).length, 1);
  assert.equal(opened.board[agentSquare!], "x");
  assert.equal(turnOf(opened.board), "o", "it is the user's turn now");
});

test("a new game defaults to the user as X on normal", () => {
  const { state: opened } = startGame({}, pickFirst);
  assert.equal(opened.user, "x");
  assert.equal(opened.level, "normal");
});

/* ── what the user actually reads ──────────────────────────────────── */

test("the board shows whose move it is, and how the game ended", () => {
  assert.match(renderBoard(state("...|...|...", "x")), /Your move/);
  assert.match(renderBoard(state("xxx|oo.|...", "x")), /You win/);
  assert.match(renderBoard(state("ooo|xx.|...", "x")), /I win/);
  assert.match(renderBoard(state("xox|xxo|oxo", "x")), /Draw/);
});

test("a note is carried above the footer, with the board still shown", () => {
  const rendered = renderBoard(state("x..|...|...", "x"), "b1 is already taken by X.");
  assert.match(rendered, /already taken/);
  assert.match(rendered.split("\n").at(-1)!, /^#ttt/);
});

test("the rendered board fits in one WhatsApp message", () => {
  // The bridge caps a self-note message at 4000 characters.
  assert.ok(renderBoard(state("xox|xxo|oxo", "o", "hard"), "x".repeat(200)).length < 1000);
});
