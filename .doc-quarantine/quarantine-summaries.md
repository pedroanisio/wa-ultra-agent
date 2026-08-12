---
disclaimer: >
  These summaries are institutional memory for documents proposed for
  retirement. They were written from the documents' own contents at audit
  time and are not independently verified. Keep this file even if the
  documents themselves are deleted.
generated_by: "Claude Opus 5 (1M context) via Claude Code — doc-hygiene skill"
date: "2026-08-12"
---

# Quarantine Summaries — whatsapp-agent

Two documents are proposed for retirement. Neither has been moved or deleted.
Each summary below is written to survive the document it describes.

---

## `spec-draft.md` — DEPRECATED

**775 lines · 1 commit · last modified 2026-08-11 · never co-committed with code**

**Evidence of supersession**: `SPEC.md:3` states verbatim — *"**Status:**
revision of `spec-draft.md`, re-grounded on this repository (eve `0.31.3`,
2026-08-10), then reconciled against the built code on 2026-08-10."*

**TL;DR.** The original architecture proposal for a WhatsApp agent, written
before the project's transport approach was settled. It argues that once the
transport problem is solved the interesting part is not WhatsApp integration but
the set of tools the agent can invoke — a thesis the finished system kept. Its
proposed *mechanism*, however, was not kept: it sketches an inbound path through
Meta's official WhatsApp Business Platform webhooks with outbound via the Cloud
API, plus WhatsApp Flows for structured interactions, and an OpenAI
Responses-API runtime exposing internal systems as callable functions. The
project went a different way, building its own Go protocol transport
(`whatsapp-transport/`) speaking the WhatsApp protocol directly, with a Node
bridge holding the archive and allowlists.

**Why it existed**: to establish that the tool surface, not the messaging
integration, was the product.

**What superseded it**: `SPEC.md` (1,143 lines), which re-grounded every claim
against the actual repository and reconciled the document against built code.

**Residual value**: historical. It is the only record of which architecture was
considered and rejected, and why. That is worth archiving rather than deleting —
the question "why didn't you just use the Business API?" has an answer here.

---

## `PRODUCT-DRAFT.md` — ORPHANED

**279 lines · 2 commits · last modified 2026-08-11**

**Broken references**:
- Commit `640fba3` — its stated verification basis — **does not exist in this
  repository** (`git cat-file -t 640fba3` fails).
- Branch `master` — the repository's default branch is `main`.

**TL;DR.** A product-framing proposal that translates the system's engineering
vocabulary into language for a non-engineering audience, and proposes how the
project would be described publicly. It is explicitly labelled *"A proposal, not
a decision"*, so its status was never in doubt.

Its problem is not its prose but its epistemic device. The document marks every
claim about the current code as ✅ verified or ⚠ unverified "against `master` at
`640fba3`". That commit is absent from this repository, and no branch named
`master` exists here. The verification apparatus is therefore unfalsifiable:
a reader cannot check a single ✅, and the marks convey a confidence that cannot
be audited. This is precisely the failure mode `DISCLAIMER.md` and CLAUDE.md's
"Formalization means research" rule exist to prevent — a citation that looks
rigorous and resolves to nothing.

**Why it existed**: to give the project a product narrative and a naming scheme
legible outside engineering.

**Recommended action**: archive, **or** re-ground it — re-verify each ✅ claim
against a commit that exists in this repository and update the header. The prose
may well still be accurate; the point is that nobody can currently tell.

**Residual value**: the naming and framing work is reusable and is not
invalidated by the broken commit reference. Only the verification marks are.

---

## Not quarantined

Recorded here so the decisions are not re-litigated later:

- **`CORPUS-FINDINGS.md`** and **`SURFACE_GAP_AUDIT.md`** — point-in-time
  analysis artifacts. Both declare their own snapshot date in their headers and
  are *supposed* to describe a past state. Judging them by freshness is a
  category error. Recommendation is structural, not lifecycle: move to
  `reports/` with the date in the filename.
- **`agent/skills/web-search/SKILL.md`** — untracked, but pairs with an
  untracked and working `agent/tools/whatsapp_search_web.ts`. New work awaiting
  commit, not dead weight.
