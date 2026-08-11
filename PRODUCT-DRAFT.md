## What the product is

**A conversation record.** Every chat you let it read is archived locally with content-addressed message keys, and everything derived from it — claims about people, open obligations, strands of work, each side's goals.

**A reading of each conversation.** Per chat: measured cadence with sample sizes, the standing frame (language, register, what must not be raised), the strands running through it, and what each side wants from each strand. Timestamped, with an explicit staleness marker — `twin_passes.through_message_key` means "how much has happened since I last looked" is a count, not a feeling.

**A shared composer.** One surface where you and the agent both write into the same thread, where every message shows who shaped it, and where how much the agent may do is set per relationship rather than globally.

The product is the third layer. The first two are what make it possible to trust, and they already exist in your repo. The third does not .

## The problems it solves

Ordered by how much they hurt, not by how interesting they are.

| Problem                              | What it looks like                                                                              | What answers it                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Invisible backlog**                | 60 threads, and you can't tell which are waiting on you from which are waiting on them          | The four-bucket ledger: overdue, due soon, they owe, unanswered. Sorted by who owes whom, never by recency                      |
| **The n-month thread**               | "What did we agree in March, and what's still open?"                                            | Strands + goals + obligations, each citing its message. Today this can only show _current_ status — the gap I flagged last turn |
| **The blank composer at 23:40**      | You know you have to reply; you don't know what to say, in your register, in the right language | Proposed moves with a draft that obeys the frame — the language, the register, the length your own messages actually run        |
| **The oversight tax**                | Approve forty drafts a day and you stop reading them; approve none and the agent is a toy       | Permission set per relationship, plus a hold window that turns _may I?_ into _stop that_                                        |
| **Can I believe it about a person?** | The tool tells you your partner is stalling. On what basis?                                     | Citations on everything; counted separated from read; retraction that leaves a tombstone                                        |
| **It must not speak for me**         | An agent that promises money or a date in your name has done real damage                        | `needs_user_wording`, raised deterministically, will learn from  the context and confidence                                     |

## The naming 

### Store concepts

|Now|Rename to|Why|
|---|---|---|
|`facts`|**`claims`** + `tier ∈ {counted, read, projected}`|Stops asserting truth, and folds the deck's "three tiers of claim" into the same word instead of a second vocabulary|
|`extractions`|**`obligations`** (`owner ∈ {user, them}`)|Named for the row, not the process. An unanswered question _is_ an obligation — someone owes an answer|
|`arcs`|**`matters`** (runner-up: `strands`)|"Arc" is unpronounceable in context and your own mockup nav mistyped it as "Arches". A _matter_ is a named strand of work with parties and open questions — a word consultants and lawyers already use, and it survives translation|
|`contexts`|**`frames`**|Maximally generic name on the most specific content. Your UI already labels it FRAME|
|`twin` / `twin_passes`|**`readings`**|It is a reading of a conversation: partial, dated, revisable. Kills the simulation implication in one word|
|`chat_touches`|**`opens`**|Says what it records: when a chat was opened and what it cost|
|`events`|**`arrivals`**|Distinguishes "a message landed" from every other kind of event|
|`proposals`|**`proposals`** (keep)|One message-level move. Now genuinely distinct from ↓|
|—|**`courses`** (new)|Two to four exclusive postures over one matter, each with cost and wrong-if|
|—|**`stances`** (new)|The taken course, held until it expires. The memory object your codebase is missing|
|—|**`goal_transitions`** (new)|Append-only status history. Without it the timeline is a lie|
|—|**`people`, `chat_participants`** (new)|The identity layer that everything cross-relationship depends on|

### Tools

