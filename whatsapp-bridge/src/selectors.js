/**
 * Every DOM hook this bridge depends on, in one file.
 *
 * ── This file is an Anti-Corruption Layer, and that is the commitment ───────
 * The pattern has a name and it predates this project by thirty years:
 *
 *   "Anti-Corruption Layer: Create an isolating layer to provide clients with
 *    functionality in terms of their own domain model." — Evans, Domain-Driven
 *    Design lineage
 *
 * WhatsApp's vocabulary lives on one side of this file — obfuscated markup,
 * aria-labels, testids. This project's vocabulary lives on the other:
 * `{key, kind, outgoing, sent_at_iso}`. Together with `message-kind.js` (a
 * rendered row becomes a typed message) and `history.js` (a scrollback becomes
 * content-addressed messages), these three files are the whole translation.
 *
 * Naming it turns a coincidence into a rule that review can apply: **nothing
 * outside these three files should know a CSS selector**, so an upstream
 * redesign breaks one place instead of five. That rule is not yet true —
 * `whatsapp.js` still walks the DOM inside its `page.evaluate` callbacks, and
 * `session.js` reaches for `#pane-side` — so it is enforced as a ratchet rather
 * than as an assertion. See `test/anti-corruption-layer.test.js`, which holds
 * each of those files to a ceiling that may only fall, and refuses to let a
 * fourth file join them.
 *
 * WhatsApp Web ships obfuscated class names that change without notice, so
 * nothing here may key on a class. What survives across builds is, in order of
 * preference: element ids (`#pane-side` has outlived years of redesigns),
 * `data-testid`, ARIA roles and labels.
 *
 * Each hook is a LIST of candidates tried in order, so a single upstream rename
 * degrades one selector rather than breaking the service. `first(page, key)`
 * reports which candidate matched, which is what makes a break diagnosable
 * instead of mysterious.
 *
 * Verified against the live logged-out page: `[data-ref]`, `canvas`, and
 * `[data-testid="link-device-qr-code"]` are all present on the QR screen, and
 * `#pane-side` is absent there — which is exactly what makes it a login signal.
 */

export const SELECTORS = {
  // Present only when NOT logged in.
  qrCanvas: [
    '[data-testid="link-device-qr-code"] canvas',
    "canvas[aria-label*='QR']",
    "[data-ref] canvas",
    "canvas",
  ],
  qrRef: ["[data-ref]"],

  // Present only when logged in: the left-hand chat list pane.
  chatPane: ["#pane-side"],

  // One row per conversation inside the pane.
  //
  // The pane renders two different row shapes, and both are needed:
  //   - browsing the chat list  -> [data-testid="cell-frame-container"]
  //   - showing search results  -> [data-testid^="list-item-"], where
  //     cell-frame-container does not exist at all
  // Missing the second shape made every search-by-name fail with "no chat
  // matched" even though the result was plainly on screen.
  chatRow: [
    "#pane-side [data-testid='cell-frame-container']",
    '#pane-side [data-testid^="list-item-"]',
    '#pane-side [role="listitem"]',
  ],

  // The search box above the chat list.
  //
  // Current builds render this as a REAL <input type="text"> (aria-label
  // "Search or start a new chat", data-tab="3"), not the contenteditable div it
  // used to be — verified live: the page had zero contenteditable elements while
  // logged in. The contenteditable forms are kept last for older builds.
  chatSearch: [
    '#side input[role="textbox"]',
    '#side input[type="text"]',
    'input[aria-label*="Search" i]',
    '#side [role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-tab="3"]',
  ],

  // The open conversation.
  conversationPanel: ['[data-testid="conversation-panel-wrapper"]', "#main"],

  // The header naming the open chat.
  //
  // Read its innerText, NOT a [title] attribute: verified live, the only [title]
  // in this header is the string "Profile details" — a button label — so a
  // title-based selector silently returned the wrong text. The chat name is the
  // first line of the header's text ("BTG Pactual" above "Business Account",
  // a group name above its member list, a contact above "online").
  conversationHeader: ['[data-testid="conversation-header"]', "#main header"],

  messageRow: ["#main [role='row']", "#main [data-id]", '[role="row"]'],

  // The scrolling container of the open conversation. Scrolling this upward is
  // the only way to reach history: the pane virtualises, so older messages do
  // not exist in the DOM until they are scrolled into view.
  //
  // UNVERIFIED against a live session, like the download selectors below.
  conversationScroller: [
    '#main [data-testid="conversation-panel-messages"]',
    '#main div[tabindex="0"][role="application"]',
    '#main [role="application"]',
    "#main .copyable-area > div[tabindex]",
  ],

  // The download affordance on a media bubble. Present only while the row is
  // hovered in most builds, which is why `downloadRowMedia` hovers first.
  //
  // UNVERIFIED against a live session: these were not confirmed the way the
  // selectors above were. If media retrieval fails, this is the first place to
  // look — read a media row with /debug/rows and add what you find.
  messageDownload: [
    '[data-icon*="download" i]',
    '[aria-label*="Download" i]',
    '[aria-label*="Baixar" i]',
    'a[download]',
  ],

  // The chevron that opens a message's context menu, for builds where download
  // lives there rather than on the bubble. Also unverified.
  messageMenu: ['[data-icon="down-context"]', '[aria-label*="Context menu" i]', '[aria-label*="Menu de contexto" i]'],

  // Items inside that open menu.
  menuItem: ['[role="application"] [role="button"]', '[role="menu"] li', '[role="menuitem"]'],

  // The composer at the bottom of an open conversation. data-tab has been the
  // stable discriminator between the search box and the composer for years.
  composer: [
    '#main footer div[contenteditable="true"][role="textbox"]',
    '#main div[contenteditable="true"][data-tab="10"]',
    '#main footer div[contenteditable="true"]',
  ],
};

