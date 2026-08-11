// Package identity decides who a message is from, and contains what that
// answer reveals.
//
// ── Why LID and not the phone number ────────────────────────────────────────
// WhatsApp is mid-migration from phone-number addressing (`…@s.whatsapp.net`)
// to LIDs (`…@lid`), an opaque per-user identifier introduced so that a group
// member's phone number is not exposed to everyone in the group. Keying the
// archive on the LID is therefore both the durable choice and the private one:
// it survives the migration, and it is not somebody's phone number.
//
// This is the decision that is expensive to revisit. Everything derived — facts,
// obligations, the interaction twin — cites a person, and re-keying people means
// rewriting all of it. So it is made once, here, and the phone number is
// demoted to an attribute that can be resolved when genuinely needed.
//
// ── Why the number is unexported ────────────────────────────────────────────
// The DOM transport this replaces knew only display names. whatsmeow knows
// every contact's real number, which makes an accidental disclosure a larger
// event than it used to be — and on 2026-08-11 this repository had one.
//
// Containment is structural rather than procedural: `phone` is unexported, so
// `encoding/json` cannot serialise it and no event payload carries it by
// default. `String()` and `GoString()` exist to close the `%v`/`%+v`/`%#v`
// debug-print paths, which would otherwise print unexported fields verbatim.
// Reading the number requires calling `PhoneNumber()`, which is greppable, and
// that is the point: the leak becomes a visible decision instead of a default.
package identity

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"go.mau.fi/whatsmeow/types"
)

// Kind is what sort of correspondent a JID denotes.
//
// Split by server rather than by guessing, because the distinctions are load
// bearing: a broadcast is not a conversation, and a newsletter has no person
// on the other end to owe anything to.
type Kind string

const (
	KindPerson     Kind = "person"
	KindGroup      Kind = "group"
	KindBroadcast  Kind = "broadcast"
	KindNewsletter Kind = "newsletter"
)

// ErrNoJID is returned for the empty JID.
//
// Worth an error rather than a fallback key: an empty JID keyed as `""` would
// silently collect every unattributable message into one correspondent, which
// reads downstream as a real person who says a great many unrelated things.
var ErrNoJID = errors.New("identity: empty JID has no stable key")

// ErrNoUser is returned for a JID with a server but no user part.
//
// `types.ParseJID` is deliberately lenient: a string containing no `@` parses
// without error into an empty user with the whole string as the SERVER, so
// `ParseJID("not a jid")` succeeds. History-sync payloads carry conversation ids
// straight from the phone, which makes that the realistic way garbage arrives.
//
// Rejecting it here rather than downstream is the difference between a counted
// failure and a correspondent named after a malformed string, silently
// accumulating somebody else's messages.
var ErrNoUser = errors.New("identity: JID has no user part")

// Identity is a correspondent, in the archive's terms.
//
// `Key` is what everything derived cites: a LID for people, the group JID for
// groups, and an opaque `pn:` digest when no LID is available yet. It is never a
// phone number — see `provisionalKey` for why that mattered enough to hash.
type Identity struct {
	Key  string `json:"key"`
	Kind Kind   `json:"kind"`

	// Provisional means the key is derived from a phone number because no LID
	// was available. The row is storable and correct, but the archive should
	// merge it once a LID appears rather than carrying two rows for one person.
	Provisional bool `json:"provisional"`

	// Unexported on purpose — see the package comment. This is the single
	// place a contact's phone number lives in this process.
	phone string
}

// PhoneNumber returns the correspondent's number, if one is known.
//
// The explicit accessor is the containment: every disclosure of a real number
// is a call site that review can find, rather than a struct field that any
// `json.Marshal` would have carried out of the process on its own.
func (i Identity) PhoneNumber() (string, bool) {
	return i.phone, i.phone != ""
}

// String renders an identity without its phone number.
//
// Defined on the value receiver so that `%v` and `%s` route through it whether
// the identity is held by value or by pointer.
func (i Identity) String() string {
	if i.Provisional {
		return fmt.Sprintf("%s(%s, provisional)", i.Kind, i.Key)
	}
	return fmt.Sprintf("%s(%s)", i.Kind, i.Key)
}

// GoString closes the `%#v` path, which ignores `String()` and would otherwise
// dump every field including the unexported one.
func (i Identity) GoString() string {
	return "identity.Identity" + i.String()
}

// LIDs is the subset of whatsmeow's LID store this package needs.
//
// Narrowed to one method so the resolver is testable without a database, a
// session or a network — the same reason `recipients.js` and `self-note.js`
// take their dependencies by injection on the JavaScript side.
type LIDs interface {
	GetLIDForPN(ctx context.Context, pn types.JID) (types.JID, error)
}

// Resolver turns JIDs into identities.
type Resolver struct {
	lids LIDs
}

func NewResolver(lids LIDs) *Resolver {
	return &Resolver{lids: lids}
}

