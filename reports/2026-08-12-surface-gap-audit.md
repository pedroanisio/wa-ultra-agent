---
title: Surface-Gap Audit — whatsapp-agent
commit: 5e8f88b40d4e86600047b9f7f97eb4aaa4bcb79a (feat/protocol-message-types, working tree dirty)
audited_at: 2026-08-12
auditor: surface-gap-audit (skill)
artifact_kind: audit_report
disclaimer: >
  This document is a forensic classification, not a source of truth. Every
  verdict herein is tied to file:line evidence captured at audit time and is
  valid only with respect to that evidence. Statements not directly supported
  by quoted source, a resolvable path, or a reproducible command are invalid
  and must be treated as removed. Operational definitions of `fake`, `stub`,
  `placeholder`, `incomplete`, `missing`, `misleading`, and `unverifiable` are
  per the surface-gap-audit skill specification — they are not legal,
  contractual, or moral judgments about the codebase or its authors. Any
  premise or claim in this report not backed by a real logical definition or
  verifiable reference may be invalid, erroneous, or a hallucination; reject
  it on those grounds without prejudice to the rest of the report. Re-run the
  audit against current code before acting on any verdict; gaps may be closed,
  surface may have moved, evidence may have aged out.
---

# Surface-Gap Audit — whatsapp-agent

## 1. Audit metadata

- **Repository**: `/home/admin/codebases/agents/whatsapp-agent`
- **Commit / branch**: `5e8f88b40d4e86600047b9f7f97eb4aaa4bcb79a` on `feat/protocol-message-types` — uncommitted working tree (23 modified/untracked paths at audit time)
- **Audit date**: 2026-08-12
- **Auditor**: surface-gap-audit skill
- **Scope**: All three shipped services and their public surface: the eve agent (`agent/`, 11,843 LOC) — tools, skills, schedules, channels, connections; the Node bridge (`whatsapp-bridge/src/`, 7,231 LOC) — HTTP routes; the Go transport (`whatsapp-transport/`, 8,844 LOC) — HTTP routes; the developer CLI surface (root `package.json` scripts); and documented promises in `README.md`, `SPEC.md`, and the loaded `SKILL.md` files. Excluded: `test/` and `whatsapp-bridge/test/` internals (tests are not surface, per skill rule), `node_modules/`, `.output/` and `.eve/` (build artifacts), `evals/` internals (not consumer surface), and `CORPUS-FINDINGS.md` / `PRODUCT-DRAFT.md` / `spec-draft.md` (drafts, not shipped promises).
- **Tools used**: ripgrep/grep, `node --test` (both suites), `go test ./...`, `npx tsc --noEmit`, `eve build`, `npm run <script>` execution, `docker compose exec` against the running container, manual file reading.
- **Surface-element count**: 138
- **Counter-of-record**: both (automated enumeration of routes/tools/scripts; manual enumeration of documented promises)

## 2. Executive verdict

Of 138 surface elements, 133 are `real`, 2 are `missing`, 2 are `misleading`, and 1 is `incomplete`; zero are `fake`, `stub`, `placeholder`, or `unverifiable`. Severity distribution is 1 `blocker`, 4 `major`, 0 `minor`, 0 `cosmetic`, 133 `n/a`. The three worst findings are: `whatsapp_inbox_events`, a tool the loaded `whatsapp` skill instructs the model to call in a twenty-line procedural section, which does not exist anywhere in the codebase (`blocker`); the `Known limits` section of `README.md` plus five passages of `SPEC.md`, which document `src/selectors.js` and a DOM-selector architecture that the same README states 469 lines earlier was deleted (`major`); and two comments in `docker-compose.yml` telling an operator that an unconfigured transport leaves the bridge "reading the DOM as before", when the bridge's own source states it is inert without one (`major`). Every executable surface resolves to substantive implementation — 37 agent tools, 46 bridge routes and 20 transport routes each reach real I/O, and a scan of 33,000 LOC of runtime code returns zero `TODO`/`FIXME`/`HACK`/`PLACEHOLDER`/`NotImplemented` markers. The posture is: the code surface is entirely real and the executable gaps are nil; all five findings are in the documentation and developer-command surface, and four of the five are one defect wearing four hats — the browser-based architecture was removed from the code and left standing in the prose that describes it.

## 3. Surface inventory with verdicts

### 3.1 Non-`real` elements

