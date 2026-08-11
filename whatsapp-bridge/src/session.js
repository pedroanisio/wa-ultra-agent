import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

import { createSessionLifecycle } from "./lifecycle.js";
import { SELECTORS, exists, first } from "./selectors.js";

/**
 * The single browser session this bridge owns.
 *
 * WhatsApp Web allows one linked web session per browser profile, so this is a
 * singleton by nature rather than by convenience: a second context on the same
 * profile directory corrupts it, and a second context on a different profile
 * needs its own QR scan.
 *
 * The profile directory IS the credential. Anyone who copies it gets your
 * WhatsApp account without a QR scan, on any machine. Treat it exactly as you
 * would a private key: never commit it, never put it in an image layer, back it
 * up only somewhere you would keep a password.
 */

const PROFILE_DIR = process.env.WA_PROFILE_DIR || "./data/profile";
const HEADLESS = process.env.WA_HEADLESS === "true";
const EXECUTABLE = process.env.WA_CHROME_PATH || undefined;

let context = null;
let page = null;

/* ------------------------------------------------------------------ *
 * Turning the open page into an event source.
 *
 * The chat list mutates in the local DOM the moment a message lands in any
 * chat. Observing that costs no clicks, no typing and no navigation — it is a
 * callback on rendering work Chromium is doing anyway — which is why detection
 * can be free even though every *action* against WhatsApp is rationed.
 *
 * Two things make this survive a long-lived session, and both are why the
 * bindings are installed on the CONTEXT rather than the page: `addInitScript`
 * then re-runs the installer on every navigation and reload (WhatsApp Web
 * reloads itself on update), and `exposeFunction` cannot be registered twice on
 * the same target, so binding it once per context and letting a fresh context
 * come with a fresh binding avoids a throw on relaunch.
 * ------------------------------------------------------------------ */

const PANE_CHANGED = "__waPaneChanged";
const paneListeners = new Set();

let watcherInstalled = false;
let watcherError = null;

/**
 * Whether this session can observe at all.
 *
 * Worth reporting rather than assuming: an uninstalled observer produces an
 * empty event queue, which is indistinguishable from a quiet day unless the
 * difference is stated somewhere. `/events` surfaces this.
 */
export const watcherState = () => ({ installed: watcherInstalled, error: watcherError });

/**
 * Installed into every document. Throttled rather than debounced, deliberately:
 * WhatsApp mutates the pane on its own timers (relative timestamps tick over),
 * so a debounce that resets on every mutation could be starved indefinitely and
 * never fire. A throttle bounds the rate *and* guarantees delivery.
 */
const OBSERVER_SCRIPT = `(() => {
  if (window.__waPaneWatcher) return;
  window.__waPaneWatcher = true;

  let pending = false;
  const notify = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      // Absent only if a mutation beats the binding during startup; the next one
      // delivers, and Node re-snapshots on connect anyway.
      window.${PANE_CHANGED}?.();
    }, 1500);
  };

  const attach = () => {
    const pane = document.querySelector("#pane-side");
    if (!pane) return false;
    new MutationObserver(notify).observe(pane, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return true;
  };

  // The SPA paints this pane long after the document exists, and this script
  // runs before any of it. Poll until the pane is there, then stop.
  if (!attach()) {
    const poll = setInterval(() => {
      if (attach()) clearInterval(poll);
    }, 2000);
  }
})()`;

async function installPaneWatcher() {
  await context.exposeFunction(PANE_CHANGED, () => {
    for (const listener of paneListeners) {
      // A throwing listener must not take down the binding for the others, and
      // there is nobody to return an error to.
      try {
        listener();
      } catch (error) {
        console.error("pane listener failed:", error?.message || error);
      }
    }
  });
  await context.addInitScript(OBSERVER_SCRIPT);
}

/**
 * Be told when the chat list changes. Returns an unsubscribe function.
 *
 * Registration is independent of the browser's lifecycle: listeners live in this
 * module, so a relaunch reinstalls the observer without the caller re-subscribing.
 */
export function onPaneChange(listener) {
  paneListeners.add(listener);
  return () => paneListeners.delete(listener);
}

