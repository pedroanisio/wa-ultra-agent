/**
 * One browser, one keyboard: operations must not interleave.
 *
 * Two concurrent sends would each click a composer and then type into whichever
 * conversation the other one opened last. Serialising every operation is what
 * makes the recipient check in `commitSend` meaningful.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 * It used to live in server.js, which was correct while every path to the
 * browser was an HTTP request. The watcher broke that assumption: it is woken by
 * a DOM mutation, not by a caller, so a mutex owned by the HTTP layer would let
 * a snapshot read land in the middle of an `openChat` — reading a half-filtered
 * pane, or competing for the keyboard with a send.
 *
 * The lock belongs to the browser, not to the transport. Everything that touches
 * the page goes through here, whatever woke it.
 */

let chain = Promise.resolve();
let queued = 0;

/** Queue `fn` behind everything already waiting for the browser. */
export function serial(fn) {
  queued++;
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {
      queued--;
    },
    () => {
      queued--;
    },
  );
  return run;
}

/** Whether anything holds or is waiting for the browser. */
export const isBusy = () => queued > 0;

/**
 * Run `fn` only if the browser is idle right now; otherwise skip it entirely.
 *
 * For work worth doing when convenient and worthless when queued. The watcher's
 * snapshot is exactly that: if an operation is in flight then the pane is
 * mid-change, so a reading taken behind it would be discarded anyway — and the
 * mutation that triggered this is still visible in the next snapshot. Queueing
 * would only build a backlog of stale reads behind a slow send.
 *
 * Resolves `{ skipped: true }` rather than throwing, because "not now" is the
 * expected outcome during any burst of activity, not a failure.
 */
export function trySerial(fn) {
  if (isBusy()) return Promise.resolve({ skipped: true });
  return serial(fn).then((value) => ({ skipped: false, value }));
}
