package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/mediastore"
)

// Everything below runs without a WhatsApp account and without a network: the
// device store, the schema upgrade and the unpaired refusals are all local. What
// is NOT covered here is anything past `Connect` on a paired session, which needs
// a real linked device — so the socket itself is verified by pairing, not by a
// test, and `session.go` is written thin for that reason.

func openSession(t *testing.T) (*Session, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "transport")

	s, err := Open(context.Background(), Config{Dir: dir})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, dir
}

func TestOpenCreatesBothDatabasesAndStartsUnpaired(t *testing.T) {
	s, dir := openSession(t)

	for _, name := range []string{sessionFile, outboxFile} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s was not created: %v", name, err)
		}
	}

	if s.Paired() {
		t.Fatal("a fresh session reported itself as paired")
	}
}

// The directory holds a linked session, which is the account credential. Group
// and world access to it would make the credential readable by anything else on
// the host.
func TestSessionDirectoryIsNotWorldReadable(t *testing.T) {
	_, dir := openSession(t)

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		t.Fatalf("session directory mode is %04o, want no group or world access", perm)
	}
}

func TestOpenRequiresADirectory(t *testing.T) {
	if _, err := Open(context.Background(), Config{}); err == nil {
		t.Fatal("Open accepted an empty Config.Dir")
	}
}

// Connecting an unpaired session would sit there looking healthy with no way to
// discover that no pairing events had anywhere to go.
func TestConnectRefusesAnUnpairedSession(t *testing.T) {
	s, _ := openSession(t)

	err := s.Connect(context.Background())
	if err == nil {
		t.Fatal("Connect succeeded on an unpaired session")
	}
	if !strings.Contains(err.Error(), "not paired") {
		t.Fatalf("error = %q, want it to name the pairing problem", err)
	}
}

func TestPairPhoneRequiresANumber(t *testing.T) {
	s, _ := openSession(t)

	if _, err := s.PairPhone(context.Background(), ""); err == nil {
		t.Fatal("PairPhone accepted an empty number")
	}
}

func TestStatusOnAFreshSession(t *testing.T) {
	s, _ := openSession(t)

	status, err := s.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}

	if status.Paired || status.Connected || status.LoggedIn {
		t.Fatalf("fresh session status = %+v, want all false", status)
	}
	if status.Queue.Depth != 0 || status.Queue.Dropped != 0 {
		t.Fatalf("fresh queue = %+v, want empty", status.Queue)
	}
	if status.Account != nil {
		t.Fatalf("an unpaired session reported an account: %+v", status.Account)
	}
}

// Status is the most casually-read surface the transport has — it goes into logs,
// dashboards and terminal output. The operator's own number must not ride along.
func TestStatusIsSafeToLog(t *testing.T) {
	s, _ := openSession(t)

	status, err := s.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	// `phone` is the unexported field in identity.Identity; if it ever becomes
	// exported, or an Identity is replaced by a raw JID string, this catches it.
	if strings.Contains(strings.ToLower(string(encoded)), "phone") {
		t.Fatalf("status payload mentions a phone field: %s", encoded)
	}
}

// The default must not be DEBUG: whatsmeow logs decrypted stanzas at that level,
// and a stanza carries the sender's phone number straight to stdout, bypassing
// every containment in internal/identity.
func TestDefaultLogLevelIsNotDebug(t *testing.T) {
	s, _ := openSession(t)

	if got := s.LogLevel(); got == LogDebug {
		t.Fatalf("an unset log level resolved to %q; whatsmeow prints decrypted "+
			"stanzas at that level, and a stanza carries the sender's phone number", got)
	}
	if s.LogLevel() != LogWarn {
		t.Fatalf("default log level = %q, want %q", s.LogLevel(), LogWarn)
	}
}

// An explicit choice must still be honoured — the default exists to protect the
// unconfigured case, not to make debugging impossible.
func TestExplicitLogLevelIsHonoured(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "transport")
	s, err := Open(context.Background(), Config{Dir: dir, LogLevel: LogDebug})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	if s.LogLevel() != LogDebug {
		t.Fatalf("log level = %q, want %q", s.LogLevel(), LogDebug)
	}
}

// ── The capability the previous transport could not have ────────────────────
//
// SPEC §3.4 records `GET /contacts` as "not buildable", and §0.5 lists "no
// contact roster, and there will not be one" as a binding constraint of the DOM
// transport — correctly, since no DOM affordance enumerates contacts.
//
// Here it is a store read — but only once a device exists. whatsmeow leaves the
// per-device sub-stores nil until pairing, so the pre-pairing call must refuse
// rather than dereference nil: an HTTP request to a contacts endpoint on a fresh
// deployment is precisely how a process would be taken down by that.
func TestContactsRefusesBeforePairingInsteadOfCrashing(t *testing.T) {
	s, _ := openSession(t)

	contacts, err := s.Contacts(context.Background())
	if !errors.Is(err, ErrNotPaired) {
		t.Fatalf("Contacts error = %v, want ErrNotPaired", err)
	}
	if contacts != nil {
		t.Fatalf("a refusal returned %d contacts", len(contacts))
	}
}

