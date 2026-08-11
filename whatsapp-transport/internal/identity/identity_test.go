package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow/types"
)

// Every formatting verb that reaches a log line.
//
// `%+v` and `%#v` are the dangerous pair: on a plain struct both print
// unexported fields, so an `Identity` that merely hides the number in an
// unexported field would still leak it through a debug print. Sealing them
// takes a `String()` and a `GoString()`, and this helper is what proves both
// are there.
func format(i Identity) string {
	return fmt.Sprintf("%v|%+v|%s|%#v", i, i, i, i)
}

// A synthetic number, never a real one. The digits below appear in assertions
// and would otherwise be a contact's number committed to a public repository —
// which is the incident this package exists to make structurally impossible.
const testPhone = "15550001111"

type stubLIDs struct {
	pnToLID map[string]string
	err     error
}

func (s stubLIDs) GetLIDForPN(_ context.Context, pn types.JID) (types.JID, error) {
	if s.err != nil {
		return types.EmptyJID, s.err
	}
	lid, ok := s.pnToLID[pn.User]
	if !ok {
		return types.EmptyJID, nil
	}
	return types.NewJID(lid, types.HiddenUserServer), nil
}

func resolver(mapping map[string]string) *Resolver {
	return NewResolver(stubLIDs{pnToLID: mapping})
}

func TestGroupKeyIsTheGroupJID(t *testing.T) {
	group := types.NewJID("120363000000000000", types.GroupServer)

	got, err := resolver(nil).Resolve(context.Background(), group)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if got.Kind != KindGroup {
		t.Fatalf("kind = %q, want %q", got.Kind, KindGroup)
	}
	if got.Key != group.String() {
		t.Fatalf("key = %q, want %q", got.Key, group.String())
	}
	// A group has no phone number to contain, and claiming otherwise would put
	// the resolver's own JID in the field.
	if _, ok := got.PhoneNumber(); ok {
		t.Fatal("a group reported a phone number")
	}
}

func TestLIDIsUsedDirectlyWhenTheJIDAlreadyCarriesOne(t *testing.T) {
	lid := types.NewJID("99887766554433", types.HiddenUserServer)

	got, err := resolver(nil).Resolve(context.Background(), lid)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if got.Kind != KindPerson {
		t.Fatalf("kind = %q, want %q", got.Kind, KindPerson)
	}
	if got.Key != lid.String() {
		t.Fatalf("key = %q, want %q", got.Key, lid.String())
	}
	if got.Provisional {
		t.Fatal("a JID that already is a LID was marked provisional")
	}
}

// The migration case: a message arrives addressed by phone number, and the LID
// is known. The key must be the LID, so that the same person keyed by either
// form lands on one row.
func TestPhoneJIDResolvesToItsLID(t *testing.T) {
	lid := "99887766554433"
	pn := types.NewJID(testPhone, types.DefaultUserServer)

	got, err := resolver(map[string]string{testPhone: lid}).Resolve(context.Background(), pn)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	want := types.NewJID(lid, types.HiddenUserServer).String()
	if got.Key != want {
		t.Fatalf("key = %q, want the LID %q", got.Key, want)
	}
	if got.Provisional {
		t.Fatal("a resolved LID was marked provisional")
	}

	number, ok := got.PhoneNumber()
	if !ok || number != testPhone {
		t.Fatalf("PhoneNumber() = %q,%v; want %q,true", number, ok, testPhone)
	}
}

// WhatsApp is mid-migration, so a phone number with no LID yet is routine, not
// an error. The message must still be storable, and the row must be marked so
// the archive can merge it once the LID appears rather than keeping two people.
func TestPhoneJIDWithoutAMappingIsProvisional(t *testing.T) {
	pn := types.NewJID(testPhone, types.DefaultUserServer)

	got, err := resolver(nil).Resolve(context.Background(), pn)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if !got.Provisional {
		t.Fatal("an unmapped phone JID was not marked provisional")
	}
	if got.Key == "" {
		t.Fatal("an unmapped phone JID produced no key; the message would be unstorable")
	}
	if got.Kind != KindPerson {
		t.Fatalf("kind = %q, want %q", got.Kind, KindPerson)
	}
}

