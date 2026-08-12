/**
 * The view models behind the five screens.
 *
 * Pure functions over data the bridge already returns, so every rule the page
 * enforces — what appears in the queue, what order it appears in, what a send
 * will close, whether a preference has actually taken effect — is testable
 * without a browser, a network or a running stack.
 *
 * ── The rule that shapes all of it ──────────────────────────────────────────
 * The unit of this UI is a DECISION, not a metric. A row exists here only if
 * there is something to do about it; a number with no action attached belongs
 * in the status line, not on the page. That is why a quiet day produces an
 * empty queue rather than four zeroes — an assistant that always has something
 * to show turns every friendship into a backlog.
 */

import type { AttentionDigest, ExtractionRow, ProposalRow } from "./bridge.ts";
import type { SettingSpec } from "./ui-settings.ts";
import { maskSecret } from "./ui-settings.ts";

/* ------------------------------------------------------------------ *
 * 1. The queue
 * ------------------------------------------------------------------ */

export type QueueKind = "proposal" | "overdue" | "dueSoon" | "waitingOn" | "unanswered";

export interface QueueItem {
  readonly kind: QueueKind;
  /** `proposal:12` or `extraction:441` — what an action posts back. */
  readonly ref: string;
  /** The conversation this belongs to, as the archive keys it. */
  readonly chat: string;
  /** One line: what it is. */
  readonly headline: string;
  /** One line: why it is here. Never a restatement of the headline. */
  readonly because: string;
  /** ISO instant this is measured against, when there is one. */
  readonly at?: string;
  /** A proposal's draft, when it has one. */
  readonly draft?: string;
  /** True when the draft commits the user and is theirs to word. */
  readonly yoursToWord: boolean;
  /** Above one means this has been suggested before and not acted on. */
  readonly timesProposed?: number;
}

/**
 * Which of the five kinds gets read first.
 *
 * A proposal outranks an obligation because it is the only row that arrives
 * with a move already worked out; the rest are things the operator still has to
 * decide what to do about. Within a kind, the oldest thing waits longest and so
 * goes first — the opposite of a notification feed, deliberately.
 */
const KIND_RANK: Record<QueueKind, number> = {
  proposal: 0,
  overdue: 1,
  unanswered: 2,
  waitingOn: 3,
  dueSoon: 4,
};

export const KIND_LABELS: Record<QueueKind, string> = {
  proposal: "proposal",
  overdue: "overdue",
  dueSoon: "due soon",
  waitingOn: "waiting on",
  unanswered: "unanswered",
};

function extractionItem(row: ExtractionRow, kind: QueueKind, because: string): QueueItem {
  return {
    kind,
    ref: `extraction:${row.id}`,
    chat: row.source_chat,
    headline: row.statement,
    because,
    at: row.due_at ?? row.source_sent_at,
    yoursToWord: false,
  };
}

/**
 * Everything waiting, ranked, with the reason it is waiting attached.
 *
 * Deliberately NOT deduplicated across kinds by chat: a person can owe you one
 * thing while you owe them another, and collapsing those into one row per
 * person produces a backlog that reads as failure while burying whichever half
 * is actually somebody else's move. The two directions stay separate here for
 * the same reason they stay separate in the digest.
 */
export function buildQueue(
  attention: AttentionDigest | null,
  proposals: readonly ProposalRow[],
): QueueItem[] {
  const items: QueueItem[] = [];

  for (const proposal of proposals) {
    if (proposal.status !== "open") continue;
    items.push({
      kind: "proposal",
      ref: `proposal:${proposal.id}`,
      chat: proposal.chat,
      headline: proposal.headline,
      because: proposal.rationale,
      at: proposal.last_proposed_at,
      draft: proposal.draft,
      yoursToWord: proposal.needs_user_wording === 1,
      timesProposed: proposal.times_proposed,
    });
  }

  if (attention) {
    for (const row of attention.overdue) {
      items.push(extractionItem(row, "overdue", "You said you would, and the date has passed."));
    }
    for (const row of attention.unanswered) {
      items.push(extractionItem(row, "unanswered", "Asked of you, and never answered."));
    }
    for (const row of attention.waitingOn) {
      items.push(extractionItem(row, "waitingOn", "Their move — this is what they owe you."));
    }
    for (const row of attention.dueSoon) {
      items.push(extractionItem(row, "dueSoon", "Yours, and the date is close."));
    }
  }

  return items.sort((a, b) => {
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    // Oldest first: the thing that has waited longest is the thing to do.
    return (a.at ?? "").localeCompare(b.at ?? "");
  });
}

/* ------------------------------------------------------------------ *
 * 2. Setup
 * ------------------------------------------------------------------ */

export type GateState = "done" | "current" | "todo" | "blocked";

export interface Gate {
  readonly n: number;
  readonly title: string;
  readonly state: GateState;
  /** What is true now, or what to do about it. Always populated. */
  readonly detail: string;
}

