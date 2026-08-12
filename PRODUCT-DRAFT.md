---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5 (1M context) via Claude Code"
  date: "2026-08-11"
---

# Product draft

**Status.** A proposal, not a decision. Every claim about the current code was checked
against `master` at `640fba3` and is marked ✅ verified or ⚠ unverified. Every rename is
a candidate; none has been applied. Nothing here is implemented.

---

## What the product is

**A conversation record.** Every chat you let it read is archived locally with
content-addressed message keys, and everything derived from it — claims about people,
open obligations, strands of work, each side's goals.

**A reading of each conversation.** Per chat: measured cadence with sample sizes, the
standing frame (language, register, what must not be raised), the strands running through
it, and what each side wants from each strand. Timestamped, with an explicit staleness
marker — `twin_passes.through_message_key` means "how much has happened since I last
looked" is a count, not a feeling.

**A shared composer.** One surface where you and the agent both write into the same
thread, where every message shows who shaped it, and where how much the agent may do is
set per relationship rather than globally.

The product is the third layer. The first two are what make it possible to trust, and they
already exist in the repo. **The third does not exist at all** — not partially, not as a
prototype. Its whole cost is still ahead.

---

## The problems it solves

Ordered by how much they hurt, not by how interesting they are.

| Problem | What it looks like | What answers it |
|---|---|---|
| **Invisible backlog** | 60 threads, and you can't tell which are waiting on you from which are waiting on them | The four-bucket ledger: overdue, due soon, they owe, unanswered. Sorted by who owes whom, never by recency ✅ built |
| **The n-month thread** | "What did we agree in March, and what's still open?" | Strands + goals + obligations, each citing its message. ⚠ Today this cannot even show current status reliably — see *The goal defect* below |
| **The blank composer at 23:40** | You know you have to reply; you don't know what to say, in your register, in the right language | Proposed moves with a draft that obeys the frame — the language, the register, the length your own messages actually run ✅ built |
| **The oversight tax** | Approve forty drafts a day and you stop reading them; approve none and the agent is a toy | Permission set per relationship, plus a hold window that turns *may I?* into *stop that*. ⚠ Neither exists |
| **Can I believe it about a person?** | The tool tells you your partner is stalling. On what basis? | Citations on everything; counted separated from read; retraction that leaves a tombstone ✅ built |
| **It must not speak for me** | An agent that promises money or a date in your name has done real damage | `needs_user_wording`, raised deterministically ✅ built |

### One correction to the last row

The draft previously read *"raised deterministically, will learn from the context and
confidence."* Those are two incompatible designs and the second is already refused by
`SPEC.md` §6.1: *"No confidence-scored autonomy, ever. Widening the boundary from 'a named
list' to 'whenever the model is sure' … is still refused."*

A commitment flag that learns is a commitment flag that can be wrong in a new way each
week, and its failure mode is silence — it simply stops raising. Keep it deterministic:
a fixed set of triggers (money, a date, an apology, a promise), stated in the tool, testable
without a model. If the trigger set is too narrow, widen the *set*, not the *mechanism*.

---

## The goal defect this draft should name

⚠ **Verified live bug, not a gap.** `goals` is written with `INSERT OR IGNORE` on a key of
`(arc, holder, statement)`. `status` is not part of that key, there is no `UPDATE goals`
anywhere in the store, and there is no `resolveGoal` — though `resolveExtraction`,
`resolveArc` and `resolveProposal` all exist. Proven against a real store:

```
pass 1 · March · "get the tiler booked", open  → status = open
pass 2 · July  · same goal, status: met        → {inserted: 0, duplicates: 1}
after pass 2                                   → status = open   (new status discarded)
```

**A goal's status is frozen at first observation, permanently.** `GOAL_STATUSES` enforces
the vocabulary on write, but only the first pass can set it.

This matters to the product, not just the schema: the agent proposes moves against goals
that were met weeks ago, so it chases finished things. That is precisely the *"an assistant
that forgets it was told no is an assistant that nags"* failure the `proposals` table spends
its entire design avoiding, reproduced on `goals` where nobody had looked.

Fix order: `resolveGoal` + a real upsert first (small, ship it regardless of any product
decision), then `goal_transitions`.

---

## The naming

Renames are cheapest **now** and get more expensive at every release. Once a UI hardcodes
`arcs` or a skill references `whatsapp_next_best`, a rename is a breaking change across the
store, the HTTP surface, 25 tool files, `agent/skills/*`, `SPEC.md` and `README.md`. The
store now has a `user_version` migration harness and a schema-drift test, so table renames
are mechanically safe — but they are not free.

### Store concepts

The table below is now a **complete inventory**. The previous version omitted five tables,
which made it impossible to tell "keep" from "not yet considered".

