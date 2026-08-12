/**
 * What each screen asks for, and what each action does.
 *
 * The bridge, the environment and the file are all INJECTED, so every rule here
 * — what the queue contains, what a send closes, which preference writes are
 * refused — is exercised in `test/ui-api.test.ts` without a network, a browser
 * or a running stack. The channel in `agent/channels/ui.ts` is then only
 * routing and authentication, which is the part that cannot be unit-tested
 * meaningfully anyway.
 *
 * ── The direction this preserves ────────────────────────────────────────────
 * Everything here runs INSIDE the agent and calls the bridge outwards, which is
 * the same direction every tool takes. The browser talks to the agent; the
 * agent talks to the bridge; the bridge holds the account. No new inversion,
 * and no credential moves anywhere it was not already held.
 */

import type { bridge as realBridge } from "./bridge.ts";
import { BridgeError } from "./bridge.ts";
import { MODEL } from "./model.ts";
import { envValues } from "./env-file.ts";
import { SETTINGS, SettingRefused, applySettings } from "./ui-settings.ts";
import { toolStatus, toolTally, GROUP_LABELS, type ToolGroup } from "./ui-tools.ts";
import {
  buildQueue,
  needsUserWording,
  pendingRestarts,
  preferenceRows,
  sendConsequences,
  setupGates,
  type QueueItem,
} from "./ui-model.ts";

export type Bridge = typeof realBridge;

export interface UiDeps {
  readonly bridge: Pick<
    Bridge,
    | "status"
    | "attention"
    | "listProposals"
    | "resolveProposal"
    | "resolveExtraction"
    | "readChat"
    | "twin"
    | "sendMessage"
    | "writeSelf"
    | "archiveStats"
    | "transportStatus"
    | "listChats"
  >;
  /** The process's own environment: what the agent is RUNNING with. */
  readonly env: Record<string, string | undefined>;
  /** The `.env` file's text, or null when there is no file to read. */
  readonly readEnvFile: () => Promise<string | null>;
  readonly writeEnvFile: (text: string) => Promise<void>;
  /** The turn log, for the one status line the queue carries. */
  readonly turns: () => { running: unknown[] };
}

/**
 * An error with an HTTP status already decided.
 *
 * The field is assigned in the body rather than declared as a parameter
 * property: Node runs this TypeScript by STRIPPING types, and a parameter
 * property is syntax that would have to be compiled away. `node --test` refuses
 * the file outright, which is a build failure rather than a type error.
 */
export class UiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Anything the bridge refused, reported with its own status rather than a 500. */
function rethrow(error: unknown): never {
  if (error instanceof BridgeError) throw new UiError(error.message, error.status || 502);
  throw error;
}

/**
 * One call, settled — including one that throws before it returns a promise.
 *
 * `Promise.allSettled` only catches REJECTIONS. A client that throws
 * synchronously (a bad URL, a missing token checked up front) throws out of the
 * array literal itself, before allSettled ever sees it, and takes down a page
 * that was meant to degrade one panel. Deferring the invocation makes both
 * failure shapes arrive the same way.
 */
