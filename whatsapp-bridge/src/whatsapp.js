import { randomUUID } from "node:crypto";

import { scrollbackWith } from "./history.js";
import { ingestWith } from "./ingest.js";
import { fetchMediaWith } from "./media.js";
import { buildDossier, resolvePerson } from "./people.js";
import { classifyRow, clean } from "./message-kind.js";
import { SELECTORS, criticalKeys, first, summarizeSelectorHealth } from "./selectors.js";
import {
  parseAliases,
  assertResolvedMatches,
  assertSendConfigured,
  assertSendable,
  normalizeName,
  resolveAlias,
} from "./recipients.js";
import { createBudget } from "./rate.js";
import { assertSelfNoteConfigured, normalizeMessages, sendSelfNoteWith } from "./self-note.js";
import { openStore, retentionFromEnv } from "./store.js";
import { trySerial } from "./serial.js";
import { onPaneChange, requireLogin, status, watcherState } from "./session.js";
import { diffRoster, inQuietHours, parseQuietHours, reactWith } from "./watch.js";

/**
 * Wait until the chat list stops changing.
 *
 * Filtering animates rows in and out, and a click on a moving element is
 * rejected outright. Polling a cheap signature — row count plus the first row's
 * title — costs one evaluate per tick and settles as soon as the list does,
 * rather than sleeping a fixed guess.
 */
async function settleList(page, rowSel, { ticks = 14, intervalMs = 250 } = {}) {
  let previous = null;
  let stable = 0;
  for (let i = 0; i < ticks; i++) {
    const signature = await page
      .$$eval(
        rowSel,
        (els) => `${els.length}|${els[0]?.querySelector("[title]")?.getAttribute("title") ?? ""}`,
      )
      .catch(() => null);
    if (signature !== null && signature === previous) {
      // Two identical reads in a row: the animation has finished.
      if (++stable >= 2) return signature;
    } else {
      stable = 0;
    }
    previous = signature;
    await page.waitForTimeout(intervalMs);
  }
  return previous;
}


/**
 * Whatever is currently typed in the chat-list search box.
 *
 * A pure read — no focus, no keystrokes — because the watcher calls it on every
 * snapshot and must not itself be an interaction. Non-empty means the pane is
 * filtered and any reading of it describes a subset, which is the distinction
 * `diffRoster` refuses to guess at.
 */
async function chatSearchText(page) {
  const search = await first(page, "chatSearch", { timeout: 10_000 });
  if (!search) return "";

  const value = await search.handle
    .evaluate((el) => el.value ?? el.textContent ?? "")
    .catch(() => "");
  return value.trim();
}

/**
 * Empty the chat-list search box, leaving the full list showing.
 *
 * Cheap no-op when it is already empty, so callers can just always call it.
 */
async function clearChatSearch(page) {
  const search = await first(page, "chatSearch", { timeout: 10_000 });
  if (!search) return;

  if (!(await chatSearchText(page))) return;

  await search.handle.evaluate((el) => el.focus());
  await page.keyboard.press("ControlOrMeta+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  // Let the list re-expand before anything reads it.
  await page.waitForTimeout(700);
}

/**
 * Name of the conversation currently open, or "" if none.
 *
 * Reads the header's first text line. The header's only [title] attribute is
 * the literal "Profile details", so an attribute-based read returned that (or a
 * business chat's "Business Account" subtitle) instead of the chat name — which
 * would defeat the recipient check that guards sending.
 */
/**
 * Strip the icon labels WhatsApp briefly renders as text.
 *
 * While a conversation header is still painting, its action buttons expose
 * their icon names ("ic-videocam", "ic-call", "ic-search", "ic-more-vert") as
 * text nodes with no separator, so the title reads
 * "Mariana de Souza e Limaic-videocamic-call...". Cutting at the first icon
 * token recovers the name; `looksSettled` then decides whether to trust it.
 */
function stripIconLabels(text) {
  return text.replace(/ic-[a-z-]+/g, "").trim();
}

const looksSettled = (title) => Boolean(title) && !/ic-[a-z-]+/.test(title);

/**
 * Name of the conversation currently open, once the header has settled.
 *
 * Reading it eagerly returns whatever the previous conversation left behind, or
 * a half-painted header — observed live: three consecutive reads each reported
 * the chat from the request before. That is not cosmetic. `assertResolvedMatches`
 * and the pre-send re-check in `deliver` both compare against this string, so a
 * stale title could authorise typing into a conversation that is no longer the
 * one that was verified.
 *
 * So poll until two consecutive reads agree and neither looks mid-render.
 */
async function openChatTitle(page, { timeout = 15_000, previous = null, expected = null } = {}) {
  const header = await first(page, "conversationHeader", { timeout });
  if (!header) return "";

  const read = async () => {
    const text = await header.handle.evaluate((el) => el.innerText || "").catch(() => "");
    const firstLine = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0];
    return clean(stripIconLabels(firstLine || ""));
  };

  // A settled header is not proof the NEW chat opened: the previous
  // conversation's header is perfectly stable too, which is how three reads in
  // a row each returned the chat from the request before. When the caller knows
  // what was showing before, or what it asked for, require one of those to
  // resolve before trusting the reading.
  let last = null;
  const deadline = Date.now() + Math.min(timeout, 12_000);
  while (Date.now() < deadline) {
    const current = await read();
    const stable = looksSettled(current) && current === last;
    const changed = previous === null || current !== previous;
    const isExpected = expected !== null && normalizeName(current) === normalizeName(expected);
    if (isExpected && looksSettled(current)) return current;
    if (stable && changed) return current;
    last = current;
    await page.waitForTimeout(200);
  }
  // Timed out. Returning the last reading would hand back the conversation that
  // was already open — which is exactly how a read of "kika" reported Antonio,
  // and a read of "vi" reported Bruno: each was the chat left over from the
  // previous request. A stale name that the caller then treats as verified is
  // worse than no name, so report nothing and let the caller fail loudly.
  return "";
}

/**
 * The chat-list rows as they currently stand. Returns null if the pane has not
 * rendered; callers decide what that means.
 *
 * Touches nothing — no clicks, no keystrokes, no navigation — which is what lets
 * the watcher call it on every DOM mutation without any of it counting against
 * the interaction budget.
 *
 * The pane virtualises its rows, so only what is scrolled into view exists in
 * the DOM. `limit` above roughly 20 therefore needs scrolling; this reads one
 * screenful, which is what a "what's new" question actually wants.
 */