| Now | Rename to | Why |
|---|---|---|
| `facts` | **`claims`** (+ `tier`, see caveat) | Stops asserting truth. `facts` names a property the row cannot guarantee |
| `extractions` | **`obligations`** (`owner ∈ {user, them}`) | Named for the row, not the process. An unanswered question *is* an obligation — someone owes an answer |
| `arcs` | **`matters`** (runner-up: `strands`) | "Arc" is unpronounceable in context and a mockup nav already mistyped it as "Arches". A *matter* is a named strand of work with parties and open questions — a word consultants and lawyers already use, and it survives translation |
| `contexts` | **`frames`** | Maximally generic name on the most specific content. The UI already labels it FRAME |
| `twin` / `twin_passes` | **`readings`** | It is a reading of a conversation: partial, dated, revisable. Kills the simulation implication in one word |
| `chat_touches` | **`opens`** | Says what it records — and see *The read receipt* below, which is the real reason this name is right |
| `events` | **`arrivals`** | Distinguishes "a message landed" from every other kind of event |
| `goals` | **`goals`** (keep) | Already correct, and `holder` is already the load-bearing column |
| `proposals` | **`proposals`** (keep) | One message-level move. Now genuinely distinct from `courses` ↓ |
| `messages`, `chats`, `transcripts` | **keep** | Transport nouns. Renaming them buys nothing and touches every FK |
| `aliases` | **keep** | Accurate, and it now carries `origin` provenance |
| — | **`courses`** (new) | Two to four exclusive postures over one matter, each with cost and wrong-if |
| — | **`stances`** (new) | The taken course, held until it expires. The memory object the codebase is missing |
| — | **`goal_transitions`** (new) | Append-only status history. Without it the timeline is a lie — and see the goal defect above, which must be fixed first |
| — | **`people`, `chat_participants`** (new) | ⚠ The identity layer — but read the constraint below before planning on it |

#### Caveat on `claims` + `tier`

Folding *counted / read / projected* into one table is half right. **`read` and `projected`
belong together** — both are model output, both need a citation, and a projection is exactly
a read claim with a wrong-if. Putting them in one table with a `tier` column makes the
notation enforceable rather than decorative: a projection can be *required* to carry a
wrong-if, and the renderer stops promising something the row does not guarantee.

**`counted` does not belong there.** Counted values are arithmetic over `messages` —
computed on read by `interactionMetrics`, never stored. A `counted` row would be a cache of
a pure function, and a cache that can disagree with its own inputs is the exact failure the
codebase already rejected when it chose to join `messages.outgoing` rather than store a
direction column. Keep counted values computed; let `tier ∈ {read, projected}` and have the
UI place the third tier from metrics.

#### The identity constraint, which is load-bearing

⚠ **WhatsApp Web renders no contact id and exposes no contact list.** Identity in this
system is the *chat name* — that is why `resolveContact` does fuzzy name matching and
reports ambiguity rather than guessing, and why aliases exist at all.

So `people` and `chat_participants` cannot get stable keys from the transport. A `people`
row would be keyed on a display name that the other person can change, that collides
between a contact and a group, and that arrives differently in group headers than in
one-to-one chats. This is not a schema problem to design around; it is a property of the
transport.

Consequence for the roadmap: the identity layer is the **highest-risk** item in this
document, and the secondary ICP depends on it entirely. It should be prototyped against
real message rows before any of it is promised.

### Tools

⚠ **The prefix change is a decision this draft made silently, and it should be explicit:**
every tool is currently `whatsapp_*` (25 files). The table proposes `im_*`.

The case for it: the product is not WhatsApp-specific in principle, and `im_` (instant
messaging) leaves room for a second transport without renaming everything a second time.
The case against: there is no second transport, `SPEC.md` §3.4 marks some transports
impossible, and a speculative abstraction in a name is still speculation. **Recommendation:
make the prefix decision separately from the verb-and-noun decisions below, which stand on
their own merits either way.**

| Now | Rename to | Why |
|---|---|---|
| `next_best` | **`propose_moves`** | Plural. The name currently contradicts the design, which returns up to `MAX_PROPOSALS` |
| `model_interaction` | **`reread_conversation`** | Verb = writes |
| `twin` | **`conversation_reading`** | Noun = reads. The pair is now decidable from the name alone |
| `attention` | **`ledger`** | Names the four buckets, not the emotion |
| `extract_actions` | **`extract_obligations`** | Matches the table |
| `remember_fact` / `retract_fact` | **`record_claim`** / **`retract_claim`** | "Remember" implies it became true |
| `archive_chat` | **`ingest_history`** | Removes a genuine ambiguity with WhatsApp's own Archive feature |
| `get_context` | **`frame`** | Matches the renamed table, and the UI label |
| `person` | **`person_dossier`** | The internal function is already `personDossier` ✅ verified |
| `write_self` | **`note_to_self`** | Says who receives it, which is the whole safety property of that path |
| `resolve_proposal` | **`close_proposal`** | ✅ Verified collision: `resolve_contact`, `resolve_obligation` and `resolve_proposal` all exist, and only the first two mean the same thing |
| `inbox_events` | **`arrivals`** | Matches the renamed table; drops "inbox", which the product does not have |

### Interface surfaces

Layout words leaked into the product vocabulary. Rail, thread, drawer and bar describe
screen furniture, not what a user is looking at.

