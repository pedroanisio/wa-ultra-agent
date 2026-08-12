/**
 * Self-notes go out one at a time, so a multi-line note arrives as one note.
 *
 * `/send/self` and `/send/self/media` take a LIST of messages and send them in
 * order. Two of those running concurrently would interleave at the recipient —
 * the user's own chat, read on a phone, where a paragraph of one note landing
 * between two lines of another is not a race condition anyone can diagnose. It
 * reads as the agent being confused. So both paths queue here, and the queue is
 * the whole mechanism: there is no lock to take and nothing to time out.
 *
 * ── What this used to be ────────────────────────────────────────────────────
 * A mutex over a browser. Two concurrent sends would each click a composer and
 * type into whichever conversation the other one opened last, and a watcher woken
 * by a DOM mutation could read a half-filtered pane mid-send — so every path to
 * the page went through here, whatever woke it. The header said so, and cited a
 * `commitSend` that had already been deleted, which left the one artefact
 * explaining why sends are serialised explaining it with a mechanism that no
 * longer existed.
 *
 * The reason narrowed rather than vanished, and it is worth keeping the
 * distinction: this no longer protects a shared resource — the transport handles
 * concurrent sends perfectly well — it protects an ORDERING the reader can see.
 * `trySerial`/`isBusy` went with the watcher; they answered "is the browser
 * busy", and nothing is.
 */

let chain = Promise.resolve();
let queued = 0;

/** Queue `fn` behind every send already waiting. Rejections do not break the chain. */
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

/** How many sends are queued or in flight. Zero means the chain is idle. */
export const pending = () => queued;
