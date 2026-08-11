import { z } from "zod";

import type { InteractionTwin } from "./bridge.ts";
import { CONFIDENCE_FLOOR } from "./extraction.ts";

/**
 * ⚠ ARCHITECTURAL CONTRACT (PALS's LAW) — LLM OUTPUT IS UNVERIFIED BY DEFAULT
 *
 * LLMs statistically produce errors: omissions, hallucinations,
 * partial completions, schema violations, and silent failures.
 * These are properties of the model class, not exceptional conditions.
 *
 * Any caller of this function that skips output validation is
 * introducing an architectural omission — not a code bug downstream.
 *
 * Verification is mandatory. Treat all LLM output as untrusted input.
 *
 * ── What this file is ───────────────────────────────────────────────────────
 * The gate between what a model says about a conversation and what the archive
 * will accept. It is the same job `extraction.ts` does for obligations, over a
 * larger surface, and it exists because the twin is the most inviting place in
 * this system to invent things: a model asked for "the arcs in this
 * conversation" will always find some, and a model asked for "the next best
 * move" will always have one.
 *
 * Four checks, in order of how much damage they prevent.
 *
 * 1. **Citation.** Every arc, goal, context observation and proposed move names
 *    the message it was read from. A key that was not in the input is dropped
 *    here, because the store rejects an entire pass for one bad citation and a
 *    good pass should not be lost to one invented id.
 *
 * 2. **Vocabulary.** Statuses, holders, dimensions and kinds are closed sets. A
 *    model that returns `"closed"` instead of `"resolved"` is not making a small
 *    mistake — it is writing a row that no query will ever find again.
 *
 * 3. **Identity.** An arc continues when its title matches one already stored,
 *    compared with punctuation, case, accents and articles removed. Without this
 *    every pass forks every thread and a month of modelling produces nine copies
 *    of "the renovation".
 *
 * 4. **Restraint.** Thresholds and caps, and one gate that only ever tightens:
 *    a draft that commits the user to money, a meeting or an apology is marked
 *    as theirs to word, whatever the model said about it.
 */

/* ------------------------------------------------------------------ *
 * The vocabularies.
 *
 * These are duplicated from `whatsapp-bridge/src/store.js`, which is a separate
 * service in a separate container and cannot be imported from here. The
 * duplication is a real drift risk, so it is not left to vigilance:
 * `test/twin.test.ts` reads the bridge's source and fails when the two lists
 * disagree.
 * ------------------------------------------------------------------ */

export const ARC_STATUSES = ["open", "stalled", "resolved", "abandoned"] as const;
export const GOAL_HOLDERS = ["user", "them", "shared"] as const;
export const GOAL_STATUSES = ["open", "met", "blocked", "dropped"] as const;
export const CONTEXT_DIMENSIONS = [
  "language",
  "register",
  "relationship",
  "cadence",
  "constraint",
  "sensitivity",
  "setting",
] as const;
export const PROPOSAL_KINDS = ["reply", "follow_up", "deliver", "ask_user", "wait"] as const;

export type ArcStatus = (typeof ARC_STATUSES)[number];
export type GoalHolder = (typeof GOAL_HOLDERS)[number];
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type ContextDimension = (typeof CONTEXT_DIMENSIONS)[number];
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** A conversation has a handful of live threads, not thirty. */
export const MAX_ARCS = 12;
export const MAX_GOALS_PER_ARC = 6;
export const MAX_CONTEXTS = 12;
/**
 * How many moves may be proposed at once.
 *
 * Low on purpose. A ranked list of eleven suggestions is not advice, it is a
 * second inbox — and the user has to read all of it to find out that the first
 * item was the only one worth doing.
 */
export const MAX_PROPOSALS = 5;

/**
 * The caveat that travels with a thin sample.
 *
 * One string, used by the twin tool and by the proposal prompt, because the two
 * must not disagree: a median drawn from three exchanges cannot be described as
 * a habit in one place and used as one in the other.
 */
export const HABIT_NOTE =
  "These timing figures rest on very few exchanges. Do not describe them as what these two " +
  "people usually do.";

/* ------------------------------------------------------------------ *
 * Arc identity
 * ------------------------------------------------------------------ */

/**
 * The form an arc title is compared in. Must match `normalizeArcTitle` in
 * `whatsapp-bridge/src/store.js`, which derives the arc's primary key from it.
 */
