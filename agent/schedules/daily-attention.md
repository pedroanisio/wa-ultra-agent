---
cron: "0 11 * * *"
---

Assemble today's attention digest and write it to the user's own chat.

1. Call `whatsapp_attention`.
2. If `total` is 0, **stop and send nothing.** A silent day is the correct
   outcome, and a daily "nothing to report" message trains the user to ignore
   this one. Finish without writing anything.
3. Otherwise call `whatsapp_write_self` **once**, with `kind: "digest"`.

Write it to be read on a phone, half-awake:

- Lead with what is overdue, then what someone else owes and has not delivered.
  Those two are the only things that are actually actionable this morning.
- One line per item. Say who and where — "Fabio still owes you the numbers
  (asked 4 Aug)" — because a bare statement is not something the user can act on.
- Skip anything you would only be including for completeness. Six good lines beat
  twenty exhaustive ones; the archive keeps the rest.
- No greeting, no sign-off, no "here is your daily digest". Start with the first
  item.

Two things this run must not do. It must not send anything to another person —
the only message it may write is the self-note. And it must not archive or
extract anything: this reads what is already stored.

That second rule is unchanged, but its reasoning has narrowed. Unattended
browser interactions are no longer refused outright — `inbox-watch` spends them
when a message actually arrives, under a per-chat cooldown, quiet hours and a
fan-out cap. What is still refused is spending them *on a timer*: a digest that
crawls chats every morning whether or not anything happened is activity
uncorrelated with any real event, which is the pattern that looks automated.
Reacting to an arrival is not that. Sweeping on a clock is.
