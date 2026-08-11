package sendguard

import (
	"context"
	"errors"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow/types"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/identity"
)

const (
	allowedLID = "99887766554433"
	otherLID   = "11223344556677"
	// Synthetic throughout — a real number here would be the leak the guard
	// exists to make impossible.
	allowedPhone = "15550001111"
)

// stubLIDs maps phone numbers to LIDs the way the device store does once
// app-state sync has run.
type stubLIDs struct{ pnToLID map[string]string }

func (s stubLIDs) GetLIDForPN(_ context.Context, pn types.JID) (types.JID, error) {
	lid, ok := s.pnToLID[pn.User]
	if !ok {
		return types.EmptyJID, nil
	}
	return types.NewJID(lid, types.HiddenUserServer), nil
}

func env(pairs map[string]string) Env {
	return func(key string) string { return pairs[key] }
}

func guard(t *testing.T, pairs map[string]string, mapping map[string]string) *Guard {
	t.Helper()
	g, err := New(context.Background(), env(pairs), identity.NewResolver(stubLIDs{pnToLID: mapping}))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return g
}

func lidJID(user string) types.JID { return types.NewJID(user, types.HiddenUserServer) }

// ── Default deny ────────────────────────────────────────────────────────────
//
// The state an operator is in before they have decided anything must refuse. A
// guard that permitted by default would make forgetting to configure it
// indistinguishable from choosing to allow everyone.

func TestUnconfiguredGuardRefusesEverything(t *testing.T) {
	g := guard(t, nil, nil)

	err := g.Permit(context.Background(), lidJID(allowedLID))
	if !errors.Is(err, ErrSendDisabled) {
		t.Fatalf("error = %v, want ErrSendDisabled", err)
	}
	if g.Enabled() {
		t.Fatal("an unconfigured guard reported itself enabled")
	}
}

func TestAllowlistWithoutTheEnableFlagStillRefuses(t *testing.T) {
	g := guard(t, map[string]string{
		EnvAllowlist: lidJID(allowedLID).String(),
	}, nil)

	if err := g.Permit(context.Background(), lidJID(allowedLID)); !errors.Is(err, ErrSendDisabled) {
		t.Fatalf("error = %v, want ErrSendDisabled", err)
	}
}

// Enabled with nobody allowlisted is a configuration mistake, and it must be
// reported as one rather than treated as "send to anyone".
func TestEnabledWithoutAnAllowlistRefuses(t *testing.T) {
	g := guard(t, map[string]string{EnvAllow: "true"}, nil)

	err := g.Permit(context.Background(), lidJID(allowedLID))
	if !errors.Is(err, ErrNoAllowlist) {
		t.Fatalf("error = %v, want ErrNoAllowlist", err)
	}
}

func TestAllowlistedRecipientIsPermitted(t *testing.T) {
	g := guard(t, map[string]string{
		EnvAllow:     "true",
		EnvAllowlist: lidJID(allowedLID).String(),
	}, nil)

	if err := g.Permit(context.Background(), lidJID(allowedLID)); err != nil {
		t.Fatalf("Permit refused an allowlisted recipient: %v", err)
	}
}

func TestRecipientOffTheAllowlistIsRefused(t *testing.T) {
	g := guard(t, map[string]string{
		EnvAllow:     "true",
		EnvAllowlist: lidJID(allowedLID).String(),
	}, nil)

	err := g.Permit(context.Background(), lidJID(otherLID))
	if !errors.Is(err, ErrNotAllowlisted) {
		t.Fatalf("error = %v, want ErrNotAllowlisted", err)
	}
}

// ── The reason both sides are canonicalised ─────────────────────────────────
//
// WhatsApp is mid-migration, so the same person is addressable two ways. An
// allowlist written in one form and a send addressed in the other must agree, or
// the guard would refuse sends the operator plainly authorised — and an operator
// fighting a guard turns it off.

func TestAllowlistWrittenAsAPhoneNumberMatchesASendByLID(t *testing.T) {
	g := guard(t, map[string]string{
		EnvAllow:     "true",
		EnvAllowlist: types.NewJID(allowedPhone, types.DefaultUserServer).String(),
	}, map[string]string{allowedPhone: allowedLID})

	if err := g.Permit(context.Background(), lidJID(allowedLID)); err != nil {
		t.Fatalf("Permit refused the same person addressed by LID: %v", err)
	}
}

func TestAllowlistWrittenAsALIDMatchesASendByPhoneNumber(t *testing.T) {
	g := guard(t, map[string]string{
		EnvAllow:     "true",
		EnvAllowlist: lidJID(allowedLID).String(),
	}, map[string]string{allowedPhone: allowedLID})

	pn := types.NewJID(allowedPhone, types.DefaultUserServer)
	if err := g.Permit(context.Background(), pn); err != nil {
		t.Fatalf("Permit refused the same person addressed by phone number: %v", err)
	}
}

