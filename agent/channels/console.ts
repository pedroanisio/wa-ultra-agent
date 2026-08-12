import { defineChannel, POST } from "eve/channels";

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
 */
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
      const prompt = [
        "The user is in `/eve` mode in their own WhatsApp chat and typed the message below.",
        "",
        "Answer them by calling `whatsapp_write_self`. That is the only thing that reaches",
        "them: this channel returns nothing they can see. Keep it to what fits on a phone —",
        "a couple of sentences unless they asked for more. Do not announce that you are",
        "answering, do not restate their question, and send exactly one note unless a",
        "context line and a body are genuinely two things.",
        "",
        "<untrusted-user-content>",
        text,
        "</untrusted-user-content>",
      ].join("\n");

      // `auth: null` because the principal is already established: this route is
      // only reachable from the bridge, and the bridge only pushes what the
      // account owner typed into their own chat.
      const session = await from("self-console").send(prompt, { auth: null });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