| # | Domain | Element | Kind | Declared at | Implementation at | Verdict | Severity |
|---|---|---|---|---|---|---|---|
| 1 | `docs/promise` | `whatsapp_inbox_events` reports what has landed since the last check | documented capability | `agent/skills/whatsapp/SKILL.md:195` | not resolvable | `missing` | `blocker` |
| 2 | `cli/commands` | `npm run bridge:dev` | command | `package.json:12` | not resolvable | `missing` | `major` |
| 3 | `docs/promise` | "Every hook lives in `src/selectors.js`" — selector-degradation architecture | documented capability | `README.md:533`, `SPEC.md:130` | n/a — file deleted | `misleading` | `major` |
| 4 | `docs/promise` | "the bridge keeps reading the DOM exactly as before" — transport-optional fallback | documented capability | `docker-compose.yml:12`, `:83` | n/a — no DOM path exists | `misleading` | `major` |
| 5 | `docs/promise` | `.env.example` as the complete configuration surface | documented capability | `.env.example` (whole file) | `agent/`, `whatsapp-bridge/src/` (38 vars read) | `incomplete` | `major` |

### 3.2 `lang/exports` — agent tools (37, all `real`)

All declared at `agent/tools/<name>.ts:1` via `defineTool`, resolved to implementations in `agent/lib/*.ts` and the bridge HTTP client. Each was verified to declare a zod `inputSchema`, contain at least one `await` to real I/O, and import at least one `../lib/` module; none returns a hardcoded value independent of inputs.

`whatsapp_archive_chat`, `whatsapp_attention`, `whatsapp_calendar`, `whatsapp_console_pending`, `whatsapp_deliver_render`, `whatsapp_edit_message`, `whatsapp_extract_actions`, `whatsapp_generate_image`, `whatsapp_get_context`, `whatsapp_list_chats`, `whatsapp_model_interaction`, `whatsapp_next_best`, `whatsapp_obligations`, `whatsapp_person`, `whatsapp_poll`, `whatsapp_presence`, `whatsapp_react`, `whatsapp_read_chat`, `whatsapp_refresh_names`, `whatsapp_remember_alias`, `whatsapp_remember_fact`, `whatsapp_resolve_contact`, `whatsapp_resolve_obligation`, `whatsapp_resolve_proposal`, `whatsapp_retract_fact`, `whatsapp_revoke_message`, `whatsapp_search_archive`, `whatsapp_search_web`, `whatsapp_send_image`, `whatsapp_send_message`, `whatsapp_send_voice`, `whatsapp_status`, `whatsapp_tictactoe`, `whatsapp_transcribe_voice`, `whatsapp_twin`, `whatsapp_view_media`, `whatsapp_write_self` — **`real`**, severity `n/a`.

### 3.3 `http/routes` — bridge (46, all `real`)

Declared in `whatsapp-bridge/src/server.js` (path dispatch, lines 141–520); handlers resolve into `whatsapp.js`, `archive-query.js`, `people.js`, `twin.js`, `store.js`, `recipients.js`, `transport.js`.

`/health`, `/status`, `/send`, `/send/media`, `/send/reaction`, `/send/revoke`, `/send/edit`, `/send/poll`, `/send/poll/vote`, `/send/self`, `/send/self/media`, `/presence`, `/history`, `/media`, `/self/chat`, `/self/pending`, `/transport/status`, `/transport/contacts`, `/transport/drain`, `/transport/connect`, `/transport/pair/phone`, `/archive/names/refresh`, `/archive/chats`, `/archive/stats`, `/archive/search`, `/archive/context`, `/archive/messages`, `/archive/extractions`, `/archive/extractions/resolve`, `/archive/transcript`, `/archive/facts`, `/archive/facts/retract`, `/archive/facts/restore`, `/archive/prune`, `/archive/attention`, `/people/dossier`, `/people/resolve`, `/people/roster`, `/people/alias`, `/people/aliases`, `/twin`, `/twin/model`, `/twin/stale`, `/twin/arcs/resolve`, `/twin/proposals`, `/twin/proposals/resolve` — **`real`**, severity `n/a`.

### 3.4 `http/routes` — transport (20, all `real`)

Declared in `whatsapp-transport/internal/httpapi/api.go:173–195`; all 10 Go packages pass `go test ./...`.

