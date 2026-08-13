/**
 * Load once, hand over in controlled pieces.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * `whatsapp_search_archive` had no ceiling of any kind. A broad query over an
 * archive of somebody's whole correspondence returns as much as the bridge will
 * give it, and every byte of that lands in the context window in a single step.
 * That is the likeliest single source of the 770K-token step that carried a
 * prompt to 1,570,042 tokens against a 1,000,000 ceiling.
 *
 * ── Why a handle, and not simply a smaller limit ────────────────────────────
 *
 * Because a shortened result set that does not say it was shortened is a worse
 * bug than the one it fixes. The search tool's own description forbids exactly
 * this: "never claim someone did not say something based on an empty result". A
 * model shown ten of ninety matches, with nothing to indicate the other eighty,
 * will summarise ten and report it as the answer.
 *
 * So a truncated set reports three things — what is shown, how much was held
 * back, and a handle that reads the rest. The model can then decide to page,
 * to narrow the query, or to stop; what it cannot do is mistake a page for the
 * whole.
 *
 * This is the load-and-search shape (LlamaIndex's `LoadAndSearchToolSpec`
 * reaches the same place), and the just-in-time retrieval Anthropic's context
 * engineering guidance describes: hold a lightweight identifier, fetch on
 * demand.
 *
 * ── Why in-process ──────────────────────────────────────────────────────────
 *
 * The rows are already fetched by the time they get here, so a store keeps the
 * answer STABLE: re-running the query to fetch page two could return different
 * rows, because the archive is still being written to. Paging a snapshot is the
 * only way "page 2" means what the reader thinks it means.
 */

import { budgetFor } from "./tool-output.ts";

/** How many sets may be held at once, oldest evicted first. */
export const MAX_OPEN_SETS = 8;

/**
 * How long a set stays readable.
 *
 * Long enough for a model to page through it in the same turn or the next,
 * short enough that somebody's correspondence is not sitting in memory for the
 * life of the process.
 */
export const RESULT_SET_TTL_MS = 30 * 60 * 1000;

/**
 * The share of one tool result's budget a search head may claim.
 *
 * A search is rarely the only thing in a turn — it is usually followed by
 * `whatsapp_get_context` on one of its hits — so the head deliberately takes a
 * fraction of what it could, leaving room for the reads it invites.
 */
const HEAD_SHARE = 0.5;

interface StoredSet {
  readonly rows: readonly unknown[];
  readonly head: number;
  readonly openedAt: number;
}

const sets = new Map<string, StoredSet>();
let counter = 0;

/**
 * How many rows may be shown, given how full this conversation already is.
 *
 * This is the link back to `context-budget.ts`: a search result is a tool
 * result like any other, so the same shrinking budget governs it. Early in a
 * conversation a broad search shows a lot; late in one it shows a little and
 * says so.
 */
export function headSize({
  sessionId,
  rowBytes,
}: {
  sessionId?: string;
  rowBytes: number;
}): number {
  const budget = budgetFor(sessionId) * HEAD_SHARE;
  const rows = Math.floor(budget / Math.max(1, rowBytes));

  // Never zero. A head of no rows reads as "no matches", which is the single
  // claim this tool must never make when there were matches.
  return Math.max(1, rows);
}

/** What opening a set gives the caller. */
export interface OpenedSet<Row> {
  readonly shown: readonly Row[];
  readonly retrieved: number;
  readonly remaining: number;
  readonly truncated: boolean;
  /** Absent when nothing was held back — there is nothing to page. */
  readonly id?: string;
}

/**
 * Show the first `head` rows; keep the rest readable behind a handle.
 *
 * A set that fits entirely gets NO handle, deliberately: an id that addresses
 * an empty remainder is an invitation to make a pointless call.
 */
export function openResultSet<Row>(
  rows: readonly Row[],
  { head }: { head: number },
): OpenedSet<Row> {
  const size = Math.max(1, Math.floor(head));
  const shown = rows.slice(0, size);
  const remaining = Math.max(0, rows.length - shown.length);

  if (remaining === 0) {
    return { shown, retrieved: rows.length, remaining: 0, truncated: false };
  }

  evictExpired();
  while (sets.size >= MAX_OPEN_SETS) {
    // Oldest first. Map preserves insertion order, so the first key is the
    // least recently opened.
    const oldest = sets.keys().next().value;
    if (oldest === undefined) break;
    sets.delete(oldest);
  }

  counter += 1;
  const id = `rs_${counter.toString(36)}${Math.floor(performance.now()).toString(36)}`;
  sets.set(id, { rows, head: shown.length, openedAt: performance.now() });

  return { shown, retrieved: rows.length, remaining, truncated: true, id };
}

/** One page of a held set, or a refusal that says what to do instead. */
export type Page<Row> =
  | {
      readonly ok: true;
      readonly rows: readonly Row[];
      readonly nextAfter: number;
      readonly remaining: number;
      readonly retrieved: number;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Read on from where the head stopped.
 *
 * `after` is an absolute index into the stored rows, not a page number, so a
 * caller that loses count cannot silently skip or repeat a page.
 */
export function pageResultSet<Row>(
  id: string,
  { after, limit = 20 }: { after?: number; limit?: number },
): Page<Row> {
  evictExpired();
  const set = sets.get(id);

  if (!set) {
    return {
      ok: false,
      error:
        `No open result set ${id}. It has expired or been replaced — run the search again to get a ` +
        "fresh one. Do not report the rows you already read as the complete answer.",
    };
  }

  const from = after === undefined ? set.head : Math.max(set.head, Math.floor(after));
  const size = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = set.rows.slice(from, from + size) as readonly Row[];
  const nextAfter = from + rows.length;

  return {
    ok: true,
    rows,
    nextAfter,
    remaining: Math.max(0, set.rows.length - nextAfter),
    retrieved: set.rows.length,
  };
}

/** Drop one set — the caller has read what it needed. */
export function closeResultSet(id: string): void {
  sets.delete(id);
}

/** Drop everything. */
export function resetResultSets(): void {
  sets.clear();
}

function evictExpired(): void {
  const now = performance.now();
  for (const [id, set] of sets) {
    if (now - set.openedAt > RESULT_SET_TTL_MS) sets.delete(id);
  }
}
