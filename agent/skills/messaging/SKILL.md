---
description: Use when acting on a WhatsApp message rather than writing a new one — reacting, correcting a typo, deleting something sent in error, running a poll, or showing a typing indicator. Also covers when a send stops for approval, and what to do when the account is not linked.
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5 (1M context) via Claude Code"
  date: "2026-08-12"
---

# Acting on messages, not just sending them

Sending is the loudest thing this agent can do and it is rarely the only option.
Most of what looks like "reply to this" is better served by something smaller.

| The situation | Reach for |
|---|---|
| Something needs acknowledging, not answering | `whatsapp_react` |
| The user's last message has a typo or a wrong date | `whatsapp_edit_message` |
| A message went to the wrong chat | `whatsapp_revoke_message`, immediately |
| A group needs to pick between options | `whatsapp_poll` |
| A considered reply is about to take a while | `whatsapp_presence` first |
| A chat shows as a long `pn:` or `@lid` string | `whatsapp_refresh_names` |
| The user explicitly asks for a voice message | `whatsapp_send_voice` |
| Anything at all just failed | `whatsapp_status` |

## Every one of these addresses ONE exact message

`messageId` is the message's `key` as the archive stores it — the protocol's own
id. Take it from a row you actually read, never from memory and never
constructed. In a group also pass `sender`, because the message you are acting on
may be somebody else's.

A wrong id does not fail loudly. It addresses a different message.

## Reacting is usually the right size

A 👍 costs the reader nothing, commits the user to nothing, and ends the
exchange. It needs no approval for exactly that reason. An empty `emoji` takes a
reaction back.

Prefer it whenever the honest content of a reply is "seen" or "thanks".

## Editing corrects; revoking admits

Both are visible. WhatsApp marks an edited message as edited and leaves "This
message was deleted" where a revoked one was — so neither hides anything, and
saying otherwise to the user would be false.

- **Edit** is for a wrong word, a wrong number, a wrong date, while the window
  WhatsApp allows is still open. If it has closed, say so; do not send the
  correction as a new message unless asked.
- **Revoke** is for a message that should not have gone at all. Speed matters
  more than deliberation here — it is the only undo that exists — so do not stop
  to draft an explanation first. Revoke, then tell the user.

## Presence is a signal to a real person

`composing` means someone is typing. Send it immediately before a message that
took time to prepare, so the pause reads as thought rather than absence. Never
send it to look busy: an indicator not followed by a message is a small lie told
in the user's name, and they are the one it is told for.

## When a send stops for approval

`whatsapp_send_message` pauses when the message commits the user — money, a time,
an apology, a promise, or anything unusually long. That pause is the guard
working. Show the user the exact text you intend to send and wait; do not
rephrase it to slip under the policy, and do not fall back to
`whatsapp_write_self` unless they ask for a draft instead.

The recipient allowlist is separate and lives in the bridge. A `403` there is
final: say who was refused and stop.

## Voice notes are not a nicer way to send text

`whatsapp_send_voice` synthesises speech and sends a real push-to-talk bubble.
Use it **only when the user asks for a voice message.** It is not an upgrade to
a text reply:

- It cannot be skim-read. The recipient has to stop and listen, in order, at the
  speed it was spoken.
- It arrives in the medium people read as someone being present, and nothing on
  the bubble says a machine read it out.
- It cannot be edited afterwards the way a text message can, so a spoken
  commitment is final in a way a typed one is not — which is why it carries the
  same approval gate as sending text.

Write for the ear: short sentences, no bullet points, no markdown, no links.
None of that survives being read aloud.

**Leave `to` empty to send it to the user's own chat.** That reaches nobody else
and is the right way to let them hear a note before a person does — offer it
whenever the wording matters.

The voice is a synthetic one and does not sound like the user. That is the
honest outcome; do not describe it to them as sounding like them.

## When nothing works

`whatsapp_status` tells the three failures apart, and they look identical from
the outside:

- **not reachable** — the bridge is down; nothing can be read or sent.
- **not configured** — no transport; the operator must set `WA_TRANSPORT_URL`.
- **not linked** — the account was never paired, or has been unlinked.

`linked: false` is the one to read first. Say it plainly and stop; every other
WhatsApp tool will fail until it is fixed, and retrying them only produces more
confusing errors. Never tell the user to re-pair while the transport reports
`paired` but not connected — a re-pair during login can cost the session.