// whatsmeow invokes event handlers synchronously on its read loop. A handler that
// panics or propagates would stall decryption of everything queued behind it, so
// the wrapper must absorb every failure and leave only a counter behind.
func TestHandleAbsorbsFailuresInsteadOfPropagating(t *testing.T) {
	s, _ := openSession(t)

	broken := liveMessage("3EB0AAA")
	broken.Info.ID = "" // unstorable: event.ErrNoID

	// No panic, no return value to check — the contract is that whatsmeow's loop
	// is never disturbed.
	s.handle(broken)

	status, err := s.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Events.Failed != 1 {
		t.Fatalf("Failed = %d, want 1 — the failure must be counted, not just swallowed",
			status.Events.Failed)
	}
}

func TestHandleQueuesAGoodMessage(t *testing.T) {
	s, _ := openSession(t)

	s.handle(liveMessage("3EB0AAA"))

	status, err := s.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Events.Messages != 1 {
		t.Fatalf("Messages = %d, want 1", status.Events.Messages)
	}
	if status.Queue.Depth != 1 {
		t.Fatalf("queue depth = %d, want 1 — the message must be durable, not just counted",
			status.Queue.Depth)
	}
}

func TestAccessorsAreWired(t *testing.T) {
	s, _ := openSession(t)

	if s.Client() == nil {
		t.Error("Client() is nil")
	}
	if s.Outbox() == nil {
		t.Error("Outbox() is nil")
	}
	if s.Media() == nil {
		t.Error("Media() is nil")
	}
	// The guard and the ingest path must share one resolver, or they would
	// disagree about who a recipient is — and the disagreement that mattered
	// would be the one guarding sends.
	if s.Resolver() == nil {
		t.Error("Resolver() is nil")
	}
}

func TestCloseIsSafeToCallOnAFreshSession(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "transport")
	s, err := Open(context.Background(), Config{Dir: dir})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

// Reopening must find the device store the previous run wrote, or every restart
// would present a QR code and the pairing would never stick.
func TestReopenReusesTheSameDeviceStore(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "transport")

	first, err := Open(context.Background(), Config{Dir: dir})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second, err := Open(context.Background(), Config{Dir: dir})
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer second.Close()

	if second.Paired() {
		t.Fatal("an unpaired store reported as paired after reopen")
	}
}

// A media fetch for a message that was never a media message, or whose pointer
// has been evicted, must be distinguishable from a broken transport.
func TestDownloadMediaReportsAnUnknownKey(t *testing.T) {
	s, _ := openSession(t)

	_, _, err := s.DownloadMedia(context.Background(), "3EB0NEVER")
	if !errors.Is(err, mediastore.ErrNotStored) {
		t.Fatalf("error = %v, want ErrNotStored", err)
	}
}

func TestRequestHistoryRefusesBeforePairing(t *testing.T) {
	s, _ := openSession(t)

	anchor := types.MessageInfo{
		MessageSource: types.MessageSource{Chat: types.NewJID("1203630000", types.GroupServer)},
		ID:            "3EB0OLD",
	}
	if err := s.RequestHistory(context.Background(), anchor, 50); !errors.Is(err, ErrNotPaired) {
		t.Fatalf("error = %v, want ErrNotPaired", err)
	}
}

// Without an anchor there is nothing to request history relative to. Refusing is
// better than sending a request the phone will answer with nothing, which would
// read as "there is no more history".
func TestRequestHistoryRequiresAnAnchor(t *testing.T) {
	s, _ := openSession(t)

	for _, anchor := range []types.MessageInfo{
		{ID: "3EB0OLD"}, // no chat
		{MessageSource: types.MessageSource{Chat: types.NewJID("1203630000", types.GroupServer)}}, // no id
	} {
		if err := s.RequestHistory(context.Background(), anchor, 50); err == nil {
			t.Fatalf("RequestHistory accepted an incomplete anchor: %+v", anchor)
		}
	}
}

func TestMediaStoreIsOpenedAlongsideTheOthers(t *testing.T) {
	s, dir := openSession(t)

	if _, err := os.Stat(filepath.Join(dir, mediaFile)); err != nil {
		t.Fatalf("%s was not created: %v", mediaFile, err)
	}
	count, err := s.Media().Count(context.Background())
	if err != nil {
		t.Fatalf("Count: %v", err)
	}
	if count != 0 {
		t.Fatalf("a fresh media store held %d rows", count)
	}
}

// ── Pairing leaves the socket closed ────────────────────────────────────────
//
// whatsmeow's `expectDisconnect()` runs as the last step of pairing and clears
// `forceAutoReconnect`, so the auto-reconnect that handles every other kind of
// drop deliberately does not fire here. Without the PairSuccess handler the
// transport reports `paired: true, connected: false` and receives nothing, which
// looks exactly like a working installation.
//
// A real reconnect needs a server, so what is asserted here is that the event is
// recognised and routed without disturbing whatsmeow's loop — the reconnect
// itself is verified by pairing.
func TestPairSuccessIsHandledWithoutDisturbingTheEventLoop(t *testing.T) {
	s, _ := openSession(t)

	// Must not panic and must not block: whatsmeow dispatches synchronously, so a
	// handler that connected inline would deadlock against its own socket
	// teardown.
	done := make(chan struct{})
	go func() {
		s.handle(&events.PairSuccess{})
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handling PairSuccess blocked; it must hand off to a goroutine")
	}

	// PairSuccess is not a message, so it must not be counted as one.
	status, err := s.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Events.Messages != 0 || status.Events.Failed != 0 {
		t.Fatalf("PairSuccess was counted as message traffic: %+v", status.Events)
	}
	if status.Events.Ignored != 1 {
		t.Fatalf("Ignored = %d, want 1 — the event should reach the dispatcher too",
			status.Events.Ignored)
	}
}
