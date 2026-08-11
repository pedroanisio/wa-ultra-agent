import { z } from "zod";

/**
 * The gap between what a model returns and what the archive will accept.
 *
 * Two jobs, and both are about not trusting the output.
 *
 * A model asked to extract obligations will sometimes cite a message key that
 * does not exist — it is emitting an identifier, and identifiers are the easiest
 * thing to invent. The store rejects a whole batch for one bad citation, so
 * anything uncitable is dropped here and counted, rather than losing a pass that
 * was otherwise good.
 *
 * The second job is the threshold. Most messages mean nothing, and an extractor
 * that finds a commitment in "kkkkk" is worse than one that finds nothing:
 * it fills the archive with noise that later has to be disbelieved. Unstated
 * confidence is treated as low, not as certain.
 */

export const EXTRACTION_TYPES = [
  "commitment", // something the user promised to do
  "waiting", // something someone owes the user
  "request", // something the user was asked to do
  "decision",
  "deadline",
  "event",
  "question", // asked and not yet answered
] as const;

export type ExtractionType = (typeof EXTRACTION_TYPES)[number];

/** Below this, an item is noise. Unstated confidence counts as zero. */
export const CONFIDENCE_FLOOR = 0.5;

/** A conversation window cannot plausibly yield more than this. */
export const MAX_ITEMS = 25;

/** The contract the model is asked to fill. Also the tool's output schema. */
export const extractionSchema = z.object({
  items: z
    .array(
      z.object({
        type: z.enum(EXTRACTION_TYPES),
        statement: z.string().describe("One short sentence, in the language of the conversation."),
        actor: z.string().optional().describe("Who is on the hook."),
        counterparty: z.string().optional().describe("Who it is owed to."),
        dueAt: z.string().optional().describe("ISO date, if one was actually stated."),
        confidence: z.number().min(0).max(1),
        sourceMessageKey: z
          .string()
          .describe("The `key` of the message this came from. Must be one of the keys provided."),
      }),
    )
    .describe("Empty when the conversation contains nothing worth recording. That is the common case."),
});

export interface NormalizedItem {
  type: ExtractionType;
  statement: string;
  actor?: string;
  counterparty?: string;
  dueAt?: string;
  confidence: number;
  sourceMessageKey: string;
}

export interface DropReport {
  uncited: number;
  empty: number;
  lowConfidence: number;
  badType: number;
  duplicate: number;
  overflow: number;
}

/** ISO date only — a time of day is never actually stated in these messages. */
function normalizeDueAt(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

export function normalizeExtraction(
  raw: unknown,
  citableKeys: Set<string>,
): { items: NormalizedItem[]; dropped: DropReport } {
  const dropped: DropReport = {
    uncited: 0,
    empty: 0,
    lowConfidence: 0,
    badType: 0,
    duplicate: 0,
    overflow: 0,
  };

  if (!Array.isArray(raw)) return { items: [], dropped };

  const seen = new Set<string>();
  const items: NormalizedItem[] = [];

  for (const candidate of raw) {
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

    if (!EXTRACTION_TYPES.includes(it.type as ExtractionType)) {
      dropped.badType++;
      continue;
    }

    const sourceMessageKey = String(it.sourceMessageKey ?? "").trim();
    // The load-bearing check: a key the model invented cannot be cited, and
    // would make the store reject every other item in the batch with it.
    if (!citableKeys.has(sourceMessageKey)) {
      dropped.uncited++;
      continue;
    }

    const stated = typeof it.confidence === "number" && Number.isFinite(it.confidence);
    const confidence = stated ? Math.min(1, Math.max(0, it.confidence as number)) : 0;
    if (confidence < CONFIDENCE_FLOOR) {
      dropped.lowConfidence++;
      continue;
    }

    const identity = `${it.type}|${statement}|${sourceMessageKey}`;
    if (seen.has(identity)) {
      dropped.duplicate++;
      continue;
    }
    seen.add(identity);

    if (items.length >= MAX_ITEMS) {
      dropped.overflow++;
      continue;
    }

    const actor = String(it.actor ?? "").trim();
    const counterparty = String(it.counterparty ?? "").trim();

    items.push({
      type: it.type as ExtractionType,
      statement,
      actor: actor || undefined,
      counterparty: counterparty || undefined,
      dueAt: normalizeDueAt(it.dueAt),
      confidence,
      sourceMessageKey,
    });
  }

  return { items, dropped };
}
