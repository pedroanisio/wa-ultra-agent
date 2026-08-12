import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { parseSearchParams } from "./archive-query.js";
import { assertSelfNoteConfigured } from "./self-note.js";
import { serial } from "./serial.js";
import {
  addFact,
  archiveChats,
  refreshChatNames,
  archiveContext,
  archiveMessages,
  archiveStats,
  attention,
  consoleState,
  forgetAlias,
  getTranscript,
  interactionTwin,
  listAliases,
  listExtractions,
  listFacts,
  listProposals,
  pendingForAgent,
  peopleRoster,
  personDossier,
  pruneArchive,
  recordTranscript,
  rememberAlias,
  resolveArc,
  resolveContact,
  resolveExtraction,
  resolveProposal,
  restoreFact,
  retractFact,
  saveExtractions,
  saveInteractionModel,
  saveProposals,
  searchArchive,
  selfChatIdentity,
  editViaTransport,
  pollViaTransport,
  pollVoteViaTransport,
  presenceViaTransport,
  reactViaTransport,
  revokeViaTransport,
  sendMediaViaTransport,
  sendSelfImage,
  sendSelfNote,
  sendViaTransport,
  staleTwins,
  startTransportDrain,
  transportConfigured,
  transportConnect,
  transportContacts,
  transportDrain,
  transportHistory,
  transportMedia,
  transportPairPhone,
  transportPairQr,
  transportStatus,
} from "./whatsapp.js";

/**
 * HTTP front end for the single browser session.
 *
 * Binds to 127.0.0.1 unless told otherwise. This service holds a live,
 * authenticated WhatsApp account: anything that can reach it can read and send
 * as you, so exposing it is a deliberate act, never a default.
 */

const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.WA_BIND_HOST || "127.0.0.1";
const TOKEN = process.env.WA_BRIDGE_TOKEN || "";

if (!TOKEN) {
  console.error("WA_BRIDGE_TOKEN is unset. Refusing to start an unauthenticated WhatsApp bridge.");
  process.exit(1);
}

function authorized(req) {
  const header = req.headers.authorization || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, code, body, type = "application/json") {
  const payload = type === "application/json" ? JSON.stringify(body, null, 2) : body;
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(payload);
}

/** A text request is a few hundred bytes; anything larger is a mistake. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * An attachment is the one request that is legitimately large.
 *
 * Sized from the transport's own 16 MiB ceiling on decoded bytes, plus base64's
 * 4/3 inflation and room for the surrounding JSON. Deriving it from that limit
 * rather than picking a round number keeps the two ends from disagreeing about
 * what is too big — a body accepted here and refused there would spend the
 * upload before failing.
 */
