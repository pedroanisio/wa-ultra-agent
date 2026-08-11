---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5 (1M context) via Claude Code"
  date: "2026-08-10"
---

# Corpus findings for whatsapp-agent

What the doc-ray corpus (885 documents) says that bears on this codebase — validations,
gaps, and one thing the code does that the literature names better than we do.

## Disclaimer

This work is subject to the methodological caveats and commitments described in [@DISCLAIMER.md](./DISCLAIMER.md).
> No statement or premise not backed by a real logical definition or verifiable reference should be taken for granted.

Every claim below cites a document and sentence ordinal. Citations are addressable via
`read_document_sentences(document_id, from_ordinal, to_ordinal)`. Where the corpus does not
support a claim, that is stated rather than filled in.

---

## 0. State of the tree

> **Status as of 2026-08-11, after the remediation pass.** The audit body below is preserved as
> written, because a findings document that quietly rewrites itself cannot be audited. Where a
> finding has been closed or was wrong, it is marked here and at the finding itself. Read this
> section first: several items below describe a tree that no longer exists.

**Original finding (stale):** *"445 tests, 429 pass, 16 fail"* — the failures clustered in
uncommitted timestamp and `interactionMetrics` work.

**Now: 490 tests, 490 pass, 0 skipped, `tsc` clean.** The 16 failures were fixed in `e9f2da8`
before any of the work below began, so §0's premise ("nothing below is worth acting on before that
is green") was already satisfied.

### What was done, and what remains

| Finding | Status |
|---|---|
| §0 · 16 failing tests | ✅ Fixed in `e9f2da8`, before this pass |
| §1 · allowlist bounds typing, not opening | ✅ Documented in `SPEC.md` §6.2 with the verified call order. Deliberately not reordered — see below |
| §2.1 · no retention schedule | ✅ Built. Three windows, cascading, dry-run by default over HTTP |
| §2.2 · dismissed proposals not fed to the prompt | ✖ **Finding was wrong.** Already built when the audit was written — `twinBriefing()` emits a do-not-repeat block and `normalizeProposals` drops matches. Closed as done, not as a gap |
| §2.2 · facts are not revisable | ✅ Built. Retraction is a tombstone with a mandatory reason, plus `whatsapp_retract_fact` |
| §2.3 · arcs modelled over the whole conversation, not per episode | 📋 Open. Real, and a larger change than this pass |
| §3 · memory poisoning / taint-marking | ✅ Built, **but not as this document proposed** — see the correction below |
| §3 · aliases have no provenance | ✅ Built. `origin` is required; `message` must cite |
| §4 · §6.1 addresses one of four oversight failure modes | ✅ `SPEC.md` §6.1.1 now records all four with an explicit accept/reject |
| §4 · band numeric confidence | ✖ **Premise was wrong.** No raw confidence ever reaches the model — not in `whatsapp_twin`, `whatsapp_next_best`, `whatsapp_model_interaction` or `twinBriefing`. Satisfied by omission; banding the *stored* value would break `CONFIDENCE_FLOOR` and the ranking sort |
| §5 · evals are built backwards | ◐ Partly. The two citation evals are now code evaluators gating on a resolvable `source_message_key`, with the judge retained as a tracked assertion. **Still never executed** — the datasets item stays open, deliberately (see below) |
| §6 · instruction hierarchy | 📋 Open. Not investigated this pass |
| §7 · `selectors.js` has a thirty-year-old name | ✅ Named in `SPEC.md` §3.5 and in the module header. The invariant is enforced as a **ratchet**, because it does not hold |

### Three corrections this document owes

**§3's proposed fix was wrong, and the better one is a join.** This document asked for a
`source_direction` column on `facts` / `contexts` / `goals` / `arcs`. That duplicates a fact the
citing message already carries: every one of those tables has a foreign key onto `messages(key)`,
and `messages.outgoing` *is* the direction. Two copies can disagree; one cannot. `extractions()`
already set the precedent by exposing `source_outgoing` as a join, and that is what was built —
no schema change, and the mark cannot drift from its own citation.

