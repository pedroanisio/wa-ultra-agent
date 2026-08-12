import { defineChannel, POST } from "eve/channels";

import { bridge } from "../lib/bridge.ts";

/**
 * The self-chat console, pushed rather than polled.
 *
 * ── Why this channel exists ─────────────────────────────────────────────────
 * `/eve` is a mode the user ENTERS in their own WhatsApp chat, and everything
 * they type while in it is meant for this agent. Getting those words here was
 * originally the agent's job: a schedule woke every minute and asked the bridge
 * whether anything was waiting. That is a poll, and it has the two costs a poll
 * always has — a reply can be a minute late, which is fatal for something the
 * user experiences as a conversation, and the agent runs 1,440 times a day to
 * discover that almost every one of those minutes was empty.
 *
 * So the bridge pushes instead. A message arrives over the protocol, the drain
 * routes it, and if the console is in `eve` the bridge posts it here within the
 * same drain tick. The user's phone is still open when the answer arrives.
 *
 * ── The direction this reverses, and why that is acceptable ─────────────────
 * Everything else in this system points one way: the agent calls the bridge and
 * never the reverse, so the bridge holds no credential belonging to anything
 * else. This route inverts that for one feature, which was worth resisting
 * until the requirement was reactivity — a poll cannot be made reactive by
 * tuning it.
 *
 * The inversion is bounded to make it worth it:
 *
 *   - The token here is its OWN secret (`WA_CONSOLE_PUSH_TOKEN`), not the UI
 *     password. A bridge that is compromised does not thereby hold the
 *     operator's login to this agent.
 *   - It carries no authority beyond "the user said this". The route cannot
 *     read the archive, cannot send to a correspondent, and cannot reach any
 *     other channel — it starts a turn with a string, and every consequence
 *     after that runs under the agent's own tools and their own allowlists.
 *   - The bridge already holds the WhatsApp account, which is strictly the more
 *     sensitive of the two credentials. Refusing it a push token while trusting
 *     it with the account was a distinction without a difference.
 *
 * ── Sessions ────────────────────────────────────────────────────────────────
 * One continuation address, `self-console`, so an `/eve` conversation is a
 * conversation: the second message sees the first. Leaving `/eve` does not reset
 * it — a user who steps out to play a game and comes back has not changed the
 * subject, and a reset would silently discard what they had been discussing.
 *
 * ── Why a cold session is refilled from the chat ────────────────────────────
 * That address holds its conversation IN MEMORY, so it lives exactly as long as
 * this process. The agent is a Nitro server that is replaced on every deploy,
 * which means a rebuild mid-conversation leaves the address resolving to an
 * empty session — and the next message arrives with the user three turns into
 * something the agent has never heard of.
 *
 * That is not hypothetical. A rebuild landed at 23:00:46 between "make it
 * funnier" and "generate an image": the first was answered in context, and the
 * second came back as "which joke do you mean?" to a user looking at the joke on
 * their screen.
 *
 * The rest of this system already solves this the same way — `lib/tictactoe.ts`
 * keeps a game in the chat precisely because "the agent may be replaced between
 * two moves". The chat is the durable record here too, so a session that starts
 * cold is refilled from it rather than starting blank.
 */

/**
 * When a conversation has run long enough to be worth starting again.
 *
 * ── Why a session must end at all ───────────────────────────────────────────
 * One fixed address kept `/eve` continuous, which was the point — and made the
 * conversation unbounded, which was not. Every turn adds the message, the tool
 * results and the model's reasoning, and nothing ever left. A turn was
 * eventually rejected outright: `prompt is too long: 1123860 tokens > 1000000`.
 * The user had asked for a voice note and got silence, with nothing in the
 * failure naming the session as the cause. Only a container restart cleared it.
 *
 * ── Why rotating is safe HERE ───────────────────────────────────────────────
 * Because a cold session is refilled from the chat below. A new address does not
 * begin an amnesiac conversation; it begins one that remembers what was said and
 * forgets what the model thought about it. In a self chat the chat is the
 * durable record — the same argument the tic-tac-toe board rests on.
 *
 * Turns rather than tokens: this side cannot see the context, and a count that
 * is roughly right in advance beats an exact one discovered in a 400.
 */
export const MAX_SESSION_TURNS = Number(process.env.WA_CONSOLE_MAX_TURNS) || 40;

/** Silence after which the next message is a new conversation, not a continuation. */
export const SESSION_IDLE_MS = Number(process.env.WA_CONSOLE_IDLE_MS) || 45 * 60 * 1000;

export interface ConsoleSession {
  /** The continuation address handed to `from(...)`. */
  address: string;
  /** How many messages this address has carried. */
  turns: number;
  /** When the last one arrived. */
  lastAt: number;
  /**
   * Whether this PROCESS has already sent into THIS address.
   *
   * Travels with the address rather than sitting beside it: a rotated session
   * that inherited `warmed: true` would start with no transcript and believe it
   * needed none, which is worse than either a cold start or a long one.
   */
  warmed: boolean;
}

/** A fresh address. Monotonic, so a rotation can never resume what it replaced. */
let rotations = 0;
function freshSession(now: number): ConsoleSession {
  rotations += 1;
  return { address: `self-console-${now}-${rotations}`, turns: 1, lastAt: now, warmed: false };
}

/**
 * The session this message belongs to — the current one, or a new one.
 *
 * Pure, so the rule can be tested without a channel, a bridge or a clock.
 */