`GET /health`, `GET /status`, `POST /connect`, `POST /pair/phone`, `GET /pair/qr`, `GET /outbox`, `POST /outbox/ack`, `GET /contacts`, `POST /send`, `POST /send/media`, `POST /send/reaction`, `POST /send/revoke`, `POST /send/edit`, `POST /send/poll`, `POST /send/poll/vote`, `POST /presence`, `POST /send/self`, `POST /send/self/media`, `GET /media`, `POST /history` — **`real`**, severity `n/a`.

### 3.5 `plugin/host` — skills, schedules, channels, connections (13, all `real`)

Skills `whatsapp`, `messaging`, `interaction-twin`, `tictactoe`, `frameforge`, `image-generation`, `web-search` (`agent/skills/*/SKILL.md`) — all seven registered in the `eve build` manifest with `description` + `markdown`. Schedules `daily-attention`, `inbox-watch`, `twin-refresh` (`agent/schedules/*.md`) — all carry valid `cron` frontmatter. Channels `console`, `eve` (`agent/channels/*.ts`). Connection `frameforge` (`agent/connections/frameforge.ts`). — **`real`**, severity `n/a`.

Note: the *content* of `agent/skills/whatsapp/SKILL.md` carries finding #1; the skill's registration as a plugin element is itself `real`.

### 3.6 `cli/commands` — npm scripts (10: 9 `real`, 1 `missing`)

`build`, `agent:dev`, `transport`, `transport:dev`, `transport:doctor`, `transport:test`, `test`, `typecheck`, `eval` — **`real`**, severity `n/a` (`whatsapp-transport/scripts/transport` exists and is executable; `node --test` and `tsc` were executed successfully during this audit). `bridge:dev` — see finding #2.

### 3.7 `docs/promise` — verified promises (12: 8 `real`, 1 `missing`, 2 `misleading`, 1 `incomplete`)