**§7's invariant does not hold, and the audit should have checked rather than suggested checking.**
The document says "worth grepping to confirm that invariant currently holds". It does not:
`whatsapp.js` carries 73 DOM references inside `page.evaluate` callbacks and `session.js` reaches
for `#pane-side`. Enforced as a ratchet with per-file ceilings that may only fall.

**§5's dataset recommendation is deliberately not implemented.** The corpus advice — split
train/dev/test and add production failures — requires production failures, and there are none,
because the evals have still never run against a live session. Inventing a dataset now would
reproduce the exact defect this section identifies: evaluators built from *hypothesised* failure
modes rather than observed ones. The honest state is an empty dataset and a stated reason.

### The one thing this document did not find

The audit inspected the corpus against the code and did not look at what was already published.
`whatsapp-bridge/test/message-kind.test.js` and two source files carried the real names of three
third-party contacts, two real group names, a real document filename, and the operator's actual
send allowlist as a test constant — public from the repository's first push. That is now remediated
(history rewritten, repository private, `test/no-real-identities.test.js` added as the standing
control), and it is recorded here because a findings document that lists six refinements while
missing a live disclosure has mis-ranked its own severity.

---

## 1. The security doctrine has a citation now

`SPEC.md` §6.2 states the rule as *"Bounded in code, never by instruction."* The corpus states
the same rule, in a peer-reviewed methodology paper, almost verbatim:

> "Third, where security lives: never in the schema, never in the description, never in the
> system prompt, but in the scaffolding's tool dispatcher — prompt instructions help steer
> behaviour, but authorisation and execution policy belong in deterministic host-side controls."
>
> — *Agents All the Way Down: A Methodology for Building Custom AI Agents from Substrate to
> Production*, Alier Forment, Pereira, García-Peñalvo, Casañ Guerrero
> (`da3cab08-de98-4c8a-a4af-067d52cae743`, ordinal 176)

And again, sharper, on the instruction-set layer:

> "Discipline: do not put security in the instruction set. Instructions shape behaviour; the
> scaffolding's allow-list shapes outcomes." (ordinal 223–224)

