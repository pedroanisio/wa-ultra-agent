// Package sendguard decides whether this transport is allowed to send to a
// recipient.
//
// ── Why the check lives here and not only in the agent ──────────────────────
// SPEC §7 puts every send bound "in the bridge, not in an instruction an agent
// could talk itself out of". That argument does not weaken when the transport
// changes: whatever resolves a name to a person, the last thing before the socket
// must be able to refuse.
//
// ── Why this is not a second copy of recipients.js ──────────────────────────
// `whatsapp-bridge/src/recipients.js` answers a different question. Under the DOM
// transport a person WAS their display name, so deciding who "Pim" means needed
// fuzzy matching, ambiguity reporting and an allowlist whose entries could contain
// the delimiter. All of that stays where it is, and stays authoritative.
//
// This package answers the question that only exists now that people have
// identifiers: is THIS recipient permitted? With a JID that is exact set
// membership — no matching, no normalisation of human names, nothing to drift
// away from the JavaScript. The two checks compose:
//
//	recipients.js  — which person does this name mean?   (fuzzy, may refuse as ambiguous)
//	sendguard      — is this person permitted?           (exact, may refuse outright)
//
// ── Default deny ────────────────────────────────────────────────────────────
// An unconfigured guard refuses everything. A misconfiguration must not read as
// permission, and an operator who has not decided who the agent may message has
// not decided "everyone".
package sendguard

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"go.mau.fi/whatsmeow/types"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/identity"
)

// Environment variable names, kept distinct from the JavaScript bridge's own
// `WA_ALLOW_SEND` / `WA_SEND_ALLOWLIST` so that the two layers are configured
// deliberately rather than one silently inheriting the other's intent.
const (
	EnvAllow     = "WA_TRANSPORT_ALLOW_SEND"
	EnvAllowlist = "WA_TRANSPORT_SEND_ALLOWLIST"
)

var (
	// ErrSendDisabled means the operator has not switched sending on at all.
	ErrSendDisabled = errors.New("sendguard: sending is disabled")

	// ErrNoAllowlist means sending is enabled but nobody is permitted, which is
	// a configuration mistake rather than a permissive state.
	ErrNoAllowlist = errors.New("sendguard: no recipients are allowlisted")

	// ErrNotAllowlisted means the recipient is not on the list.
	ErrNotAllowlisted = errors.New("sendguard: recipient is not allowlisted")
)

type Guard struct {
	enabled  bool
	resolver *identity.Resolver

	// permitted holds canonical identity keys, not raw JIDs. Canonicalising both
	// sides through the resolver is what makes an allowlist entry written as a
	// phone number match a message addressed by LID, and vice versa.
	permitted map[string]struct{}
}

// Env is the subset of the environment this package reads. An interface rather
// than `os.Getenv` so a test needs no process-wide state.
type Env func(string) string

// New builds a guard from the environment.
//
// Never returns an error for missing configuration: an absent allowlist is a
// guard that refuses, which is a valid and safe state to run in. Errors are
// reserved for entries that cannot be parsed, because silently ignoring a
// malformed allowlist entry would narrow the allowlist without saying so — and an
// operator who wrote a name there would conclude the agent may message them.
func New(ctx context.Context, env Env, resolver *identity.Resolver) (*Guard, error) {
	g := &Guard{
		enabled:   strings.EqualFold(strings.TrimSpace(env(EnvAllow)), "true"),
		resolver:  resolver,
		permitted: map[string]struct{}{},
	}

	for _, entry := range splitEntries(env(EnvAllowlist)) {
		jid, err := types.ParseJID(entry)
		if err != nil {
			return nil, fmt.Errorf("sendguard: %s contains an unparseable entry: %w", EnvAllowlist, err)
		}

		id, err := g.resolver.Resolve(ctx, jid)
		if err != nil {
			// Reported rather than skipped. A display name in this variable
			// parses as a JID with no user part, and skipping it would leave the
			// operator believing they had allowlisted somebody.
			return nil, fmt.Errorf("sendguard: %s entry is not a usable address "+
				"(expected a JID such as <id>@lid or <number>@s.whatsapp.net): %w", EnvAllowlist, err)
		}
		g.permitted[id.Key] = struct{}{}
	}

	return g, nil
}

// splitEntries accepts comma, semicolon or whitespace separation.
//
// Unlike the JavaScript allowlist, an entry here can never legally contain the
// delimiter — a JID has no commas or spaces — so this needs none of
// `splitAllowlistEntries`' quoting rules and cannot drift from them.
func splitEntries(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '\n' || r == '\t' || r == ' '
	})

	out := make([]string, 0, len(fields))
	for _, field := range fields {
		trimmed := strings.Trim(strings.TrimSpace(field), `"'`)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// Enabled reports whether sending is switched on at all.
func (g *Guard) Enabled() bool { return g.enabled }

// Size reports how many recipients are permitted, for status output.
//
// A count rather than the list: a status endpoint that enumerated the allowlist
// would publish exactly the identifiers `identity-guard.js` exists to keep out of
// logs.
func (g *Guard) Size() int { return len(g.permitted) }

// Permit refuses unless the recipient is explicitly allowlisted.
//
// A recipient whose LID is unknown canonicalises to their phone number and will
// not match an allowlist entry written as a LID. That mismatch resolves to a
// refusal, which is the safe direction: the cost is a send the operator must
// re-authorise, rather than a message to the wrong person.
func (g *Guard) Permit(ctx context.Context, to types.JID) error {
	if !g.enabled {
		return fmt.Errorf("%w: set %s=true to enable it", ErrSendDisabled, EnvAllow)
	}
	if len(g.permitted) == 0 {
		return fmt.Errorf("%w: set %s", ErrNoAllowlist, EnvAllowlist)
	}

	id, err := g.resolver.Resolve(ctx, to)
	if err != nil {
		return fmt.Errorf("sendguard: unusable recipient: %w", err)
	}

	if _, ok := g.permitted[id.Key]; !ok {
		// The refusal deliberately does not echo the recipient. An error string
		// reaches logs, and a log is a publication surface — the same rule
		// `scanForRealIdentities` follows on the JavaScript side.
		return ErrNotAllowlisted
	}
	return nil
}