/**
 * The hooks nothing can work without, split by where they live.
 *
 * `chatPane`, `chatRow` and `chatSearch` are in the left-hand list and exist
 * whenever the session is logged in. The rest live inside an open conversation
 * and do not exist until one is opened, which is why a health check has a
 * scope: asserting `messageRow` against the chat list would always fail.
 *
 * The debug selectors are deliberately absent. A broken `messageDownload` makes
 * one fetch fail loudly, which is survivable; a broken `messageRow` makes a
 * full conversation read as empty, which is not.
 */
export const CRITICAL_SELECTORS = {
  list: ["chatPane", "chatRow", "chatSearch"],
  conversation: ["conversationHeader", "messageRow", "conversationScroller"],
};

/** Which hooks to probe for a scope. `all` is both, list first. */
export function criticalKeys(scope = "all") {
  if (scope === "list") return [...CRITICAL_SELECTORS.list];
  if (scope === "conversation") return [...CRITICAL_SELECTORS.conversation];
  return [...CRITICAL_SELECTORS.list, ...CRITICAL_SELECTORS.conversation];
}

/**
 * Turn probe results into a verdict.
 *
 * Pure, so the decision can be tested without a browser — the probing itself
 * lives in `whatsapp.js`, which has the page.
 */
export function summarizeSelectorHealth(checked, scope = "all") {
  const broken = checked.filter((entry) => !entry.ok).map((entry) => entry.key);
  // Nothing probed is not a clean bill of health — it means the check did not
  // run, and reporting `ok` for it would reintroduce the silent pass this whole
  // mechanism exists to remove.
  const ok = checked.length > 0 && broken.length === 0;
  return { ok, scope, checked, broken };
}

/** Resolve the first candidate that matches, or null. */
export async function first(page, key, { timeout = 0 } = {}) {
  const candidates = SELECTORS[key];
  if (!candidates) throw new Error(`unknown selector key: ${key}`);

  if (timeout > 0) {
    // Race all candidates so a rename costs no extra wall-clock.
    try {
      await Promise.any(
        candidates.map((sel) => page.waitForSelector(sel, { timeout, state: "attached" })),
      );
    } catch {
      return null;
    }
  }

  for (const sel of candidates) {
    const handle = await page.$(sel);
    if (handle) return { handle, selector: sel };
  }
  return null;
}

export async function exists(page, key, opts) {
  return (await first(page, key, opts)) !== null;
}
