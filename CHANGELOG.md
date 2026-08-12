---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "scripts/gen-changelog.ts (from Conventional Commit subjects)"
  date: "2026-08-12"
---

# Changelog

Generated from the commit history by `npm run changelog`. **Do not hand-edit** —
the next run overwrites it. To change an entry, the commit subject is the source.

This project follows [Conventional Commits](https://www.conventionalcommits.org/)
and [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- reach each model through the endpoint that accepts its tools, and search the web (`c7edfa9`)
- check the documentation against the code, in CI (`76c0b38`)
- the queue you can act on, instead of a phone and a curl (`7039e82`)
- the archive can say what period it covers, and obligations can be windowed by it (`779b712`)
- derive every model limit from a registry, and move to gpt-5.6-luna (`d89bcfe`)
- warn on the phone when a conversation passes 80% of the context window (`800a67d`)
- build documents with FrameForge and deliver them into WhatsApp (`b805732`)
- complete the protocol send surface, and describe what arrives on it (`f9b53c9`)
- implement message classification and translation layer for WhatsApp protocol (`cd58f8e`)

### Fixed

- the browser is gone from the code that outlived it (`857cac8`)
- the identity guard could not see the names it was guarding (`0429620`)
- the archive holds a shorter name than the one people use (`44cf78e`)
- assemble the pairing placeholder, so the identity guard stops flagging it (`a9a4232`)
- a conversation the archive holds must never read as empty (`7cecc68`)
- one answer per turn, however many times the runtime runs it (`25a32a1`)
- a turn that dies now says so, instead of leaving the chat silent (`5e8f88b`)
- align the agent's tool surface with what the bridge actually returns (`d431b96`)

### Documentation

- scrub a real name from the quarantined draft (`21149ab`)
- regenerate the changelog (`ae85b18`)
- make every document describe the system that exists (`da153ae`)
- say which name the send allowlist actually matches (`06dede8`)
- update HOWTO-TRANSPORT-SETUP.md for contact name placeholders and add PRODUCT-DRAFT.md (`93d432b`)

### Other

- Initial Commit (`55185cb`)