// ResolvePair settles an identity from the two address forms a message carries.
//
// `MessageSource` gives both `Sender` and `SenderAlt` — one the LID, the other
// the phone number, in whichever order the sending client chose. Reading the
// pair is strictly better than resolving `Sender` alone: it settles identity
// from the message itself, so the common case costs no database lookup, and it
// works for a contact whose mapping the store has not learned yet.
//
// Falls back to `Resolve` when neither side is a LID.
func (r *Resolver) ResolvePair(ctx context.Context, primary, alt types.JID) (Identity, error) {
	if primary.IsEmpty() {
		return Identity{}, ErrNoJID
	}

	// Only user addresses come in pairs; a group or broadcast has one form.
	if !isUserServer(primary.Server) {
		return r.Resolve(ctx, primary)
	}

	lid, pn := sortByServer(primary, alt)
	if lid.IsEmpty() {
		return r.Resolve(ctx, primary)
	}

	person := Identity{Key: lid.ToNonAD().String(), Kind: KindPerson}
	if !pn.IsEmpty() {
		// Retained rather than discarded because the operator legitimately needs
		// to reach a number sometimes; contained rather than exported because
		// they do not need it in every log line. See the package comment.
		person.phone = pn.ToNonAD().User
	}
	return person, nil
}

// sortByServer splits a pair of user JIDs into (lid, phone), either of which may
// be empty. Written as a split rather than a chain of conditionals because the
// two forms arrive in either order and the asymmetry is the whole bug surface.
func sortByServer(a, b types.JID) (lid, pn types.JID) {
	for _, jid := range [2]types.JID{a, b} {
		if jid.IsEmpty() {
			continue
		}
		switch jid.Server {
		case types.HiddenUserServer:
			lid = jid
		case types.DefaultUserServer, types.LegacyUserServer:
			pn = jid
		}
	}
	return lid, pn
}

// ProvisionalKeyPrefix marks a key derived from a phone number rather than a LID.
//
// Visible on purpose: the archive needs to recognise these to merge them once the
// real LID appears, and a reader needs to know that this key is not durable.
const ProvisionalKeyPrefix = "pn:"

// provisionalKey derives a stable, non-obvious key from a phone number.
//
// ── Why not just use the phone JID ──────────────────────────────────────────
// Because the key is the one field that goes everywhere. It is written to the
// archive, returned by the contacts endpoint, embedded in error messages, and
// printed by anything debugging a chat. Using `<number>@s.whatsapp.net` as the key
// would put a real phone number in all of those places, which defeats the
// containment in this package for exactly the contacts whose LID has not arrived
// yet — and mid-migration, that is many of them.
//
// ── What this does and does not protect against ─────────────────────────────
// It resists CASUAL disclosure, which is the failure this repository actually had:
// identifiers typed into prose, comments and fixtures and then committed. A
// reviewer scanning a diff sees `pn:8f3a…` and not somebody's number.
//
// It is NOT anonymity. The space of phone numbers is small enough to enumerate, so
// anyone holding this hash and wanting a specific number can confirm it by
// hashing candidates. That is a deliberate, stated limit: the goal is that a
// number cannot be read off a key by accident, not that it cannot be recovered by
// someone trying.
//
// Deterministic and unsalted, because the same person must produce the same key
// across restarts and processes — a salt would make every restart a new
// correspondent.
func provisionalKey(phone string) string {
	sum := sha256.Sum256([]byte(phone))
	return ProvisionalKeyPrefix + hex.EncodeToString(sum[:10])
}

func isUserServer(server string) bool {
	switch server {
	case types.HiddenUserServer, types.DefaultUserServer, types.LegacyUserServer:
		return true
	}
	return false
}

// Resolve maps a JID onto the identity the archive should key on.
//
// Never fails for a well-formed JID. A LID lookup that errors or comes back
// empty degrades to a provisional phone-keyed identity, because WhatsApp being
// mid-migration is a routine condition and losing correspondence over it would
// be a worse outcome than a row that needs merging later.
func (r *Resolver) Resolve(ctx context.Context, jid types.JID) (Identity, error) {
	if jid.IsEmpty() {
		return Identity{}, ErrNoJID
	}
	// Every correspondent this archive can key on has a user part: a group has
	// its id, a person has their LID or number. A bare server address is not a
	// correspondent, and treating one as a person invents somebody.
	if jid.User == "" {
		return Identity{}, fmt.Errorf("%w: %s", ErrNoUser, jid.Server)
	}

	switch jid.Server {
	case types.GroupServer:
		return Identity{Key: jid.String(), Kind: KindGroup}, nil

	case types.BroadcastServer:
		return Identity{Key: jid.String(), Kind: KindBroadcast}, nil

	case types.NewsletterServer:
		return Identity{Key: jid.String(), Kind: KindNewsletter}, nil

	case types.HiddenUserServer:
		// Already the durable form. The phone number behind it is deliberately
		// not looked up: nothing here needs it, and fetching it would put a
		// number in memory for every message received.
		return Identity{Key: jid.ToNonAD().String(), Kind: KindPerson}, nil
	}

	// A phone-addressed user. Prefer the LID; fall back to an opaque key.
	pn := jid.ToNonAD()
	person := Identity{
		Key:         provisionalKey(pn.User),
		Kind:        KindPerson,
		Provisional: true,
		phone:       pn.User,
	}

	if r.lids == nil {
		return person, nil
	}

	lid, err := r.lids.GetLIDForPN(ctx, pn)
	if err != nil || lid.IsEmpty() {
		return person, nil
	}

	person.Key = lid.ToNonAD().String()
	person.Provisional = false
	return person, nil
}
