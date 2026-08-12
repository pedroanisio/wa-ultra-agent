/**
 * The five screens, as one self-contained document.
 *
 * ── Why the page is a string in a module ────────────────────────────────────
 * eve compiles to a Nitro server that is bundled. A file read at runtime from
 * `import.meta.url` works under `eve dev` and is absent from the bundle in
 * production — the failure arrives as a 500 on the deployed agent and never
 * once on the machine it was written on. A module is bundled by definition.
 *
 * ── Why there is no framework ───────────────────────────────────────────────
 * The whole surface is five screens of text and about a dozen actions. A build
 * step would be a second toolchain to keep working for a page that renders a
 * list — and this project's own history with a rendering dependency is the
 * reason Playwright was deleted.
 *
 * ── The one rule this file may not break ────────────────────────────────────
 * Nothing from the archive is ever assigned as HTML. Every value on these
 * screens is somebody's correspondence, a display name they chose, or a model's
 * reading of both, and all three are third-party text. `text()` sets
 * `textContent`; there is no `innerHTML` in this file, and adding one would
 * turn a message into markup on a page that can send messages.
 */

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --panel: #ffffff;
  --ink: #1a1a1a;
  --muted: #6b6b6b;
  --line: #d8d5d0;
  --accent: #7950f2;
  --live: #12b886;
  --warn: #f08c00;
  --stop: #e03131;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14151a;
    --panel: #1b1d23;
    --ink: #e8e6e3;
    --muted: #9a9a9a;
    --line: #2e3138;
    --accent: #9775fa;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