export function nextConsoleSession(current: ConsoleSession | undefined, now: number): ConsoleSession {
  if (!current) return freshSession(now);
  if (current.turns >= MAX_SESSION_TURNS) return freshSession(now);
  if (now - current.lastAt >= SESSION_IDLE_MS) return freshSession(now);
  return { ...current, turns: current.turns + 1, lastAt: now };
}

/** The live session for this process. Never durable — see `warmed`. */
let session: ConsoleSession | undefined;

/** How much of the chat a cold session is refilled with. */
const REHYDRATE_MESSAGES = 24;

/**
 * The recent chat, as a transcript the model can read.
 *
 * Deliberately NOT attributed per line. Everything in a self chat is outgoing —
 * the user's typing and the agent's own notes are both messages from the account
 * to itself — and the archive stores no marker separating them. Labelling them
 * would mean guessing, and a transcript that misattributes a line is worse than
 * one that admits it cannot. The model can tell its own writing from a two-word
 * instruction; a wrong label it would have to trust.
 */
export function formatTranscript(messages: Array<{ text?: string; sent_at_iso?: string }>): string {
  return messages
    .map((message) => ({
      at: (message.sent_at_iso ?? "").slice(11, 16),
      // Collapsed to one line: a multi-line note is one turn, and left as-is it
      // reads as several, inflating a short exchange into a long one.
      body: String(message.text ?? "").replace(/\s*\n\s*/g, " ").trim(),
    }))
    // Dropped on the BODY, not on the rendered line: a blank message still has a
    // timestamp, so filtering afterwards leaves `[02:00]` behind — a turn that
    // never happened, in a transcript the model is told to trust.
    .filter(({ body }) => body !== "")
    .map(({ at, body }) => (at ? `[${at}] ${body}` : body))
    .join("\n");
}

/**
 * The chat's recent transcript, or an empty string if it cannot be had.
 *
 * Never throws. A cold session with no history is a worse conversation; a reply
 * that never arrives because the archive was briefly unreachable is a broken
 * one, and the user is waiting on their phone either way.
 */
async function recentTranscript(): Promise<string> {
  try {
    const self = await bridge.selfChat();
    const stored = await bridge.archiveMessages({
      chat: self.chat,
      limit: REHYDRATE_MESSAGES,
      newest: true,
    });
    return formatTranscript(stored.messages ?? []);
  } catch {
    return "";
  }
}
export default defineChannel({
  routes: [
    POST("/message", async (request, { from }) => {
      const expected = process.env.WA_CONSOLE_PUSH_TOKEN;
      if (!expected) {
        // Refuse rather than accept anything: an unset secret must never mean
        // "no authentication required" on a route that starts agent turns.
        return Response.json(
          { error: "WA_CONSOLE_PUSH_TOKEN is unset, so this route is closed." },
          { status: 503 },
        );
      }

      const presented = request.headers.get("authorization") ?? "";
      if (presented !== `Bearer ${expected}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      const body = (await request.json().catch(() => null)) as { text?: string } | null;
      const text = body?.text?.trim();
      if (!text) return Response.json({ error: "text is required" }, { status: 400 });

      // ── Why the text is wrapped ─────────────────────────────────────────
      // A turn started here has no reply path of its own: this route returns a
      // session id to the bridge and nothing else, so an answer written "here"
      // is an answer nobody reads. The user is looking at WhatsApp, and
      // `whatsapp_write_self` is the only thing that reaches them.
      //
      // The user's own words are fenced and labelled untrusted, exactly as the
      // read tools label message content. They are the account owner, so this is
      // not about them attacking their own agent — it is that a self-note can
      // quote a stranger's message verbatim, and text that arrived from a third
      // party must never be able to change what this turn does by looking like
      // an instruction wrapped around it.
      // A cold session gets the chat back. `warmed` is false on the first
      // message this process handles, which is exactly the case a restart
      // creates — and the case where the session it is about to write into is
      // empty despite the conversation being hours old.
      // Chosen before anything else in the turn: whether the chat has to be
      // refilled depends on which session this message lands in, and a rotation
      // makes a warm conversation cold by design.
      session = nextConsoleSession(session, Date.now());

      const transcript = session.warmed ? "" : await recentTranscript();

      const prompt = [
        "The user is in `/eve` mode in their own WhatsApp chat and typed the message below.",
        "",
        "Just answer. Your reply is delivered to them automatically — you do NOT need to call",
        "whatsapp_write_self, and calling it would send your answer twice. Keep it to what fits on",
        "a phone: a couple of sentences unless they asked for more.",
        "",
        "If you cannot do what they asked — a render came back defective, a tool refused, a name",
        "did not resolve — SAY SO in your reply. Silence is the one unacceptable outcome: they are",
        "waiting on their phone and cannot see that anything happened at all.",
        "",
        "Use whatsapp_deliver_render only to attach a rendered page or document; the words that go",
        "with it belong in your reply.",
        "",
        "<untrusted-user-content>",
        text,
        "</untrusted-user-content>",
      ].join("\n");

      // `auth: null` because the principal is already established: this route is
      // only reachable from the bridge, and the bridge only pushes what the
      // account owner typed into their own chat.
      const sent = await from(session!.address).send(prompt, { auth: null });

      // Only after the send lands. Setting it earlier would mark the session
      // warm on a turn that never reached it, and the next message — the retry —
      // would arrive cold with no transcript.
      session = { ...session!, warmed: true };

      return Response.json({ sessionId: sent.id });
    }),
  ],
});