// ── Why the provisional key is a digest and not the number ──────────────────
//
// The key is the field that travels: into the archive, into the contacts
// response, into error messages and into anything printing a chat. Using the
// phone JID as the key would put a real number in every one of those places for
// exactly the contacts whose LID has not arrived — which mid-migration is many of
// them, and which the unexported `phone` field does nothing to prevent.
//
// This was found by a test on the contacts endpoint, not by design.
func TestProvisionalKeyDoesNotContainThePhoneNumber(t *testing.T) {
	pn := types.NewJID(testPhone, types.DefaultUserServer)

	got, err := resolver(nil).Resolve(context.Background(), pn)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if strings.Contains(got.Key, testPhone) {
		t.Fatalf("key %q contains the phone number", got.Key)
	}
	if !strings.HasPrefix(got.Key, ProvisionalKeyPrefix) {
		t.Fatalf("key %q lacks the %q marker the archive merges on", got.Key, ProvisionalKeyPrefix)
	}
	// The number is still reachable deliberately — contained, not discarded.
	if number, ok := got.PhoneNumber(); !ok || number != testPhone {
		t.Fatalf("PhoneNumber() = %q,%v; want the number retained", number, ok)
	}
}

// The same person must key identically across calls, restarts and processes, or
// every reconnection would invent a new correspondent.
func TestProvisionalKeyIsStableAndDistinct(t *testing.T) {
	ctx := context.Background()
	r := resolver(nil)

	first, err := r.Resolve(ctx, types.NewJID(testPhone, types.DefaultUserServer))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	second, err := r.Resolve(ctx, types.NewJID(testPhone, types.DefaultUserServer))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if first.Key != second.Key {
		t.Fatalf("the same number produced two keys: %q and %q", first.Key, second.Key)
	}

	other, err := r.Resolve(ctx, types.NewJID("15550002222", types.DefaultUserServer))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if other.Key == first.Key {
		t.Fatal("two different numbers collided on one key")
	}
}

// ── The containment property ────────────────────────────────────────────────
//
// On 2026-08-11 real contact identifiers reached a public repository. The DOM
// transport only ever knew display names; whatsmeow knows every contact's phone
// number, so this transport raises the stakes of the same accident.
//
// The structural defence is that the number lives in an unexported field.
// `encoding/json` cannot reach it, so no log line, event payload or debug dump
// can carry it by default — a leak now requires calling `PhoneNumber()`, which
// is one grep away from review.
func TestPhoneNumberIsNeverSerialised(t *testing.T) {
	pn := types.NewJID(testPhone, types.DefaultUserServer)

	got, err := resolver(map[string]string{testPhone: "99887766554433"}).
		Resolve(context.Background(), pn)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	if strings.Contains(string(encoded), testPhone) {
		t.Fatalf("the phone number survived JSON encoding: %s", encoded)
	}
	// Same guarantee for the formatting verbs, which is how a number reaches a
	// log line rather than an event payload.
	for _, rendered := range []string{got.String(), format(got)} {
		if strings.Contains(rendered, testPhone) {
			t.Fatalf("the phone number survived formatting: %s", rendered)
		}
	}
}

func TestNonHumanServersGetTheirOwnKinds(t *testing.T) {
	cases := []struct {
		name string
		jid  types.JID
		want Kind
	}{
		{"status broadcast", types.StatusBroadcastJID, KindBroadcast},
		{"broadcast list", types.NewJID("12345", types.BroadcastServer), KindBroadcast},
		{"newsletter", types.NewJID("12345", types.NewsletterServer), KindNewsletter},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolver(nil).Resolve(context.Background(), tc.jid)
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			if got.Kind != tc.want {
				t.Fatalf("kind = %q, want %q", got.Kind, tc.want)
			}
			if _, ok := got.PhoneNumber(); ok {
				t.Fatalf("%s reported a phone number", tc.name)
			}
		})
	}
}

// `types.ParseJID` accepts a string with no `@` and returns it as the SERVER
// with an empty user, no error. History-sync conversation ids come straight from
// the phone, so this is the realistic path for garbage — and a correspondent
// keyed on a malformed string would quietly collect messages under a name nobody
// recognises.
func TestJIDWithoutAUserPartIsRejected(t *testing.T) {
	parsed, err := types.ParseJID("this is not a jid")
	if err != nil {
		t.Fatalf("premise changed: ParseJID now rejects garbage (%v), so this guard "+
			"may be redundant — check before deleting it", err)
	}
	if parsed.User != "" {
		t.Fatalf("premise changed: ParseJID now yields user %q", parsed.User)
	}

	if _, err := resolver(nil).Resolve(context.Background(), parsed); !errors.Is(err, ErrNoUser) {
		t.Fatalf("Resolve error = %v, want ErrNoUser", err)
	}

	// Same guard on the pair path, which is the one events actually use.
	if _, err := resolver(nil).ResolvePair(context.Background(), parsed, types.EmptyJID); err == nil {
		t.Fatal("ResolvePair accepted a JID with no user part")
	}
}

