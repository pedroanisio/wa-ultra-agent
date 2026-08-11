---
cron: "0 12 * * 0"
---

Bring the interaction twins back up to date, and tell the user only about the
conversations where something is actually waiting on them.

1. Call `whatsapp_twin` with **no chat**. It lists the conversations whose twin
   has fallen behind the archive.
2. Take at most **five** of them, most-drifted first, and run
   `whatsapp_model_interaction` on each. Stop at five even if there are twenty:
   the rest are still there next week, and a sweep that grows without a bound is
   how a weekly job becomes an expensive one.
3. For each chat that came back with an **open or stalled** arc, or with
   something outstanding in either direction, call `whatsapp_next_best`. Skip the
   ones that produced no arc — there is nothing to propose against.
4. Keep only the moves that are genuinely waiting on the user: a `follow_up` on
   something overdue, a `deliver` on something they owe, a `reply` to a question
   that is still unanswered. Drop every `wait`, and drop anything whose reasoning
   amounts to "it has been a while".
5. If nothing survives step 4, **stop and write nothing.** No "everything looks
   fine" note. That is the normal outcome of a quiet week and the whole reason
   this run is worth having.
6. Otherwise write **one** `whatsapp_write_self` note with `kind: "digest"`.

Writing the note:

- One line per conversation, not per move. Lead with the person and what is
  waiting: "Fabio — still owes you the numbers, asked 4 Aug; you last chased on
  the 6th".
- Include the draft only where you have one and it is short. A note the user has
  to edit before using is worse than a note that just tells them what is open.
- Mark anything flagged as theirs to word. Those are for them to write, and the
  note is exactly the right place for it.
- Say when a twin is stale and could not be refreshed, in one line at the end.
  A picture the user thinks is current when it is not is the failure this whole
  layer exists to prevent.
- No greeting, no sign-off, no "here is your weekly review". Start with the first
  conversation.

Three things this run must not do. It must not send anything to another person —
the only message it may write is the self-note. It must not archive, read, or
open a chat: modelling and proposing both read the stored archive, and if the
archive is behind, that is a note to the user, not a reason to start scraping on
a timer. And it must not propose a move it cannot ground in the twin.

> **Why this is allowed on a clock at all.** `daily-attention` refuses to spend
> browser interactions on a timer, and that rule stands. Nothing in steps 1–5
> touches WhatsApp: `whatsapp_twin`, `whatsapp_model_interaction` and
> `whatsapp_next_best` all read and write SQLite only. The single self-note in
> step 6 is the one interaction this run can cost, it happens only when there is
> something real to say, and it is the same trade the daily digest already makes.
> If the bridge reports quiet hours, skip the note and let next week's run carry
> it — the modelling is already saved.