| Promise | Source | Verdict |
|---|---|---|
| The bridge refuses any recipient not on the allowlist | `README.md`, tool descriptions | `real` — `whatsapp-bridge/src/recipients.js:193` |
| Sending is off by default and an empty allowlist means nobody | `README.md` "Enabling send" | `real` — `recipients.js:172-181` |
| The bridge refuses to start unauthenticated | `README.md` "Bridge API" | `real` — `server.js:75` |
| Message content is untrusted and tools mark it | `README.md` "Known limits" | `real` — `whatsapp_view_media.ts:73`, `whatsapp_search_web.ts:103` |
| History depth is whatever the phone holds | `README.md` "Known limits" | `real` — `POST /history` |
| Media is listed, not read; opening one costs a fetch | `README.md` "Known limits" | `real` — `whatsapp_view_media`, `whatsapp_transcribe_voice` |
| Twin arc merging is an unbuilt operation | `README.md`, `SPEC.md:758`, §8.10 | `real` — accurately declared unbuilt |
| A test asserts the browser path cannot return | `README.md:66-68` | `real` — `whatsapp-bridge/test/anti-corruption-layer.test.js` present |
| `whatsapp_inbox_events` reports what has landed | `agent/skills/whatsapp/SKILL.md:195` | `missing` (#1) |
| Selector hooks live in `src/selectors.js` | `README.md:533`, `SPEC.md:130` | `misleading` (#3) |
| Unset transport ⇒ bridge reads the DOM as before | `docker-compose.yml:12`, `:83` | `misleading` (#4) |
| `.env.example` is the configuration surface | `.env.example` | `incomplete` (#5) |

## 4. Findings detail

### 4.1. `whatsapp_inbox_events` — missing (blocker)

**Verdict**: `missing`
**Severity**: `blocker`
**Surface declaration**: `agent/skills/whatsapp/SKILL.md:195` — a consumer reaches this by the model calling `load_skill("whatsapp")`, which returns the full markdown body into the model's context as procedure to follow.
**Implementation location**: not resolvable. No file named `whatsapp_inbox_events.ts` exists in `agent/tools/`; the identifier appears nowhere in the agent source except as a historical note.

**Evidence**:

`agent/skills/whatsapp/SKILL.md:193-208`

```markdown
## Messages that arrive on their own

`whatsapp_inbox_events` reports what has landed since the last check. The bridge
watches the chat list passively and queues each change; the tool claims that
queue and the bridge tops up the archive for whichever chats its own limits let
it open.

You are not the one deciding how much to read. By the time the tool returns, the
reads have happened and were bounded — several messages in one chat coalesce into
one read, a chat inside its cooldown is not reopened, at most a few chats per
wake, and every read draws from the same interaction budget an archive does.

Four rules:

- **`events: []` means nothing new.** One line if asked; on a scheduled run,
  silence.
- **`quiet: true` means stop.** The bridge is inside quiet hours and did nothing
```

The replacement tool documents the removal explicitly — `agent/tools/whatsapp_console_pending.ts:8-17`:

```typescript
 * ── What this replaced ──────────────────────────────────────────────────────
 * `whatsapp_inbox_events`, which is gone with the browser. That tool existed
 * because detection was free and REACTING was not: a chat could only be topped
 * up by opening it in a real browser, so the bridge held a queue and rationed
 * reads against a cooldown, a fan-out cap, a scroll cap and quiet hours. The
 * transport pushes messages into a durable outbox now, the bridge drains it
 * every few seconds, and no read costs anything WhatsApp can see. There is
 * nothing left to ration and no arrival queue to claim from.
```

Reproduction: `comm -23 <(grep -rhoE "whatsapp_[a-z_]+" agent/skills/ agent/instructions.md README.md | sort -u) <(ls agent/tools/ | sed 's/\.ts$//' | sort -u)` returns exactly `whatsapp_inbox_events`.

**Signals matched**: `missing` — strong signal "surface element is declared but its implementation cannot be resolved"; the documented capability names a callable that does not exist. Compounding: the section's twenty lines of behavioral rules (`quiet: true`, cooldowns, fan-out caps, interaction budget) describe a rationing subsystem the replacement tool states no longer exists.

**Guards considered**: G5 (test code) — ruled out, `SKILL.md` is loaded into the model's runtime context, not a test fixture. G6 (generated code) — ruled out, hand-written. G10 (documented plugin default) — ruled out, no default is registered under this name. G12/G13 (flag-gated / experimental) — ruled out, the section carries no experimental marker and no flag gates it. G2 (type-only) — not applicable.

**Tie-break applied**: `missing` vs `misleading` were both candidates — the section also materially misdescribes the arrival mechanism. `missing` wins by the precedence rule (`missing > stub > fake > placeholder > misleading > incomplete > real`).

**Remediation classification**: `realign-contract`

### 4.2. `npm run bridge:dev` — missing (major)

**Verdict**: `missing`
**Severity**: `major`
**Surface declaration**: `package.json:12` — a developer reaches this by running `npm run bridge:dev` from the repository root; it is one of ten top-level scripts.
**Implementation location**: not resolvable. The target script `start:xvfb` does not exist in `whatsapp-bridge/package.json`.

**Evidence**:

`package.json:12`

```json
    "bridge:dev": "cd whatsapp-bridge && npm run start:xvfb",
```

`whatsapp-bridge/package.json:7-10` — the complete script set:

```json
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test \"test/*.test.js\""
  },
```

Executed during this audit:

```
$ npm run bridge:dev
npm error Missing script: "start:xvfb"
```

`start:xvfb` was the Chromium-under-Xvfb launcher; `README.md:64-67` records that the browser path and its dependencies were removed.

**Signals matched**: `missing` — strong signal "command registered against an unbound handler"; the registry entry resolves to a nonexistent script.

**Guards considered**: G5 (test code) — ruled out, this is a root developer command. G6 (generated) — ruled out, `package.json` is hand-maintained. G14 (platform conditional) — ruled out, the failure is unconditional on every platform. G12 (feature flag) — ruled out, no flag gates it.

**Tie-break applied**: not required; only `missing` matched.

**Remediation classification**: `delete-surface`

### 4.3. `src/selectors.js` selector-degradation architecture — misleading (major)

**Verdict**: `misleading`
**Severity**: `major`
**Surface declaration**: `README.md:533` (in `## Known limits`) and `SPEC.md:130`, `:256`, `:284`, `:458` — an operator reaches this while diagnosing why archiving is failing, which is precisely when the "Known limits" section is read.
**Implementation location**: n/a. `find . -name "selectors.js" -not -path "*/node_modules/*"` returns nothing.

**Evidence**:

`README.md:531-538` — presented as current architecture:

```markdown
- **Selectors are unversioned.** WhatsApp Web ships obfuscated classes that
  change without notice. Every hook lives in `src/selectors.js` as an ordered
  list of candidates, so a rename degrades one selector instead of breaking the
  service — but a redesign will eventually need edits there. Archiving asserts
  the hooks it depends on before it walks a chat and refuses with a `503` naming
  the dead one, because the alternative failure is silent: a broken `messageRow`
  reads every conversation as empty and reports the archive as complete.
```

The same file, 469 lines earlier — `README.md:64-68`:

```markdown
What went with it: `src/session.js`, `src/selectors.js`, `src/lifecycle.js`,
`src/watch.js`, the `/debug/*` and `/events*` routes, `/qr`, `/chats`,
`/messages`, `/ingest`, the prepare/commit send dance, and the Playwright
dependency. `test/anti-corruption-layer.test.js` now asserts that none of it
comes back — no source file may address WhatsApp's markup or drive a browser.
```

`SPEC.md:130` states the removed module as live design: "Selector strategy is in `whatsapp-bridge/src/selectors.js`: never key on a class (WhatsApp ships…".

The drift reaches in-source documentation too — `whatsapp-bridge/src/serial.js:1-6` documents a live module's purpose entirely in terms of the removed browser, and cites a function that no longer exists anywhere in the tree (`grep -rn "commitSend" whatsapp-bridge/src/` returns only this comment):

```javascript
/**
 * One browser, one keyboard: operations must not interleave.
 *
 * Two concurrent sends would each click a composer and then type into whichever
 * conversation the other one opened last. Serialising every operation is what
 * makes the recipient check in `commitSend` meaningful.
```

The module itself is `real` — it serializes two send paths in `server.js:619,633` — but nothing it claims about why is still true.

**Signals matched**: `misleading` — heuristic 1–3: the documented contract ("a rename degrades one selector instead of breaking the service"; "refuses with a `503` naming the dead one") cannot be satisfied by any code in the repository, because neither the module nor the DOM path exists. The document runs and produces non-trivial output — an operator reading it forms a concrete, wrong model of the failure mode.

**Guards considered**: G6 (generated docs) — ruled out, `README.md` and `SPEC.md` are hand-written and are documented promises per Phase 4. G13 (experimental marker) — ruled out, no such marker. G11 (versioned pinned shape) — not applicable. The skill's Phase 4 rule explicitly places README claims in scope as promises.

**Tie-break applied**: `missing` vs `misleading` were both candidates. The promise is not merely absent — the text actively describes a live mechanism and a diagnostic (`503` naming the dead selector) that cannot occur, and `README.md:64` proves the authors know it was removed. Under precedence `missing` outranks `misleading`; however `missing` requires that the surface element be *declared but unresolvable*, and here the element is a description of behavior rather than a callable. Classified `misleading` on that basis, and the reasoning is stated so a reviewer can overturn it.

**Remediation classification**: `realign-contract`

### 4.4. "the bridge keeps reading the DOM exactly as before" — misleading (major)

**Verdict**: `misleading`
**Severity**: `major`
**Surface declaration**: `docker-compose.yml:12-14` and `docker-compose.yml:82-84` — an operator reaches this while deciding whether to configure `whatsapp-transport` at all; these comments are the guidance on what happens if they do not.
**Implementation location**: n/a. No DOM-reading path exists in `whatsapp-bridge/src/`.

**Evidence**:

`docker-compose.yml:12-14`

```yaml
  # Optional. Leave WA_TRANSPORT_TOKEN unset and the bridge keeps reading the DOM
  # exactly as before — but then this service refuses to start, so comment it out
  # too rather than running it unconfigured.
```

`docker-compose.yml:82-84`

```yaml
      # Where to drain messages from. Unset means "there is no transport": the
      # bridge reads the DOM as before and every /transport/* route answers 503.
      # Setting it moves reception onto the protocol and sends through it too.
```

The bridge's own source contradicts both — `whatsapp-bridge/src/whatsapp.js:70`:

```javascript
 * All of it is inert unless WA_TRANSPORT_URL is set, so an installation that has
```

and `whatsapp-bridge/src/server.js:188`:

```javascript
            "Sending an image requires the protocol transport. Set WA_TRANSPORT_URL; " +
```

The same `docker-compose.yml` states at line 3 that "the browser driver it replaced is gone" — the file contradicts itself nine lines later.

**Signals matched**: `misleading` — heuristic 1–3: the documented contract is graceful degradation to a prior mode; the actual behavior is an inert bridge with no reception path. An operator who follows this guidance ships a stack that silently receives nothing, which is the failure mode the surrounding documentation elsewhere takes pains to prevent.

**Guards considered**: G6 (generated) — ruled out, hand-written. G12 (feature-flag gated) — considered, since `WA_TRANSPORT_URL` is a configuration toggle; ruled out because the guard requires the documented "disabled" behavior to be accurate, and here it is not. G13 (experimental) — ruled out, no marker. G14 (platform conditional) — not applicable.

**Tie-break applied**: `missing` vs `misleading` — as with finding 4.3, the element is a description of behavior rather than a callable, so `misleading` applies; the reasoning is stated so a reviewer can overturn it.

**Remediation classification**: `realign-contract`

### 4.5. `.env.example` as the configuration surface — incomplete (major)

**Verdict**: `incomplete`
**Severity**: `major`
**Surface declaration**: `.env.example` (whole file, 42 documented variables) — an operator reaches this by copying it to `.env` during setup, which `README.md` "Setup" directs them to do.
**Implementation location**: `agent/` and `whatsapp-bridge/src/` read 38 distinct `process.env.*` variables.

**Evidence**:

Fourteen variables are read by runtime code and absent from `.env.example`:

```
OPENAI_API_KEY        WA_AGENT_URL           WA_BIND_HOST
WA_CONSOLE_IDLE_MS    WA_CONSOLE_MAX_TURNS   WA_CONSOLE_PUSH_TOKEN
WA_CONSOLE_QUEUE_PATH WA_CONTEXT_WINDOW_TOKENS
WA_DATE_ORDER         WA_ELEVENLABS_URL      WA_MODEL_ID
WA_SPEECH_MODEL       WA_SPEECH_URL          WA_TOOL_BYTE_BUDGET
```

Two of these gate advertised capabilities and one is a secret:

`agent/lib/imagegen.ts:258,273` — the key for image generation, voice synthesis and transcription:

```typescript
  const key = deps.key ?? imageDeps.key ?? process.env.OPENAI_API_KEY ?? "";
  ...
      "OPENAI_API_KEY is not set on the agent, so no image can be generated. This is configuration, "
```

`docker-compose.yml` passes `WA_CONSOLE_PUSH_TOKEN` with the comment "Its own secret, deliberately not WA_UI_PASSWORD: this grants \"the user said this\"" — a credential an operator setting up from `.env.example` is never told exists.

Reproduction: compare `grep -rhoE "process\.env\.[A-Z_][A-Z0-9_]*" agent/ whatsapp-bridge/src/` against `grep -oE "^[A-Z_][A-Z0-9_]*=" .env.example`.

**Signals matched**: `incomplete` — AST condition 4: "documentation lists behaviors A, B, C; the body implements only A." The configuration surface enumerates 42 variables where the runtime consumes 38, of which 14 are undocumented. The omission is not uniform: `ELEVENLABS_API_KEY` is documented at length while `OPENAI_API_KEY`, its documented fallback provider, is not.

**Guards considered**: G8 (constants) — not applicable. G12 (feature-flag gated) — considered for `WA_CONTEXT_WINDOW_TOKENS` and `WA_TOOL_BYTE_BUDGET`, which are tuning overrides with working defaults; they justify `minor` individually, but `OPENAI_API_KEY` and `WA_CONSOLE_PUSH_TOKEN` do not, and the element is the file as a whole. G13 (experimental) — ruled out, `.env.example` carries no such marker.

**Tie-break applied**: `missing` vs `incomplete` were candidates. The file exists and documents most of the surface, so `incomplete` is correct; `missing` would require the artifact to be absent.

**Remediation classification**: `complete`

## 5. Methodology

- **Directories scanned**: `agent/` (all `.ts`, `.md`), `whatsapp-bridge/src/` (all `.js`), `whatsapp-transport/` (all `.go`), `scripts/`, root manifests and documentation (`README.md`, `SPEC.md`, `CLAUDE.md`, `HOWTO-TRANSPORT-SETUP.md`, `package.json`, `docker-compose.yml`, `Dockerfile`, `.env.example`, `.gitignore`).
- **Directories excluded**: `node_modules/`, `.output/`, `.eve/`, `.git/`, `data/` (runtime state, contains private message data), `test/` and `whatsapp-bridge/test/` internals (tests are not surface; used only as corroboration), `evals/` internals, `.repo/`, `.agent-tasks/`.
- **Manifests read**: `package.json`, `whatsapp-bridge/package.json`, `whatsapp-transport/go.mod`, `tsconfig.json`, `docker-compose.yml`.
- **Commands run**:
  - Surface enumeration: `grep -oE 'path === "[^"]+"' whatsapp-bridge/src/server.js`; `grep -rnoE 'HandleFunc\("[^"]+"|mux\.Handle\("[^"]+"' whatsapp-transport`; `ls agent/tools/*.ts`; `node -e '...package.json.scripts'`.
  - Gap signals: `grep -rnE "\b(TODO|FIXME|XXX|HACK|PLACEHOLDER|WIP|TBD)\b"` and `grep -rnE "not implemented|NotImplemented|unimplemented|coming soon"` across `agent/`, `whatsapp-bridge/src/`, `whatsapp-transport/`, `scripts/` — **zero matches in runtime code**.
  - Misleading-name sweep: `grep -rnE "function (send|save|persist|store|validate|encrypt|hash|retry|cache|memoize)[A-Za-z]*\s*\("` — 15 matches, each read in context, all `real`.
  - Cross-reference: `comm` of documented tool names vs. files on disk; `comm` of `process.env.*` reads vs. `.env.example` keys.
  - Execution: `node --test` (agent, 753 tests: 751 pass / 1 fail / 1 skip); `cd whatsapp-bridge && npm test` (424 tests: 423 pass / 0 fail); `go test ./...` (10 packages, all pass); `npx tsc --noEmit` (clean); `eve build` (clean, both new tools and all 7 skills present in the manifest); `npm run bridge:dev` (fails).
  - Runtime verification: `docker compose exec agent node -e '...'` against the live container to confirm `whatsapp_search_web` and `whatsapp_generate_image` reach their providers and return substantive output.
- **Build steps run**: `eve build` — used to confirm the compiled manifest contains all 37 tools and all 7 skills, i.e. that skill and tool registration is not merely a filesystem convention.
- **Working-tree state**: commit `5e8f88b` with 23 modified or untracked paths, including in-flight work by the maintainer on `agent/lib/model.ts` (referenced by `test/model.test.ts`, not yet created).
- **Classification depth, stated honestly**: all 137 elements were resolved to an implementation location. All four non-`real` elements were read in full. Of the 37 tools, 14 were read line-by-line; the remaining 23 were verified structurally (declares a zod `inputSchema`; contains ≥1 `await`; imports ≥1 `../lib/` module; returns values derived from those calls) rather than by full reading. A `fake` implementation that passed all four structural checks would not have been caught in those 23. See §6.

## 6. Limitations

- **23 of 37 agent tools were structurally verified, not fully read.** Static evidence is sufficient to rule out `stub`, `missing`, and `placeholder` for them (each resolves, each performs I/O, no work-not-done markers exist anywhere in the tree), but not sufficient to rule out `misleading` — a tool whose description promises more than its body delivers would pass the checks applied. Resolving action: read all 37 bodies against their `description` strings. Worst case if wrong: one or more tools are `misleading` at `major`.
- **Behavioral correctness of the 46 bridge and 20 transport routes was not established.** This audit confirms each route resolves to a substantive handler and that both test suites pass; it does not confirm each handler satisfies its contract under adversarial input. Resolving action: contract tests per route, or an OpenAPI spec to diff against. Worst case if wrong: individual routes are `incomplete` at `major`.
- **`whatsapp-bridge/src/plugins.js` was enumerated but its runtime-loaded plugin set was not resolved.** Plugin hosts dispatch at runtime and static analysis cannot enumerate out-of-tree plugins. Resolving action: inspect the configured plugin directory on a running instance. Worst case: an in-tree plugin slot is `stub`; no `unverifiable` verdict was issued because no plugin is advertised in the documented surface.
- **No CI configuration exists** (`.github/workflows` absent). This is not a surface-gap verdict under this skill's taxonomy — no surface element claims CI — but it means the 1,187 tests, the typecheck and the build that this audit ran manually are not enforced on any change. It is recorded here because it bears directly on whether the verdicts above stay true.
- **`test/model.test.ts` fails at audit time**, importing `agent/lib/model.ts`, which does not exist. This is maintainer work in progress in the uncommitted tree, not a shipped surface gap, and is excluded from the inventory on that basis.
- **Two tools are implemented and undocumented** — `whatsapp_console_pending` and `whatsapp_retract_fact` appear in no `SKILL.md`, `instructions.md`, or `README.md`. Undocumented-but-real is not a gap verdict in this taxonomy. Recorded because the reverse direction (surface exceeding documentation) is invisible to the Phase 4 check.

## 7. Appendix: counted summaries

**A. Verdicts by Domain.**

| Domain | real | fake | stub | placeholder | incomplete | missing | misleading | unverifiable | Total |
|---|---|---|---|---|---|---|---|---|---|
| `lang/exports` | 37 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 37 |
| `http/routes` (bridge) | 46 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 46 |
| `http/routes` (transport) | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 20 |
| `plugin/host` | 13 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 13 |
| `cli/commands` | 9 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 10 |
| `docs/promise` | 8 | 0 | 0 | 0 | 1 | 1 | 2 | 0 | 12 |
| **Total** | **133** | **0** | **0** | **0** | **1** | **2** | **2** | **0** | **138** |

**B. Severity by Domain.**

| Domain | blocker | major | minor | cosmetic | n/a | Total |
|---|---|---|---|---|---|---|
| `lang/exports` | 0 | 0 | 0 | 0 | 37 | 37 |
| `http/routes` (bridge) | 0 | 0 | 0 | 0 | 46 | 46 |
| `http/routes` (transport) | 0 | 0 | 0 | 0 | 20 | 20 |
| `plugin/host` | 0 | 0 | 0 | 0 | 13 | 13 |
| `cli/commands` | 0 | 1 | 0 | 0 | 9 | 10 |
| `docs/promise` | 1 | 3 | 0 | 0 | 8 | 12 |
| **Total** | **1** | **4** | **0** | **0** | **133** | **138** |

**C. Documented promises check.**

| Promise | Source | Surface element matched | Verdict | Severity |
|---|---|---|---|---|
| Bridge refuses non-allowlisted recipients | `README.md`, tool descriptions | `assertSendable` — `recipients.js:193` | `real` | `n/a` |
| Sending off by default; empty allowlist = nobody | `README.md` "Enabling send" | `assertSendConfigured` — `recipients.js:172` | `real` | `n/a` |
| Bridge refuses to start unauthenticated | `README.md` "Bridge API" | `server.js:75` | `real` | `n/a` |
| Message content is untrusted and marked as such | `README.md` "Known limits" | `whatsapp_view_media.ts:73`, `whatsapp_search_web.ts:103` | `real` | `n/a` |
| History depth is bounded by the phone | `README.md` "Known limits" | `POST /history` — `server.js`, `api.go:195` | `real` | `n/a` |
| Media listed, not read; opening costs a fetch | `README.md` "Known limits" | `whatsapp_view_media`, `whatsapp_transcribe_voice` | `real` | `n/a` |
| Twin arc merging is unbuilt | `README.md`, `SPEC.md:758` | declared unbuilt, no surface claims it | `real` | `n/a` |
| A test bars the browser path from returning | `README.md:66` | `whatsapp-bridge/test/anti-corruption-layer.test.js` | `real` | `n/a` |
| Generated images are verified before sending | `README.md` "Generating a picture" | `whatsapp_generate_image` / `whatsapp_send_image` split | `real` | `n/a` |
| `whatsapp_inbox_events` reports arrivals | `agent/skills/whatsapp/SKILL.md:195` | none — surface gap | `missing` | `blocker` |
| Selector hooks live in `src/selectors.js` | `README.md:533`, `SPEC.md:130` | none — module deleted | `misleading` | `major` |
| Unset transport ⇒ bridge reads the DOM as before | `docker-compose.yml:12`, `:83` | none — bridge is inert (`whatsapp.js:70`) | `misleading` | `major` |
| `.env.example` is the configuration surface | `.env.example` | 14 of 38 runtime variables absent | `incomplete` | `major` |

## 8. Reproducibility

- Commit: `5e8f88b40d4e86600047b9f7f97eb4aaa4bcb79a`
- Working-tree dirty: `yes` (23 paths)
- Files audited: 138 surface elements across ~130 source and documentation files
- Total LOC scanned: 33,002 (agent 11,843; bridge 7,231; transport 8,844; tests 4,553 as corroboration; scripts 110; evals 421)
- Test evidence at audit time: 1,187 automated tests (agent 753, bridge 424, transport 10 Go packages) — 1 failure, in uncommitted maintainer work-in-progress
