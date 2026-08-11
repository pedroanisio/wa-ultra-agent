import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { parseSearchParams } from "./archive-query.js";
import { serial } from "./serial.js";
import { qrPng, sessionHealth, shutdown, status, waitForLogin } from "./session.js";
import {
  addFact,
  archiveContext,
  archiveMessages,
  archiveStats,
  commitSend,
  completeEvents,
  pendingEvents,
  reactToEvents,
  releaseEvents,
  startWatching,
  watchStatus,
  debugRows,
  debugMessageRows,
  fetchMedia,
  attention,
  forgetAlias,
  getTranscript,
  ingestChat,
  interactionTwin,
  listAliases,
  listExtractions,
  listFacts,
  listProposals,
  pruneArchive,
  restoreFact,
  retractFact,
  resolveArc,
  resolveProposal,
  saveInteractionModel,
  saveProposals,
  staleTwins,
  peopleRoster,
  personDossier,
  readHistory,
  recordTranscript,
  rememberAlias,
  resolveContact,
  resolveExtraction,
  saveExtractions,
  searchArchive,
  selectorHealth,
  debugScreenshot,
  debugSelectors,
  debugStructure,
  listChats,
  prepareSend,
  readChat,
  sendMessage,
  sendSelfNote,
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

async function readJson(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    // A bridge request is a few hundred bytes; anything larger is a mistake.
    if (chunks.reduce((n, x) => n + x.length, 0) > 64 * 1024) throw new Error("body too large");
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // Liveness must not require a token: it is what the container healthcheck
  // calls, and it reveals nothing about the account.
  //
  // It used to return `{ok:true}` unconditionally, which made it a check on the
  // HTTP server rather than on the thing this service exists to hold. A browser
  // that could not launch reported healthy indefinitely and Docker never
  // restarted it — the same silent-failure shape as an uninstalled pane watcher.
  //
  // Deliberately NOT firecrawl's version of this, which opens a context and a
  // page per call: there is one session here, every operation queues behind
  // `serial()`, and an unauthenticated endpoint that drives the browser is both
  // a way to stall real work and a way to spend interactions from outside. This
  // reports state the session already knows and touches nothing.
  //
  // Coarse on purpose. `state` says whether Chromium is up; it never says
  // whether an account is linked, and `lastError` stays behind the token
  // because a launch failure can carry the profile path.
  if (path === "/health") {
    const { ok, state } = sessionHealth();
    return send(res, ok ? 200 : 503, { ok, browser: state });
  }

  if (!authorized(req)) return send(res, 401, { error: "unauthorized" });

  try {
    if (path === "/status") return send(res, 200, await serial(() => status()));

    if (path === "/qr") {
      const png = await serial(() => qrPng());
      if (!png) return send(res, 200, { state: "logged_in", note: "Already linked; no QR needed." });
      if (url.searchParams.get("format") === "json") {
        return send(res, 200, { state: "logged_out", pngBase64: png.toString("base64") });
      }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return res.end(png);
    }

    if (path === "/wait-for-login") {
      const ok = await serial(() => waitForLogin(Number(url.searchParams.get("timeoutMs") || 180_000)));
      return send(res, ok ? 200 : 408, { loggedIn: ok });
    }

    // Structure of the first few chat rows, for repairing selectors when a
    // WhatsApp Web redesign breaks extraction. Returns DOM shape, not a feed.
    if (path === "/debug/rows") {
      const limit = Number(url.searchParams.get("limit") || 4);
      return send(res, 200, await serial(() => debugRows(limit)));
    }

    // Rows inside the OPEN conversation, raw. This is the one to read when a
    // message is misclassified; /debug/rows above is the chat list.
    if (path === "/debug/message-rows") {
      const limit = Number(url.searchParams.get("limit") || 8);
      return send(res, 200, await serial(() => debugMessageRows(limit)));
    }

    if (path === "/debug/screenshot") {
      const png = await serial(() => debugScreenshot());
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return res.end(png);
    }

    if (path === "/debug/structure") {
      return send(res, 200, await serial(() => debugStructure()));
    }

    if (path === "/debug/selectors") {
      return send(res, 200, await serial(() => debugSelectors()));
    }

    // Why the browser is down, for whoever is holding the token.
    //
    // The counterpart to `/health`, which is unauthenticated and therefore says
    // only up/starting/down. This adds the launch error and the attempt counts —
    // "it recovered after three failed launches" is a different fact from "it
    // came up cleanly", and only the counts distinguish them. Queues behind
    // nothing and starts no browser, so it still answers when the session is
    // wedged, which is the moment it is worth having.
    if (path === "/debug/session") return send(res, 200, sessionHealth());

    // Are the hooks ingestion depends on still alive? This is the check
    // `ingestChat` asserts before every run; exposed so it can also be polled.
    if (path === "/debug/selector-health") {
      const scope = url.searchParams.get("scope") || "all";
      const health = await serial(() => selectorHealth({ scope }));
      return send(res, health.ok ? 200 : 503, health);
    }

    if (path === "/chats") {
      const limit = Number(url.searchParams.get("limit") || 15);
      return send(res, 200, await serial(() => listChats({ limit })));
    }

    if (path === "/messages") {
      const chat = url.searchParams.get("chat");
      if (!chat) return send(res, 400, { error: "chat is required" });
      const limit = Number(url.searchParams.get("limit") || 25);
      return send(res, 200, await serial(() => readChat({ chat, limit })));
    }

    // One-shot send for an allowlisted recipient. The allowlist is the
    // boundary; /send/prepare + /send/commit remain for a confirm-first flow.
    if (path === "/send" && req.method === "POST") {
      const { to, message } = await readJson(req);
      if (!to || !message) return send(res, 400, { error: "to and message are required" });
      return send(res, 200, await serial(() => sendMessage({ to, message })));
    }

    // Everything ingested so far. Cheap and browser-free: it reads SQLite, not
    // WhatsApp, so it costs nothing from the interaction budget.
    if (path === "/archive/stats") return send(res, 200, archiveStats());

    /* -------------------------------------------------------------- *
     * Events.
     *
     * `/events` and `/events/status` read SQLite and never WhatsApp, so they are
     * unserialised. `/events/react` is the one that opens chats, and it goes
     * through `serial` like every other browser operation.
     * -------------------------------------------------------------- */

    if (path === "/events") {
      return send(res, 200, pendingEvents({ limit: Number(url.searchParams.get("limit")) || undefined }));
    }

    if (path === "/events/status") return send(res, 200, watchStatus());

    if (path === "/events/react" && req.method === "POST") {
      const { limit } = await readJson(req);
      return send(res, 200, await serial(() => reactToEvents({ limit })));
    }

    if (path === "/events/complete" && req.method === "POST") {
      const { keys } = await readJson(req);
      return send(res, 200, completeEvents({ keys }));
    }

    if (path === "/events/release" && req.method === "POST") {
      const { keys } = await readJson(req);
      return send(res, 200, releaseEvents({ keys }));
    }

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
        archiveMessages({ chat, limit: Number(url.searchParams.get("limit")) || undefined }),
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
          limit: Number(url.searchParams.get("limit")) || undefined,
        }),
      );
    }

    // Scroll back through a chat without storing anything.
    if (path === "/history") {
      const chat = url.searchParams.get("chat");
      if (!chat) return send(res, 400, { error: "chat is required" });
      const maxScrolls = Number(url.searchParams.get("maxScrolls"));
      return send(
        res,
        200,
        await serial(() =>
          readHistory({ chat, maxScrolls: Number.isInteger(maxScrolls) ? maxScrolls : 3 }),
        ),
      );
    }

    // Walk a chat backwards and write it to the archive. Bounded by maxScrolls
    // and by the interaction budget; call again while hasMore is true.
    if (path === "/ingest" && req.method === "POST") {
      const { chat, mode, maxScrolls } = await readJson(req);
      if (!chat) return send(res, 400, { error: "chat is required" });
      if (mode && mode !== "top-up" && mode !== "backfill") {
        return send(res, 400, { error: 'mode must be "top-up" or "backfill"' });
      }
      return send(res, 200, await serial(() => ingestChat({ chat, mode, maxScrolls })));
    }

    // The payload behind one media message, addressed by position from the end
    // of the chat. `kind`/`from`/`time` are the caller's fingerprint: the bridge
    // refuses if the row there is not the one they read.
    if (path === "/media") {
      const chat = url.searchParams.get("chat");
      const fromEnd = Number(url.searchParams.get("fromEnd"));
      if (!chat) return send(res, 400, { error: "chat is required" });
      if (!Number.isInteger(fromEnd) || fromEnd < 0) {
        return send(res, 400, { error: "fromEnd must be a non-negative integer" });
      }

      const expect = {
        kind: url.searchParams.get("kind") || undefined,
        from: url.searchParams.get("from") || undefined,
        time: url.searchParams.get("time") || undefined,
      };
      const maxBytes = Number(url.searchParams.get("maxBytes")) || undefined;

      return send(res, 200, await serial(() => fetchMedia({ chat, fromEnd, expect, maxBytes })));
    }

    // Write to the user's own chat. No allowlist and no confirmation step,
    // because the recipient is a constant: the bridge refuses unless the
    // conversation actually open is exactly WA_SELF_CHAT_NAME. Validation lives
    // in self-note.js and carries its own status codes.
    if (path === "/send/self" && req.method === "POST") {
      const { messages } = await readJson(req);
      return send(res, 200, await serial(() => sendSelfNote({ messages })));
    }

    if (path === "/send/prepare" && req.method === "POST") {
      const { to, message } = await readJson(req);
      if (!to || !message) return send(res, 400, { error: "to and message are required" });
      return send(res, 200, await serial(() => prepareSend({ to, message })));
    }

    if (path === "/send/commit" && req.method === "POST") {
      const { token } = await readJson(req);
      if (!token) return send(res, 400, { error: "token is required" });
      return send(res, 200, await serial(() => commitSend({ token })));
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

  // Opt-in, and off by default. Watching is passive and costs no interactions,
  // but the queue it fills is what a dispatcher then acts on, and an operator
  // who has not configured quiet hours or a cooldown should not acquire a
  // reactive agent by upgrading.
  if (process.env.WA_WATCH_EVENTS !== "true") {
    console.log("events: disabled (set WA_WATCH_EVENTS=true to observe the chat list)");
    return;
  }

  // Deliberately not awaited: this launches the browser, which takes tens of
  // seconds and must not delay the port being answerable. Failure is reported
  // and left alone — /events/status is where its state is visible.
  startWatching().then(
    (state) =>
      console.log(
        `events: watching (observer ${state.installed === false ? "NOT installed" : "installed"})`,
      ),
    (error) => console.error("events: failed to start watching:", error?.message || error),
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await shutdown();
    server.close(() => process.exit(0));
  });
}