async function readChatRows(page, limit, { timeout = 20_000 } = {}) {
  const rowSel = (await first(page, "chatRow", { timeout }))?.selector;
  if (!rowSel) return null;

  // Extraction is driven by what the rows actually contain (see /debug/rows):
  //   - "Locked chats" and "Archived" are rows in this pane but NOT chats. They
  //     carry no [title] element, which is the only reliable discriminator.
  //   - The name and the message snippet are both [title] attributes; reading
  //     them beats slicing innerText, which interleaves the unread label, the
  //     timestamp and the badge digit with the text.
  //   - The unread count is in aria-label ("2 unread messages"). Scraping a
  //     digits-only span instead picked up any number in the preview.
  const chats = await page.$$eval(
    rowSel,
    (rows, max) => {
      const out = [];
      for (const row of rows) {
        const titled = [...row.querySelectorAll("[title]")];
        if (titled.length === 0) continue; // nav entry, not a conversation

        const labels = [...row.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label") || "");
        const unreadLabel = labels.find((l) => /unread message/i.test(l));
        const unread = unreadLabel ? Number(unreadLabel.match(/\d+/)?.[0] ?? 0) : 0;

        const name = titled[0].getAttribute("title") || "";
        const lines = (row.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
        const time = lines.find((l) => /^\d{1,2}:\d{2}$/.test(l) || /^(yesterday|ontem)$/i.test(l));

        // Rebuild the snippet from the row's text minus the parts that are not
        // the message: this keeps the sender prefix that makes a group preview
        // readable ("Helena: ..."), which the [title] snippet alone drops.
        const noise = new Set([name, time].filter(Boolean));
        const snippet = lines
          .filter(
            (l) =>
              !noise.has(l) &&
              !/unread message/i.test(l) &&
              !/^\d+$/.test(l), // trailing badge digit
          )
          // WhatsApp renders a group sender as three nodes — "Helena", ":",
          // "text" — so the colon is kept and reattached here rather than
          // dropped, which would read as "Helena Amanha".
          .join(" ")
          .replace(/\s+:\s*/g, ": ")
          .replace(/\s{2,}/g, " ");

        out.push({
          name,
          preview: snippet || titled[titled.length - 1].getAttribute("title") || "",
          unread,
          time,
          pinned: labels.some((l) => /pinned/i.test(l)) || undefined,
        });
        if (out.length >= max) break;
      }
      return out;
    },
    limit,
  );

  return chats.map((c) => ({
    ...c,
    name: clean(c.name),
    preview: clean(c.preview).slice(0, 160),
  }));
}

/**
 * Recent conversations, newest first.
 *
 * Shares `readChatRows` with the watcher on purpose: an event has to be derived
 * from exactly the rows a human listing would show, or the two disagree about
 * what "unread" and "preview" mean and the diff produces events that correspond
 * to nothing the user can see.
 */
export async function listChats({ limit = 15 } = {}) {
  const page = await requireLogin();

  // Clear any leftover search first. openChat types into the same box and does
  // not reset it, so without this a listing after a read returns only the
  // previous query's matches — a "what's new" answer showing one chat because
  // someone read that chat a moment ago.
  await clearChatSearch(page);

  const chats = await readChatRows(page, limit);
  if (!chats) return { chats: [], note: "Chat list did not render; the page may still be loading." };

  return { chats };
}

/**
 * Report the DOM shape of the first few chat rows.
 *
 * WhatsApp Web's markup is unversioned, so when extraction starts returning
 * blanks the only way to repair it is to look at what the rows actually contain.
 * This returns structure — text lines, title attributes, aria-labels — so a
 * selector can be fixed without attaching a debugger to a live session.
 */
export async function debugRows(limit = 4) {
  const page = await requireLogin();
  const rowSel = (await first(page, "chatRow", { timeout: 20_000 }))?.selector;
  if (!rowSel) return { rowSelector: null, rows: [] };

  const rows = await page.$$eval(
    rowSel,
    (els, max) =>
      els.slice(0, max).map((row, index) => ({
        index,
        textLines: (row.innerText || "").split("\n"),
        titles: [...row.querySelectorAll("[title]")].map((e) => e.getAttribute("title")),
        ariaLabels: [...row.querySelectorAll("[aria-label]")]
          .map((e) => e.getAttribute("aria-label"))
          .slice(0, 6),
        selfAriaLabel: row.getAttribute("aria-label"),
        hasImg: Boolean(row.querySelector("img")),
        spanCount: row.querySelectorAll("span").length,
      })),
    limit,
  );

  return { rowSelector: rowSel, rows };
}

/** PNG of the current page. The fastest way to see what state the session is in. */
/**
 * Raw shape of the rows inside the OPEN conversation.
 *
 * `/debug/rows` dumps chat-list rows, which is the wrong thing to look at when
 * a message is misclassified — and `message-kind.js` has been telling operators
 * to use it for exactly that. This is the sibling it should have had: every
 * signal `classifyRow` consumes, unprocessed, so a wrong kind or a missing
 * sender can be diagnosed against what the DOM actually contains rather than
 * against what the extractor believed.
 *
 * Deliberately raw. It reports what is there, decides nothing, and is the
 * source the classification fixtures in `test/` are captured from.
 */
export async function debugMessageRows(limit = 8) {
  const page = await requireLogin();
  const rowSel = (await first(page, "messageRow", { timeout: 20_000 }))?.selector;
  if (!rowSel) return { rows: [], note: "No message rows rendered. Is a conversation open?" };

  const rows = await page.$$eval(
    rowSel,
    (els, max) =>
      els.slice(-max).map((row) => ({
        // Present after all, on an inner element — see the note in history.js.
        dataId: row.querySelector("[data-id]")?.getAttribute("data-id") || null,
        prePlainText: row.querySelector("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text") || null,
        icons: [...row.querySelectorAll("[data-icon]")]
          .map((e) => e.getAttribute("data-icon"))
          .filter(Boolean),
        ariaLabels: [row.getAttribute("aria-label"), ...[...row.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label"))]
          .filter(Boolean)
          .slice(0, 10),
        titles: [...row.querySelectorAll("[title]")].map((e) => e.getAttribute("title")).filter(Boolean).slice(0, 6),
        bodyText: row.querySelector("span.selectable-text, .copyable-text span")?.innerText || "",
        rowText: (row.innerText || "").slice(0, 400),
      })),
    limit,
  );

  return { rows, count: rows.length };
}

export async function debugScreenshot() {
  const page = await requireLogin();
  return await page.screenshot({ type: "png", fullPage: false });
}

/** Top-level structure: ids, testids and header labels, for locating panels. */
export async function debugStructure() {
  const page = await requireLogin();
  return await page.evaluate(() => ({
    ids: [...document.querySelectorAll("[id]")].map((e) => e.id).filter(Boolean).slice(0, 40),
    testIds: [
      ...new Set([...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid"))),
    ].slice(0, 40),
    headers: [...document.querySelectorAll("header")].map((h) => ({
      titles: [...h.querySelectorAll("[title]")].map((e) => e.getAttribute("title")).slice(0, 4),
      text: (h.innerText || "").slice(0, 80),
    })),
    gridRoles: document.querySelectorAll('[role="grid"]').length,
    rowRoles: document.querySelectorAll('[role="row"]').length,
    appRegions: [...document.querySelectorAll('[role="application"],[role="region"],[role="main"]')].map(
      (e) => ({ role: e.getAttribute("role"), label: e.getAttribute("aria-label"), id: e.id }),
    ),
    // Sample message rows: what marks a message as sent rather than received?
    messageRows: [...document.querySelectorAll('#main [role="row"]')].slice(-4).map((r) => ({
      classes: (r.className || "").toString().slice(0, 90),
      dataId: r.getAttribute("data-id"),
      innerDataId: r.querySelector("[data-id]")?.getAttribute("data-id"),
      dataIcons: [...r.querySelectorAll("[data-icon]")].map((e) => e.getAttribute("data-icon")),
      ariaLabels: [...r.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).slice(0, 5),
      hasMsgOut: Boolean(r.querySelector(".message-out")),
      hasMsgIn: Boolean(r.querySelector(".message-in")),
      childClasses: [...r.children].map((c) => (c.className || "").toString().slice(0, 60)),
    })),
  }));
}

/**
 * Which selector candidates currently match, per key.
 *
 * When extraction breaks, the question is always "which hook died", and
 * answering it by editing code and redeploying is slow. This reports the live
 * match count for every candidate, plus the contenteditable elements on the
 * page, which is where the search box and composer both live.
 */
export async function debugSelectors() {
  const page = await requireLogin();

  const perKey = {};
  for (const [key, candidates] of Object.entries(SELECTORS)) {
    perKey[key] = [];
    for (const sel of candidates) {
      const n = await page.$$eval(sel, (els) => els.length).catch(() => -1);
      perKey[key].push({ selector: sel, matches: n });
    }
  }

  const describe = (e) => ({
    tag: e.tagName.toLowerCase(),
    type: e.getAttribute("type"),
    role: e.getAttribute("role"),
    dataTab: e.getAttribute("data-tab"),
    ariaLabel: e.getAttribute("aria-label"),
    ariaPlaceholder: e.getAttribute("aria-placeholder"),
    placeholder: e.getAttribute("placeholder"),
    testId: e.getAttribute("data-testid"),
    contentEditable: e.getAttribute("contenteditable"),
    inMain: Boolean(e.closest("#main")),
    inSide: Boolean(e.closest("#side")),
    inFooter: Boolean(e.closest("footer")),
  });

  // Any element a human could type into, however it is implemented. Recent
  // builds moved chat search from a contenteditable div to a real <input>, so
  // probing only for contenteditable reported "nothing to type into".
  const typeable = await page.$$eval(
    'input, textarea, [contenteditable="true"], [role="textbox"], [role="searchbox"]',
    (els, d) => els.slice(0, 12).map(eval(d)),
    `(${describe.toString()})`,
  );

  const landmarks = await page.evaluate(() => ({
    side: Boolean(document.querySelector("#side")),
    paneSide: Boolean(document.querySelector("#pane-side")),
    main: Boolean(document.querySelector("#main")),
    app: Boolean(document.querySelector("#app")),
    headerCount: document.querySelectorAll("header").length,
    footerCount: document.querySelectorAll("footer").length,
  }));

  return { perKey, typeable, landmarks };
}

/**
 * Are the selectors ingestion depends on still matching anything?
 *
 * `/debug/selectors` answers "which hook died" once someone already suspects
 * one has. This answers the question nobody thinks to ask, and it exists
 * because of a specific silent failure: if `messageRow` stops matching, reading
 * a conversation returns zero rows, ingestion writes nothing, reports
 * `atTop: true` — and the agent tells the user their chat is empty. A break
 * that reads as an answer is worse than a break that reads as an error.
 *
 * Deliberately spends nothing from the interaction budget. It queries a page
 * that is already rendered: no scroll, no navigation, no request to WhatsApp,
 * so none of the traffic pattern the budget exists to bound.
 *
 * Which hooks count as critical, and what the results mean, are in
 * selectors.js — tested without a browser. This is only the probing.
 */
export async function selectorHealth({ scope = "all" } = {}) {
  const page = await requireLogin();

  // The conversation hooks live under #main and do not exist until a chat is
  // opened, so probing them on an idle page reported `conversationHeader` and
  // `conversationScroller` as broken every time. An alert that fires when
  // nothing is wrong is one nobody reads, which would have cost this check the
  // only thing it is for.
  let keys = criticalKeys(scope);
  let note;
  if (scope !== "list" && !(await first(page, "conversationPanel"))) {
    keys = criticalKeys("list");
    note =
      "No conversation is open, so the conversation selectors were not checked — they do not " +
      "exist until a chat is opened. Open one, or ask for scope=conversation after doing so.";
  }

  const checked = [];
  for (const key of keys) {
    const hit = await first(page, key);
    checked.push({ key, ok: Boolean(hit), matchedBy: hit?.selector ?? null });
  }

  return { ...summarizeSelectorHealth(checked, scope), ...(note ? { note } : {}) };
}

/**
 * Refuse to walk a conversation whose hooks are broken.
 *
 * A 503 with the dead selector named is the alert §3.5 asks for; the
 * alternative is an archive that silently stops growing.
 */
async function assertSelectorsHealthy(scope) {
  const health = await selectorHealth({ scope });
  if (health.ok) return health;

  const error = new Error(
    `These selectors no longer match anything: ${health.broken.join(", ")}. Reading this chat ` +
      "would report it as empty rather than fail, so nothing was read. WhatsApp Web has almost " +
      "certainly changed — inspect /debug/selectors and /debug/structure, then update " +
      "src/selectors.js.",
  );
  error.statusCode = 503;
  throw error;
}

/**
 * Open one conversation by name and confirm which one actually opened.
 *
 * The confirmation is the point. Search is fuzzy — typing "Ana" can land on
 * "Ana Paula", and every later action (reading, and above all sending) targets
 * whatever is open. Returning the resolved title lets the caller compare intent
 * against reality before anything irreversible happens.
 */
export async function openChat(query) {
  const page = await requireLogin();

  // What is showing before the click, so the read afterwards can tell a new
  // conversation from the one already open.
  const before = await openChatTitle(page, { timeout: 2_000 }).catch(() => null);

  const search = await first(page, "chatSearch", { timeout: 20_000 });
  if (!search) throw new Error("Could not find the chat search box.");

  // Focus directly rather than clicking. Playwright's click waits for the
  // element to be "stable", and WhatsApp's sidebar animates continuously enough
  // that the search box never satisfies that check — a click here times out
  // after 30s even though the element is present and interactive. focus() has no
  // actionability requirement, and the keystrokes that follow are real events.
  await search.handle.evaluate((el) => el.focus());

  // Clear whatever a previous call left behind, or the query concatenates.
  await page.keyboard.press("ControlOrMeta+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(query, { delay: 40 });
  await page.waitForTimeout(1200);

  const rowSel = (await first(page, "chatRow", { timeout: 15_000 }))?.selector;
  if (!rowSel) throw new Error(`No chat matched "${query}".`);

  // The result list animates as it filters, and Playwright refuses to click a
  // moving target ("element is not stable"). Wait for the list to stop changing
  // instead of clicking into an animation.
  await settleList(page, rowSel);

  // Skip rows that are not conversations. "Locked chats" and "Archived" sit at
  // the top of this pane and survive a search, so clicking the literal first row
  // can open a folder instead of a chat — and for a send, "whatever opened" is
  // exactly what must never be typed into.
  const rows = await page.$$(rowSel);
  const chatRows = [];
  for (const row of rows) {
    if (await row.$("[title]")) chatRows.push(row);
  }
  if (chatRows.length === 0) throw new Error(`No chat matched "${query}".`);

  const target = chatRows[0];
  await target.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await target.click({ timeout: 10_000 });
  } catch {
    // A list that never fully settles would otherwise be unusable. force skips
    // the stability check; the conversation-title check below is what actually
    // guarantees the right chat opened, so this stays safe.
    await target.click({ force: true, timeout: 10_000 });
  }

  const opened = await openChatTitle(page, { previous: before, expected: query });
  if (!opened) throw new Error("A chat opened but its title could not be read; refusing to act on it.");

  const q = query.toLowerCase();
  const o = opened.toLowerCase();
  return { opened, exactMatch: o === q, contains: o.includes(q) || q.includes(o) };
}

/**
 * Classify the message rows currently rendered, opening nothing.
 *
 * Split out from `readChat` so media retrieval can re-read the same window
 * without navigating again — `fetchMedia` has already opened the chat and must
 * not disturb it between resolving a row and downloading it.
 */
async function readVisibleMessages(page, limit) {
  const rowSel = (await first(page, "messageRow", { timeout: 20_000 }))?.selector;
  if (!rowSel) return { messages: [], counts: {}, note: "No messages rendered." };

  // The browser returns a plain description of each row and decides nothing.
  // What the row *means* is settled in Node by `classifyRow`, where it can be
  // tested without a WhatsApp session.
  const rows = await page.$$eval(
    rowSel,
    (els, max) => {
      // Direction comes from the bubble tail: data-icon="tail-out" on a sent
      // message, "tail-in" on a received one. Neither data-id nor .message-out
      // exists in this build, so the tail is the only marker — and WhatsApp
      // draws it only on the FIRST message of a consecutive run, which is why a
      // tail-less row inherits the run it belongs to rather than reporting
      // "unknown" for every message after the first.
      let runDirection;
      return els.slice(-max).map((row) => {
        const icons = [...row.querySelectorAll("[data-icon]")].map((e) => e.getAttribute("data-icon"));
        if (icons.includes("tail-out")) runDirection = true;
        else if (icons.includes("tail-in")) runDirection = false;

        const labels = [...row.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label"));
        const own = row.getAttribute("aria-label");

        return {
          // data-pre-plain-text carries "[HH:MM, DD/MM/YYYY] Sender: " on the
          // bubble — the only place author and timestamp appear as plain text.
          meta: row.querySelector("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text") || "",
          bodyText: row.querySelector("span.selectable-text, .copyable-text span")?.innerText || "",
          rowText: row.innerText || "",
          icons: icons.filter(Boolean),
          ariaLabels: [own, ...labels].filter(Boolean).slice(0, 8),
          titles: [...row.querySelectorAll("[title]")]
            .map((e) => e.getAttribute("title"))
            .filter(Boolean)
            .slice(0, 4),
          outgoing: runDirection,
        };
      });
    },
    limit,
  );

  const messages = rows.map((raw, i) => {
    const message = classifyRow(raw);
    return {
      // Position counted from the newest message, which is how media is
      // addressed for retrieval: 0 is the last message in the chat.
      fromEnd: rows.length - 1 - i,
      ...message,
      text: message.text.slice(0, 2000),
      // The row's own author label ("You:") is direct evidence and beats the
      // inherited bubble-tail run, which only marks the first message of a
      // consecutive group and is therefore a guess for every message after it.
      outgoing: message.outgoing ?? raw.outgoing,
    };
  });

  // A one-line census, so "what did I miss" can lead with the shape of the
  // backlog rather than reading every placeholder.
  const counts = {};
  for (const m of messages) counts[m.kind] = (counts[m.kind] || 0) + 1;

  return { messages, counts };
}

/** Read the visible tail of a conversation. */
export async function readChat({ chat, limit = 25 }) {
  const page = await requireLogin();
  // Nicknames resolve here as well: reading "tonhão" should work like sending to him.
  const resolved = await openChat(resolveAlias(chat));
  await page.waitForTimeout(800);

  const { messages, counts, note } = await readVisibleMessages(page, limit);
  return {
    chat: resolved.opened,
    resolvedFrom: chat,
    exactMatch: resolved.exactMatch,
    counts,
    messages,
    note,
  };
}

/* ------------------------------------------------------------------ *
 * Sending: two phases, on purpose.
 *
 * A message to a real person cannot be recalled after a few minutes, and the
 * recipient is chosen by a fuzzy search. One tool call must therefore not be
 * able to send: `prepare` resolves the recipient and returns a preview plus a
 * short-lived token, and only `commit` types. That forces the resolved name in
 * front of a human before anything leaves the machine, and makes a hallucinated
 * or repeated call inert.
 * ------------------------------------------------------------------ */

const pending = new Map();
const TOKEN_TTL_MS = 5 * 60_000;

/**
 * Compare names the way a person would, without letting a short entry match
 * half the address book.
 *
 * Lowercases, collapses whitespace, strips surrounding quotes left by a
 * hand-edited .env, and drops a trailing parenthetical — which is what makes
 * "Joao Vitor Almeida Rocha" match the self-chat WhatsApp titles
 * "Joao Vitor Almeida Rocha (You)".
 */

/**
 * Config-level checks, cheap and browser-free.
 *
 * Run these BEFORE opening a chat. Otherwise a bridge with sending switched off
 * reports "not linked to WhatsApp" — the login error masks the real cause and
 * sends the operator to fetch their phone to fix a missing env var.
 */


export async function prepareSend({ to, message }) {
  if (!message?.trim()) throw new Error("Refusing to prepare an empty message.");
  assertSendConfigured();
  const canonical = resolveAlias(to);
  const resolved = await openChat(canonical);
  // Same guard as the one-call path: being allowlisted is not evidence of
  // being the chat that was asked for.
  assertResolvedMatches(canonical, resolved.opened);
  assertSendable(resolved.opened);

  const token = randomUUID();
  pending.set(token, { to: resolved.opened, message, expires: Date.now() + TOKEN_TTL_MS });

  return {
    token,
    resolvedRecipient: resolved.opened,
    requestedRecipient: to,
    exactMatch: resolved.exactMatch,
    preview: message,
    expiresInSeconds: TOKEN_TTL_MS / 1000,
    warning: resolved.exactMatch
      ? undefined
      : `"${to}" resolved to "${resolved.opened}" — confirm this is the right person before committing.`,
  };
}

/**
 * Open the staged recipient, re-verify it, and type.
 *
 * Shared by the one-shot and two-phase paths so both get the same guard: the
 * conversation that is actually open is checked against the intended recipient
 * immediately before typing. That check — not the confirmation step — is what
 * prevents a message landing in the wrong chat, so it survives even when
 * sending is autonomous.
 */
async function deliver(page, to, message) {
  const openNow = await openChatTitle(page);
  if (openNow !== to) {
    const again = await openChat(to);
    if (again.opened !== to) {
      throw new Error(`Expected "${to}" to be open but found "${again.opened}". Not sending.`);
    }
  }
  assertSendable(to);
  await typeAndSend(page, message);

  return { sent: true, to, message, at: new Date().toISOString() };
}

/**
 * Type one message into whatever conversation is open, and send it.
 *
 * Deliberately knows nothing about *which* chat is open: the caller owns that
 * check. `deliver` re-verifies an allowlisted recipient; `sendSelfNote` verifies
 * the self chat. Keeping the keystrokes in one place means both paths share the
 * quirk this function exists for.
 */
async function typeAndSend(page, message) {
  const composer = await first(page, "composer", { timeout: 15_000 });
  if (!composer) throw new Error("Could not find the message composer.");

  await composer.handle.click();
  // Type rather than paste: WhatsApp binds its send handler to key events, and
  // a newline in the text would submit early, so send line by line.
  const lines = message.split("\n");
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(line, { delay: 15 });
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
}

/**
 * Send in one call, for a recipient already on the allowlist.
 *
 * No confirmation step: the allowlist is the boundary. Anyone not on it is
 * refused outright, so the blast radius of a wrong tool call is bounded by
 * configuration rather than by a human reading each message. The recipient is
 * still resolved and re-verified before typing.
 */
export async function sendMessage({ to, message }) {
  if (!message?.trim()) throw new Error("Refusing to send an empty message.");
  assertSendConfigured();

  const page = await requireLogin();
  // Resolve the nickname first: the guard below compares requested against
  // resolved, so an unresolved alias would always look like a mismatch.
  //
  // The roster comes first, because it can answer things the env alias map
  // cannot: a partial name ("Fabio") becomes the full chat title, which is what
  // makes `assertResolvedMatches` pass instead of refusing a request that was
  // perfectly clear. An ambiguous name refuses HERE, with the candidates, rather
  // than letting WhatsApp's recency-ranked search pick one.
  const canonical = resolveRecipientName(to);
  const resolved = await openChat(canonical);

  // The recipient must be the chat that was ASKED for, not merely a chat that
  // happens to be allowlisted.
  //
  // Searching "Helena Braga" opens the group "We" — she is its most recent
  // sender, so the group outranks her own chat in the results. "We" is on the
  // allowlist, so checking only the resolved name authorised delivering a
  // message meant for one person into a group. The allowlist bounds WHO may be
  // written to; this bounds whether the right one was found.
  assertResolvedMatches(canonical, resolved.opened);

  assertSendable(resolved.opened);

  const result = await deliver(page, resolved.opened, message);
  return {
    ...result,
    requestedRecipient: to,
    exactMatch: resolved.exactMatch,
    warning: resolved.exactMatch
      ? undefined
      : `"${to}" resolved to "${resolved.opened}" — it is allowlisted, but confirm this was the intended person.`,
  };
}

export async function commitSend({ token }) {
  const entry = pending.get(token);
  if (!entry) {
    // A replayed or invented token is a caller mistake, not a bridge fault:
    // 400 keeps it out of the error log and tells the caller what to do.
    const e = new Error("Unknown or already-used token. Call prepare again.");
    e.statusCode = 400;
    throw e;
  }
  pending.delete(token); // single use, even if the send throws below
  if (Date.now() > entry.expires) {
    const e = new Error("Confirmation expired. Call prepare again.");
    e.statusCode = 400;
    throw e;
  }

  const page = await requireLogin();
  return await deliver(page, entry.to, entry.message);
}


/**
 * Write a note to the user's own chat.
 *
 * The safe half of sending: the recipient is a constant, so there is no
 * allowlist, no fuzzy recipient, and no confirmation step. What replaces all of
 * that is one exact comparison against the configured self chat, in
 * `self-note.js` — which is where the rules live, browser-free and tested.
 *
 * Config and input are checked here too, before `requireLogin()`. Otherwise a
 * bridge with WA_SELF_CHAT_NAME unset reports "not linked to WhatsApp" and sends
 * the operator to fetch their phone to fix an env var.
 */
export async function sendSelfNote({ messages }) {
  assertSelfNoteConfigured();
  normalizeMessages(messages);

  const page = await requireLogin();
  return await sendSelfNoteWith(
    {
      env: process.env,
      openChatTitle: () => openChatTitle(page),
      openChat,
      typeAndSend: (text) => typeAndSend(page, text),
    },
    { messages },
  );
}

/* ------------------------------------------------------------------ *
 * Media retrieval.
 *
 * The rules — which rows have a payload, how one is addressed, and what proves
 * it is still the row the caller meant — live in `media.js` and are tested
 * without a browser. What follows is only the part that has to drive Chromium.
 *
 * The download step is the least verified code in this bridge. WhatsApp Web
 * exposes downloading differently per media kind and per build, so it tries the
 * bubble's own control first and the context menu second, and says what it
 * looked for when both fail. Repair it from /debug/rows rather than guessing.
 * ------------------------------------------------------------------ */

/** Click through to the bytes behind one media row. */
async function downloadRowMedia(page, target) {
  const rowSel = (await first(page, "messageRow", { timeout: 20_000 }))?.selector;
  if (!rowSel) throw new Error("No message rows are rendered.");

  const rows = await page.$$(rowSel);
  const element = rows[rows.length - 1 - target.fromEnd];
  if (!element) {
    const e = new Error(`Row ${target.fromEnd} from the end is no longer rendered.`);
    e.statusCode = 409;
    throw e;
  }

  await element.scrollIntoViewIfNeeded().catch(() => {});
  // Most builds reveal the control only on hover.
  await element.hover().catch(() => {});
  await page.waitForTimeout(400);

  const clickAndCapture = async (handle) => {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      handle.click({ timeout: 10_000 }),
    ]);
    const path = await download.path();
    if (!path) throw new Error("The download produced no file on disk.");
    const { readFile } = await import("node:fs/promises");
    try {
      return { buffer: await readFile(path), suggestedFilename: download.suggestedFilename() };
    } finally {
      // Playwright reaps downloads when the context closes. This context is a
      // persistent one that stays open for weeks, so without this every photo,
      // PDF and voice note ever fetched accumulates in the browser's temp
      // directory — on the same volume as the session profile and the archive,
      // and holding the same private correspondence twice over. In `finally`
      // because a read that failed still left the file behind.
      await download.delete().catch(() => {});
    }
  };

  for (const selector of SELECTORS.messageDownload) {
    const control = await element.$(selector);
    if (control) return await clickAndCapture(control);
  }

  // Fall back to the row's context menu.
  for (const selector of SELECTORS.messageMenu) {
    const chevron = await element.$(selector);
    if (!chevron) continue;

    await chevron.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);

    for (const itemSel of SELECTORS.menuItem) {
      for (const item of await page.$$(itemSel)) {
        const label = clean(await item.innerText().catch(() => ""));
        if (/^(download|baixar)/i.test(label)) return await clickAndCapture(item);
      }
    }
    // Leave no menu open behind us.
    await page.keyboard.press("Escape").catch(() => {});
  }

  const e = new Error(
    "Could not find a download control on that message. WhatsApp Web's markup has probably " +
      "changed: inspect the row with /debug/rows and update SELECTORS.messageDownload.",
  );
  e.statusCode = 502;
  throw e;
}

/**
 * Fetch the payload behind one media message, addressed by position.
 *
 * `expect` is how the caller proves it still means the message it read. Omit it
 * and a message arriving in between silently redirects the fetch to a different
 * attachment — see media.js.
 */
export async function fetchMedia({ chat, fromEnd, expect, maxBytes }) {
  const page = await requireLogin();

  return await fetchMediaWith(
    {
      openChat,
      // A wider window than the caller read, so a couple of new arrivals do not
      // push the target out of range before the fingerprint can reject them.
      readRows: async () => (await readVisibleMessages(page, 60)).messages,
      downloadRow: (target) => downloadRowMedia(page, target),
    },
    { chat, fromEnd, expect, maxBytes },
  );
}

/* ------------------------------------------------------------------ *
 * History and ingestion.
 *
 * The rules live in rate.js, history.js, ingest.js and store.js, all tested
 * without a browser. What follows is the browser part — scrolling the pane —
 * plus the singletons that hold the interaction budget and the archive.
 *
 * The budget deliberately gates ingestion only. Interactive reads are low
 * volume and refusing one means refusing the user; a backfill is the traffic
 * that actually looks automated, so that is what is capped.
 * ------------------------------------------------------------------ */

const budget = createBudget({ maxPerHour: Number(process.env.WA_MAX_INTERACTIONS_PER_HOUR) || 240 });

let storeHandle = null;
function store() {
  storeHandle ??= openStore(process.env.WA_STORE_PATH || "./data/store.db", {
    // Only consulted for a window whose own rows cannot say whether "8/3" is
    // 3 August or 8 March. Evidence in the messages always wins.
    dateOrder: process.env.WA_DATE_ORDER,
  });
  return storeHandle;
}

/** A caller mistake, not a fault: 400 keeps it out of the error log. */
function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/** Move the conversation back one screenful and let WhatsApp render it. */
async function scrollUp(page) {
  const scroller = await first(page, "conversationScroller", { timeout: 10_000 });
  if (!scroller) {
    throw new Error(
      "Could not find the conversation's scrolling container, so history cannot be reached. " +
        "Inspect it with /debug/structure and update SELECTORS.conversationScroller.",
    );
  }

  await scroller.handle.evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollTop - Math.round(el.clientHeight * 0.9));
  });
  // Older rows are fetched and rendered asynchronously; reading too early
  // returns the same window and looks like the top of the history.
  await page.waitForTimeout(1400);
}

/**
 * Read further back than one screenful, without writing anything.
 *
 * Useful on its own for "scroll up a bit"; `ingestChat` is the version that
 * persists what it finds.
 */
export async function readHistory({ chat, maxScrolls = 3, stopAtKey }) {
  const page = await requireLogin();
  const resolved = await openChat(chat);
  await page.waitForTimeout(800);

  const walk = await scrollbackWith(
    {
      budget,
      readMessages: async () => (await readVisibleMessages(page, 60)).messages,
      scrollUp: () => scrollUp(page),
    },
    { chat: resolved.opened, maxScrolls, stopAtKey },
  );

  return { ...walk, resolvedFrom: chat, exactMatch: resolved.exactMatch };
}

/**
 * Walk a chat backwards and write what it finds to the archive.
 *
 * Bounded on purpose. Call it again to continue: messages are content-addressed
 * so a re-read costs nothing, and `hasMore` says whether there is anything left.
 */
export async function ingestChat({ chat, mode = "top-up", maxScrolls = 5 }) {
  const page = await requireLogin();
  const resolved = await openChat(chat);
  await page.waitForTimeout(800);

  // Before anything is written: a broken message-row selector would make this
  // store nothing and report the chat as fully read. Costs no budget.
  await assertSelectorsHealthy("conversation");

  return await ingestWith(
    {
      store: store(),
      scrollback: (options) =>
        scrollbackWith(
          {
            budget,
            readMessages: async () => (await readVisibleMessages(page, 60)).messages,
            scrollUp: () => scrollUp(page),
          },
          options,
        ),
    },
    { chat: resolved.opened, mode, maxScrolls },
  );
}

/**
 * Keyword search over everything ingested so far.
 *
 * `filters` is passed through whole, deliberately. Naming the fields again here
 * is what caused them to be dropped: this function once destructured `{ query,
 * chat, limit }` and silently discarded the other five between the HTTP layer
 * that parsed them and the store that implements them. See archive-query.js.
 */
export function searchArchive({ query, ...filters }) {
  return { query, chat: filters.chat, hits: store().search(query, filters) };
}

export function archiveStats() {
  return { ...store().stats(), budgetRemaining: budget.remaining(), budgetPerHour: budget.maxPerHour };
}

/** The conversation around one search hit. Reads SQLite, never WhatsApp. */
export function archiveContext({ key, before, after }) {
  return store().contextAround(key, { before, after });
}

/** Stored messages for one chat, each carrying the key an extraction must cite. */
export function archiveMessages({ chat, limit }) {
  return { chat, messages: store().messagesFor(chat, { limit }) };
}

/** Persist what an extraction pass found. All-or-nothing on provenance. */
export function saveExtractions({ items }) {
  return store().addExtractions(items || []);
}

/**
 * File a voice note's transcript against the message it came from.
 *
 * Two reasons this is stored rather than returned and forgotten. A transcript
 * is the only readable form a voice note ever has, so without it the archive
 * holds `[voice note · 3:42]` and nothing else — the chat stays unsearchable.
 * And transcription is the one step that can send private audio to a third
 * party, so doing it twice for the same message is a privacy cost, not just a
 * bill.
 *
 * The message must already be archived: `requireMessage` refuses otherwise
 * (409), because a transcript with no message to cite is exactly the unsourced
 * row the foreign keys exist to prevent.
 */
export function recordTranscript({ key, text }) {
  if (!key) throw badRequest("key is required.");
  if (!String(text || "").trim()) throw badRequest("Refusing to store an empty transcript.");

  store().recordTranscript(key, String(text).trim());
  return { stored: true, key };
}

/** A transcript already stored for this message, or null. */
export function getTranscript({ key }) {
  if (!key) throw badRequest("key is required.");
  const row = store().transcriptFor(key);
  return { key, transcript: row ? row.text : null, createdAt: row?.created_at };
}

/**
 * Record something durable about a person or a project.
 *
 * The provenance rule is the whole feature: a fact carries the key of the
 * message it came from, the store enforces that with a foreign key, and so
 * "why do you think the meeting moved?" is answerable with the sentence that
 * caused the belief. A fact the agent merely inferred has nothing to cite and
 * is refused — which is the intended outcome, not a limitation.
 */
export function addFact({ subject, statement, sourceMessageKey, confidence }) {
  if (!String(statement || "").trim()) throw badRequest("statement is required.");
  if (!sourceMessageKey) {
    throw badRequest(
      "sourceMessageKey is required. A fact with no message behind it cannot be stored — that is " +
        "what keeps the archive from filling with things nobody said.",
    );
  }

  const id = store().addFact({
    subject: subject?.trim() || null,
    statement: String(statement).trim(),
    sourceMessageKey,
    confidence,
  });
  return { id, subject: subject?.trim() || null, sourceMessageKey };
}

/** Stored facts, each joined to the message that produced it. */
export function listFacts({ subject, chat, limit }) {
  return { facts: store().factsWithSource({ subject, chat, limit }) };
}

export function listExtractions(filters) {
  return { items: store().extractions(filters) };
}

/* ------------------------------------------------------------------ *
 * The interaction twin.
 *
 * All four of these are archive operations: they read and write SQLite and
 * never open a chat, so none of them spends from the interaction budget and
 * none of them can be rate-limited. That is what makes it reasonable to model
 * a conversation on a cadence, unlike reading one.
 * ------------------------------------------------------------------ */

/**
 * Write one modelling pass: the arcs running through a conversation, what each
 * side wants out of them, and the standing frame the conversation happens in.
 *
 * Nothing here is trusted. Every arc, goal and context cites a message, the
 * store rejects the pass if any citation names a message nobody read, and the
 * pass records the last message it considered so staleness is a count rather
 * than a guess.
 */
export function saveInteractionModel({ chat, throughMessageKey, considered, arcs, contexts }) {
  if (!String(chat || "").trim()) throw badRequest("chat is required.");
  if (!throughMessageKey) {
    throw badRequest(
      "throughMessageKey is required. Without the last message a pass considered, a twin cannot " +
        "say how out of date it is, and a stale twin reads exactly like a current one.",
    );
  }
  return store().saveInteractionModel({
    chat: String(chat).trim(),
    throughMessageKey,
    considered,
    arcs,
    contexts,
  });
}

/** The assembled twin: what is counted, what was read, and how stale it is. */
export function interactionTwin({ chat, arcStatus, horizonDays }) {
  if (!String(chat || "").trim()) throw badRequest("chat is required.");
  return store().twin(String(chat).trim(), { arcStatus, horizonDays });
}

/** Conversations whose archive has moved on since they were last modelled. */
export function staleTwins({ limit, minimumNew } = {}) {
  return { chats: store().staleTwins({ limit, minimumNew }) };
}

export function resolveArc({ id, status }) {
  if (!Number.isInteger(id)) throw badRequest("id must be an integer.");
  return store().resolveArc(id, status);
}

/**
 * Record proposed next moves. Proposals only — nothing here is sent.
 *
 * Separate from sending on purpose, and it is the safety property of the whole
 * feature: this endpoint cannot reach another person, so a bad proposal is a bad
 * suggestion in a table rather than a message that cannot be recalled.
 */
export function saveProposals({ items }) {
  if (!Array.isArray(items)) throw badRequest("items must be an array.");
  return store().addProposals(items);
}

export function listProposals({ chat, status, limit } = {}) {
  return { proposals: store().proposals({ chat, status, limit }) };
}

export function resolveProposal({ id, status }) {
  if (!Number.isInteger(id)) throw badRequest("id must be an integer.");
  return store().resolveProposal(id, status);
}

/** Close an extracted obligation out. */
export function resolveExtraction({ id, status }) {
  return store().resolveExtraction(id, status);
}

/** "What needs my attention?" — assembled from the archive, browser-free. */
export function attention({ horizonDays } = {}) {
  return store().attention({ horizonDays });
}

/* ------------------------------------------------------------------ *
 * The people graph.
 *
 * WhatsApp's search ranks by recency, so it answers "who did you mean" with
 * "whoever spoke last". The roster built from the archive answers it by name
 * instead — see people.js. Aliases come from two places and both are honoured:
 * WA_CONTACT_ALIASES for the operator's hand-edits, and the store for ones the
 * agent has been taught at runtime.
 * ------------------------------------------------------------------ */

/** Env aliases and learned ones, merged. Learned entries win. */
function allAliases() {
  const merged = new Map();
  for (const [alias, canonical] of parseAliases(process.env)) merged.set(alias, canonical);
  for (const [alias, canonical] of store().aliasMap()) merged.set(alias, canonical);
  return merged;
}

export function resolveContact({ name }) {
  return resolvePerson(name, { roster: store().roster(), aliases: allAliases() });
}

export function peopleRoster() {
  return { roster: store().roster(), aliases: Object.fromEntries(allAliases()) };
}

/**
 * Everything known about one person, gathered from the archive.
 *
 * Browser-free, so it costs nothing from the interaction budget: the roster,
 * the facts and the obligations were all written by earlier reads. The shaping
 * lives in people.js; this is only the gathering.
 */
export function personDossier({ name }) {
  const db = store();
  const resolution = resolvePerson(name, { roster: db.roster(), aliases: allAliases() });

  if (!resolution.name) return { query: name, ...buildDossier(resolution) };

  const canonical = resolution.name;
  return {
    query: name,
    ...buildDossier(resolution, {
      profile: db.roster().find((entry) => entry.name === canonical),
      // Every nickname that points here, so the agent can say "you call them
      // tonhão" instead of silently accepting it.
      aliases: [...allAliases()]
        .filter(([, target]) => normalizeName(target) === normalizeName(canonical))
        .map(([alias]) => alias),
      facts: db.factsWithSource({ subject: canonical }),
      obligations: db.extractions({ chat: canonical, limit: 200 }),
    }),
  };
}

/**
 * @param origin  "session" when the user said so in conversation with the agent,
 *                "message" when it was read out of chat text — which then has to
 *                cite the message, exactly as a fact does. Defaults to "session"
 *                so existing callers keep working, but the tool description tells
 *                the agent to pass "message" when it inferred rather than was told.
 */
export function rememberAlias({ alias, canonical, origin, sourceMessageKey }) {
  return store().setAlias(alias, canonical, { origin, sourceMessageKey });
}

export function forgetAlias({ alias }) {
  return store().removeAlias(alias);
}

/** Every alias with where it came from — the review surface for learned nicknames. */
export function listAliases({ origin } = {}) {
  return { aliases: store().aliasesWithProvenance({ origin }) };
}

/**
 * Withdraw a stored fact.
 *
 * Exposed because provenance proves traceability, not truth: a false statement
 * genuinely present in the archive passes every check the store makes, and then
 * reads back as a cited fact with a receipt. Without this the only way to correct
 * it is to edit the database by hand.
 */
export function retractFact({ id, reason }) {
  if (!Number.isInteger(id)) throw badRequest("id must be an integer.");
  return store().retractFact(id, reason);
}

export function restoreFact({ id }) {
  if (!Number.isInteger(id)) throw badRequest("id must be an integer.");
  return store().restoreFact(id);
}

/**
 * Apply the retention policy.
 *
 * `dryRun` defaults to TRUE here, unlike in the store. This is reachable over
 * HTTP and it deletes correspondence; the default for a destructive operation
 * behind a network boundary should be to describe itself.
 */
export function pruneArchive({ dryRun = true, ...overrides } = {}) {
  const policy = { ...retentionFromEnv(process.env), ...overrides };
  return { policy, ...store().prune({ ...policy, dryRun }) };
}

/**
 * The chat name to actually open for a requested recipient.
 *
 * Falls back to the env alias map, then to the raw name, so a chat that has
 * never been archived still works exactly as it did before the roster existed.
 * An ambiguous name is refused rather than guessed: a wrong recipient cannot be
 * recalled, so asking costs far less than being confidently wrong.
 */
function resolveRecipientName(requested) {
  let resolution;
  try {
    resolution = resolveContact({ name: requested });
  } catch {
    // A store that cannot be read must not take sending down with it.
    return resolveAlias(requested);
  }

  if (resolution.ambiguous) {
    const names = resolution.candidates.map((c) => `"${c.name}"`).join(", ");
    const error = new Error(
      `"${requested}" matches more than one chat: ${names}. Refusing to guess — ask which one is ` +
        "meant and send to that exact name.",
    );
    error.statusCode = 409;
    throw error;
  }

  return resolution.name || resolveAlias(requested);
}

/* ------------------------------------------------------------------ *
 * The watcher.
 *
 * Detection is free and therefore ungated: a DOM mutation the browser was going
 * to paint anyway, read without touching anything. Reaction costs browser
 * interactions and is therefore gated four ways — coalescing, per-chat cooldown,
 * quiet hours and a fan-out cap — with the rules in watch.js and the ceiling in
 * rate.js.
 *
 * The gating lives HERE, in the bridge, for the same reason the interaction
 * budget does: a cap the agent enforces is a cap a confused agent can talk
 * itself out of. The agent is handed a plan that has already been bounded.
 * ------------------------------------------------------------------ */

const WATCH_SNAPSHOT_ROWS = 30;

let baseline = null;
let watching = false;
let unsubscribe = null;
const watchCounters = { snapshots: 0, skipped: 0, recorded: 0, lastAt: null, lastSkip: null };

function watchSettings() {
  return {
    cooldownMs: Number(process.env.WA_EVENT_COOLDOWN_MINUTES || 15) * 60_000,
    maxChatsPerWake: Number(process.env.WA_EVENT_MAX_CHATS || 3),
    maxScrolls: Number(process.env.WA_EVENT_MAX_SCROLLS || 2),
    quietHoursRaw: process.env.WA_QUIET_HOURS || "",
    quietHours: parseQuietHours(process.env.WA_QUIET_HOURS || ""),
  };
}

/**
 * Read the pane and queue whatever changed.
 *
 * `trySerial` rather than `serial`: if an operation holds the browser then the
 * pane is mid-change and this reading would be thrown away by the `filtered`
 * guard regardless, while the mutation that triggered it stays visible to the
 * next snapshot. Queueing would only pile stale reads up behind a slow send.
 */
async function snapshotNow() {
  const outcome = await trySerial(async () => {
    const state = await status();
    if (state.state !== "logged_in") return { skipped: "not-logged-in" };

    const page = await requireLogin();
    const rows = await readChatRows(page, WATCH_SNAPSHOT_ROWS, { timeout: 5_000 });
    if (!rows) return { skipped: "pane-not-rendered" };

    // Filtered means a read or send has the search box populated. `diffRoster`
    // refuses such a snapshot outright — it describes a subset, and diffing a
    // subset against a full list reports every hidden chat as a change.
    const filtered = Boolean(await chatSearchText(page));
    return { snapshot: { rows, filtered, at: new Date().toISOString() } };
  });

  if (outcome.skipped) {
    watchCounters.skipped++;
    watchCounters.lastSkip = "browser-busy";
    return { skipped: "browser-busy" };
  }
  if (outcome.value.skipped) {
    watchCounters.skipped++;
    watchCounters.lastSkip = outcome.value.skipped;
    return { skipped: outcome.value.skipped };
  }

  watchCounters.snapshots++;
  watchCounters.lastAt = new Date().toISOString();

  const { events, baseline: next, skipped } = diffRoster(baseline, outcome.value.snapshot);
  // A null baseline means the snapshot must not be remembered — see diffRoster.
  if (next) baseline = next;
  if (skipped) watchCounters.lastSkip = skipped;

  if (!events.length) return { events: 0, skipped };

  const written = store().recordEvents(events);
  watchCounters.recorded += written.inserted;
  return { events: events.length, ...written };
}

/**
 * Start observing. Idempotent, and safe to call before login: the snapshot
 * checks session state itself and simply skips until the pane exists.
 */
export async function startWatching() {
  if (watching) return { watching: true, alreadyRunning: true };

  // Registering the listener also forces the browser to launch, which is what
  // installs the in-page observer.
  unsubscribe = onPaneChange(() => {
    snapshotNow().catch((error) => {
      console.error("snapshot failed:", error?.message || error);
    });
  });
  watching = true;

  await requireLogin().catch(() => null);
  // Establish the baseline immediately rather than waiting for the first
  // mutation, so the first real arrival is a diff against a known list instead
  // of being swallowed as "no baseline".
  await snapshotNow().catch(() => null);

  return { watching: true, ...watcherState() };
}

export function stopWatching() {
  unsubscribe?.();
  unsubscribe = null;
  watching = false;
  return { watching: false };
}

/** What the watcher is doing, and whether it can do anything at all. */
export function watchStatus() {
  const settings = watchSettings();
  const observer = watcherState();

  return {
    watching,
    observer,
    baselineAt: baseline?.at ?? null,
    counters: { ...watchCounters },
    queue: store().eventStats(),
    settings: {
      cooldownMinutes: settings.cooldownMs / 60_000,
      maxChatsPerWake: settings.maxChatsPerWake,
      maxScrolls: settings.maxScrolls,
      quietHours: settings.quietHoursRaw || null,
      quietHoursValid: Boolean(settings.quietHours) || !settings.quietHoursRaw,
      inQuietHoursNow: inQuietHours(new Date().toISOString(), settings.quietHours),
    },
    budgetRemaining: budget.remaining(),
    // An observer that never installed produces an empty queue, which is
    // indistinguishable from a quiet day unless it is said out loud.
    note: observer.installed
      ? undefined
      : "The in-page observer is not installed, so no events can be detected. Restart the bridge.",
  };
}

/** Look at the queue without claiming anything. */
export function pendingEvents({ limit } = {}) {
  return { events: store().pendingEvents({ limit }), queue: store().eventStats() };
}

export function completeEvents({ keys }) {
  return store().completeEvents(keys || []);
}

export function releaseEvents({ keys }) {
  return store().releaseEvents(keys || []);
}

/**
 * Claim pending events, top up the archive for the chats worth reading, and hand
 * back what the agent should tell the user about.
 *
 * Claim-and-act is one operation on purpose. If the agent claimed events and
 * then decided for itself what to read, the cooldown and the fan-out cap would
 * be advisory. Here the reads have already happened, bounded, before the agent
 * sees anything.
 *
 * Events are NOT completed here. The agent acks them after it has written its
 * note, so a crash between the two leaves them pending and the user is told
 * late rather than never. The cooldown is what stops the retry re-reading the
 * chat.
 */
export async function reactToEvents({ limit = 25 } = {}) {
  const result = await reactWith(
    { store: store(), ingest: (options) => ingestChat(options) },
    { limit, settings: watchSettings() },
  );

  return { ...result, budgetRemaining: budget.remaining() };
}
