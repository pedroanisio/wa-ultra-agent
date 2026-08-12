/**
 * What the agent is doing right now, and what it did last.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A request went in at 03:17:13 and four minutes later there was no reply, no
 * error, and nothing in any log that said whether the turn was still running,
 * stuck on a tool, or dead. Three of the failures this system has had tonight
 * were only diagnosable by reading container logs, decoding session files and
 * counting archive rows — and one of them (a silently discarded reply) was
 * invisible even then, provable only by a controlled experiment.
 *
 * The common thread is not that things failed. Things fail. It is that failure
 * and slowness were indistinguishable from each other and from success, so the
 * only honest answer to "what is it doing" was "I do not know".
 *
 * ── What it records ─────────────────────────────────────────────────────────
 * One entry per turn: when it started, which tools it called and how long each
 * took, how it ended, and how long the whole thing was. Held in memory and
 * bounded — this is an operational window, not an audit log, and the archive
 * remains the record of what was actually said.
 *
 * ── The two rules it follows ────────────────────────────────────────────────
 * 1. Never log message content. A turn's text is the user's correspondence; it
 *    belongs in the archive, which is access-controlled, and not in a container
 *    log that scrolls past in a terminal. Lengths and counts, never bodies.
 * 2. Never throw. Telemetry that can break a turn is worse than no telemetry —
 *    every entry point here swallows its own failures.
 */

/** How many finished turns to keep. Enough to explain "what just happened". */
const HISTORY_LIMIT = 40;

export type TurnOutcome = "running" | "answered" | "silent" | "failed" | "cancelled";

export interface ToolCall {
  readonly name: string;
  readonly startedAt: number;
  endedAt?: number;
  status?: string;
  error?: string;
}

export interface TurnRecord {
  readonly turnId: string;
  readonly startedAt: number;
  /** Characters in, so a huge paste is visible without logging what it said. */
  readonly requestChars: number;
  tools: ToolCall[];
  steps: number;
  endedAt?: number;
  outcome: TurnOutcome;
  /** The failure as reported, truncated. Errors are diagnostics, not content. */
  error?: string;
  /** Characters out. Zero on a turn that ended without saying anything. */
  replyChars?: number;
}

const live = new Map<string, TurnRecord>();
const history: TurnRecord[] = [];

function now(): number {
  return Date.now();
}

/** `[console]` so one grep gives the whole timeline of a turn. */
function line(turnId: string, event: string, detail: string): void {
  const short = turnId.length > 12 ? `${turnId.slice(0, 12)}…` : turnId;
  console.log(`[console] ${short} ${event}${detail ? ` ${detail}` : ""}`);
}

export function turnStarted(turnId: string, requestChars: number): void {
  try {
    const record: TurnRecord = {
      turnId,
      startedAt: now(),
      requestChars,
      tools: [],
      steps: 0,
      outcome: "running",
    };
    live.set(turnId, record);
    line(turnId, "started", `chars=${requestChars}`);
  } catch {
    /* telemetry must never break a turn */
  }
}

export function toolStarted(turnId: string, name: string): void {
  try {
    const record = live.get(turnId);
    if (!record) return;
    record.tools.push({ name, startedAt: now() });
    line(turnId, "tool→", name);
  } catch {
    /* ignored */
  }
}

export function toolFinished(turnId: string, status: string, error?: string): void {
  try {
    const record = live.get(turnId);
    if (!record) return;
    // The most recent unfinished call: results arrive in order per step, and a
    // mismatch here costs a timing figure, never correctness.
    const call = [...record.tools].reverse().find((t) => t.endedAt === undefined);
    if (!call) return;
    call.endedAt = now();
    call.status = status;
    if (error) call.error = error.slice(0, 200);
    line(
      turnId,
      "tool←",
      `${call.name} ${status} ${call.endedAt - call.startedAt}ms${error ? ` error=${call.error}` : ""}`,
    );
  } catch {
    /* ignored */
  }
}

export function stepCompleted(turnId: string): void {
  try {
    const record = live.get(turnId);
    if (record) record.steps += 1;
  } catch {
    /* ignored */
  }
}

/**
 * Close a turn's record, and hand it back.
 *
 * The record is RETURNED rather than only filed because the caller's next
 * decision depends on it: a turn that ends without a reply is answered
 * differently depending on whether the model ran at all (`steps`) and whether
 * anything already reached the user (`tools`). Re-deriving that from the
 * snapshot would mean searching a list by id for something this function is
 * holding. `undefined` on a turn that was never opened, and on any internal
 * failure — telemetry still must not break a turn.
 */
export function turnEnded(
  turnId: string,
  outcome: Exclude<TurnOutcome, "running">,
  extra: { replyChars?: number; error?: string } = {},
): TurnRecord | undefined {
  try {
    const record = live.get(turnId);
    if (!record) {
      line(turnId, outcome, "(no start recorded)");
      return undefined;
    }
    live.delete(turnId);
    record.endedAt = now();
    record.outcome = outcome;
    record.replyChars = extra.replyChars ?? 0;
    if (extra.error) record.error = extra.error.slice(0, 300);

    history.unshift(record);
    history.length = Math.min(history.length, HISTORY_LIMIT);

    const seconds = ((record.endedAt - record.startedAt) / 1000).toFixed(1);
    const tools = record.tools.map((t) => t.name).join(",") || "none";
    line(
      turnId,
      outcome,
      `in ${seconds}s steps=${record.steps} tools=${tools} reply=${record.replyChars}ch` +
        (record.error ? ` error=${record.error}` : ""),
    );
    return record;
  } catch {
    /* ignored */
    return undefined;
  }
}

/**
 * The answer to "what is it doing right now".
 *
 * `stuck` is the field worth reading: a turn running longer than this with no
 * tool in flight is one that is not going to finish on its own.
 */
export function snapshot(stuckAfterMs = 120_000): {
  now: string;
  running: Array<Record<string, unknown>>;
  recent: Array<Record<string, unknown>>;
} {
  const at = now();
  return {
    now: new Date(at).toISOString(),
    running: [...live.values()].map((r) => {
      const pending = r.tools.find((t) => t.endedAt === undefined);
      return {
        turnId: r.turnId,
        elapsedMs: at - r.startedAt,
        steps: r.steps,
        toolsCalled: r.tools.map((t) => t.name),
        waitingOn: pending ? { tool: pending.name, forMs: at - pending.startedAt } : null,
        stuck: at - r.startedAt > stuckAfterMs && !pending,
      };
    }),
    recent: history.slice(0, 10).map((r) => ({
      turnId: r.turnId,
      outcome: r.outcome,
      tookMs: (r.endedAt ?? at) - r.startedAt,
      steps: r.steps,
      tools: r.tools.map((t) => ({ name: t.name, ms: (t.endedAt ?? at) - t.startedAt, status: t.status })),
      replyChars: r.replyChars,
      ...(r.error ? { error: r.error } : {}),
    })),
  };
}