header {
  display: flex;
  gap: 1rem;
  align-items: baseline;
  flex-wrap: wrap;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  position: sticky;
  top: 0;
  z-index: 5;
}
nav { display: flex; gap: 0.25rem; }
nav button {
  font: inherit;
  color: var(--muted);
  background: none;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 0.2rem 0.6rem;
  cursor: pointer;
}
nav button[aria-current="true"] { color: var(--ink); border-color: var(--line); background: var(--bg); }
.spacer { flex: 1; }
.pill { color: var(--muted); }
.pill b { color: var(--ink); font-weight: 600; }
.dot { color: var(--live); }
.dot.off { color: var(--muted); }
.dot.warn { color: var(--warn); }
main { padding: 1rem; max-width: 1180px; }
.screen[hidden] { display: none; }
.split { display: grid; grid-template-columns: minmax(240px, 22rem) 1fr; gap: 1rem; align-items: start; }
@media (max-width: 800px) { .split { grid-template-columns: 1fr; } }
.panel {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  padding: 0.75rem 0.9rem;
  margin-bottom: 1rem;
}
.panel h2 { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 0.6rem; }
.queue-item {
  display: block;
  width: 100%;
  text-align: left;
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--line);
  padding: 0.55rem 0.6rem;
  cursor: pointer;
}
.queue-item:last-child { border-bottom: 0; }
.queue-item:hover { background: var(--bg); }
.queue-item[aria-current="true"] { border-left-color: var(--accent); background: var(--bg); }
.queue-item .who { display: flex; justify-content: space-between; gap: 0.5rem; }
.queue-item .kind { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
.queue-item .what { color: var(--muted); overflow-wrap: anywhere; }
.empty { color: var(--muted); padding: 0.6rem; }
.msg { padding: 0.15rem 0; overflow-wrap: anywhere; }
.msg .at { color: var(--muted); }
.msg.out .at { color: var(--accent); }
dl.facts { display: grid; grid-template-columns: 7.5rem 1fr; gap: 0.15rem 0.75rem; margin: 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
.draft {
  border: 1px dashed var(--line);
  border-radius: 4px;
  padding: 0.5rem 0.6rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.flag { color: var(--warn); }
.stop { color: var(--stop); }
.muted { color: var(--muted); }
.actions { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.7rem; }
button.act {
  font: inherit;
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
  color: var(--ink);
  cursor: pointer;
}
button.act.primary { border-color: var(--accent); color: var(--accent); }
button.act:disabled { opacity: 0.45; cursor: not-allowed; }
.gate { display: grid; grid-template-columns: 2rem 1fr; gap: 0.5rem; padding: 0.45rem 0; border-bottom: 1px solid var(--line); }
.gate:last-child { border-bottom: 0; }
.gate .n { color: var(--muted); }
.gate .t { font-weight: 600; }
.gate .d { color: var(--muted); overflow-wrap: anywhere; }
.gate.done .n { color: var(--live); }
.gate.current { background: var(--bg); }
.gate.current .n { color: var(--warn); }
.qr { display: grid; gap: 0; margin: 0.75rem 0; width: min(280px, 70vw); }
.qr-row { display: grid; }
.qr-cell { width: 100%; aspect-ratio: 1; }
.qr-cell.on { background: #000; }
.qr-cell.off { background: #fff; }
.qr-frame { background: #fff; padding: 12px; border-radius: 4px; width: max-content; }
.pref { border-bottom: 1px solid var(--line); padding: 0.55rem 0; }
.pref:last-child { border-bottom: 0; }
.pref .row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
.pref label { min-width: 14rem; }
.pref input[type="text"], .pref select, .pref textarea, .compose textarea, .compose input {
  font: inherit;
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0.25rem 0.4rem;
  min-width: 16rem;
}
.pref .note { color: var(--muted); margin-top: 0.2rem; }
.pref .pending { color: var(--warn); }
.tool { display: grid; grid-template-columns: 1.2rem 18rem 1fr; gap: 0.4rem; padding: 0.2rem 0; }
.tool .state.live { color: var(--live); }
.tool .state.gated { color: var(--warn); }
.tool .state.dark { color: var(--muted); }
.tool .why { color: var(--muted); overflow-wrap: anywhere; }
dialog {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--ink);
  max-width: 46rem;
  width: 92vw;
  padding: 1rem;
}
dialog::backdrop { background: rgba(0, 0, 0, 0.45); }
.compose textarea { width: 100%; min-height: 7rem; }
ul.consequences { margin: 0.4rem 0 0; padding-left: 1.1rem; color: var(--muted); }
ul.consequences li.irreversible { color: var(--ink); }
.banner { border: 1px solid var(--stop); color: var(--stop); border-radius: 4px; padding: 0.5rem 0.7rem; margin-bottom: 1rem; }
.banner[hidden] { display: none; }
.saving { color: var(--muted); }
`;

const BODY = `
<header>
  <strong>whatsapp-agent</strong>
  <nav>
    <button data-screen="queue" aria-current="true">1 Queue</button>
    <button data-screen="setup">2 Setup</button>
    <button data-screen="prefs">3 Preferences</button>
    <button data-screen="tools">4 Tools</button>
  </nav>
  <span class="spacer"></span>
  <span class="pill" id="headline"></span>
</header>
<main>
  <div class="banner" id="banner" hidden></div>

  <section class="screen" id="screen-queue">
    <div class="split">
      <div class="panel">
        <h2 id="queue-heading">Needs you</h2>
        <div id="queue-list"></div>
      </div>
      <div id="detail"></div>
    </div>
  </section>

  <section class="screen" id="screen-setup" hidden>
    <div class="panel">
      <h2>Eight gates, in order</h2>
      <div id="gates"></div>
    </div>
    <div class="panel" id="pairing"></div>
  </section>

  <section class="screen" id="screen-prefs" hidden>
    <div id="prefs"></div>
  </section>

  <section class="screen" id="screen-tools" hidden>
    <div id="tools"></div>
  </section>
</main>

<dialog id="compose">
  <form method="dialog" class="compose" id="compose-form">
    <h2 id="compose-title">Edit &amp; send</h2>
    <div id="compose-to"></div>
    <textarea id="compose-text" spellcheck="true"></textarea>
    <div id="compose-flags"></div>
    <div class="actions">
      <button class="act primary" value="send" id="compose-send">Send</button>
      <button class="act" value="self" id="compose-self">Send to my own chat</button>
      <button class="act" value="cancel">Cancel</button>
    </div>
  </form>
</dialog>
`;

/**
 * The client.
 *
 * Written without template literals on purpose: this whole file is one, and a
 * nested backtick or a stray dollar-brace would be interpolated by the server
 * rather than shipped to the browser.
 */
const SCRIPT = `
"use strict";

var state = { screen: "queue", items: [], selected: null, detail: null, qr: null };

function el(tag, className, textValue) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML: everything rendered here is third-party text.
  if (textValue !== undefined && textValue !== null) node.textContent = String(textValue);
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function fail(message) {
  var banner = document.getElementById("banner");
  banner.textContent = message;
  banner.hidden = false;
}

function clearFailure() { document.getElementById("banner").hidden = true; }

async function api(path, options) {
  var response = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, options || {}));
  var body = null;
  try { body = await response.json(); } catch (error) { body = null; }
  if (!response.ok) {
    throw new Error((body && body.error) || (response.status + " " + response.statusText));
  }
  clearFailure();
  return body;
}

/* ── screens ─────────────────────────────────────────────────────── */

function show(screen) {
  state.screen = screen;
  var buttons = document.querySelectorAll("nav button");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].setAttribute("aria-current", String(buttons[i].dataset.screen === screen));
  }
  var sections = document.querySelectorAll(".screen");
  for (var j = 0; j < sections.length; j++) {
    sections[j].hidden = sections[j].id !== "screen-" + screen;
  }
  if (screen !== "setup" && state.qr) { state.qr.close(); state.qr = null; }
  if (screen === "queue") loadQueue();
  if (screen === "setup") loadSetup();
  if (screen === "prefs") loadPrefs();
  if (screen === "tools") loadTools();
}

/* ── 1. the queue ────────────────────────────────────────────────── */

async function loadQueue() {
  var data;
  try { data = await api("/ui/api/queue"); } catch (error) { return fail("Queue: " + error.message); }

  state.items = data.items;
  var headline = document.getElementById("headline");
  clear(headline);
  headline.appendChild(el("span", "dot" + (data.status.transportConnected ? "" : " off"), "\\u25CF"));
  headline.appendChild(el("span", null, " " + (data.status.transportConnected ? "live" : "not receiving")));
  headline.appendChild(el("span", null, "  \\u00B7  send " + (data.status.sendOn ? "ON to " + data.status.allowlist.length : "OFF")));
  headline.appendChild(el("span", null, "  \\u00B7  " + data.status.archivedMessages.toLocaleString() + " archived"));

  document.getElementById("queue-heading").textContent = "Needs you \\u2014 " + data.items.length;

  var list = document.getElementById("queue-list");
  clear(list);
  if (!data.items.length) {
    var quiet = el("div", "empty", "Nothing is waiting.");
    quiet.appendChild(el("div", "muted", "A quiet day is a valid screen. This is not a backlog."));
    list.appendChild(quiet);
    clear(document.getElementById("detail"));
    return;
  }

  data.items.forEach(function (item) {
    var button = el("button", "queue-item");
    button.type = "button";
    button.dataset.ref = item.ref;
    var who = el("div", "who");
    who.appendChild(el("strong", null, item.chat));
    who.appendChild(el("span", "kind", item.kind));
    button.appendChild(who);
    button.appendChild(el("div", "what", item.headline));
    button.addEventListener("click", function () { selectItem(item.ref); });
    list.appendChild(button);
  });

  selectItem(state.selected && data.items.some(function (i) { return i.ref === state.selected; })
    ? state.selected
    : data.items[0].ref);
}

async function selectItem(ref) {
  state.selected = ref;
  var buttons = document.querySelectorAll(".queue-item");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].setAttribute("aria-current", String(buttons[i].dataset.ref === ref));
  }
  var item = state.items.filter(function (i) { return i.ref === ref; })[0];
  if (!item) return;

  var detail = document.getElementById("detail");
  clear(detail);
  detail.appendChild(renderItem(item));

  var conversation = el("div", "panel");
  conversation.appendChild(el("h2", null, "Conversation"));
  conversation.appendChild(el("div", "muted", "loading\\u2026"));
  detail.appendChild(conversation);

  var data;
  try { data = await api("/ui/api/conversation?chat=" + encodeURIComponent(item.chat)); }
  catch (error) { clear(conversation); conversation.appendChild(el("div", "stop", error.message)); return; }

  clear(conversation);
  conversation.appendChild(el("h2", null, item.chat));
  if (!data.messages.length) conversation.appendChild(el("div", "empty", "Nothing archived for this chat yet."));
  data.messages.forEach(function (message) {
    var line = el("div", "msg" + (message.outgoing ? " out" : ""));
    line.appendChild(el("span", "at", (message.sent_at_iso || "").slice(11, 16) + " "));
    line.appendChild(el("span", null, (message.sender ? message.sender + ": " : "") + (message.text || "")));
    conversation.appendChild(line);
  });

  if (data.measured) {
    var measured = el("div", "panel");
    measured.appendChild(el("h2", null, "Measured \\u2014 counted from the archive"));
    var facts = el("dl", "facts");
    Object.keys(data.measured).forEach(function (key) {
      var value = data.measured[key];
      if (value === null || value === undefined || typeof value === "object") return;
      facts.appendChild(el("dt", null, key));
      facts.appendChild(el("dd", null, String(value)));
    });
    measured.appendChild(facts);
    document.getElementById("detail").appendChild(measured);
  }

  if (data.read && (data.read.arcs.length || data.read.goals.length)) {
    var read = el("div", "panel");
    read.appendChild(el("h2", null, "Read \\u2014 a model's reading, each citing a message"));
    data.read.arcs.forEach(function (arc) {
      read.appendChild(el("div", null, "arc: " + (arc.title || "") + " \\u00B7 " + (arc.status || "")));
    });
    data.read.goals.forEach(function (goal) {
      var holder = goal.holder === "user" ? "you want" : goal.holder === "them" ? "they want" : "shared";
      read.appendChild(el("div", null, holder + ": " + (goal.statement || "") + (goal.arc ? "  [" + goal.arc + "]" : "")));
    });
    document.getElementById("detail").appendChild(read);
  }
}