The same paper names the mechanism the bridge already is — a **pre-tool-use hook** as "where the
allow-list is actually checked, where a requested call is admitted or denied" (ordinal 227–229) —
and observes that engineers discover this boundary empirically: "where the security boundary
belongs (almost always at the scaffolding's tool dispatch, not in the prompt)" (ordinal 247).

**Use:** cite this in `SPEC.md` §6.2. It converts a design assertion into a referenced one,
which is what `CLAUDE.md` rule 2 asks for.

**One verified subtlety, worth a comment in the code.** In `whatsapp.js:767–780` the order is
`resolveRecipientName` → `openChat` → `assertResolvedMatches` → `assertSendable`. The allowlist
check is last and runs on `resolved.opened`, the chat actually open — so an alias cannot widen
the allowlist, and the doc comment in `whatsapp_remember_alias.ts` claiming as much is correct.
But `openChat` runs *before* `assertSendable`, so the allowlist bounds **typing**, not
**opening**. A non-allowlisted chat is navigated to (and read, and charged against the
interaction budget) before being refused. Not a send, so the blast radius is small; it is still
a place where the boundary is one step later than the comment implies.

---

## 2. The single most useful document: *Building Ambient AI Agents*

`7aef0d5e-1702-4154-b82d-3c8a77a38ea0` — Patton & Patton, Packt Early Access, 815 sentences.
This is the same product category as this project: an always-on agent that watches an event
stream, remembers, and mostly stays quiet. Its organising triad is **Observation, Memory,
Restraint** (ordinal 158–159), and its restraint chapter is a table this codebase can be
audited against directly.

### 2.1 The Layers of Restraint (ordinal 247–252) versus `watch.js`

| Layer (book) | Mechanism | In this codebase |
|---|---|---|
| Signal Filtering | sub-threshold signals dropped, relevance scoring | ◐ `store.attention()` selects; no relevance score |
| Temporal Gating | timing by user availability | ✅ `inQuietHours`, `watch.js:214` |
| Rate Limiting | cap frequency, batch low-priority | ✅ `rate.js` token bucket + `maxChatsPerWake` |
| Context Awareness | do-not-disturb, cognitive load | ✅ quiet hours; ✖ no DND signal |
| Privacy / Retention | collect only what is needed, auto-delete | ◐ no media table (good, `SPEC.md` §4); **no retention schedule on messages, transcripts, arcs** |
| HITL Boundary | approval above a threshold or for sensitive ops | ✅ send allowlist |

Four of six are built and one is deliberately partial. The gap that is neither is **retention**.
`SPEC.md` §4 argues persuasively for not storing media bytes — "several orders of magnitude more
to lose" — and then stores message text, transcripts, facts, and now arcs and goals forever. The
book's framing (ordinal 251) treats a retention schedule as a restraint mechanism, not a
housekeeping nicety. The archive is the most sensitive artifact this system creates and it is the
one thing with no expiry policy.

### 2.2 The four memory objects, and the one this codebase is missing

The book splits memory across four implementation objects (ordinal 222–226):

- **Session State Model** — live session context. → eve's `defineState`. Correct per `SPEC.md` §4.
- **User Model** — "selected evidence and revisable beliefs about an individual user". → `facts`,
  `aliases`, and now the twin's `contexts`.
- **Application Domain Model** — workflow and population-level knowledge. → not applicable
  (single user, by non-goal).
- **Procedural Policy Layer** — "governs how remembered context should influence action".
  → **does not exist here.**

The distinction the book insists on (ordinal 221) is:

> "A policy about when to intervene is not the same thing as a memory of what happened."

**The main case is already built, and built well.** From the same chapter (ordinal 228), a memory
system should let the agent notice "that the user has explicitly asked not to receive a certain
kind of help." The `proposals` table does exactly that: `PROPOSAL_STATUSES` includes `dismissed`,
and the upsert at `store.js:1332–1341` bumps `times_proposed` on a key collision while leaving
`status` untouched — with the reasoning stated in the schema comment: *"an assistant that forgets
it was told no is an assistant that nags."* That is the book's principle, implemented, before
reading the book.

Two narrower gaps remain:

- **Dismissal is keyed on content, so it suppresses only the identical move.** The proposal key is
  content-addressed, so "chase Helena about the tiler quote" and "ask Helena where the tiler
  quote got to" are two keys. Dismissing the first does not suppress the second. The cheap fix is
  not semantic dedup — it is passing the chat's `dismissed` proposals into the proposal prompt as
  *do-not-repeat* context. `personDossier` already assembles `dismissed` at `store.js:1489`, so the
  data is in hand.
- **There is no policy scoped wider than one proposal** — no "never propose `follow_up` in this
  chat", no per-chat opt-out. Whether that is worth building is a product call, not a defect.

The book also states the selectivity rule that `whatsapp_remember_fact`'s doc comment already
argues for, in one line worth quoting in that file (ordinal 236–238):

> "A useful memory system does not preserve everything. It preserves what can improve future
> interpretation, future restraint, or future assistance. Memory makes the agent more capable,
> but only when it remains typed, selective, revisable, and accountable."

`facts` are typed, selective and accountable (FK provenance). **Revisable** is the weak one —
there is a `forgetAlias` but no equivalent for a fact that has gone stale or was wrong.

### 2.3 Episode discipline — independent convergence, and one gap

The book's sensing unit is the **interaction episode**: "a bounded sequence of related UI signals
that, taken together, represent one coherent slice of user activity" (ordinal 641). Its lifecycle
is strict and the ordering is load-bearing (ordinal 666–676):

> "Pattern detection happens only after the episode has collected enough evidence, and candidate
> intent is inferred only after those patterns have been finalized. That sequence prevents the
> sensing layer from making premature claims based on partial behavior."

`twin.js`'s `NEW_CONVERSATION_GAP_MINUTES = 6h` is exactly an episode boundary, and
`interactionMetrics` is exactly the finalize-patterns step. Independent convergence on the same
structure — worth noting in the file header as corroboration.

The gap: `modelSchema` in `agent/lib/twin.ts` asks the model for arcs over the **whole
conversation**, not per episode. The book's discipline says intent is inferred at the episode
boundary, from a bounded window, because that is what makes the inference stable (ordinal 675).
An arc extracted over 2,000 messages has no bounded window and no stability guarantee. The
`continues` flag and `normalizeArcTitle` are compensating for this after the fact. Modelling
per-episode and letting arcs *span* episodes by title identity would put the citation window and
the inference window in the same place.

Also worth adopting: the book's threshold honesty (ordinal 758) — *"If the pattern doesn't meet
the threshold, no intent is inferred because the sensing layer only makes claims it can
support."* This is `CONFIDENCE_FLOOR` and `habitsAreThin`, already present. Good.

**One caveat on this document:** it is a Packt Early Access release and the corpus copy contains
only chapters 1–3 (815 sentences; outline ends at ordinal 814). The book repeatedly forward-
references Chapter 5 for the operational memory architecture — "how user beliefs are formed and
corrected… how procedural memory governs restraint" (ordinal 240). **That chapter is not in the
corpus.** The four-object split above is from the chapter-1 summary, not from its implementation
chapter. Do not treat §2.2 as a complete design.

---

## 3. The largest real gap: memory poisoning

This is the finding I would act on first, after the tests.

`SPEC.md` §6.3 is well-built and covers *actions* derived from third-party text: "Extractor
output is a proposal, never an action", "No message content may select a recipient", "Level 3 is
never reachable from a path that started with third-party text." It does not cover **durable
beliefs** derived from third-party text. The corpus names that attack class specifically:

> "Memory poisoning corrupts what the agent stores and later retrieves, so it acts on false
> premises many steps later."
> — *An Illustrated Guide to AI Agents* (`c8bb78ea-0f19-42a1-ba8e-58da1fe9d1d0`, ordinal 2749)

> "Memory Poisoning: Attackers can inject false or misleading data into an agent's memory,
> causing long-term behavioral shifts that are difficult to detect and reverse."
> — (`0c0b50be-8c56-44cc-be43-4395dd37ace7`, ordinal 217)

> "A common scenario involves injecting malicious instructions or fabricated facts into the
> agent's conversation history, scratchpad, or memory store." … "By treating memory as a
> sensitive attack surface rather than a passive storage layer, agentic systems can prevent
> attackers from covertly steering behavior over time."
> — (`b2d8c932-1afa-4b88-b821-3cbf80e5d577`, ordinals 4636, 4643)

It is catalogued as **OWASP ASI05** (`b9beb35c-a25d-4fec-9809-14196641bae7`, ordinal 3039), and
*Adversarial Machine Learning* notes the long-play variant: "Attackers can deliberately engage
the agent over time to inject adversarial memory entries that subtly reshape its perception of
past experiences" (`9f35b3b8`, ordinal 7174).

**Why this bites here specifically.** `SPEC.md` §4 calls FK-enforced provenance "the single
strongest anti-hallucination measure in the system." That is true and it is the right design.
But provenance proves **traceability, not truth**. `whatsapp_remember_fact` refuses a fact the
agent merely inferred — excellent — and accepts any fact that cites a real message. The messages
it cites are written by anyone in any group chat. A false statement that is genuinely present in
the archive passes every check the store makes, and then reads back as a cited fact with a
receipt, which is *more* persuasive than an uncited one.

`aliases` is the weaker of the two: `whatsapp_remember_alias` has **no provenance requirement at
all** — no `sourceMessageKey`, no FK. The allowlist ordering (verified in §1) means an alias
cannot widen who may be messaged, so the blast radius stays inside the allowlist. But an alias
learned from chat text is message content influencing recipient resolution, one step removed,
which is in tension with §6.3's "No message content may select a recipient."

The twin adds a third surface. `arcs`, `goals` and `contexts` are model-generated readings of
untrusted text, stored durably, and `agent/instructions.md` now tells the agent to read the twin
*before drafting into a conversation*. That is untrusted-derived durable state on the path to
composing outgoing messages. The citation checks in `agent/lib/twin.ts` are genuinely good and
prevent invention — they do not and cannot detect a citation to a message that is itself a
plant.

**What the corpus recommends, and what would fit here:**

1. Treat the three memory tables as a taint surface, not a storage layer (`b2d8c932`, 4643).
   Concretely: record on each `fact` / `alias` / `context` row whether its source message was
   **outgoing** (the user wrote it) or **inbound** (someone else did). The store already has
   `outgoing` on messages and `twin.js` already keys on it. A fact sourced from the user's own
   message is a different epistemic object from one sourced from a group chat, and right now they
   are indistinguishable at read time.
2. Require provenance on `aliases`, the same way `facts` does — or make it explicit in the tool
   description that an alias may only be set from a **user instruction in the current session**,
   never from something read in a chat.
3. Give `whatsapp_person` a way to show and retract a fact — the "revisable" property from §2.2.
   Poisoned memory that cannot be removed is the failure mode the corpus calls "difficult to
   detect and reverse."

---

## 4. `SPEC.md` §6.1 removed one of four oversight failure modes

§6.1 is the most carefully argued section in the spec, and its central empirical claim —
"Approval fatigue is a real failure mode. A gate on every message to one's own mother is clicked
through unread within a week" — is supported. The corpus names it directly:

> "Alert fatigue: Continuous or low-priority alerts can lead human operators to overlook critical
> warnings, reducing their effectiveness in preventing errors."
> — *Building Applications with AI Agents* (`40c73f7f-2ee2-48fe-847c-d500322f5b7b`, ordinal 3159)

But it is item two of four. The full taxonomy (ordinals 3157–3162):

1. **Automation bias** — "Humans may over-trust agent recommendations, failing to adequately
   scrutinize outputs, **especially if presented with high confidence**."
2. **Alert fatigue** — as above. *The one §6.1 addressed.*
3. **Skill decay** — "As agents handle more routine tasks, human skills required for effective
   oversight may deteriorate."
4. **Misaligned incentives** — efficiency versus safety.

And the recommended mitigation is not removal of the gate: "systems should include clear
escalation paths, **adaptive alerting mechanisms**, and ongoing training" (ordinal 3162). Fatigue
is a reason to make oversight *selective*, not absent.

Two of the other three apply more to this codebase after the twin than before:

- **Automation bias.** `whatsapp_twin` returns arcs and goals each carrying a `confidence`
  number. The corpus's finding is that a confidence figure is what causes under-scrutiny. The
  code already fights this well — `habitsAreThin`, `HABIT_NOTE`, `twinCoverage.stale`, and the
  counted-versus-read distinction in `instructions.md` are all exactly right, and better than
  most of what the corpus describes. The remaining exposure is that a model's `confidence: 0.9`
  on an arc is rendered with the same authority as an arithmetic median. Consider not surfacing
  numeric confidence on modelled rows to the model at all — a three-level band, or nothing.
- **Skill decay.** The agent drafts in the user's voice and `instructions.md` §"Do not write like
  a machine" is dedicated to making the drafts indistinguishable. The oversight step §6.1 relies
  on — "Show it first" — is the user judging whether a message sounds like them. That judgment is
  precisely the skill that decays when a machine does it well, every day, for months. This is not
  an argument to reverse §6.1; it is a fourth consideration that section does not currently
  weigh, and it argues for the self-note route (§5.2) on independent grounds.

**Use:** §6.1 should cite the taxonomy and say which of the four it accepted, which it rejected,
and why — `CLAUDE.md` rule 6's "document the feedback-processing decision" applied to the
literature. The section's conclusion may well survive intact. Its reasoning is currently
one-quarter complete.

---

## 5. The evals are built backwards

`evals/` holds six `defineEval` files, derived from `SPEC.md`, never run (each roadmap phase says
"needs a live run"). They are well-written — `quiet-day-is-silent.eval.ts` encodes a real
restraint property, and `empty-is-not-absence.eval.ts` encodes a real epistemic one. The method
is inverted from what the corpus recommends.

*Evals for AI Engineers* (`bfd8ddf3-9c32-4ee0-818c-e23a20a8d2e7`):

> "Evaluation is not a one-time check; it is an iterative process where requirements become clear
> only after you interact with real outputs." (ordinal 206)

> "Before writing any evaluator, skim your 10 worst traces and ask: 'Did the prompt actually say
> what I wanted?'" … "In our experience, half of early failures are specification errors that
> disappear with a one-line prompt edit, saving weeks of evaluator development on a problem that
> was never a model limitation." (ordinals 2320–2321)

> "A typical setup uses 5 to 7 evaluators, a mix of code-based and LLM-as-Judge, each tracking a
> known failure mode." (ordinal 1943)

Three actionable differences:

1. **Six evaluators is the right number** (ordinal 1943 — 5 to 7). The problem is not count, it is
   that each tracks a *hypothesised* failure mode rather than an observed one. One live session
   producing ten traces would tell you which of the six are measuring something real.
2. **Prefer code evaluators where the property is objective** — "fast, cheap, deterministic, and
   interpretable" (ordinal 1044), reserving LLM-as-Judge "when nuance or interpretation is
   required" (ordinal 1058). `digest-cites-its-sources.eval.ts` and `commitment-is-cited.eval.ts`
   are judging *citation presence*, which is objectively checkable — the store has the FK. Those
   two are candidates for code evaluators, which also removes a model call from the gate.
3. **Split the eval data** train/dev/test, and add production failures to all three splits
   (ordinal 1243). Currently there is no dataset at all — each eval is a single prompt.

The stronger point, against the project's own doctrine: `CLAUDE.md` states PALS's LAW — "Absence
of a verification layer is a design defect." The verification layer for the LLM-dependent half of
this system (`extraction.ts`, `twin.ts`, the drafting behaviour) is `evals/`, and it has never
executed. By the project's own standard that is an open design defect, and it is the one the
roadmap keeps deferring as "needs a live run."

---

## 6. Instruction hierarchy — a cheap hardening the corpus supports

*AI Engineering* (`8ca10aa3-b965-4d1e-b307-91eede2b0a1b`, ordinal 4165):

> "Since tool outputs have the lowest priority, this hierarchy can neutralize many indirect
> prompt injection attacks."

`whatsapp_read_chat` already tags results `trust: "untrusted-user-content"`, which `SPEC.md` §2
correctly lists as built. The tag is a string in the payload — advisory, and read by the same
model it is meant to constrain. Two mechanical improvements consistent with the corpus:

- *Agents All the Way Down* (ordinals 160–166): keep stable instructions in the cached system
  prefix and volatile per-turn state in the message history, never the reverse. Worth verifying
  how eve composes tool results.
- *AI Security Engineering* (`0a3550a3-0672-432f-9cde-9b4b912d1d2c`, ordinal 288): "the true
  security controls will be implemented outside the prompts, such as programmatic checks…
  which will ultimately determine what the program is capable of doing beyond its intended prompt
  instructions." Consistent with §1 — the trust tag is documentation of a boundary the bridge
  enforces, and should be described that way rather than as a control.

---

## 7. `selectors.js` has a thirty-year-old name

The DOM seam is the system's single largest fragility, and `SPEC.md` §3.5 handles it well
(`CRITICAL_SELECTORS`, assertion before walking, `503` naming the dead selector, and the correct
observation that "a break that reads as an answer is worse than one that reads as an error").
The pattern has a name in the corpus:

> "Anti-Corruption Layer: Create an isolating layer to provide clients with functionality in terms
> of their own domain model." — Evans, *Domain-Driven Design* lineage
> (`91b925d2-2449-46a4-9128-441bab9f91b8`, ordinal 2472; see also `7bd81787`, ordinal 1314 and
> `ce291685`, ordinals 1336–1340: "In order to avoid corruption and protect your model from
> external influences you can create an isolation layer that contains an interface written in
> terms of your model.")

`message-kind.js` + `selectors.js` + `history.js` are that layer: WhatsApp's DOM on one side, this
project's `{key, kind, outgoing, sent_at_iso}` vocabulary on the other. Naming it in the module
headers makes the boundary a deliberate architectural commitment rather than an implementation
detail — and gives a rule for review: **nothing outside those three files may know a CSS
selector.** Worth grepping to confirm that invariant currently holds.

The same paper from §1 names the other pattern in play here — the **liteshell**, a Facade
presented to an LLM as if it were a CLI (`da3cab08`, ordinals 200–213) — and observes that MCP
earns its keep specifically "where a tool requires sustained stateful interaction the shell idiom
does not model cleanly, the canonical example being browser automation" (ordinals 198–199). That
is a direct endorsement of the two-service split in `README.md` §"Why there are two services".

---

## Ranked next actions

> **Superseded — kept for the record.** Items 1, 2, 5 and 6 are done; item 4 was already built when
> this was written; item 3 is half done. The live list is the table in §0. What remains, re-ranked
> against the tree as it now stands, is at the end of this section.

1. ~~**Green the tree.**~~ Done in `e9f2da8`, before this pass.
2. ~~**Taint-mark durable memory** (§3).~~ Done — as a join on `messages.outgoing` rather than the
   four columns proposed here, plus alias provenance and fact retraction.
3. ◐ **Run the evals once** (§5), then rewrite them from the traces. The citation evals are now code
   evaluators; **they have still never executed.** This remains the project's own PALS's LAW debt.
4. ~~**Feed dismissed proposals into the proposal prompt** (§2.2).~~ Was already built.
5. ~~**Add a retention policy**~~ (§2.1). Done.
6. ~~**Cite the literature in `SPEC.md`**~~ — §6.2, §6.1.1 and §3.5 now carry the citations.

### What is actually next

1. **Run the evals against a live session.** Everything else in this list is a refinement; this is
   the only unbuilt *verification layer* in a codebase whose own `CLAUDE.md` calls the absence of
   one a design defect. Nine evals now exist and none has ever run. Until then their value is
   unknown — including the two just rewritten.
2. **Model arcs per episode** (§2.3). The `continues` flag and `normalizeArcTitle` are compensating
   after the fact for an inference window that has no bound. The largest remaining correctness
   finding.
3. **Lower the ACL ceilings** (§7). `session.js` is one reference and is the obvious first retirement;
   `whatsapp.js` is 73 and wants doing in slices, each moving one evaluate callback into a named
   reader in `selectors.js`.
4. **Verify how eve composes tool results** (§6) — whether the `trust: "untrusted-user-content"` tag
   sits in the cached prefix or the message history. Unexamined.
5. **Operator-only, outside the code:** request a GitHub Support purge of the pre-rewrite objects
   (they remain owner-fetchable by SHA; the private flip is what closes anonymous access, not the
   rewrite), and decide whether the three exposed third parties are notified.

## Corrections made while writing this

- An earlier draft claimed proposal dismissal was not durable. It is (§2.2). Credit where due:
  the `times_proposed`/`status` split is the book's restraint principle, arrived at independently.
- `grep` over `whatsapp-bridge/src/store.js` returned no matches in this sandbox even for strings
  the file demonstrably contains. `sed`/`awk`/`node` read it correctly. Any future audit of that
  file should not trust a silent grep.

## Documents worth reading in full

| Document | ID | Why |
|---|---|---|
| Building Ambient AI Agents (ch. 1–3 only) | `7aef0d5e` | Same product category. Restraint layers, memory objects, episode discipline. |
| Agents All the Way Down | `da3cab08` | 791 sentences. Security-in-the-scaffolding, hooks, liteshell, MCP-vs-CLI cost model. |
| Evals for AI Engineers | `bfd8ddf3` | Directly addresses the one unbuilt verification layer. |
| Building Applications with AI Agents | `40c73f7f` | HITL failure taxonomy; agentic threat vectors. |
| AI Security Engineering | `0a3550a3` | 560 sentences. Controls outside the prompt. |