function settle<T>(call: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  return Promise.resolve()
    .then(call)
    .then((value) => ({ status: "fulfilled", value }) as const)
    .catch((reason: unknown) => ({ status: "rejected", reason }) as const);
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

export async function queueScreen(deps: UiDeps): Promise<{
  items: QueueItem[];
  status: {
    sendOn: boolean;
    allowlist: string[];
    archivedMessages: number;
    transportConnected: boolean;
    runningTurns: number;
  };
}> {
  // Settled rather than awaited together: a queue that cannot render because
  // one of four reads failed is a worse outcome than a queue missing a section.
  const [attention, proposals, stats, transport] = await Promise.all([
    settle(() => deps.bridge.attention({})),
    settle(() => deps.bridge.listProposals({ status: "open" })),
    settle(() => deps.bridge.archiveStats()),
    settle(() => deps.bridge.transportStatus()),
  ]);

  const items = buildQueue(
    attention.status === "fulfilled" ? attention.value : null,
    proposals.status === "fulfilled" ? proposals.value.proposals : [],
  );

  return {
    items,
    status: {
      sendOn: deps.env.WA_ALLOW_SEND?.trim().toLowerCase() === "true",
      allowlist: splitList(deps.env.WA_SEND_ALLOWLIST),
      archivedMessages: stats.status === "fulfilled" ? stats.value.messages : 0,
      transportConnected:
        transport.status === "fulfilled" ? Boolean(transport.value.session?.connected) : false,
      runningTurns: deps.turns().running.length,
    },
  };
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * One conversation, with both halves of the twin kept apart.
 *
 * The agent is required to say which half it is speaking from, and this is the
 * screen where that rule stops being prose: `measured` is arithmetic over rows
 * that were really read, `read` is a model's reading of the same messages, and
 * they are two fields rather than one narrative.
 */
export async function conversationScreen(
  deps: UiDeps,
  chat: string,
  limit = 25,
): Promise<{
  chat: string;
  messages: unknown[];
  measured: unknown;
  read: { arcs: unknown[]; goals: unknown[]; contexts: unknown[] } | null;
  staleness: unknown;
  proposals: unknown[];
}> {
  if (!chat.trim()) throw new UiError("a chat is required", 400);

  const [messages, twin, proposals] = await Promise.all([
    settle(() => deps.bridge.readChat(chat, limit)),
    settle(() => deps.bridge.twin({ chat })),
    settle(() => deps.bridge.listProposals({ chat, status: "open" })),
  ]);

  if (messages.status === "rejected") rethrow(messages.reason);

  const twinValue = twin.status === "fulfilled" ? twin.value : null;

  return {
    chat,
    messages: messages.value.messages,
    measured: twinValue?.metrics ?? null,
    read: twinValue
      ? {
          arcs: twinValue.arcs ?? [],
          // Flattened from the arcs, where they are stored: a goal belongs to a
          // thread, and the arc it came from is carried along so the page can
          // say which conversation a want belongs to rather than listing wants
          // with nothing to attach them to.
          goals: (twinValue.arcs ?? []).flatMap((arc) =>
            arc.goals.map((goal) => ({ ...goal, arc: arc.title })),
          ),
          contexts: twinValue.contexts ?? [],
        }
      : null,
    staleness: twinValue?.coverage ?? null,
    proposals: proposals.status === "fulfilled" ? proposals.value.proposals : [],
  };
}

/* ------------------------------------------------------------------ *
 * Acting on a queue row
 * ------------------------------------------------------------------ */

export type QueueAction = "accept" | "dismiss" | "done" | "dropped";

/**
 * Resolve a row without sending anything.
 *
 * `accept` here means "this proposal was acted on" — it does NOT send. The only
 * path that puts words on somebody's phone is `sendFromUi` below, and keeping
 * them separate means a mis-click on a list cannot deliver a message.
 */
export async function resolveQueueItem(
  deps: UiDeps,
  ref: string,
  action: QueueAction,
): Promise<{ ref: string; status: string }> {
  const [kind, rawId] = ref.split(":");
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new UiError(`unrecognised ref: ${ref}`, 400);

  try {
    if (kind === "proposal") {
      const status = action === "accept" ? "accepted" : "dismissed";
      await deps.bridge.resolveProposal({ id, status });
      return { ref, status };
    }
    if (kind === "extraction") {
      const status = action === "dropped" ? "dropped" : "done";
      await deps.bridge.resolveExtraction({ id, status });
      return { ref, status };
    }
  } catch (error) {
    rethrow(error);
  }
  throw new UiError(`unrecognised ref: ${ref}`, 400);
}

/* ------------------------------------------------------------------ *
 * Edit & send
 * ------------------------------------------------------------------ */

export interface SendRequest {
  readonly to: string;
  readonly message: string;
  readonly quoted?: { messageId: string; sender?: string };
  /** The queue row this answers, resolved only after the send lands. */
  readonly ref?: string;
  /** Send it to the operator's own chat instead of the recipient. */
  readonly toSelf?: boolean;
}

/**
 * Put words on somebody's phone, then close what they answered.
 *
 * ── Order matters ───────────────────────────────────────────────────────────
 * The send happens FIRST and the row is resolved only if it succeeded. The
 * reverse order loses the obligation when the send fails: the queue would go
 * quiet about something that was never delivered, which is the one failure this
 * whole screen exists to prevent.
 */
export async function sendFromUi(
  deps: UiDeps,
  request: SendRequest,
): Promise<{
  sent: boolean;
  resolvedName: string | null;
  exactMatch: boolean;
  consequences: ReturnType<typeof sendConsequences>;
  resolved?: string;
}> {
  const message = request.message?.trim();
  if (!message) throw new UiError("a message is required", 400);

  if (request.toSelf) {
    try {
      await deps.bridge.writeSelf([message]);
    } catch (error) {
      rethrow(error);
    }
    return {
      sent: true,
      resolvedName: "your own chat",
      exactMatch: true,
      consequences: sendConsequences({ recipient: "you", exactMatch: true }),
    };
  }

  const to = request.to?.trim();
  if (!to) throw new UiError("a recipient is required", 400);

  let result: Awaited<ReturnType<Bridge["sendMessage"]>>;
  try {
    result = await deps.bridge.sendMessage(to, message, { quoted: request.quoted });
  } catch (error) {
    rethrow(error);
  }

  const resolvedName = result.resolvedName ?? null;
  const exactMatch = resolvedName === null || resolvedName === to;

  let resolved: string | undefined;
  if (request.ref) {
    // A failure here is reported, never thrown: the message is already on their
    // phone, and answering "that failed" to a delivered send is a worse lie
    // than leaving a row open.
    try {
      await resolveQueueItem(deps, request.ref, "accept");
      resolved = request.ref;
    } catch {
      resolved = undefined;
    }
  }

  return {
    sent: true,
    resolvedName,
    exactMatch,
    resolved,
    consequences: sendConsequences({
      recipient: resolvedName ?? to,
      exactMatch,
      quoted: Boolean(request.quoted),
      resolvesProposal: request.ref?.startsWith("proposal:")
        ? Number(request.ref.split(":")[1])
        : undefined,
    }),
  };
}

/** Whether this draft is the operator's to word — asked before they send it. */
export function draftReview(draft: string, modelFlag = false): {
  yoursToWord: boolean;
  chars: number;
} {
  return { yoursToWord: needsUserWording(draft, modelFlag), chars: draft.length };
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

export async function setupScreen(deps: UiDeps) {
  const [status, transport, stats] = await Promise.all([
    settle(() => deps.bridge.status()),
    settle(() => deps.bridge.transportStatus()),
    settle(() => deps.bridge.archiveStats()),
  ]);

  const transportValue = transport.status === "fulfilled" ? transport.value : null;

  return {
    gates: setupGates({
      env: deps.env,
      modelId: MODEL.id,
      modelProvider: MODEL.provider,
      modelWindow: MODEL.contextWindowTokens,
      bridgeReachable: status.status === "fulfilled",
      transport: transportValue
        ? {
            paired: transportValue.session?.paired,
            connected: transportValue.session?.connected,
          }
        : null,
      archivedMessages: stats.status === "fulfilled" ? stats.value.messages : 0,
      provisionalChats: transportValue?.archive?.provisionalChats ?? 0,
    }),
    paired: Boolean(transportValue?.session?.paired),
  };
}

/* ------------------------------------------------------------------ *
 * Preferences
 * ------------------------------------------------------------------ */

export async function preferencesScreen(deps: UiDeps) {
  const text = await deps.readEnvFile();
  const rows = preferenceRows(SETTINGS, deps.env, text === null ? {} : envValues(text));
  return {
    // A UI that offers to save into a file it cannot see would report success
    // and change nothing.
    writable: text !== null,
    rows,
    restarts: pendingRestarts(rows),
    sections: [...new Set(SETTINGS.map((spec) => spec.section))],
  };
}

export async function savePreferences(
  deps: UiDeps,
  updates: Record<string, string>,
): Promise<{ saved: string[]; restarts: string[] }> {
  const text = await deps.readEnvFile();
  if (text === null) {
    throw new UiError(
      "There is no .env file mounted here, so nothing can be saved. Mount it read-write " +
        "into the agent (see docker-compose.yml) or edit it on the host.",
      409,
    );
  }

  let next: string;
  try {
    next = applySettings(text, updates);
  } catch (error) {
    if (error instanceof SettingRefused) throw new UiError(error.message, 400);
    throw error;
  }

  await deps.writeEnvFile(next);

  const saved = Object.keys(updates);
  const rows = preferenceRows(
    SETTINGS.filter((spec) => saved.includes(spec.key)),
    deps.env,
    envValues(next),
  );
  return { saved, restarts: pendingRestarts(rows) };
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

export function toolsScreen(deps: UiDeps) {
  const statuses = toolStatus(deps.env);
  const groups = (Object.keys(GROUP_LABELS) as ToolGroup[]).map((group) => ({
    group,
    label: GROUP_LABELS[group],
    tools: statuses.filter((status) => status.group === group),
  }));
  return { tally: toolTally(statuses), groups };
}