const MAX_MEDIA_BODY_BYTES = Math.ceil((16 * 1024 * 1024 * 4) / 3) + 64 * 1024;

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    chunks.push(c);
    total += c.length;
    if (total > maxBytes) throw new Error("body too large");
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** The drain loop's handle, so shutdown can stop it. Null until boot. */
let drain = null;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // Liveness must not require a token: it is what the container healthcheck
  // calls, and it reveals nothing about the account.
  //
  // It used to return `{ok:true}` unconditionally, which made it a check on the
  // HTTP server rather than on the thing this service exists to hold: whatever
  // had actually failed reported healthy indefinitely and Docker never restarted
  // it. So it reports whether a transport is configured, which is the one fact
  // that decides whether this service can do anything at all.
  //
  // It performs no work to find that out — no request to the transport, no read
  // of the archive. An unauthenticated endpoint that did real work would be a way
  // to stall this service from outside, and health checks run on a timer forever.
  //
  // Liveness only, and deliberately coarse: it answers before the token check,
  // so it must never disclose whether an account is linked. Whether the
  // transport is paired and connected is behind the token, on /transport/status.
  if (path === "/health") {
    return send(res, 200, { ok: true, transport: transportConfigured() ? "configured" : "unset" });
  }

  if (!authorized(req)) return send(res, 401, { error: "unauthorized" });

  try {
    // What this service can say about itself. The session's own state lives on
    // /transport/status, which asks the transport rather than paraphrasing it.
    if (path === "/status") {
      return send(res, 200, {
        archive: archiveStats(),
        transport: transportConfigured() ? "configured" : "unset",
      });
    }








    // One-shot send for an allowlisted recipient. The allowlist is the
    // boundary; /send/prepare + /send/commit remain for a confirm-first flow.
    if (path === "/send" && req.method === "POST") {
      const { to, message, quoted } = await readJson(req);
      if (!to || !message) return send(res, 400, { error: "to and message are required" });

      // Protocol only. There is no longer a second way to send, which is the
      // point: the DOM path typed into a search box and trusted a fuzzy match.
      return send(res, 200, await sendViaTransport({ to, message, quoted }));
    }

    // An image, for an allowlisted recipient. Protocol-only on purpose: the DOM
    // path has no attachment mechanism at all, and a 503 that says so is better
    // than a route that exists on paper and fails at a file picker.
    if (path === "/send/media" && req.method === "POST") {
      const {
        to, dataBase64, mimetype, caption, width, height, kind, filename, durationSeconds, quoted,
      } = await readJson(req, MAX_MEDIA_BODY_BYTES);
      if (!to || !dataBase64 || !mimetype) {
        return send(res, 400, { error: "to, dataBase64 and mimetype are required" });
      }
      if (!transportConfigured()) {
        return send(res, 503, {
          error:
            "Sending an image requires the protocol transport. Set WA_TRANSPORT_URL; " +
            "the browser path cannot attach files.",
        });
      }
      return send(
        res,
        200,
        await sendMediaViaTransport({
          to,
          image: Buffer.from(dataBase64, "base64"),
          kind,
          mimetype,
          caption,
          filename,
          width,
          height,
          durationSeconds,
          quoted,
        }),
      );
    }

    // Acting on a message that already exists: a reaction, a deletion, a
    // correction, a poll. Each is something this account DOES in someone's
    // conversation, so each goes through the same allowlist as a plain message —
    // `resolveAllowedRecipient` is the one gate, and a test drives every one of
    // these through it.
    if (path === "/send/reaction" && req.method === "POST") {
      const { to, messageId, emoji, sender } = await readJson(req);
      if (!to || !messageId) return send(res, 400, { error: "to and messageId are required" });
      return send(res, 200, await reactViaTransport({ to, messageId, emoji, sender }));
    }

    if (path === "/send/revoke" && req.method === "POST") {
      const { to, messageId, sender } = await readJson(req);
      if (!to || !messageId) return send(res, 400, { error: "to and messageId are required" });
      return send(res, 200, await revokeViaTransport({ to, messageId, sender }));
    }

    if (path === "/send/edit" && req.method === "POST") {
      const { to, messageId, message } = await readJson(req);
      if (!to || !messageId || !message) {
        return send(res, 400, { error: "to, messageId and message are required" });
      }
      return send(res, 200, await editViaTransport({ to, messageId, message }));
    }

    if (path === "/send/poll/vote" && req.method === "POST") {
      const { to, messageId, sender, options } = await readJson(req);
      if (!to || !messageId) return send(res, 400, { error: "to and messageId are required" });
      return send(res, 200, await pollVoteViaTransport({ to, messageId, sender, options }));
    }

    // Typing indicators. Gated like a message because that is what it is: a
    // signal this account emits into somebody else's conversation.
    if (path === "/presence" && req.method === "POST") {
      const { to, state, media } = await readJson(req);
      if (!to || !state) return send(res, 400, { error: "to and state are required" });
      return send(res, 200, await presenceViaTransport({ to, state, media }));
    }

    if (path === "/send/poll" && req.method === "POST") {
      const { to, name, options, selectableCount } = await readJson(req);
      if (!to || !name) return send(res, 400, { error: "to and name are required" });
      return send(res, 200, await pollViaTransport({ to, name, options, selectableCount }));
    }

    /* -------------------------------------------------------------- *
     * The protocol transport.
     *
     * None of these are serialised: `serial()` exists to keep a multi-message
     * self-note in order, and none of these write one. They are 503 when no
     * transport is configured, which is a statement about this installation
     * rather than an error.
     * -------------------------------------------------------------- */

    if (path === "/transport/status") return send(res, 200, await transportStatus());

    if (path === "/transport/contacts") return send(res, 200, await transportContacts());

    // A drain the operator asked for, rather than the one on the interval. Useful
    // after a restart, and the only way to see the outcome of a single batch.
    if (path === "/transport/drain" && req.method === "POST") {
      const { limit } = await readJson(req);
      return send(res, 200, await transportDrain({ limit }));
    }

    if (path === "/transport/connect" && req.method === "POST") {
      return send(res, 200, await transportConnect());
    }

    // Pairing returns a code the operator types into their phone. Short-lived and
    // useless without the handset, so it is safe to hand back over loopback.
    if (path === "/transport/pair/phone" && req.method === "POST") {
      const { phone } = await readJson(req);
      return send(res, 200, await transportPairPhone(phone));
    }

    /**
     * The rotating QR payload, passed through as an event stream.
     *
     * ── Why the bridge carries this at all ──────────────────────────────────
     * The agent's web UI renders the code, and the agent holds no transport
     * token — deliberately, because that token also sends messages. Proxying
     * the one stream is narrower than handing over the credential: this route
     * can be watched, and it cannot send, connect or read a contact.
     *
     * ── Why it is not buffered ──────────────────────────────────────────────
     * The stream never ends. WhatsApp rotates the code every ~20 s and each one
     * arrives as a `data:` line, so anything that waits for the body to finish
     * waits until pairing times out. Chunks are forwarded as they arrive, and
     * the upstream read is aborted when this response closes — otherwise a
     * browser that navigated away leaves a QR channel open on the transport and
     * the next attempt to pair finds one already running.
     */
    if (path === "/transport/pair/qr") {
      const upstream = new AbortController();
      const stream = await transportPairQr(upstream.signal);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        // Nothing here should be buffered by anything in between: a proxy that
        // holds 4 KB before flushing delays the code past its own rotation.
        "x-accel-buffering": "no",
      });

      res.on("close", () => upstream.abort());

      try {
        for await (const chunk of stream.body) {
          if (res.writableEnded) break;
          res.write(chunk);
        }
      } catch (error) {
        // An abort is how this stream normally ends: the operator paired, or
        // closed the page. Only report something that is not that.
        if (!upstream.signal.aborted) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`);
        }
      }
      return res.end();
    }

    // Everything ingested so far. Cheap and browser-free: it reads SQLite, not
    // WhatsApp, so it costs nothing from the interaction budget.
    // Every conversation the archive holds, most recently active first. The
    // agent's chat list reads this; there is no rendered pane to walk.
    // Pull names from the roster now rather than waiting for the hourly pass.
    // A group renamed a minute ago is a group the agent cannot find by name.
    if (path === "/archive/names/refresh" && req.method === "POST") {
      return send(res, 200, await refreshChatNames());
    }

    if (path === "/archive/chats") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      return send(res, 200, archiveChats({ limit }));
    }

    if (path === "/archive/stats") return send(res, 200, archiveStats());

    /* -------------------------------------------------------------- *
     * Events.
     *
     * `/events` and `/events/status` read SQLite and never WhatsApp, so they are
     * unserialised. `/events/react` is the one that opens chats, and it goes
     * through `serial` like every other browser operation.
     * -------------------------------------------------------------- */






    // Parsed in archive-query.js and passed through whole. Listing the filters
    // again here is what let five of them get dropped once already.
    if (path === "/archive/search") {
      const params = parseSearchParams(url.searchParams);
      if (!params.query) return send(res, 400, { error: "q is required" });
      return send(res, 200, searchArchive(params));
    }

    // The conversation around one hit. A search result is rarely an answer on
    // its own — "dia 28" means nothing without the message before it.
    if (path === "/archive/context") {
      const key = url.searchParams.get("key");
      if (!key) return send(res, 400, { error: "key is required" });
      return send(
        res,
        200,
        archiveContext({
          key,
          before: Number(url.searchParams.get("before")) || undefined,
          after: Number(url.searchParams.get("after")) || undefined,
        }),
      );
    }

    // Stored messages for one chat, each with the key an extraction must cite.
    if (path === "/archive/messages") {
      const chat = url.searchParams.get("chat");
      if (!chat) return send(res, 400, { error: "chat is required" });
      return send(
        res,
        200,
        // `newest` cuts the limit from the recent end. Without it a limit of 20
        // over a long chat returns its twenty OLDEST messages, which reads as an
        // empty conversation to anything asking what just happened.
        await archiveMessages({
          chat,
          limit: Number(url.searchParams.get("limit")) || undefined,
          newest: url.searchParams.get("newest") === "1",
        }),
      );
    }

    // What an extraction pass found. Every item cites a message key, and the
    // store rejects the batch if any of them was never read.
    if (path === "/archive/extractions" && req.method === "POST") {
      const { items } = await readJson(req);
      return send(res, 200, saveExtractions({ items }));
    }

    // A voice note's transcript, filed against the message it came from. GET
    // first so a repeat transcription reuses it instead of uploading the audio
    // to a transcription provider a second time.
    if (path === "/archive/transcript" && req.method === "POST") {
      const { key, text } = await readJson(req);
      return send(res, 200, recordTranscript({ key, text }));
    }

    if (path === "/archive/transcript") {
      return send(res, 200, getTranscript({ key: url.searchParams.get("key") }));
    }

    // Durable facts about people and projects. Every one cites a message, and
    // the store's foreign key is what enforces that rather than a code review.
    if (path === "/archive/facts" && req.method === "POST") {
      const { subject, statement, sourceMessageKey, confidence } = await readJson(req);
      return send(res, 200, addFact({ subject, statement, sourceMessageKey, confidence }));
    }

    if (path === "/archive/facts") {
      return send(
        res,
        200,
        listFacts({
          subject: url.searchParams.get("subject") || undefined,
          chat: url.searchParams.get("chat") || undefined,
          limit: Number(url.searchParams.get("limit")) || undefined,
        }),
      );
    }

    // Everything the archive knows about one person: activity, aliases, stored
    // facts, and what each of them owes the other.
    if (path === "/people/dossier") {
      const name = url.searchParams.get("name");
      if (!name) return send(res, 400, { error: "name is required" });
      return send(res, 200, personDossier({ name }));
    }

    // Who a name refers to, decided by name similarity against the archive's
    // roster — never by which chat spoke most recently.
    if (path === "/people/resolve") {
      const name = url.searchParams.get("name");
      if (!name) return send(res, 400, { error: "name is required" });
      return send(res, 200, resolveContact({ name }));
    }

    if (path === "/people/roster") return send(res, 200, peopleRoster());

    if (path === "/people/alias" && req.method === "POST") {
      const { alias, canonical, forget, origin, sourceMessageKey } = await readJson(req);
      if (!alias) return send(res, 400, { error: "alias is required" });
      if (forget) return send(res, 200, forgetAlias({ alias }));
      if (!canonical) return send(res, 400, { error: "canonical is required" });
      // origin says whether the user stated this nickname or the agent read it out
      // of chat text. The store requires a citation for the second case.
      return send(res, 200, rememberAlias({ alias, canonical, origin, sourceMessageKey }));
    }

    // Every alias and where it came from. Answers "which nicknames did the agent
    // teach itself?", which `/people/alias` cannot, because aliasMap() returns
    // only the lookup on purpose.
    if (path === "/people/aliases") {
      return send(res, 200, listAliases({ origin: url.searchParams.get("origin") || undefined }));
    }

    // Withdraw a stored fact. Provenance proves traceability, not truth: a false
    // statement that really is in the archive passes every check the store makes.
    // A tombstone rather than a delete, so "why did I believe this?" stays
    // answerable after the belief turns out to be wrong.
    if (path === "/archive/facts/retract" && req.method === "POST") {
      const { id, reason } = await readJson(req);
      return send(res, 200, retractFact({ id, reason }));
    }

    if (path === "/archive/facts/restore" && req.method === "POST") {
      const { id } = await readJson(req);
      return send(res, 200, restoreFact({ id }));
    }

    // Apply the retention policy. dryRun defaults to TRUE: this deletes
    // correspondence, and a destructive operation behind a network boundary
    // should describe itself unless explicitly told to act.
    if (path === "/archive/prune" && req.method === "POST") {
      const body = await readJson(req);
      return send(res, 200, pruneArchive({ ...body, dryRun: body.dryRun !== false }));
    }

    // What the policy is and what it would remove right now, without doing it.
    if (path === "/archive/prune") {
      return send(res, 200, pruneArchive({ dryRun: true }));
    }

    // Everything open, bucketed into what is late, what is coming, what others
    // owe, and what was never answered.
    if (path === "/archive/attention") {
      return send(
        res,
        200,
        attention({ horizonDays: Number(url.searchParams.get("horizonDays")) || undefined }),
      );
    }

    /* ---------------------------------------------------------------- *
     * The interaction twin. Archive-only: no chat is opened by any of
     * these, so none of them spends from the interaction budget.
     * ---------------------------------------------------------------- */

    // One modelling pass over a conversation: its arcs, the goals on each side,
    // and the frame it happens in. Every item cites a message, and the pass
    // cites the last message it read so staleness stays measurable.
    if (path === "/twin/model" && req.method === "POST") {
      const { chat, throughMessageKey, considered, arcs, contexts } = await readJson(req);
      return send(res, 200, saveInteractionModel({ chat, throughMessageKey, considered, arcs, contexts }));
    }

    if (path === "/twin") {
      const chat = url.searchParams.get("chat");
      if (!chat) return send(res, 400, { error: "chat is required" });
      return send(
        res,
        200,
        interactionTwin({
          chat,
          arcStatus: url.searchParams.get("arcStatus") || undefined,
          horizonDays: Number(url.searchParams.get("horizonDays")) || undefined,
        }),
      );
    }

    // Which conversations are worth re-modelling. Answers "where has the
    // picture drifted" without opening anything.
    if (path === "/twin/stale") {
      return send(
        res,
        200,
        staleTwins({
          limit: Number(url.searchParams.get("limit")) || undefined,
          minimumNew: Number(url.searchParams.get("minimumNew")) || undefined,
        }),
      );
    }

    if (path === "/twin/arcs/resolve" && req.method === "POST") {
      const { id, status } = await readJson(req);
      return send(res, 200, resolveArc({ id, status }));
    }

    // Proposed next moves. This endpoint reaches nobody: a proposal is a row,
    // and sending is still only /send and /send/self, behind the allowlist.
    if (path === "/twin/proposals" && req.method === "POST") {
      const { items } = await readJson(req);
      return send(res, 200, saveProposals({ items }));
    }

    if (path === "/twin/proposals") {
      return send(
        res,
        200,
        listProposals({
          chat: url.searchParams.get("chat") || undefined,
          status: url.searchParams.get("status") || undefined,
          limit: Number(url.searchParams.get("limit")) || undefined,
        }),
      );
    }

    if (path === "/twin/proposals/resolve" && req.method === "POST") {
      const { id, status } = await readJson(req);
      return send(res, 200, resolveProposal({ id, status }));
    }

    if (path === "/archive/extractions/resolve" && req.method === "POST") {
      const { id, status } = await readJson(req);
      if (!Number.isInteger(id)) return send(res, 400, { error: "id must be an integer" });
      return send(res, 200, resolveExtraction({ id, status }));
    }

    if (path === "/archive/extractions") {
      return send(
        res,
        200,
        listExtractions({
          type: url.searchParams.get("type") || undefined,
          actor: url.searchParams.get("actor") || undefined,
          chat: url.searchParams.get("chat") || undefined,
          status: url.searchParams.get("status") || undefined,
          overdue: url.searchParams.get("overdue") === "true" || undefined,
          dueBefore: url.searchParams.get("dueBefore") || undefined,
          // The window the item was SAID in. `dueBefore` above is the window it
          // is due in; asking "the last 45 days" means the first one.
          since: url.searchParams.get("since") || undefined,
          until: url.searchParams.get("until") || undefined,
          limit: Number(url.searchParams.get("limit")) || undefined,
        }),
      );
    }

    // Ask the operator's phone for messages older than one already held. The
    // reachable depth is whatever the phone still has — not whatever WhatsApp's
    // servers have — so a short answer is a fact about the phone, not a failure.
    if (path === "/history" && req.method === "POST") {
      const { chat, oldestId, oldestFromMe, oldestTimestamp, count } = await readJson(req);
      if (!chat) return send(res, 400, { error: "chat is required" });
      return send(res, 200, await transportHistory({ chat, oldestId, oldestFromMe, oldestTimestamp, count }));
    }

    // The payload behind one media message, addressed by the protocol's own
    // message id. The old route took a position from the end of a rendered chat
    // and a fingerprint to check it against, because a position is not an
    // address; an id is.
    if (path === "/media") {
      const key = url.searchParams.get("key");
      if (!key) return send(res, 400, { error: "key is required" });
      return send(res, 200, await transportMedia(key));
    }

    // Which chat is the user's own.
    //
    // The agent is not given WA_SELF_CHAT_NAME — it is a real contact name, so
    // it lives in exactly one place and the bridge is that place. But an agent
    // that has *written* a self-note may also need to *read* the chat it wrote
    // to, and `/messages` takes a name. Reading it back is how a conversation
    // held in the self chat survives the agent being restarted between turns.
    //
    // Browser-free: this reports configuration, opens nothing, and spends no
    // interaction budget. It reuses the same check `/send/self` runs, so an
    // unconfigured bridge answers 403 here with the same instructions rather
    // than handing out an empty name that would fuzzy-match some other chat.
    // Which chat is the user's own, and where a caller can READ it.
    //
    // The title in WA_SELF_CHAT_NAME is still what enables the feature, but it
    // is not an address any more: on the protocol the account's own key is, and
    // that key is also what the archive files self-messages under. A caller that
    // wants to read back what it wrote needs the key, not the title — reporting
    // the title here is what sent tic-tac-toe to a browser that no longer exists.
    if (path === "/self/chat") {
      assertSelfNoteConfigured();
      // `console` says whether this bridge's own console currently owns the
      // keyboard. Anything else that answers the self chat reads it and stands
      // down, or two responders end up racing for the same digits.
      return send(res, 200, { ...(await selfChatIdentity()), console: consoleState() });
    }

    // What the operator typed in `/eve` mode, and nothing else. Drains on read:
    // the agent asks, answers through /send/self, and a message handed over twice
    // would be answered twice. Empty is the normal state.
    if (path === "/self/pending") {
      const waitMs = Number(url.searchParams.get("waitMs")) || 0;
      return send(res, 200, await pendingForAgent({ waitMs }));
    }

    // Write to the user's own chat. No allowlist and no confirmation step,
    // because the recipient is a constant — the transport addresses the account's
    // own JID from its device store, so there is no name to mis-resolve and
    // nothing for a human to confirm. Validation lives in self-note.js and
    // carries its own status codes.
    if (path === "/send/self" && req.method === "POST") {
      const { messages } = await readJson(req);
      return send(res, 200, await serial(() => sendSelfNote({ messages })));
    }

    // An image to the user's own chat, on the same terms as the note above: one
    // possible recipient, so no allowlist and no confirmation. The larger body
    // limit is the only difference, and it is the attachment's, not a relaxation
    // of anything else.
    if (path === "/send/self/media" && req.method === "POST") {
      const { dataBase64, mimetype, caption, width, height, kind, filename, durationSeconds } =
        await readJson(req, MAX_MEDIA_BODY_BYTES);
      if (!dataBase64) return send(res, 400, { error: "dataBase64 is required" });
      return send(
        res,
        200,
        await serial(() =>
          sendSelfImage({
            image: Buffer.from(dataBase64, "base64"),
            kind,
            mimetype,
            caption,
            filename,
            width,
            height,
            durationSeconds,
          }),
        ),
      );
    }



    return send(res, 404, { error: "not found" });
  } catch (error) {
    const code = error.statusCode || 500;
    // 4xx here is a normal, actionable outcome (not linked, not allowlisted);
    // only a genuine fault deserves a stack in the log.
    if (code >= 500) console.error(error);
    return send(res, code, { error: error.message, state: error.state });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`whatsapp-bridge listening on http://${HOST}:${PORT}`);
  console.log(`send: ${process.env.WA_ALLOW_SEND === "true" ? "ENABLED" : "disabled"}`);

  // The protocol transport, when one is configured. Started before the watcher
  // because it needs no browser: messages begin arriving in the archive whether
  // or not Chromium ever comes up.
  if (transportConfigured()) {
    drain = startTransportDrain();
    console.log("transport: draining the outbox into the archive");
  } else {
    console.log("transport: none configured (set WA_TRANSPORT_URL to receive over the protocol)");
  }

  // Opt-in, and off by default. Watching is passive and costs no interactions,
  // but the queue it fills is what a dispatcher then acts on, and an operator
  // who has not configured quiet hours or a cooldown should not acquire a
  // reactive agent by upgrading.
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    // Stopped first: a drain that is mid-flight when the store closes would
    // throw on the write, and a drain that starts after it would ack entries it
    // never stored.
    drain?.stop();
    server.close(() => process.exit(0));
  });
}