function renderItem(item) {
  var panel = el("div", "panel");
  panel.appendChild(el("h2", null, item.kind + (item.timesProposed > 1 ? " \\u00B7 suggested " + item.timesProposed + " times" : "")));
  panel.appendChild(el("div", null, item.headline));
  panel.appendChild(el("div", "muted", item.because));

  if (item.draft) {
    panel.appendChild(el("div", "draft", item.draft));
    if (item.yoursToWord) {
      panel.appendChild(el("div", "flag", "\\u2691 Yours to word \\u2014 this commits you. The model drafted around it."));
    }
  }

  var actions = el("div", "actions");
  if (item.kind === "proposal") {
    actions.appendChild(action("Edit & send", "primary", function () { openCompose(item); }));
    actions.appendChild(action("Dismiss", null, function () { resolve(item.ref, "dismiss"); }));
  } else {
    actions.appendChild(action("Reply", "primary", function () { openCompose(item); }));
    actions.appendChild(action("Mark done", null, function () { resolve(item.ref, "done"); }));
    actions.appendChild(action("Drop", null, function () { resolve(item.ref, "dropped"); }));
  }
  panel.appendChild(actions);
  return panel;
}

function action(label, className, onClick) {
  var button = el("button", "act" + (className ? " " + className : ""), label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

async function resolve(ref, action) {
  try {
    await api("/ui/api/resolve", { method: "POST", body: JSON.stringify({ ref: ref, action: action }) });
  } catch (error) { return fail("That row could not be closed: " + error.message); }
  state.selected = null;
  loadQueue();
}

/* ── the compose dialog ──────────────────────────────────────────── */

function openCompose(item) {
  var dialog = document.getElementById("compose");
  var text = document.getElementById("compose-text");
  text.value = item.draft || "";

  var to = document.getElementById("compose-to");
  clear(to);
  to.appendChild(el("div", null, "to " + item.chat));
  to.appendChild(el("div", "muted", "Resolved and re-checked at send time. The allowlist is enforced by the bridge, not by this page."));

  dialog.dataset.ref = item.ref;
  dialog.dataset.chat = item.chat;
  reviewDraft();
  dialog.showModal();
}

var reviewTimer = null;
function reviewDraft() {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(async function () {
    var text = document.getElementById("compose-text").value;
    var flags = document.getElementById("compose-flags");
    clear(flags);
    if (!text.trim()) return;
    var review;
    try { review = await api("/ui/api/draft", { method: "POST", body: JSON.stringify({ draft: text }) }); }
    catch (error) { return; }
    flags.appendChild(el("div", "muted", review.chars + " characters"));
    if (review.yoursToWord) {
      flags.appendChild(el("div", "flag", "\\u2691 Yours to word: this names a price, fixes a time, apologises or promises."));
    }
  }, 200);
}

async function submitCompose(event) {
  var dialog = document.getElementById("compose");
  var choice = event.submitter ? event.submitter.value : "cancel";
  if (choice === "cancel") return;

  var body = {
    to: dialog.dataset.chat,
    message: document.getElementById("compose-text").value,
    ref: dialog.dataset.ref,
    toSelf: choice === "self",
  };

  try {
    var result = await api("/ui/api/send", { method: "POST", body: JSON.stringify(body) });
    if (!result.exactMatch && result.resolvedName) {
      fail("Sent \\u2014 to " + result.resolvedName + ", which is a fuzzy match on the name given.");
    }
  } catch (error) {
    fail("Not sent: " + error.message);
  }
  state.selected = null;
  loadQueue();
}

/* ── 2. setup ────────────────────────────────────────────────────── */

async function loadSetup() {
  var data;
  try { data = await api("/ui/api/setup"); } catch (error) { return fail("Setup: " + error.message); }

  var gates = document.getElementById("gates");
  clear(gates);
  data.gates.forEach(function (gate) {
    var row = el("div", "gate " + gate.state);
    row.appendChild(el("div", "n", gate.state === "done" ? "\\u2713" : String(gate.n)));
    var body = el("div");
    body.appendChild(el("div", "t", gate.title));
    body.appendChild(el("div", "d", gate.detail));
    row.appendChild(body);
    gates.appendChild(row);
  });

  var pairing = document.getElementById("pairing");
  clear(pairing);
  if (data.paired) {
    pairing.appendChild(el("h2", null, "Linked"));
    pairing.appendChild(el("div", "muted", "This account is paired. Pairing again consumes a second of WhatsApp's four device slots rather than replacing this one."));
    return;
  }

  pairing.appendChild(el("h2", null, "Link the account"));
  pairing.appendChild(el("div", "muted", "The code rotates roughly every 20 seconds, so this is a live stream rather than a picture."));
  var frame = el("div", "qr-frame");
  var grid = el("div", "qr");
  grid.id = "qr";
  frame.appendChild(grid);
  pairing.appendChild(frame);
  pairing.appendChild(el("div", "muted", "Phone \\u2192 WhatsApp \\u2192 Settings \\u2192 Linked devices \\u2192 Link a device"));

  var phone = el("div", "actions");
  var input = el("input");
  input.type = "text";
  // Assembled rather than written out: this is a synthetic placeholder, but the
  // identity guard scans tracked files for the SHAPE of a number and cannot tell
  // a placeholder from a leak — nor should it try. See
  // whatsapp-bridge/test/no-real-identities.test.js, whose own fixtures do this.
  input.placeholder = "+" + "55" + " " + "11" + " " + "90000" + "-" + "0000";
  input.id = "pair-phone";
  phone.appendChild(input);
  phone.appendChild(action("Pair by phone number instead", null, pairByPhone));
  pairing.appendChild(phone);
  pairing.appendChild(el("div", "pair-result muted"));

  startQrStream();
}

function startQrStream() {
  if (state.qr) state.qr.close();
  var source = new EventSource("/ui/api/pair/qr");
  state.qr = source;

  source.addEventListener("message", function (event) {
    var payload;
    try { payload = JSON.parse(event.data); } catch (error) { return; }
    if (payload.error) { fail("Pairing: " + payload.error); return; }
    if (payload.paired) { source.close(); state.qr = null; loadSetup(); return; }
    if (payload.matrix) drawQr(payload.matrix);
  });

  source.addEventListener("error", function () {
    // The stream ends when pairing completes, and EventSource retries by
    // itself. Re-reading the gates is how a completed pairing gets noticed.
    if (state.screen === "setup") loadSetup();
  });
}

function drawQr(matrix) {
  var grid = document.getElementById("qr");
  if (!grid) return;
  clear(grid);
  matrix.modules.forEach(function (row) {
    var line = el("div", "qr-row");
    line.style.gridTemplateColumns = "repeat(" + matrix.size + ", 1fr)";
    row.forEach(function (dark) { line.appendChild(el("div", "qr-cell " + (dark ? "on" : "off"))); });
    grid.appendChild(line);
  });
}

async function pairByPhone() {
  var input = document.getElementById("pair-phone");
  var result = document.querySelector(".pair-result");
  try {
    var body = await api("/ui/api/pair/phone", { method: "POST", body: JSON.stringify({ phone: input.value }) });
    result.textContent = "Type this into the phone: " + (body.code || JSON.stringify(body));
  } catch (error) {
    result.textContent = "";
    fail("Pairing: " + error.message);
  }
}

/* ── 3. preferences ──────────────────────────────────────────────── */

async function loadPrefs() {
  var data;
  try { data = await api("/ui/api/preferences"); } catch (error) { return fail("Preferences: " + error.message); }

  var root = document.getElementById("prefs");
  clear(root);

  var intro = el("div", "panel");
  intro.appendChild(el("h2", null, "What these change"));
  intro.appendChild(el("div", "muted",
    data.writable
      ? "Every row writes .env, which is what the NEXT start reads. Nothing here changes a running process, so a saved row stays marked until the service restarts."
      : "No .env file is mounted here, so nothing can be saved from this page. Mount it read-write into the agent, or edit it on the host."));
  if (data.restarts.length) {
    intro.appendChild(el("div", "flag", "Saved and not yet in force. Restart: " + data.restarts.join(", ")));
  }
  root.appendChild(intro);

  data.sections.forEach(function (section) {
    var panel = el("div", "panel");
    panel.appendChild(el("h2", null, section));
    data.rows.filter(function (row) { return row.section === section; }).forEach(function (row) {
      panel.appendChild(renderPref(row, data.writable));
    });
    root.appendChild(panel);
  });
}

function renderPref(row, writable) {
  var wrap = el("div", "pref");
  var line = el("div", "row");
  line.appendChild(el("label", null, row.label));

  var input;
  if (row.kind === "boolean") {
    input = document.createElement("select");
    // Three states, not two. A key the file does not set is running on a
    // default — showing that as "false" is the opposite of the truth for
    // WA_ALLOW_SELF_NOTE, and one Save from switching self notes off.
    var options = [
      { value: "", label: "unset" + (row.defaultValue ? " (default: " + row.defaultValue + ")" : "") },
      { value: "true", label: "true" },
      { value: "false", label: "false" },
    ];
    options.forEach(function (option) {
      var node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      input.appendChild(node);
    });
    input.value = row.pending === "true" ? "true" : row.pending === "false" ? "false" : "";
  } else if (row.kind === "choice") {
    input = document.createElement("select");
    if (row.whenEmpty) {
      var blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "(unset)";
      input.appendChild(blank);
    }
    (row.choices || []).forEach(function (option) {
      var node = document.createElement("option");
      node.value = option;
      node.textContent = option;
      input.appendChild(node);
    });
    input.value = row.pending;
  } else {
    input = document.createElement("input");
    input.type = "text";
    // A secret is reported by its shape and never returned, so the box starts
    // empty: typing replaces it, leaving it alone keeps what is there.
    input.value = row.kind === "secret" ? "" : row.pending;
    if (row.kind === "secret") input.placeholder = row.pending || "(unset)";
  }
  input.disabled = !writable;
  input.dataset.key = row.key;
  line.appendChild(input);

  var save = action("Save", null, async function () {
    var payload = {};
    payload[row.key] = input.value;
    save.disabled = true;
    save.textContent = "saving\\u2026";
    try {
      var result = await api("/ui/api/preferences", { method: "POST", body: JSON.stringify(payload) });
      save.textContent = result.restarts.length ? "saved \\u00B7 restart " + result.restarts.join(", ") : "saved";
    } catch (error) {
      save.textContent = "Save";
      fail(error.message);
    }
    save.disabled = !writable;
    setTimeout(function () { save.textContent = "Save"; }, 4000);
  });
  save.disabled = !writable;
  line.appendChild(save);
  wrap.appendChild(line);

  wrap.appendChild(el("div", "note", row.note));
  if (!row.pending && row.whenEmpty) wrap.appendChild(el("div", "note", row.whenEmpty));
  if (row.defaulted) {
    wrap.appendChild(el("div", "note",
      "The file does not set this. In force now: " + row.effective + " \u2014 from a default, not from a saved value."));
  }
  if (row.awaitingRestart) {
    wrap.appendChild(el("div", "pending",
      "In force now: " + (row.effective || "(unset)") + " \\u2014 saved: " + (row.pending || "(unset)") +
      ". Restart " + row.restarts + " to apply."));
  }
  return wrap;
}

/* ── 4. tools ────────────────────────────────────────────────────── */

async function loadTools() {
  var data;
  try { data = await api("/ui/api/tools"); } catch (error) { return fail("Tools: " + error.message); }

  var root = document.getElementById("tools");
  clear(root);

  var summary = el("div", "panel");
  summary.appendChild(el("h2", null, "Reach"));
  summary.appendChild(el("div", null,
    data.tally.live + " live \\u00B7 " + data.tally.gated + " gated \\u00B7 " + data.tally.dark + " dark, of " + data.tally.total));
  summary.appendChild(el("div", "muted",
    "A tool going dark is a working state: with no key the model is told it cannot do that thing, rather than being allowed to try and fail on somebody's phone."));
  root.appendChild(summary);

  data.groups.forEach(function (group) {
    var panel = el("div", "panel");
    panel.appendChild(el("h2", null, group.label));
    group.tools.forEach(function (tool) {
      var row = el("div", "tool");
      row.appendChild(el("span", "state " + tool.state, tool.state === "live" ? "\\u25CF" : tool.state === "gated" ? "\\u25D1" : "\\u25CB"));
      row.appendChild(el("span", null, tool.tool));
      row.appendChild(el("span", "why", tool.reason));
      panel.appendChild(row);
    });
    root.appendChild(panel);
  });
}

/* ── boot ────────────────────────────────────────────────────────── */

document.querySelectorAll("nav button").forEach(function (button) {
  button.addEventListener("click", function () { show(button.dataset.screen); });
});
document.getElementById("compose-text").addEventListener("input", reviewDraft);
document.getElementById("compose-form").addEventListener("submit", submitCompose);

show("queue");
`;

/** The whole document, ready to be returned as `text/html`. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>whatsapp-agent</title>
<style>${STYLES}</style>
</head>
<body>
${BODY}
<script>${SCRIPT}</script>
</body>
</html>
`;
