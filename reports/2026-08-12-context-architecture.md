---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
    Every claim about this repository below cites a file:line or a measured
    number; every external claim cites a source. Claims about eve's internals
    are read from the compiled bundle in node_modules and may change on upgrade.
  generated_by: "Claude Opus 5 (1M context) via Claude Code"
  date: "2026-08-12"
---

# Context architecture — why the prompt hit 1.57M, and what to change

> **OPEN, partly implemented.** Status line added by a doc-hygiene pass so that
> `docs:check` can tell a live report from a closed one; the author of this
> document owns the wording. `agent/lib/context-budget.ts`,
> `agent/lib/result-set.ts` and `whatsapp_search_page` exist and carry the
> proposals below. Which of §1's four defects are fully closed is not asserted
> here — read the diagnosis, not this banner, for that.

**Trigger.** A `/eve` console turn died with:

```
prompt is too long: 1570042 tokens > 1000000 maximum
```

That is **157% of the window** and **670,042 tokens past** the compaction
threshold. A prompt does not drift 670K tokens past a guard. It arrives there in
one step. This document explains how, and proposes the fix.

---

## 1. Diagnosis — four defects, in order of blame

### 1.1 Compaction is reactive, so it cannot see the step that kills it

eve's compaction config, read from the compiled bundle
(`node_modules/eve/dist/src/execution/session.js`):

```js
function createCompactionConfig(e = {}) {
  let t = e.thresholdPercent ?? 0.9,
      n = { recentWindowSize: 10,
            threshold: Math.floor(e.contextWindowTokens * t) };
  return e.lastKnownInputTokens === undefined ? n
       : { ...n, lastKnownInputTokens: …, lastKnownPromptMessageCount: … };
}
```