func TestEmptyJIDIsRejectedRatherThanKeyedAsEmpty(t *testing.T) {
	_, err := resolver(nil).Resolve(context.Background(), types.EmptyJID)
	if err == nil {
		t.Fatal("the empty JID resolved without error; it would key every unknown sender alike")
	}
}

// ── ResolvePair ─────────────────────────────────────────────────────────────
//
// Every message carries both address forms: `MessageSource.Sender` and
// `SenderAlt`, one a LID and the other a phone number, in whichever order the
// sender's client chose. Reading the pair settles identity from the message
// itself, so the common case costs no database lookup at all.

func TestResolvePairPrefersTheLIDWhicheverSideItIsOn(t *testing.T) {
	lid := types.NewJID("99887766554433", types.HiddenUserServer)
	pn := types.NewJID(testPhone, types.DefaultUserServer)

	// No mapping configured: if either call reaches the store it resolves to
	// nothing, so a non-provisional result proves the pair alone was enough.
	for _, tc := range []struct {
		name              string
		primary, alt      types.JID
		wantPhoneRetained bool
	}{
		{"LID primary, phone alt", lid, pn, true},
		{"phone primary, LID alt", pn, lid, true},
		{"LID primary, no alt", lid, types.EmptyJID, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolver(nil).ResolvePair(context.Background(), tc.primary, tc.alt)
			if err != nil {
				t.Fatalf("ResolvePair: %v", err)
			}
			if got.Key != lid.String() {
				t.Fatalf("key = %q, want the LID %q", got.Key, lid.String())
			}
			if got.Provisional {
				t.Fatal("a pair carrying a LID was marked provisional")
			}
			if _, ok := got.PhoneNumber(); ok != tc.wantPhoneRetained {
				t.Fatalf("PhoneNumber() present = %v, want %v", ok, tc.wantPhoneRetained)
			}
		})
	}
}

func TestResolvePairFallsBackToTheStoreWhenNeitherSideIsALID(t *testing.T) {
	pn := types.NewJID(testPhone, types.DefaultUserServer)
	lid := "99887766554433"

	got, err := resolver(map[string]string{testPhone: lid}).
		ResolvePair(context.Background(), pn, types.EmptyJID)
	if err != nil {
		t.Fatalf("ResolvePair: %v", err)
	}

	want := types.NewJID(lid, types.HiddenUserServer).String()
	if got.Key != want {
		t.Fatalf("key = %q, want %q", got.Key, want)
	}
}

func TestResolvePairKeepsGroupsUnchanged(t *testing.T) {
	group := types.NewJID("120363000000000000", types.GroupServer)

	got, err := resolver(nil).ResolvePair(context.Background(), group, types.EmptyJID)
	if err != nil {
		t.Fatalf("ResolvePair: %v", err)
	}
	if got.Kind != KindGroup || got.Key != group.String() {
		t.Fatalf("got %+v, want group/%q", got, group.String())
	}
}

// The containment must hold on this path too — it is the one events actually
// use, so a leak here would be the leak that matters.
func TestResolvePairNeverSerialisesThePhoneNumber(t *testing.T) {
	got, err := resolver(nil).ResolvePair(
		context.Background(),
		types.NewJID("99887766554433", types.HiddenUserServer),
		types.NewJID(testPhone, types.DefaultUserServer),
	)
	if err != nil {
		t.Fatalf("ResolvePair: %v", err)
	}

	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(encoded), testPhone) || strings.Contains(format(got), testPhone) {
		t.Fatalf("the phone number escaped: %s / %s", encoded, format(got))
	}
}

// A lookup failure is not a reason to lose a message. The store can be busy,
// mid-migration or briefly unreadable, and the archive would rather hold a
// provisional row than none.
func TestLookupFailureDegradesToProvisional(t *testing.T) {
	pn := types.NewJID(testPhone, types.DefaultUserServer)
	r := NewResolver(stubLIDs{err: context.DeadlineExceeded})

	got, err := r.Resolve(context.Background(), pn)
	if err != nil {
		t.Fatalf("Resolve returned an error instead of degrading: %v", err)
	}
	if !got.Provisional {
		t.Fatal("a failed lookup was not marked provisional")
	}
}