// A device-suffixed JID is the same person on a different device. Sending is per
// person, so the suffix must not defeat the allowlist.
func TestDeviceSuffixDoesNotDefeatTheAllowlist(t *testing.T) {
	g := guard(t, map[string]string{
		EnvAllow:     "true",
		EnvAllowlist: lidJID(allowedLID).String(),
	}, nil)

	withDevice := lidJID(allowedLID)
	withDevice.Device = 3

	if err := g.Permit(context.Background(), withDevice); err != nil {
		t.Fatalf("Permit refused an allowlisted person on another device: %v", err)
	}
}

func TestGroupsAreAllowlistedByTheirJID(t *testing.T) {
	group := types.NewJID("120363000000000000", types.GroupServer)
	g := guard(t, map[string]string{
		EnvAllow:     "true",
		EnvAllowlist: group.String(),
	}, nil)

	if err := g.Permit(context.Background(), group); err != nil {
		t.Fatalf("Permit refused an allowlisted group: %v", err)
	}
	other := types.NewJID("120363999999999999", types.GroupServer)
	if err := g.Permit(context.Background(), other); !errors.Is(err, ErrNotAllowlisted) {
		t.Fatalf("error for a different group = %v, want ErrNotAllowlisted", err)
	}
}

func TestSeparatorsAndQuotingAreTolerated(t *testing.T) {
	a, b := lidJID(allowedLID), lidJID(otherLID)

	for _, raw := range []string{
		a.String() + "," + b.String(),
		a.String() + ", " + b.String(),
		a.String() + "; " + b.String(),
		a.String() + "\n" + b.String(),
		`"` + a.String() + `","` + b.String() + `"`,
	} {
		g := guard(t, map[string]string{EnvAllow: "true", EnvAllowlist: raw}, nil)
		if g.Size() != 2 {
			t.Fatalf("%q parsed to %d entries, want 2", raw, g.Size())
		}
		for _, jid := range []types.JID{a, b} {
			if err := g.Permit(context.Background(), jid); err != nil {
				t.Fatalf("%q refused %s: %v", raw, jid, err)
			}
		}
	}
}

// A display name in the JID allowlist is the mistake an operator will actually
// make, having configured the JavaScript allowlist with names for months.
// Skipping it silently would leave them believing somebody was allowlisted.
func TestUnusableAllowlistEntryIsReportedNotSkipped(t *testing.T) {
	_, err := New(context.Background(),
		env(map[string]string{
			EnvAllow:     "true",
			EnvAllowlist: "Ana Lucia Prado",
		}),
		identity.NewResolver(nil))

	if err == nil {
		t.Fatal("New accepted a display name as an allowlist entry")
	}
	if !strings.Contains(err.Error(), EnvAllowlist) {
		t.Fatalf("error %q should name the variable at fault", err)
	}
}

// The refusal reaches logs. Echoing the recipient there would republish exactly
// the identifiers the identity guard keeps out of the tree.
func TestRefusalDoesNotEchoTheRecipient(t *testing.T) {
	g := guard(t, map[string]string{
		EnvAllow:     "true",
		EnvAllowlist: lidJID(allowedLID).String(),
	}, nil)

	pn := types.NewJID(allowedPhone, types.DefaultUserServer)
	err := g.Permit(context.Background(), pn)
	if err == nil {
		t.Fatal("Permit allowed an unmapped, unlisted recipient")
	}
	if strings.Contains(err.Error(), allowedPhone) || strings.Contains(err.Error(), otherLID) {
		t.Fatalf("the refusal echoed the recipient: %q", err)
	}
}

// Size feeds the status endpoint. Reporting the count rather than the list is what
// keeps a status page from publishing the allowlist.
func TestSizeReportsTheCountWithoutTheEntries(t *testing.T) {
	g := guard(t, map[string]string{
		EnvAllow:     "true",
		EnvAllowlist: lidJID(allowedLID).String() + "," + lidJID(otherLID).String(),
	}, nil)

	if g.Size() != 2 {
		t.Fatalf("Size() = %d, want 2", g.Size())
	}
}

func TestEnableFlagIsCaseInsensitiveButRequiresTrue(t *testing.T) {
	for raw, want := range map[string]bool{
		"true": true, "TRUE": true, "True": true, " true ": true,
		"false": false, "1": false, "yes": false, "": false,
	} {
		g := guard(t, map[string]string{
			EnvAllow:     raw,
			EnvAllowlist: lidJID(allowedLID).String(),
		}, nil)
		if g.Enabled() != want {
			t.Errorf("%q enabled = %v, want %v", raw, g.Enabled(), want)
		}
	}
}