Two facts matter. Compaction **does** run by default at `0.9 × window`
(900,000), so [context-alert.ts:29](../agent/lib/context-alert.ts#L29) is right
that it exists. And it is driven by **`lastKnownInputTokens`** — the size of the
*previous* request.

Nothing measures the prompt **before** it is sent. So the sequence that killed
this turn is:

| Step | Context | Compaction check |
|---|---|---|
| n−1 completes | ~800K | 800K < 900K → no compaction |
| step n adds tool output | +770K | *not evaluated — nothing measures pre-flight* |
| step n dispatched | **1.57M** | API rejects |

The guard is a rear-view mirror. Any single step that adds more than the
headroom between "last known" and the hard ceiling jumps straight over it.

### 1.2 The per-tool budget is a fraction of the *window*, not of what is *left*

[tool-output.ts:63](../agent/lib/tool-output.ts#L63):

```ts
export const CONTEXT_BYTE_BUDGET =
  Math.floor((CONTEXT_WINDOW_TOKENS * BUDGET_SHARE * CHARS_PER_TOKEN) / BASE64_INFLATION);
```

With a 1M window and `BUDGET_SHARE = 0.25`, that is **750,000 bytes ≈ 187,500
plain-text tokens for a single tool result — 19% of the entire window.**

The file's own comment says the share is "deliberately a small fraction rather
than most of it… a single result that fills the window has already broken the
turn even when it technically fits." The reasoning is right and the
implementation does not follow it: the budget is an **absolute constant**,
computed once from the window, **blind to how full the context already is.**
187,500 tokens is a small fraction of an empty window and a fatal amount at 850K.

This is the direct mechanical cause. Two admitted results from a
three-quarters-full context exceed the ceiling, and nothing in the code can
notice.

### 1.3 The five bulk-text tools have no budget guard at all

`fitsInContext()` exists and is good. It is used by the **media** tools. The
tools that return unbounded *text* do not call it:

| Tool | Guard | Can return |
|---|---|---|
| `whatsapp_search_archive` | **none** | every match across every archived chat |
| `whatsapp_read_chat` | **none** | a whole conversation |
| `whatsapp_archive_chat` | **none** | a bounded-work batch, unbounded in bytes |
| `whatsapp_get_context` | **none** | a span around each hit |
| `whatsapp_twin` | **none** | arcs, goals, contexts, measures |

A search that matches broadly is the single most likely source of a 770K step,
and it is the one tool with no ceiling.

### 1.4 The alert can only narrate the failure

[context-alert.ts](../agent/lib/context-alert.ts) is well built — it counts
cache reads (correctly: a cache read is still prompt), it bands at 80/90/95%,
it fires once per band. But it runs on `step.completed`, which is **after** the
tokens are in, and it has no authority to refuse anything. It told the user the
conversation was getting long. It could not stop the step that killed it.

### 1.5 The outer fuse is effectively absent

eve's default is `DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION = 4e7` — **40
million tokens per session**, and `agent.ts` sets no `limits`. As a backstop
against runaway sessions that is not a limit, it is a rounding error.

---

## 2. What the field says

### 2.1 The threshold is set for survival, not for quality

Chroma tested 18 frontier models and found **every one degrades as input grows**,
with serious loss well before the window is full — a 200K model showing real
accuracy loss around 50K. Two distinct failure modes: *positional* degradation
(the lost-in-the-middle U-shape, 20–30 points lower for evidence in the middle)
and *length* degradation, where accuracy falls as input grows **even when the
evidence is fixed and well-placed**.

The corpus agrees from the applied side: *"Simply feeding an entire conversation
history into an LLM's context window is often counterproductive"* (doc
`0042b924`, ordinal 3015), and *"filling it up to the brim with tool JSON schemas
is bound to decrease the LLM's performance"* (doc `c8bb78ea`, ordinal 1737).

**Implication for us:** compacting at 90% is a rule about not crashing. By the
time this agent is at 900K it has been answering badly for a long while. The
quality threshold is far lower than the survival threshold.

### 2.2 The five techniques that apply

From Anthropic's context-engineering guidance, all five map onto gaps above:

1. **Compaction** — summarize near the limit, reinitialize. *We have this, but
   reactive and too late.*
2. **Structured note-taking (agentic memory)** — write notes to storage outside
   the window, pull them back when needed. *We have world-class primitives for
   this and never use them to shed context.*
3. **Sub-agent architectures** — isolated windows, returning distilled summaries
   of ~1–2K tokens. *Unused.*
4. **Tool-result clearing** — drop raw outputs deep in history, keep the
   decision. Described as one of the safest, lightest-touch forms of compaction.
   *Unused.*
5. **Just-in-time retrieval** — hold lightweight identifiers, load at runtime.
   *Inverted: our tools push whole payloads.*

The corpus names the same pattern independently: LlamaIndex's
`LoadAndSearchToolSpec` splits one huge-output tool into load-and-index plus
search, and *"this is the whole trick for keeping big tool outputs from bloating
the model context"* (doc `70273677`, ordinals 4601–4611). And the reference
pattern: *"Send a lightweight reference instead of the full data… avoids context
limits"* (doc `0042b924`, ordinal 2627).

On history specifically, the corpus separates **trimming** (drop oldest; cheap,
loses information silently) from **summarization** (an LLM condenses; *"this
summary might still fill the context window over time as summaries are stacked…
but it is much slower"*, doc `c8bb78ea`, ordinals 1276–1297). Both are inferior
to not putting the bytes in.

---

## 3. Proposal

Ordered by ratio of harm prevented to work required. **A and B stop the crash;
C–E are the architecture.**

### A. Budget against remaining headroom — not against the window

Make the tool-result ceiling a function of live usage.

```ts
// tool-output.ts — the budget becomes a call, not a constant
export function contextByteBudget(usedTokens: number): number {
  const remaining = Math.max(0, CONTEXT_WINDOW_TOKENS - usedTokens);
  const share = Math.min(BUDGET_SHARE * CONTEXT_WINDOW_TOKENS, remaining * 0.5);
  return Math.floor((share * CHARS_PER_TOKEN) / BASE64_INFLATION);
}
```

`context-alert.ts` already computes exactly the input this needs (`usedTokens`,
cache-aware). Today that number is used only to print a warning. Wire it into a
small module both files read, and the same arithmetic that warns the user starts
governing admission.

**Effect on the observed failure:** at 800K used, the ceiling for one result
becomes 100K tokens rather than 187.5K, and the second such result is refused
rather than admitted. Keep `BUDGET_SHARE` as the absolute cap so an *empty*
context still cannot take a 187K dump.

### B. A pre-flight check, and a compaction the agent can trigger

The rear-view mirror is the root cause, so add a mirror that looks forward.
eve exposes the lever — `channel-operations.d.ts:40`: *"Queues context
compaction without creating a session."*

Before dispatching a step, estimate the projected prompt (last known + pending
tool results). If it would cross the threshold, **compact first, then dispatch.**
Refusing a step is always better than a 400 that discards the whole turn:
compaction loses detail, a rejected prompt loses the turn.

Also set the fuse that is currently 40M:

```ts
limits: { maxInputTokensPerSession: 8_000_000 }   // agent.ts
```

### C. Just-in-time retrieval for the five unguarded tools

This is the structural fix, and this codebase is unusually well placed for it:
**the archive is already SQLite.** The data is already external. The tools simply
hand over more of it than anyone asked for.

Change their contract from *return the payload* to *return a head plus a handle*:

```ts
whatsapp_search_archive({ query })
  → { hits: [...first 20...], total: 1_847, resultSetId: "rs_a91f", truncated: true }
whatsapp_search_page({ resultSetId, after })   // new — pages the rest
```

This is `LoadAndSearchToolSpec` and Anthropic's just-in-time retrieval arriving
at the same place. It fits the repo's existing grain: `whatsapp_archive_chat`
already returns `hasMore` rather than everything, and the search tool already
reports `coverage`. Extend the pattern that is already there rather than
inventing one.

**Do not** solve this with truncation alone. A silently truncated result set is
the failure `whatsapp_search_archive`'s own description warns about — "never
claim someone did not say something based on an empty result". Truncation must
be *stated in the result* (`truncated: true`, `total`), or the guard against
context overflow becomes a cause of wrong answers.

### D. Tool-result clearing, starting with media

The lightest-touch compaction: once a step is well behind the head of the
conversation, replace raw tool output with a one-line stub naming the tool, its
arguments and where the result went. Keep the decision, drop the bytes.

Start with `whatsapp_view_media` and `whatsapp_transcribe_voice` — base64 image
payloads are the single largest per-item contributor, and the model has already
extracted whatever it needed by the next step. A photo is worth ~187K tokens
under the current budget and worth zero once described.

### E. Structured note-taking, using primitives we already have

The repo already has best-in-class agentic memory and does not use it to shed
context: `whatsapp_remember_fact` (provenance-enforced), `whatsapp_twin`,
`whatsapp_extract_actions`, `whatsapp_write_self`. All persist outside the
window; all can be read back on demand.

Add a **checkpoint before compaction**: when the pre-flight in (B) decides to
compact, first persist durable conclusions as facts and obligations, *then*
compact. Compaction then discards a transcript whose content has already been
written down, instead of being the only place that knowledge lived. This is
exactly Anthropic's structured note-taking, built from parts already shipped.

### F. Sub-agent isolation for sweeps

`whatsapp_archive_chat` in `backfill` mode and `whatsapp_extract_actions` across
many chats are the two operations whose *entire purpose* is to chew through
volume. They should run in a sub-agent with its own window and return a
distilled summary (Anthropic's guidance: ~1–2K tokens), not stream every message
through the conversation the user is having.

eve supports this — the compiled manifest carries `subagents`, `subagentEdges`
and `workflowTool.maxSubagents`. This is the largest change here and the one to
do last.

### G. Lower the quality threshold, separately from the survival one

Given §2.1, treat 90% as the *crash* threshold and add a *quality* threshold far
below it. Concretely: compact at ~60% of window on a conversational session, and
say so in the notice `context-alert.ts` already sends. The user's real choice is
not "compact or crash" but "compact now while it still reasons well, or keep a
long transcript and get worse answers".

---

## 4. What I would do first

1. **A + B together** — they are perhaps 150 lines, they reuse arithmetic that
   already exists, and together they make the observed crash impossible.
2. **C for `whatsapp_search_archive` only** — the highest-variance tool, and the
   pattern generalises to the other four once proven.
3. **D for the two media tools** — mechanical, large win, no semantic risk.
4. Then E, F, G as architecture rather than repair.

**One caution against over-fitting.** The 1.57M failure is a *crash*, and A–D
fix crashes. §2.1 says the more expensive problem is silent quality loss long
before any crash, and nothing in A–D addresses that; only G does, and G costs
the user context they may want. Fixing only the crash and declaring the context
problem solved would be the wrong conclusion to draw from this document.

---

## Sources

External:

- [Effective context engineering for AI agents — Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Context engineering: memory, compaction, and tool clearing — Claude Cookbook](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)
- [Context Rot: How Increasing Input Tokens Impacts LLM Performance — Chroma](https://www.trychroma.com/research/context-rot)
- [Context rot explained (& how to prevent it) — Redis](https://redis.io/blog/context-rot/)
- [Context Rot, RAG, and Long Context: How to Architect LLM Systems in 2026](https://glasp.co/articles/context-rot-rag-long-context-hybrid)
- [Diagnosing and Mitigating Context Rot in Long-horizon Search (arXiv)](https://arxiv.org/pdf/2606.29718)
- [LOCA-bench: Benchmarking Language Agents Under Controllable and Extreme Context Growth (arXiv)](https://arxiv.org/pdf/2602.07962)

Corpus (doc-ray, cited by document id + sentence ordinal):

- `70273677`, ordinals 4600–4611 — `LoadAndSearchToolSpec`; load-and-search for large tool outputs
- `c8bb78ea`, ordinals 1276–1300 — trimming vs summarization of history; ordinal 1737 — tool schemas degrading performance
- `0042b924`, ordinal 2627 — send a lightweight reference instead of full data; ordinal 3015 — feeding whole history is counterproductive
- `58a2b6fc`, ordinal 5618 — tight briefs for sub-agents; ordinal 5314 — bloat lowers instruction compliance
- `157a0220`, ordinal 2970 — tool descriptions consuming the window
- `289d3d8f`, ordinal 72 — dynamic context loaded on demand

Repository:

- [`agent/lib/tool-output.ts:63`](../agent/lib/tool-output.ts#L63) — the constant budget
- [`agent/lib/context-alert.ts`](../agent/lib/context-alert.ts) — advisory bands, cache-aware token count
- [`agent/lib/model.ts:97-137`](../agent/lib/model.ts#L97-L137) — the window registry
- `node_modules/eve/dist/src/execution/session.js` — `createCompactionConfig`, `DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION = 4e7`
- `node_modules/eve/dist/src/channel/channel-operations.d.ts:40` — queueable compaction