/** Chromium flags chosen for a long-lived container session. */
function launchArgs() {
  return [
    // The container runs unprivileged; Chromium's sandbox needs syscalls the
    // default seccomp profile denies.
    "--no-sandbox",
    "--disable-dev-shm-usage", // /dev/shm is 64 MB in Docker by default
    // WhatsApp Web reads navigator.webdriver; this removes the flag that the
    // automation stack would otherwise set on every page.
    "--disable-blink-features=AutomationControlled",
  ];
}

/**
 * Launch coalescing, retry-after-failure and the liveness the healthcheck reads.
 *
 * The rules are in `lifecycle.js`, tested without a browser. Here they are wired
 * to the real thing: `alive` is "the page is still open", which also covers a
 * crashed browser, because Playwright closes every page when the process dies.
 */
const session = createSessionLifecycle({
  launch: () => launch(),
  alive: (p) => !p.isClosed(),
});

/** Liveness only — never anything about the account. See `server.js` `/health`. */
export const sessionHealth = () => session.health();

export async function getPage() {
  return await session.acquire();
}

async function launch() {
  mkdirSync(PROFILE_DIR, { recursive: true });

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    executablePath: EXECUTABLE,
    viewport: { width: 1280, height: 900 },
    args: launchArgs(),
    // A stale desktop UA gets served a "browser not supported" wall.
    userAgent:
      process.env.WA_USER_AGENT ||
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });

  // A browser that dies under us — OOM in a starved container, a Chromium crash
  // — must not leave a handle that looks usable. Playwright fires this on the
  // context when the process goes, and `lifecycle` relaunches on the next call
  // rather than driving a dead page. Without it the failure surfaces later, as
  // an unrelated timeout somewhere in the middle of a send.
  context.once("close", () => session.lost("browser disconnected"));

  page = context.pages()[0] ?? (await context.newPage());
  page.once("crash", () => session.lost("page crashed"));

  // Before the navigation, so the init script runs on the document it creates
  // rather than only on the next reload. Additive by design: a session that
  // cannot observe is degraded, not broken, so this must never stop the bridge
  // from serving reads and sends. `watcherState()` is how the failure is seen
  // instead of being silently absent.
  try {
    await installPaneWatcher();
    watcherInstalled = true;
  } catch (error) {
    watcherInstalled = false;
    watcherError = error?.message || String(error);
    console.error("pane watcher not installed; events will not fire:", watcherError);
  }

  await page.goto("https://web.whatsapp.com/", {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });

  // The SPA paints its first real screen well after domcontentloaded. Wait for
  // either terminal state rather than a fixed sleep.
  await Promise.race([
    page.waitForSelector(SELECTORS.chatPane[0], { timeout: 90_000 }).catch(() => null),
    page.waitForSelector(SELECTORS.qrRef[0], { timeout: 90_000 }).catch(() => null),
  ]);

  return page;
}

/**
 * Which of the three states the session is in.
 *
 * `loading` is distinct from `logged_out` on purpose: reporting "scan the QR"
 * while the app is still booting would send someone to fetch their phone for
 * nothing.
 */
export async function status() {
  const p = await getPage();
  if (await exists(p, "chatPane")) return { state: "logged_in" };
  if (await exists(p, "qrRef")) return { state: "logged_out", reason: "awaiting QR scan" };
  return { state: "loading" };
}

/** PNG of the current QR, for linking the account. Null once logged in. */
export async function qrPng() {
  const p = await getPage();
  if (await exists(p, "chatPane")) return null;

  const found = await first(p, "qrCanvas", { timeout: 30_000 });
  if (!found) return null;
  return await found.handle.screenshot({ type: "png" });
}

/** Wait until linked, polling for the chat pane. */
export async function waitForLogin(timeoutMs = 180_000) {
  const p = await getPage();
  try {
    await p.waitForSelector(SELECTORS.chatPane[0], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function requireLogin() {
  const s = await status();
  if (s.state !== "logged_in") {
    const error = new Error(
      s.state === "loading"
        ? "WhatsApp Web is still loading — retry in a few seconds."
        : "Not linked to WhatsApp. Open GET /qr, scan it from your phone, then retry.",
    );
    error.statusCode = 409;
    error.state = s.state;
    throw error;
  }
  return getPage();
}

export async function shutdown() {
  await context?.close().catch(() => {});
  context = null;
  page = null;
  // A deliberate teardown, so it clears the session without recording a fault:
  // `/health` must not read `down` because someone asked the bridge to stop.
  session.reset();
}