export interface SetupFacts {
  /** From the process, not the file: what the agent is actually running with. */
  readonly env: Record<string, string | undefined>;
  readonly modelId: string;
  readonly modelProvider: string;
  readonly modelWindow: number;
  /** `null` when the bridge could not be reached at all. */
  readonly bridgeReachable: boolean;
  /** The transport's own report, or null when it could not be asked. */
  readonly transport: {
    paired?: boolean;
    connected?: boolean;
    queued?: number;
    dropped?: number;
  } | null;
  /** Messages held by the archive. Zero is the pre-first-drain state. */
  readonly archivedMessages: number;
  /** Chats whose key is provisional, which is what "names arrived late" looks like. */
  readonly provisionalChats: number;
}

/**
 * The eight gates, in the order they can actually be satisfied.
 *
 * Ordered rather than a checklist because they genuinely depend on each other:
 * there is no point reporting that no message has arrived when the account is
 * not linked, and a scan is wasted if the transport is restarted during login.
 * The first unsatisfied gate is `current`; everything after it is `todo`, even
 * when it happens to be satisfiable — showing four simultaneous "do this now"
 * rows is how an operator ends up doing the one that wastes the pairing.
 */
export function setupGates(facts: SetupFacts): Gate[] {
  const env = facts.env;
  const has = (key: string) => Boolean(env[key]?.trim());

  const raw: Array<{ title: string; ok: boolean; detail: string }> = [
    {
      title: "Model",
      ok: has("OPENAI_API_KEY") || has("ANTHROPIC_API_KEY"),
      detail: has("OPENAI_API_KEY") || has("ANTHROPIC_API_KEY")
        ? `${facts.modelId} · ${facts.modelProvider} · ${facts.modelWindow.toLocaleString()} token window`
        : "No provider key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env, by hand — a key that authenticates the agent is not editable from this page.",
    },
    {
      title: "Bridge",
      ok: facts.bridgeReachable,
      detail: facts.bridgeReachable
        ? "Answering, and holding the archive."
        : "Not answering. Nothing on this page can load until it does.",
    },
    {
      title: "Transport",
      ok: has("WA_TRANSPORT_URL"),
      detail: has("WA_TRANSPORT_URL")
        ? "Configured, with its own bearer token — a second secret, so rotating one cannot silently unauthenticate the other."
        : "WA_TRANSPORT_URL is unset, so the bridge has no way to receive anything and /transport/* answers 503.",
    },
    {
      title: "Stack",
      ok: facts.transport !== null,
      detail:
        facts.transport === null
          ? "The bridge cannot reach the transport. Bring it up before pairing."
          : "Bridge and transport are both answering.",
    },
    {
      title: "Link the account",
      ok: Boolean(facts.transport?.paired),
      detail: facts.transport?.paired
        ? "Paired. This is one of WhatsApp's four linked-device slots."
        : "Scan the code below, or pair by phone number. Do not restart the transport while the phone still says “Logging in” — pairing completes only after the session survives its first login, and tearing it down there wastes the scan.",
    },
    {
      title: "First drain",
      ok: facts.archivedMessages > 0,
      detail:
        facts.archivedMessages > 0
          ? `${facts.archivedMessages.toLocaleString()} messages held.`
          : "Nothing has arrived yet. The bridge drains the transport's outbox on a timer; history sync takes a few minutes.",
    },
    {
      title: "Names",
      ok: facts.archivedMessages > 0 && facts.provisionalChats === 0,
      detail:
        facts.provisionalChats > 0
          ? `${facts.provisionalChats} chats still carry a provisional key. Restart the transport ONCE history sync has settled: a contact cache filled seconds after pairing is filled empty, and those contacts never join their durable key.`
          : "Every chat carries a durable key.",
    },
    {
      title: "Sending",
      // Off is a satisfied gate, not an unfinished one. Read-only is the right
      // way to start, and a checklist that nags towards enabling send would be
      // pushing the operator the wrong way.
      ok: true,
      detail:
        env.WA_ALLOW_SEND?.trim().toLowerCase() === "true"
          ? `On. The allowlist is the boundary: ${
              env.WA_SEND_ALLOWLIST?.trim()
                ? env.WA_SEND_ALLOWLIST
                : "empty, which permits nobody"
            }.`
          : "Off, which is the right way to start. Turn it on in Preferences once you have read a week of archive.",
    },
  ];

  const firstUnsatisfied = raw.findIndex((gate) => !gate.ok);

  return raw.map((gate, index) => ({
    n: index + 1,
    title: gate.title,
    detail: gate.detail,
    state: gate.ok
      ? ("done" as const)
      : index === firstUnsatisfied
        ? ("current" as const)
        : ("todo" as const),
  }));
}

/* ------------------------------------------------------------------ *
 * 3. Preferences
 * ------------------------------------------------------------------ */