| Now                                 | Rename to                                      | Why                                                                            |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `im_next_best`                      | **`im_propose_moves`**                         | Plural. The name currently contradicts the design                              |
| `im_model_interaction`              | **`im_reread_conversation`**                   | Verb = writes                                                                  |
| `im_twin`                           | **`im_conversation_reading`**                  | Noun = reads. The pair is now decidable from the name alone                    |
| `im_attention`                      | **`im_ledger`**                                | Names the `N` buckets, not the emotion                                         |
| `im_extract_actions`                | **`im_extract_obligations`**                   | Matches the table                                                              |
| `im_remember_fact` / `retract_fact` | **`im_record_claim`** / **`im_retract_claim`** | "Remember" implies it became true                                              |
| `im_archive_chat`                   | **`im_ingest_history`**                        | Removes a genuine ambiguity with WhatsApp's own Archive                        |
| `im_get_context`                    | **`im_frame`**                                 |                                                                                |
| `im_person`                         | **`im_person_dossier`**                        | Your own internal function is already `personDossier`                          |
| `im_write_self`                     | **`im_note_to_self`**                          |                                                                                |
| `im_resolve_proposal`               | **`im_close_proposal`**                        | "Resolve" collides with `resolve_contact`, which means something else entirely |
| `im_inbox_events`                   | **`im_arrivals`**                              |                                                                                |

### Interface surfaces

The deck's layout words leaked into the product vocabulary. Rail, thread, drawer, bar describe screen furniture, not what a user is looking at.

|Deck / mockup|Rename to|Why|
|---|---|---|
|rail|**Owed queue**|It's sorted by who owes whom; the name should say so|
|drawer, depths 1–3|**Standing / Matter / Courses**|Three named panels beat three numbered depths|
|bar|**Budget bar**|Keep, and add the missing line — see below|
|Autonomy ladder: Observe / Brief / Suggest / Draft / Send within bounds|**Watch / Read / Suggest / Draft / Send**|All verbs, one syllable, same part of speech. "Brief" was a noun in a list of verbs|
|"Drafted, you edited · hybrid"|**"Yours, agent-drafted"**|"Hybrid" tells the reader nothing about who is accountable|
|falsifier|**wrong if** (user-facing)|Your own UI copy is already better than your term|
|standing strategy|**stance**|Shorter, and a stance is something you visibly hold and can be shown to have outgrown|
|what-if|**consequence probe** — or just label it _"if I do nothing"_|It deliberately does not simulate the other person; the name should not suggest it does|
|**NER graph**|**Relationship map** (personal) / **Account map** (business)|It isn't named-entity recognition. NER is a technique, not a view, and the actual content is people, goals and tension|
|**Objectives War Game**|**Objectives board**, with an adversarial display mode|Tank icons over `Goal: Son's Reunion` assert that your family is a contest with a win condition. Make the skin opt-in per chat|
|Emotional Tone 70%|**Observed cadence**|Report the behaviour you measured, not the feeling you inferred|
|Response Probability 90%|**Measured reply rate (n=41)**|Same information, honestly denominated|

Product:  **relationship desk** — directions worth testing: _Desk_, _Standing_, _Receipts_, _Second Hand_. Not a decision, a starting set.

## ICP

**Primary ICP — the solo operator whose income lives in WhatsApp threads, technical enough to self-host.** Independent consultants, brokers (property, insurance, freight), contractors and renovation project managers, boutique agency founders, solo architects and lawyers — in WhatsApp-first markets: Brazil, Mexico, India, Indonesia, Nigeria, South Africa, Italy, Spain, the Gulf.

**Secondary ICP — 2–8 person partner-led firms where each partner owns their own relationships.** This is where the war-game and account-map framing earns its place. It needs multi-account, participant identity, and a shared claims store with per-partner visibility. Not buildable on today's schema, and worth saying so rather than selling it.

## Two things the renaming exposes

The rename surfaces a gap in the budget bar. Your interaction budget is framed entirely as a cost to _you_ — reads left, cooldown, quiet hours. But opening a chat through WhatsApp Web sends a read receipt. The agent reading at 03:14 and saying nothing changes what the other person believes about you, and nothing in the repo or the deck mentions this. `opens` is the right table name because it names an act with two observers.

And `claims` with a `tier` column is worth more than a rename. Right now "counted vs read vs projected" lives in a design document as a drawing convention. As a column it becomes enforceable: a projection can be required to carry a wrong-if, a counted claim can be required to have a denominator, and the notation on screen stops being a promise the renderer makes and becomes a property of the row.