export function normalizeArcTitle(title: string): string {
  return String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(the|a|an|o|a|os|as|um|uma)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ *
 * The modelling contract
 * ------------------------------------------------------------------ */

export const modelSchema = z.object({
  arcs: z
    .array(
      z.object({
        title: z
          .string()
          .describe(
            "A short name for the thread, in the language of the conversation. To continue a " +
              "thread already listed as known, return its title exactly as given.",
          ),
        summary: z.string().optional().describe("One or two sentences on where it stands."),
        status: z.enum(ARC_STATUSES),
        firstMessageKey: z.string().describe("The `key` of the message that opened it."),
        lastMessageKey: z.string().describe("The `key` of the most recent message belonging to it."),
        confidence: z.number().min(0).max(1),
        goals: z
          .array(
            z.object({
              holder: z
                .enum(GOAL_HOLDERS)
                .describe("`user` for the account's owner, `them` for the other side, `shared` for both."),
              statement: z.string().describe("What they are trying to get, in one short sentence."),
              status: z.enum(GOAL_STATUSES),
              confidence: z.number().min(0).max(1),
              sourceMessageKey: z.string().describe("The `key` of the message that shows this."),
            }),
          )
          .default([])
          .describe("Both sides where both are visible. An arc with no legible goal has none."),
      }),
    )
    .describe("Empty when the conversation has no thread running through it. Small talk has none."),
  contexts: z
    .array(
      z.object({
        dimension: z.enum(CONTEXT_DIMENSIONS),
        statement: z.string().describe("One short, checkable observation."),
        confidence: z.number().min(0).max(1),
        sourceMessageKey: z.string().describe("The `key` of a message that demonstrates it."),
      }),
    )
    .describe("The standing frame: language, register, who these two are, what to avoid."),
});

export interface NormalizedGoal {
  holder: GoalHolder;
  statement: string;
  status: GoalStatus;
  confidence: number;
  sourceMessageKey: string;
}

export interface NormalizedArc {
  title: string;
  summary?: string;
  status: ArcStatus;
  firstMessageKey: string;
  lastMessageKey: string;
  confidence: number;
  goals: NormalizedGoal[];
  /** True when this pass attached to a thread that was already stored. */
  continues: boolean;
}

export interface NormalizedContext {
  dimension: ContextDimension;
  statement: string;
  confidence: number;
  sourceMessageKey: string;
}

export interface ModelDropReport {
  uncited: number;
  empty: number;
  lowConfidence: number;
  badVocabulary: number;
  duplicate: number;
  overflow: number;
  uncitedGoals: number;
}

const confidenceOf = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/**
 * Everything a modelling pass returned, reduced to what the archive will accept.
 *
 * `knownTitles` are the arc titles already stored for this conversation. A
 * returned title that matches one of them after normalisation is replaced by the
 * stored spelling, so a rewording continues the thread instead of forking it.
 */
export function normalizeModel(
  raw: unknown,
  citableKeys: Set<string>,
  knownTitles: string[] = [],
): { arcs: NormalizedArc[]; contexts: NormalizedContext[]; dropped: ModelDropReport } {
  const dropped: ModelDropReport = {
    uncited: 0,
    empty: 0,
    lowConfidence: 0,
    badVocabulary: 0,
    duplicate: 0,
    overflow: 0,
    uncitedGoals: 0,
  };

  const known = new Map(knownTitles.map((title) => [normalizeArcTitle(title), title]));
  const seenArcs = new Set<string>();
  const arcs: NormalizedArc[] = [];
  const contexts: NormalizedContext[] = [];

  const input = (raw ?? {}) as { arcs?: unknown; contexts?: unknown };

  for (const candidate of Array.isArray(input.arcs) ? input.arcs : []) {
    if (!candidate || typeof candidate !== "object") {
      dropped.empty++;
      continue;
    }
    const it = candidate as Record<string, unknown>;

    const rawTitle = String(it.title ?? "").trim();
    const identity = normalizeArcTitle(rawTitle);
    if (!identity) {
      dropped.empty++;
      continue;
    }

    if (!ARC_STATUSES.includes(it.status as ArcStatus)) {
      dropped.badVocabulary++;
      continue;
    }

    const firstMessageKey = String(it.firstMessageKey ?? "").trim();
    const lastMessageKey = String(it.lastMessageKey ?? "").trim();
    // Both, because an arc is a span. A span with one invented end is not a
    // partially good arc; it is an arc over messages that were never read.
    if (!citableKeys.has(firstMessageKey) || !citableKeys.has(lastMessageKey)) {
      dropped.uncited++;
      continue;
    }

    const confidence = confidenceOf(it.confidence);
    if (confidence < CONFIDENCE_FLOOR) {
      dropped.lowConfidence++;
      continue;
    }

    if (seenArcs.has(identity)) {
      dropped.duplicate++;
      continue;
    }
    seenArcs.add(identity);

    if (arcs.length >= MAX_ARCS) {
      dropped.overflow++;
      continue;
    }

    const goals: NormalizedGoal[] = [];
    for (const rawGoal of Array.isArray(it.goals) ? it.goals : []) {
      if (!rawGoal || typeof rawGoal !== "object") {
        dropped.empty++;
        continue;
      }
      const goal = rawGoal as Record<string, unknown>;
      const statement = String(goal.statement ?? "").trim();
      const sourceMessageKey = String(goal.sourceMessageKey ?? "").trim();

      if (!statement) {
        dropped.empty++;
        continue;
      }
      if (
        !GOAL_HOLDERS.includes(goal.holder as GoalHolder) ||
        !GOAL_STATUSES.includes((goal.status ?? "open") as GoalStatus)
      ) {
        dropped.badVocabulary++;
        continue;
      }
      // Counted separately: a bad goal citation costs one goal, while a bad arc
      // citation costs the arc and everything under it.
      if (!citableKeys.has(sourceMessageKey)) {
        dropped.uncitedGoals++;
        continue;
      }
      const goalConfidence = confidenceOf(goal.confidence);
      if (goalConfidence < CONFIDENCE_FLOOR) {
        dropped.lowConfidence++;
        continue;
      }
      if (goals.length >= MAX_GOALS_PER_ARC) {
        dropped.overflow++;
        continue;
      }

      goals.push({
        holder: goal.holder as GoalHolder,
        statement,
        status: (goal.status ?? "open") as GoalStatus,
        confidence: goalConfidence,
        sourceMessageKey,
      });
    }

    const summary = String(it.summary ?? "").trim();
    arcs.push({
      // The stored spelling wins, so the arc's key stays put.
      title: known.get(identity) ?? rawTitle,
      summary: summary || undefined,
      status: it.status as ArcStatus,
      firstMessageKey,
      lastMessageKey,
      confidence,
      goals,
      continues: known.has(identity),
    });
  }

  const seenContexts = new Set<string>();
  for (const candidate of Array.isArray(input.contexts) ? input.contexts : []) {
    if (!candidate || typeof candidate !== "object") {
      dropped.empty++;
      continue;
    }
    const it = candidate as Record<string, unknown>;

    const statement = String(it.statement ?? "").trim();
    if (!statement) {
      dropped.empty++;
      continue;
    }
    if (!CONTEXT_DIMENSIONS.includes(it.dimension as ContextDimension)) {
      dropped.badVocabulary++;
      continue;
    }
    const sourceMessageKey = String(it.sourceMessageKey ?? "").trim();
    if (!citableKeys.has(sourceMessageKey)) {
      dropped.uncited++;
      continue;
    }
    const confidence = confidenceOf(it.confidence);
    if (confidence < CONFIDENCE_FLOOR) {
      dropped.lowConfidence++;
      continue;
    }

    const identity = `${it.dimension}|${statement.toLowerCase()}`;
    if (seenContexts.has(identity)) {
      dropped.duplicate++;
      continue;
    }
    seenContexts.add(identity);

    if (contexts.length >= MAX_CONTEXTS) {
      dropped.overflow++;
      continue;
    }

    contexts.push({
      dimension: it.dimension as ContextDimension,
      statement,
      confidence,
      sourceMessageKey,
    });
  }

  return { arcs, contexts, dropped };
}

/* ------------------------------------------------------------------ *
 * Handing the twin to a model
 * ------------------------------------------------------------------ */

/**
 * Every message key the twin actually rests on.
 *
 * This is the citable set for a proposal. A move may only be argued from the
 * evidence the twin contains, and nothing else is in scope — which is what makes
 * "cite your basis" checkable rather than decorative.
 */
export function citableKeysFromTwin(twin: InteractionTwin): Set<string> {
  const keys = new Set<string>();
  for (const arc of twin.arcs ?? []) {
    keys.add(arc.first_message_key);
    keys.add(arc.last_message_key);
    for (const goal of arc.goals ?? []) keys.add(goal.source_message_key);
  }
  for (const context of twin.contexts ?? []) keys.add(context.source_message_key);
  const obligations = twin.obligations;
  for (const bucket of [obligations?.userOwesThem, obligations?.theyOweUser, obligations?.unanswered]) {
    for (const item of bucket ?? []) keys.add(item.source_message_key);
  }
  return keys;
}

/**
 * The twin as text, for a model that has to propose a move from it.
 *
 * Written so that every line the model might cite carries its key inline. The
 * staleness line and the thin-sample caveat are included deliberately: a
 * proposal made from a three-week-old picture, or one that appeals to a habit
 * measured twice, is exactly the failure this whole layer exists to avoid.
 */
export function twinBriefing(twin: InteractionTwin): string {
  const lines: string[] = [];
  const metrics = twin.metrics;
  const coverage = twin.coverage;

  lines.push(`Conversation: ${twin.chat}`);

  if (coverage) {
    lines.push(
      coverage.stale
        ? `Model freshness: OUT OF DATE — ${coverage.reason}.`
        : `Model freshness: current as of ${coverage.modelledAt}.`,
    );
  }

  if (metrics) {
    const measured = [
      metrics.silentDays !== undefined ? `${metrics.silentDays} day(s) since the last message` : null,
      metrics.ballWith === "user"
        ? "they spoke last — the next message is the user's"
        : metrics.ballWith === "them"
          ? "the user spoke last — the next message is theirs"
          : null,
      metrics.medianReplyMinutesUser !== undefined
        ? `user usually replies in ~${metrics.medianReplyMinutesUser} min (${metrics.replySampleUser} exchanges)`
        : null,
      metrics.medianReplyMinutesThem !== undefined
        ? `they usually reply in ~${metrics.medianReplyMinutesThem} min (${metrics.replySampleThem} exchanges)`
        : null,
      metrics.medianCharsUser !== undefined
        ? `the user's messages run ~${metrics.medianCharsUser} characters`
        : null,
      metrics.activeHours.length
        ? `most active around ${metrics.activeHours.map((h) => `${h.hour}:00`).join(", ")}`
        : null,
    ].filter(Boolean);

    lines.push(`Measured: ${measured.join("; ") || "not enough archived history to measure anything"}.`);
    if (metrics.habitsAreThin) lines.push(HABIT_NOTE);
  }

  if (twin.arcs?.length) {
    lines.push("\nThreads:");
    for (const arc of twin.arcs) {
      lines.push(
        `- "${arc.title}" [${arc.status}] opened at key=${arc.first_message_key}, last at ` +
          `key=${arc.last_message_key}${arc.summary ? ` — ${arc.summary}` : ""}`,
      );
      for (const goal of arc.goals ?? []) {
        lines.push(
          `    · ${goal.holder} wants: ${goal.statement} [${goal.status}] (key=${goal.source_message_key})`,
        );
      }
    }
  } else {
    lines.push("\nThreads: none modelled.");
  }

  if (twin.contexts?.length) {
    lines.push("\nHow this conversation works — a draft must obey these:");
    for (const context of twin.contexts) {
      lines.push(`- ${context.dimension}: ${context.statement} (key=${context.source_message_key})`);
    }
  }

  const obligations = twin.obligations;
  const owed = [
    ...(obligations?.theyOweUser ?? []).map((i) => `- they owe the user: ${i.statement}`),
    ...(obligations?.userOwesThem ?? []).map((i) => `- the user owes them: ${i.statement}`),
    ...(obligations?.unanswered ?? []).map((i) => `- unanswered: ${i.statement}`),
  ];
  if (owed.length) {
    lines.push("\nOutstanding:");
    const rows = [
      ...(obligations?.theyOweUser ?? []),
      ...(obligations?.userOwesThem ?? []),
      ...(obligations?.unanswered ?? []),
    ];
    owed.forEach((line, index) => {
      const row = rows[index];
      lines.push(
        `${line}${row?.due_at ? ` (due ${row.due_at})` : ""} (key=${row?.source_message_key})`,
      );
    });
  }

  if (twin.proposals?.length) {
    lines.push("\nAlready proposed and still open — do not repeat these:");
    for (const proposal of twin.proposals) {
      lines.push(`- ${proposal.kind}: ${proposal.headline}`);
    }
  }
  if (twin.dismissed?.length) {
    lines.push("\nThe user has already said NO to these. Never propose them again:");
    for (const proposal of twin.dismissed) {
      lines.push(`- ${proposal.kind}: ${proposal.headline}`);
    }
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * The proposal contract
 * ------------------------------------------------------------------ */

export const proposalSchema = z.object({
  moves: z
    .array(
      z.object({
        kind: z.enum(PROPOSAL_KINDS),
        arcTitle: z
          .string()
          .optional()
          .describe("The exact title of the arc this serves, copied from the twin. Omit if none."),
        headline: z.string().describe("What to do, in one short line, addressed to the user."),
        draft: z
          .string()
          .optional()
          .describe(
            "The message itself, in the language and register of the conversation. Omit for " +
              "`wait` and `ask_user`.",
          ),
        rationale: z
          .string()
          .describe("Why this is the move, in terms of what the twin actually shows."),
        timing: z
          .string()
          .optional()
          .describe("When, and why then — 'tonight, she replies in the evenings'."),
        needsUserWording: z
          .boolean()
          .describe("True when this commits the user to something and must be worded by them."),
        confidence: z.number().min(0).max(1),
        basis: z
          .array(z.string())
          .describe("The `key` of every message this rests on. At least one, all from the twin."),
      }),
    )
    .describe(
      "Ranked, best first. Empty is a valid and common answer: a conversation with nothing " +
        "outstanding needs no move.",
    ),
});

export interface NormalizedProposal {
  kind: ProposalKind;
  arcTitle?: string;
  headline: string;
  draft?: string;
  rationale: string;
  timing?: string;
  needsUserWording: boolean;
  confidence: number;
  basis: string[];
  /** Why `needsUserWording` was raised here rather than by the model. */
  wordingReason?: string;
}

export interface ProposalDropReport {
  uncited: number;
  empty: number;
  lowConfidence: number;
  badVocabulary: number;
  unknownArc: number;
  duplicate: number;
  alreadyDismissed: number;
  overflow: number;
}

/**
 * Drafts the user has to word themselves.
 *
 * A one-directional gate: it can only raise `needsUserWording`, never lower it,
 * so a miss falls back to whatever the model decided and a false positive costs
 * a self-note instead of a send. Bilingual because the conversations are — a
 * Portuguese chat is the common case here, and a gate that only reads English
 * would wave through exactly the messages it exists to catch.
 *
 * This is a keyword heuristic and nothing more. It is not a semantic
 * understanding of commitment, and it is not presented as one.
 */
const COMMITMENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    // A currency symbol cannot be wrapped in \b — "$" is not a word character,
    // so `\bR\$\b` never matches "R$ 4.500", which is the exact string this
    // pattern exists to catch. Symbols are matched literally; words keep \b.
    pattern:
      /(R\$|US\$|€|£|\$\s*\d|\b(USD|EUR|BRL|GBP)\b|\b\d+\s*(reais|mil|k)\b|\b(pre[çc]o|or[çc]amento|pagar|pago|paguei|cobran[çc]a|desconto|price|pay|payment|invoice|refund|deposit)\b)/i,
    reason: "it puts a number on money",
  },
  {
    pattern:
      /\b(amanh[ãa]|hoje|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|\d{1,2}h(\d{2})?|\d{1,2}:\d{2}|reuni[ãa]o|encontro|marcar|confirmo|meeting|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    reason: "it fixes a time with someone",
  },
  {
    pattern:
      /\b(desculpa|desculpe|foi mal|perd[ãa]o|me perdoa|sorry|apolog(y|ise|ize)|my fault)\b/i,
    reason: "it apologises on the user's behalf",
  },
  {
    pattern: /\b(prometo|garanto|assumo|fecho|fechado|combinado|aceito|promise|guarantee|deal|i'?ll commit)\b/i,
    reason: "it promises something",
  },
];

export function commitmentRisk(draft?: string): string | undefined {
  if (!draft) return undefined;
  for (const { pattern, reason } of COMMITMENT_PATTERNS) {
    if (pattern.test(draft)) return reason;
  }
  return undefined;
}

/** How a dismissed proposal is recognised again. Mirrors the store's identity. */
const proposalIdentity = (kind: string, arcTitle: string | undefined, text: string) =>
  `${kind}|${normalizeArcTitle(arcTitle ?? "")}|${text.trim().toLowerCase()}`;

/**
 * Everything a proposal pass returned, reduced to moves that are reviewable.
 *
 * `knownArcTitles` comes from the twin. A move attached to a thread that was
 * never modelled is dropped rather than silently detached: it is either an
 * invention or evidence that the conversation needs re-modelling, and both are
 * better reported than absorbed.
 *
 * `dismissed` are the identities of moves the user has already said no to. They
 * are dropped here as well as in the store, so a re-proposal never reaches the
 * user a second time.
 */
export function normalizeProposals(
  raw: unknown,
  {
    citableKeys,
    knownArcTitles = [],
    dismissed = [],
  }: {
    citableKeys: Set<string>;
    knownArcTitles?: string[];
    dismissed?: Array<{ kind: string; arcTitle?: string; draft?: string; headline: string }>;
  },
): { moves: NormalizedProposal[]; dropped: ProposalDropReport } {
  const dropped: ProposalDropReport = {
    uncited: 0,
    empty: 0,
    lowConfidence: 0,
    badVocabulary: 0,
    unknownArc: 0,
    duplicate: 0,
    alreadyDismissed: 0,
    overflow: 0,
  };

  const known = new Map(knownArcTitles.map((title) => [normalizeArcTitle(title), title]));
  const refused = new Set(
    dismissed.map((d) => proposalIdentity(d.kind, d.arcTitle, d.draft || d.headline)),
  );
  const seen = new Set<string>();
  const moves: NormalizedProposal[] = [];

  const input = (raw ?? {}) as { moves?: unknown };
  const candidates = Array.isArray(input.moves) ? input.moves : [];

  // Ranked by the model, then re-sorted here: the cap has to cut the least
  // confident moves, not whichever ones happened to be emitted last.
  const ordered = [...candidates].sort(
    (a, b) =>
      confidenceOf((b as Record<string, unknown>)?.confidence) -
      confidenceOf((a as Record<string, unknown>)?.confidence),
  );

  for (const candidate of ordered) {
    if (!candidate || typeof candidate !== "object") {
      dropped.empty++;
      continue;
    }
    const it = candidate as Record<string, unknown>;

    if (!PROPOSAL_KINDS.includes(it.kind as ProposalKind)) {
      dropped.badVocabulary++;
      continue;
    }

    const headline = String(it.headline ?? "").trim();
    const rationale = String(it.rationale ?? "").trim();
    if (!headline || !rationale) {
      // A move with no stated reasoning cannot be reviewed, and an unreviewable
      // suggestion about someone's private correspondence is worse than none.
      dropped.empty++;
      continue;
    }

    const basis = (Array.isArray(it.basis) ? it.basis : [])
      .map((key) => String(key ?? "").trim())
      .filter(Boolean);
    const cited = basis.filter((key) => citableKeys.has(key));
    if (!cited.length) {
      dropped.uncited++;
      continue;
    }

    const confidence = confidenceOf(it.confidence);
    if (confidence < CONFIDENCE_FLOOR) {
      dropped.lowConfidence++;
      continue;
    }

    let arcTitle: string | undefined;
    const requested = String(it.arcTitle ?? "").trim();
    if (requested) {
      const snapped = known.get(normalizeArcTitle(requested));
      if (!snapped) {
        dropped.unknownArc++;
        continue;
      }
      arcTitle = snapped;
    }

    // A move to wait, or a question for the user, has no message in it. A draft
    // attached to one is a contradiction the user would have to resolve.
    const kind = it.kind as ProposalKind;
    const rawDraft = String(it.draft ?? "").trim();
    const draft = kind === "wait" || kind === "ask_user" ? undefined : rawDraft || undefined;

    const identity = proposalIdentity(kind, arcTitle, draft || headline);
    if (seen.has(identity)) {
      dropped.duplicate++;
      continue;
    }
    if (refused.has(identity)) {
      dropped.alreadyDismissed++;
      continue;
    }
    seen.add(identity);

    if (moves.length >= MAX_PROPOSALS) {
      dropped.overflow++;
      continue;
    }

    const risk = commitmentRisk(draft);
    // The flag means "there is a message here and it is the user's to word". A
    // `wait` and an `ask_user` have no message at all, so it does not apply to
    // them — and saying it does produced live nonsense: the agent was told to
    // write a self-note asking the user to word a decision to say nothing.
    const carriesAMessage = kind !== "wait" && kind !== "ask_user";
    const needsUserWording =
      carriesAMessage && (it.needsUserWording === true || Boolean(risk) || !draft);
    const wordingReason = !needsUserWording
      ? undefined
      : it.needsUserWording === true
        ? undefined
        : (risk ?? "there is no draft, so the wording is theirs");

    moves.push({
      kind,
      arcTitle,
      headline,
      draft,
      rationale,
      timing: String(it.timing ?? "").trim() || undefined,
      // Raised, never lowered, within the kinds it applies to.
      needsUserWording,
      wordingReason,
      confidence,
      basis: cited,
    });
  }

  return { moves, dropped };
}