export interface PreferenceRow {
  readonly key: string;
  readonly label: string;
  readonly kind: SettingSpec["kind"];
  readonly section: string;
  readonly restarts: SettingSpec["restarts"];
  readonly note: string;
  readonly choices?: readonly string[];
  readonly whenEmpty?: string;
  /** What the running process is using. Secrets are masked. */
  readonly effective: string;
  /** What the file says the NEXT start will use. Secrets are masked. */
  readonly pending: string;
  /**
   * True when the FILE holds a value the running process is not using.
   *
   * This is the field the whole screen turns on. Writing `.env` cannot change a
   * running process's environment, so a UI that showed only the saved value
   * would report a send allowlist that is not in force, which is the most
   * dangerous possible lie for this particular page to tell.
   *
   * ── Why an empty file value is never drift ──────────────────────────────
   * Because "the file says nothing and something else supplied a value" is the
   * normal state of half these keys: compose writes `${WA_IMAGE_MODEL:-gpt-
   * image-1}`, and the code has defaults of its own. Comparing raw strings
   * reported every one of those as a pending change on a page nobody had
   * touched — which is worse than useless, because it teaches the operator to
   * ignore the one banner that matters.
   */
  readonly awaitingRestart: boolean;
  /** True when the file is silent and a default is what is actually running. */
  readonly defaulted: boolean;
  /** What runs when the file says nothing, as declared by the setting. */
  readonly defaultValue?: string;
}

export function preferenceRows(
  specs: readonly SettingSpec[],
  processEnv: Record<string, string | undefined>,
  fileEnv: Record<string, string>,
): PreferenceRow[] {
  return specs.map((spec) => {
    const raw = (processEnv[spec.key] ?? "").trim();
    const saved = (fileEnv[spec.key] ?? "").trim();
    const mask = spec.kind === "secret";
    // Drift is "the file holds something the process is not using". A file that
    // is silent cannot be waiting on a restart — there is nothing in it to
    // apply.
    const awaitingRestart = saved !== "" && saved !== raw;
    return {
      key: spec.key,
      label: spec.label,
      kind: spec.kind,
      section: spec.section,
      restarts: spec.restarts,
      note: spec.note,
      choices: spec.choices,
      whenEmpty: spec.whenEmpty,
      effective: mask ? maskSecret(raw) : raw,
      pending: mask ? maskSecret(saved) : saved,
      awaitingRestart,
      defaulted: saved === "" && raw !== "",
      defaultValue: spec.defaultValue,
    };
  });
}

/** Which services need restarting for what is currently saved to take effect. */
export function pendingRestarts(rows: readonly PreferenceRow[]): SettingSpec["restarts"][] {
  const scopes = new Set<SettingSpec["restarts"]>();
  for (const row of rows) if (row.awaitingRestart && row.restarts !== "none") scopes.add(row.restarts);
  return [...scopes].sort();
}

/* ------------------------------------------------------------------ *
 * 4. Edit & send
 * ------------------------------------------------------------------ */

export interface SendConsequence {
  readonly text: string;
  /** True for the ones that cannot be undone. */
  readonly irreversible: boolean;
}

/**
 * Everything a send does, not just the part the operator can see.
 *
 * A send from this screen also closes an obligation and resolves a proposal.
 * Those are invisible from the compose box, and an interface that shows only
 * the message is hiding two thirds of the action it is about to take.
 */
export function sendConsequences(params: {
  recipient: string;
  exactMatch: boolean;
  closesObligation?: string;
  resolvesProposal?: number;
  quoted?: boolean;
}): SendConsequence[] {
  const out: SendConsequence[] = [
    {
      text: `Arrives on ${params.recipient}'s phone immediately, from your number, with your name on it.`,
      irreversible: true,
    },
  ];
  if (!params.exactMatch) {
    out.push({
      text: `“${params.recipient}” is a fuzzy match on the name you gave. Check it is the person you mean.`,
      irreversible: true,
    });
  }
  if (params.quoted) {
    out.push({ text: "Sent as a reply to the quoted message.", irreversible: false });
  }
  if (params.closesObligation) {
    out.push({ text: `Closes: ${params.closesObligation}`, irreversible: false });
  }
  if (params.resolvesProposal !== undefined) {
    out.push({
      text: `Resolves proposal #${params.resolvesProposal} as accepted, so it stops being suggested.`,
      irreversible: false,
    });
  }
  out.push({
    text: "Nothing is written to the archive until it comes back through the drain.",
    irreversible: false,
  });
  return out;
}

/**
 * Whether this draft is the operator's to word.
 *
 * The flag only ever tightens: the model sets it when it drafts, and this check
 * raises it again regardless — in Portuguese and English, because the account
 * this was built against writes both. A draft that names a price, fixes a time,
 * apologises or promises is a commitment, and a commitment made in somebody's
 * name should be typed by them.
 */
const COMMITMENT = new RegExp(
  [
    // money
    "R\\$\\s*\\d", "\\$\\s*\\d", "\\d+\\s*(reais|euros|dollars|libras)",
    // fixing a time
    "\\b(amanh[ãa]|hoje|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)\\b",
    "\\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b",
    "\\b\\d{1,2}[:h]\\d{2}\\b",
    // apologising or promising
    "\\b(desculpa|desculpe|perd[ãa]o|prometo|garanto|combinado)\\b",
    "\\b(sorry|apologies|i promise|i guarantee|i'll definitely)\\b",
  ].join("|"),
  "i",
);

export function needsUserWording(draft: string, modelFlag: boolean): boolean {
  return modelFlag || COMMITMENT.test(draft);
}