| Deck / mockup | Rename to | Why |
|---|---|---|
| rail | **Owed queue** | It's sorted by who owes whom; the name should say so |
| drawer, depths 1–3 | **Standing / Matter / Courses** | Three named panels beat three numbered depths |
| bar | **Budget bar** | Keep, and add the missing line — see below |
| Autonomy ladder: Observe / Brief / Suggest / Draft / Send within bounds | **Watch / Read / Suggest / Draft / Send** | All verbs, one syllable, same part of speech. "Brief" was a noun in a list of verbs |
| "Drafted, you edited · hybrid" | **"Yours, agent-drafted"** | "Hybrid" tells the reader nothing about who is accountable. The new name puts you first, because you are |
| falsifier | **wrong if** (user-facing) | The UI copy is already better than the term |
| standing strategy | **stance** | Shorter, and a stance is something you visibly hold and can be shown to have outgrown |
| what-if | **consequence probe** — or just label it *"if I do nothing"* | It deliberately does not simulate the other person; the name must not suggest it does |
| NER graph | **Relationship map** (personal) / **Account map** (business) | It isn't named-entity recognition. NER is a technique, not a view, and the content is people, goals and tension |
| Objectives War Game | **Objectives board**, adversarial skin opt-in per chat | Tank icons over `Goal: Son's Reunion` assert that your family is a contest with a win condition |
| Emotional Tone 70% | **Observed cadence** | Report the behaviour measured, not the feeling inferred |
| Response Probability 90% | **Measured reply rate (n=41)** | Same information, honestly denominated |

**Product name.** Not decided. The direction is *a desk for relationships you are
accountable to* — candidates worth testing: **Desk**, **Standing**, **Receipts**,
**Second Hand**. A starting set, not a shortlist.

---

## ICP

**Primary — the solo operator whose income lives in WhatsApp threads, technical enough to
self-host.** Independent consultants; brokers in property, insurance and freight;
contractors and renovation project managers; boutique agency founders; solo architects and
lawyers. In WhatsApp-first markets: Brazil, Mexico, India, Indonesia, Nigeria, South
Africa, Italy, Spain, the Gulf.

Why this ICP fits the product as it actually is: one account, one operator, no shared
visibility, and a willingness to run a container. Every one of those is a current
constraint rather than a positioning choice.

**Secondary — 2–8 person partner-led firms where each partner owns their own
relationships.** This is where the account-map framing earns its place. It needs
multi-account, participant identity, and a shared claims store with per-partner visibility.

⚠ **Not buildable on today's schema, and the blocker is the identity constraint above, not
effort.** Participant identity cannot be derived from a transport that exposes no contact
id. Say so rather than selling it.

---

## Two things the renaming exposes

### The read receipt

The interaction budget is framed entirely as a cost to **you** — reads left, cooldown,
quiet hours. But opening a chat through WhatsApp Web marks messages read, and that **sends
a signal to the other person.** The agent reading at 03:14 and saying nothing changes what
your contact believes about you.

⚠ **Verified: the repository does not mention read receipts anywhere.** Not in the code, not
in `SPEC.md`, not in `README.md`. The `chat_touches` docblock frames the cooldown purely as
keeping "the session from looking automated" — a detection concern about the platform, with
no mention of the human on the other end.

`opens` is therefore the right name, because it names **an act with two observers.** Three
consequences worth deciding on:

1. **Quiet hours currently protect the wrong party.** They stop the agent waking *you* at
   04:00. They do not stop it marking *her* messages read at 04:00. If quiet hours are about
   not behaving strangely, they should gate reads, not only notifications.
2. **The budget bar should show the outward cost, not only the inward one.** "6 reads left"
   is a rate limit. "3 chats marked read since 22:00" is a behavioural fact about you that
   someone else can see.
3. **`opens` should record whether a receipt was sent**, because that is the difference
   between a read the archive paid for and a read the *relationship* paid for.

### `claims` with a `tier` is worth more than a rename

Right now "counted vs read vs projected" is a drawing convention in a design document. As a
column it becomes enforceable: a projection can be required to carry a wrong-if, a read
claim can be required to carry a citation, and the notation on screen stops being a promise
the renderer makes and becomes a property of the row.

That is the general principle worth extracting from this whole naming exercise: **a
distinction that lives only in a document is a distinction that will be violated.** The
ones that survive are the ones a foreign key or a `NOT NULL` enforces.

---

## What this document does not settle

Listed so they are not mistaken for decided.

- **The `im_*` prefix.** A speculative abstraction against a second transport that does not exist.
- **`matters` vs `strands`.** Both work; `matters` reads better in business contexts, `strands` in personal ones. The product serves both.
- **Whether `counted` claims are stored or computed.** Recommended computed, above.
- **The identity layer.** Highest-risk item here, and blocked by the transport rather than by effort.
- **Product name.** Four candidates, no test yet.
- **Whether the adversarial skin ships at all.** Opt-in per chat is a mitigation, not a decision that it should exist.
