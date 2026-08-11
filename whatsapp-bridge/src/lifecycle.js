/**
 * When the browser is launched, relaunched, and admitted to be gone.
 *
 * Split out of `session.js` for the reason `self-note.js` and `media.js` are
 * split out of `whatsapp.js`: every interesting case here is a failure case, and
 * a test that needs Chromium to die on demand cannot be written deterministically.
 * The launcher is injected; this file never imports playwright.
 *
 * ── The bug this exists to prevent ──────────────────────────────────────────
 * The previous form was `launching ??= launch()`. That coalesces concurrent
 * callers correctly, which is what it was written for, and it also caches a
 * REJECTED promise forever. One transient failure — Chromium OOM under a
 * starved container, a `goto` past its timeout on a slow network — and every
 * later call re-awaits the same rejection. The bridge is then dead until someone
 * restarts the container, reporting the original error long after the cause has
 * passed. A retry is not an optimisation here; it is the difference between a
 * blip and an outage.
 *
 * ── What a scraper reference does NOT transfer ──────────────────────────────
 * firecrawl's playwright service (`apps/playwright-service-ts/api.ts`) is the
 * opposite kind of client: stateless, anonymous, one fresh context per request,
 * against hostile third-party pages. Almost none of its browser handling belongs
 * here, and copying it would break this bridge rather than harden it:
 *
 *   - a new `BrowserContext` per request      → there is exactly one linked
 *     session, and it lives in a persistent profile directory; a second context
 *     on that profile corrupts it
 *   - a rotating `user-agent` per request     → the UA is pinned because a stale
 *     one gets served a "browser not supported" wall, and a UA that changes
 *     between requests is an automation signal on an authenticated account
 *   - `serviceWorkers: 'block'`               → WhatsApp Web is a PWA and
 *     registers one; blocking it degrades or breaks the app
 *   - aborting media/ad requests              → media is the payload here, not
 *     noise; `fetchMedia` depends on it loading
 *   - a request-level SSRF proxy              → one fixed first-party origin, no
 *     caller-supplied URLs, nothing to guard against
 *   - `--no-zygote`, `--disable-gpu`          → tuned for short-lived scrape
 *     processes; this session runs for weeks under Xvfb
 *
 * The one property worth taking from it is structural, not code: firecrawl's
 * `if (!browser) await initializeBrowser()` retries by construction on every
 * request, and its `/health` actually exercises the browser instead of asserting
 * that the process is alive. Both are about never trusting a cached "it worked
 * once". That is what this module implements, in the shape this bridge needs.
 */

/**
 * @param launch  Brings the session up and resolves to the handle callers want.
 *                Rejecting is a first-class outcome, not an exception.
 * @param alive   Whether the handle currently held is still usable. Consulted
 *                only when one is held — never mid-launch, where there is no
 *                handle to ask about and the answer would relaunch on top of a
 *                launch already running.
 */
export function createSessionLifecycle({ launch, alive = () => true, now = () => Date.now() }) {
  let handle = null;
  let launching = null;

  let launches = 0;
  let failures = 0;
  let lastError;
  let lastFailureAt;
  let upSince;

  const forget = () => {
    handle = null;
    upSince = undefined;
  };

  return {
    /**
     * The live handle, launching one if there is none.
     *
     * Concurrent callers during startup join the single in-flight attempt rather
     * than racing several persistent contexts onto the same profile directory —
     * and if that attempt fails they all learn about it, because handing a
     * caller a half-launched session is worse than making it retry.
     */
    async acquire() {
      if (handle && alive(handle)) return handle;
      // A handle that is no longer alive is gone, whatever it still points at.
      if (handle) forget();

      launching ??= (async () => {
        try {
          const launched = await launch();
          handle = launched;
          launches++;
          upSince = now();
          lastError = undefined;
          lastFailureAt = undefined;
          return launched;
        } catch (error) {
          failures++;
          lastError = error?.message || String(error);
          lastFailureAt = now();
          forget();
          throw error;
        } finally {
          // The line the whole module exists for. Clearing this on failure as
          // well as on success is what makes the next caller try again instead
          // of inheriting a rejection from minutes ago.
          launching = null;
        }
      })();

      return launching;
    },

    /**
     * Declare the session gone without attributing a fault.
     *
     * For a browser that disconnected or crashed under us: the next `acquire`
     * relaunches rather than handing out a handle to a dead process. Not counted
     * as a launch failure, because nothing failed to launch.
     */
    lost(reason) {
      if (!handle) return;
      forget();
      if (reason) lastError = reason;
    },

    /** Deliberate teardown. Distinct from `lost`, and never a fault. */
    reset() {
      forget();
      launching = null;
      lastError = undefined;
      lastFailureAt = undefined;
    },

    /**
     * What the healthcheck is allowed to know.
     *
     * Three states, and the distinction between two of them gates container
     * startup. The browser is launched lazily on the first request, so between
     * `docker compose up` and that request there is no session — reporting that
     * absence as a fault would fail the healthcheck at boot and, through
     * `depends_on: service_healthy`, keep the agent from ever starting.
     *
     *   starting  never launched, or launching right now      → healthy
     *   up        a live handle is held                       → healthy
     *   down      a launch was attempted and failed           → NOT healthy
     *
     * `down` is the only state that means something is wrong, and it is the one
     * the old unconditional `{ok:true}` could never report — which is why a
     * wedged bridge used to sit there indefinitely with Docker seeing nothing.
     */
    health() {
      const state = handle ? "up" : failures > 0 && !launching ? "down" : "starting";
      return {
        ok: state !== "down",
        state,
        launches,
        failures,
        upSince,
        lastError,
        lastFailureAt,
      };
    },
  };
}
