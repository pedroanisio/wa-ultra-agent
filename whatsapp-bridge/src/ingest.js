/**
 * Scrollback, written down.
 *
 * Two modes, and the distinction is what keeps this affordable:
 *
 *   top-up   — the routine case. Stops the moment it recognises a message it
 *              already has, so "what arrived since yesterday" costs a scroll or
 *              two rather than a walk through the whole chat.
 *
 *   backfill — deliberately does not stop at known messages, because the point
 *              is to get past them into history it has never seen. Bounded by
 *              `maxScrolls` and by the interaction budget instead, and designed
 *              to be run repeatedly rather than to finish in one call.
 *
 * Because messages are content-addressed (history.js), running either mode
 * again is free: a window already stored is counted as duplicates and written
 * nowhere.
 */
export async function ingestWith({ scrollback, store }, { chat, mode = "top-up", maxScrolls = 5 } = {}) {
  const before = store.chatBounds(chat);

  // A backfill must be able to walk *past* what is already stored, so it gets
  // no stopping point. A top-up stops at the newest message we hold.
  const stopAtKey = mode === "backfill" ? undefined : before.newestKey;

  const walk = await scrollback({ chat, maxScrolls, stopAtKey });
  const written = store.upsertMessages(chat, walk.messages);

  return {
    chat,
    mode,
    scanned: walk.messages.length,
    inserted: written.inserted,
    duplicates: written.duplicates,
    scrolls: walk.scrolls,
    atTop: walk.atTop,
    reachedKnown: walk.reachedKnown,
    budgetExhausted: walk.budgetExhausted,
    budgetRemaining: walk.budgetRemaining,
    hasMore: walk.hasMore,
    bounds: store.chatBounds(chat),
  };
}
