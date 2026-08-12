package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"

	// Pure-Go SQLite, registered as "sqlite". `dbutil.ParseDialect` accepts any
	// name with a `sqlite` prefix, so whatsmeow's store works with it unmodified
	// and the container needs no C toolchain.
	_ "modernc.org/sqlite"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/identity"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/mediastore"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/outbox"
)

// ── Why two database files and not one ──────────────────────────────────────
//
// whatsmeow's store and the outbox each get their own SQLite file, for a reason
// that is not tidiness. whatsmeow holds transactions open while issuing further
// queries, so a shared handle capped at one connection would deadlock the moment
// a nested read happened inside a write. Widening the pool instead trades that
// deadlock for SQLITE_BUSY between two writers on one file.
//
// Separate files remove the problem rather than tuning it: each database has
// exactly one writer and they never contend. This is the same reasoning that
// keeps the transport out of the archive's file — see the `outbox` package
// comment.
const (
	sessionFile = "session.db"
	outboxFile  = "outbox.db"
	mediaFile   = "media.db"
)

// LogLevel is how loud whatsmeow is allowed to be.
//
// ── Why the default is not DEBUG ────────────────────────────────────────────
// whatsmeow's DEBUG level prints decrypted stanzas, and a stanza carries the
// sender's full JID — which before the LID migration is their phone number. A
// debug-level transport therefore writes contacts' phone numbers to stdout,
// where they land in container logs, in `docker compose logs` output, and in
// anything scraping them.
//
// That is exactly the disclosure `internal/identity` is built to prevent, and it
// would bypass it entirely by never passing through an `Identity`. So DEBUG is
// available but never the default, and turning it on is a deliberate act.
type LogLevel string

const (
	LogWarn  LogLevel = "WARN"
	LogInfo  LogLevel = "INFO"
	LogDebug LogLevel = "DEBUG"
)

type Config struct {
	// Dir holds the transport's two databases. Treat it exactly as the browser
	// profile directory was treated: the paired session in it IS the credential,
	// and anyone who copies it has the account without a QR scan.
	Dir string

	// LogLevel defaults to LogWarn. See the type comment before raising it.
	LogLevel LogLevel

	// OutboxCapacity defaults to outbox.DefaultCapacity.
	OutboxCapacity int64
}

type Session struct {
	container  *sqlstore.Container
	client     *whatsmeow.Client
	outbox     *outbox.Outbox
	media      *mediastore.Store
	dispatcher *Dispatcher
	resolver   *identity.Resolver
	log        waLog.Logger

	// logLevel is the level actually in force after defaulting, kept so the
	// choice is observable. Without it, "the default is not DEBUG" is only
	// assertable by reading Open, which no test can do.
	logLevel LogLevel
}

// LogLevel reports the level in force, after defaulting.
func (s *Session) LogLevel() LogLevel { return s.logLevel }

// Status is what the transport can say about itself without connecting.
type Status struct {
	Paired    bool     `json:"paired"`
	Connected bool     `json:"connected"`
	LoggedIn  bool     `json:"loggedIn"`
	Events    Snapshot `json:"events"`
	Queue     struct {
		Depth   int64 `json:"depth"`
		Dropped int64 `json:"dropped"`
	} `json:"queue"`

	// Account is the operator's own identity, carried as an Identity so that the
	// containment applies to their number too. A status endpoint is the most
	// casually-read surface there is.
	Account *identity.Identity `json:"account,omitempty"`
}

// Open prepares the transport: both databases, the device store and the client.
//
// Does not connect. Pairing state decides what happens next, and that decision
// belongs to the caller — an unpaired session needs a human with a phone.
func Open(ctx context.Context, cfg Config) (*Session, error) {
	if cfg.Dir == "" {
		return nil, errors.New("session: Config.Dir is required")
	}
	if cfg.LogLevel == "" {
		cfg.LogLevel = LogWarn
	}
	if err := os.MkdirAll(cfg.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("session: preparing %s: %w", cfg.Dir, err)
	}

	log := waLog.Stdout("whatsmeow", string(cfg.LogLevel), true)

	opts := []outbox.Option{}
	if cfg.OutboxCapacity > 0 {
		opts = append(opts, outbox.WithCapacity(cfg.OutboxCapacity))
	}
	box, err := outbox.Open(ctx, filepath.Join(cfg.Dir, outboxFile), opts...)
	if err != nil {
		return nil, err
	}

	media, err := mediastore.Open(ctx, filepath.Join(cfg.Dir, mediaFile))
	if err != nil {
		box.Close()
		return nil, err
	}

	// `_foreign_keys=on` is whatsmeow's own recommendation: its store relies on
	// cascading deletes to clean up a logged-out device's keys.
	dsn := "file:" + filepath.Join(cfg.Dir, sessionFile) + "?_foreign_keys=on&_journal_mode=WAL"
	container, err := sqlstore.New(ctx, "sqlite", dsn, log.Sub("store"))
	if err != nil {
		box.Close()
		media.Close()
		return nil, fmt.Errorf("session: opening device store: %w", err)
	}

	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		box.Close()
		media.Close()
		return nil, fmt.Errorf("session: reading device: %w", err)
	}

	client := whatsmeow.NewClient(device, log.Sub("client"))
	resolver := identity.NewResolver(device.LIDs)
	// device.Contacts is the name of last resort: history-sync messages carry no
	// push name, so without it a first pairing produces an archive of unnamed
	// `@lid` chats. See Dispatcher.nameFor.
	dispatcher := NewDispatcher(resolver, box, media, client, device.Contacts)

	s := &Session{
		container:  container,
		client:     client,
		outbox:     box,
		media:      media,
		dispatcher: dispatcher,
		resolver:   resolver,
		log:        log,
		logLevel:   cfg.LogLevel,
	}

	client.AddEventHandler(s.handle)
	return s, nil
}

// handle is the bridge from whatsmeow's callback to the dispatcher.
//
// whatsmeow calls event handlers synchronously on its read loop, so a slow or
// failing handler stalls decryption of everything behind it. The work here is one
// SQLite insert, which is fast — but an error must not propagate into whatsmeow's
// loop, because there is nothing it could usefully do with one. It is logged and
// counted instead, and `Status.Events.Failed` is what makes it visible.
func (s *Session) handle(raw any) {
	// Pairing leaves the socket closed. Reconnecting is not the dispatcher's job
	// — it describes messages — so it is handled here, before dispatch.
	if _, ok := raw.(*events.PairSuccess); ok {
		go s.reconnectAfterPairing()
	}

	if err := s.dispatcher.Handle(context.Background(), raw); err != nil {
		s.log.Errorf("handling %T: %v", raw, err)
	}
}

// reconnectAfterPairing brings the session back up once a device is linked.
//
// ── Why this is necessary ───────────────────────────────────────────────────
// whatsmeow calls `expectDisconnect()` as the last step of pairing, which both
// suppresses the Disconnected event AND clears `forceAutoReconnect`. In
// `onDisconnect` the reconnect branch is then skipped, so auto-reconnect — on by
// default, and working for every other kind of drop — deliberately does not fire
// here.
//
// The consequence without this function is the worst kind of quiet failure: the
// operator scans the code, sees "success", and the transport reports `paired:
// true, connected: false` while receiving nothing at all. Everything looks
// installed and no messages arrive.
//
// Run in its own goroutine because whatsmeow dispatches events synchronously on
// its read loop: connecting from inside the handler would deadlock against the
// teardown of the very socket that delivered the event.
func (s *Session) reconnectAfterPairing() {
	// Wait for the server-side disconnect to land. Connecting while the old
	// socket is still closing is refused, and a fixed sleep would be a guess in
	// both directions, so this polls briefly instead.
	for i := 0; i < 50; i++ {
		if !s.client.IsConnected() {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := s.client.ConnectContext(ctx); err != nil {
		// Not fatal, and deliberately loud: a restart of the process also
		// reconnects, and /status will show `connected: false` until then.
		s.log.Errorf("pairing succeeded but reconnecting failed: %v. "+
			"Call POST /connect or restart the service; the device is linked and the "+
			"session is saved.", err)
		return
	}
	s.log.Infof("reconnected after pairing")
}

// Paired reports whether a device is registered, without connecting.
func (s *Session) Paired() bool { return s.client.Store.ID != nil }

// Self is the operator's own address, for the one send that needs no allowlist.
//
// Returned as a JID rather than an Identity because it exists to be SENT to,
// and `/send` speaks JIDs. That makes it the one place the operator's own
// number leaves this package, which is why it is a named method with this
// comment rather than a field: a self-note is addressed here and nowhere else,
// and `POST /send/self` never echoes it back to the caller.
//
// The device suffix is stripped: a message is addressed to a person, not to the
// particular linked device this transport happens to be.
func (s *Session) Self() (types.JID, bool) {
	id := s.client.Store.ID
	if id == nil {
		return types.JID{}, false
	}
	return id.ToNonAD(), true
}

func (s *Session) Status(ctx context.Context) (Status, error) {
	status := Status{
		Paired:    s.Paired(),
		Connected: s.client.IsConnected(),
		LoggedIn:  s.client.IsLoggedIn(),
		Events:    s.dispatcher.Counters(),
	}

	stats, err := s.outbox.Stats(ctx)
	if err != nil {
		return Status{}, err
	}
	status.Queue.Depth = stats.Depth
	status.Queue.Dropped = stats.Dropped

	if id := s.client.Store.ID; id != nil {
		account, err := s.resolver.Resolve(ctx, id.ToNonAD())
		if err == nil {
			status.Account = &account
		}
	}
	return status, nil
}

// Connect brings up an already-paired session.
//
// Refuses an unpaired one rather than connecting and waiting: without a QR
// channel registered first, whatsmeow's pairing events have nowhere to go, and
// the session would sit connected-but-useless with no way to tell why.
func (s *Session) Connect(ctx context.Context) error {
	if !s.Paired() {
		return fmt.Errorf("%w — call BeginQRPairing or PairPhone first", ErrNotPaired)
	}
	if err := s.client.ConnectContext(ctx); err != nil {
		return fmt.Errorf("session: connecting: %w", err)
	}
	return nil
}

// BeginQRPairing starts a first-time login and returns the QR code stream.
//
// Order is load-bearing: whatsmeow requires the QR channel to be taken BEFORE
// connecting, because the channel is fed by pairing events that arrive during the
// handshake. Taking it afterwards yields a channel that never produces a code.
//
// Cancellation is detached from the caller's context, and that is load-bearing
// too. `ctx` here belongs to the `/pair/qr` HTTP request, and the handler
// returns the instant it forwards `success` — so the request is cancelled
// within milliseconds of a successful scan. whatsmeow's QR emitter reacts to
// its context being done by calling `Disconnect()` on the *client* (qrchan.go),
// not merely by stopping the code stream, so that cancellation races
// `reconnectAfterPairing` and tears down the socket it has just established.
// The observable failure is the one this cost an evening to find: the phone
// spins on "Logging in", the half-provisioned registration is abandoned
// server-side, and the next connect is refused with `401 logged out from
// another device` — which whatsmeow treats as a logout and deletes the session,
// so `paired` flips back to false and the whole scan is wasted.
//
// The channel still terminates on its own for the reasons that matter: success,
// timeout, or a pairing error all close it from whatsmeow's side.
func (s *Session) BeginQRPairing(ctx context.Context) (<-chan whatsmeow.QRChannelItem, error) {
	if s.Paired() {
		return nil, errors.New("session: already paired — use Connect")
	}

	pairCtx := context.WithoutCancel(ctx)

	codes, err := s.client.GetQRChannel(pairCtx)
	if err != nil {
		return nil, fmt.Errorf("session: opening QR channel: %w", err)
	}
	if err := s.client.ConnectContext(pairCtx); err != nil {
		return nil, fmt.Errorf("session: connecting to pair: %w", err)
	}
	return codes, nil
}

// PairPhone returns a code for the operator to type into WhatsApp on their phone.
//
// The alternative to a QR scan, and the better one for a headless host: it needs
// no screen and no image rendering, only the operator's own number.
func (s *Session) PairPhone(ctx context.Context, phone string) (string, error) {
	if s.Paired() {
		return "", errors.New("session: already paired — use Connect")
	}
	if phone == "" {
		return "", errors.New("session: a phone number is required to pair")
	}

	// Detached for the same reason as BeginQRPairing: this connection has to
	// outlive the HTTP request that asked for the code, because the operator
	// still has to type it into their phone afterwards.
	if !s.client.IsConnected() {
		if err := s.client.ConnectContext(context.WithoutCancel(ctx)); err != nil {
			return "", fmt.Errorf("session: connecting to pair: %w", err)
		}
	}

	code, err := s.client.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, "WhatsApp Agent")
	if err != nil {
		return "", fmt.Errorf("session: requesting a pairing code: %w", err)
	}
	return code, nil
}

// Client exposes the underlying client for the operations that are genuinely
// whatsmeow's — sending, downloading media, requesting history.
//
// Deliberately not wrapped one method at a time: a passthrough per call would be
// a second API to keep in step with whatsmeow's, and the HTTP layer is where the
// policy (allowlist, rate limits) belongs anyway.
func (s *Session) Client() *whatsmeow.Client { return s.client }

// Outbox exposes the queue for the HTTP layer to drain.
func (s *Session) Outbox() *outbox.Outbox { return s.outbox }

// ErrNotPaired is returned by operations that need a registered device.
var ErrNotPaired = errors.New("session: not paired")

// Contacts returns everyone the account knows.
//
// This is the endpoint SPEC §3.4 records as "not buildable" and §0.5 calls a
// permanent limit of the DOM transport. It is one store read here, which is the
// clearest single illustration of what changing transport bought.
//
// The guard is not defensive padding: whatsmeow leaves the per-device sub-stores
// nil until a device is registered, so calling this before pairing dereferences
// nil and takes the process down. An HTTP request is exactly how that would
// happen.
func (s *Session) Contacts(ctx context.Context) (map[types.JID]types.ContactInfo, error) {
	if !s.Paired() || s.client.Store.Contacts == nil {
		return nil, fmt.Errorf("%w: the contact roster arrives with app-state sync after pairing", ErrNotPaired)
	}
	return s.client.Store.Contacts.GetAllContacts(ctx)
}

// Groups returns the groups this account has joined, with their subjects.
//
// ── Why this is not a store read like Contacts ──────────────────────────────
// whatsmeow persists no group subject. The name of a group exists on the server
// and nowhere on disk, so the only way to learn that a JID is called "We" is to
// ask — which is why this needs a live connection where Contacts needs only a
// registered device, and why it can fail while the contact roster succeeds.
//
// The connection guard is the same class of protection as the nil sub-store
// check above: `GetJoinedGroups` on a disconnected client returns a "not
// connected" error rather than crashing, but saying so in the session's own
// vocabulary keeps the caller from reporting a network fault as an empty
// account.
func (s *Session) Groups(ctx context.Context) ([]types.GroupInfo, error) {
	if !s.Paired() {
		return nil, fmt.Errorf("%w: group subjects are read from the server, not the store", ErrNotPaired)
	}
	if !s.client.IsConnected() {
		return nil, errors.New("session: not connected — group subjects require a live connection")
	}

	joined, err := s.client.GetJoinedGroups(ctx)
	if err != nil {
		return nil, fmt.Errorf("session: listing joined groups: %w", err)
	}

	// Flattened to values because the pointers are whatsmeow's, and a caller
	// that ranged over them would be reading a slice this package does not own.
	groups := make([]types.GroupInfo, 0, len(joined))
	for _, group := range joined {
		if group == nil {
			continue
		}
		groups = append(groups, *group)
	}
	return groups, nil
}

// Close disconnects and releases both databases.
func (s *Session) Close() error {
	if s.client != nil {
		s.client.Disconnect()
	}
	var problems []error
	if s.outbox != nil {
		problems = append(problems, s.outbox.Close())
	}
	if s.media != nil {
		problems = append(problems, s.media.Close())
	}
	if s.container != nil {
		problems = append(problems, s.container.Close())
	}
	return errors.Join(problems...)
}

// Ensure the device store's LID map satisfies the resolver's dependency, so that
// an upstream rename or signature change fails the build here rather than at the
// call site in Open.
//
// Written against a zero VALUE rather than a nil pointer: `(*store.Device)(nil).LIDs`
// compiles just as happily and then dereferences nil during package
// initialisation, crashing the process before main runs. It did exactly that
// once.
var _ identity.LIDs = store.Device{}.LIDs

// Resolver exposes the identity resolver so the send guard and the HTTP layer
// canonicalise addresses exactly as the ingest path does. Two resolvers with
// different LID views would disagree about who a recipient is, and the one that
// mattered would be the one guarding sends.
func (s *Session) Resolver() *identity.Resolver { return s.resolver }

// ErrMediaUnavailable means the media cannot be produced.
//
// Distinct from "this message has no media": the difference between "there was
// never a file here" and "there was one and it can no longer be fetched" is the
// difference between a correct empty answer and a gap the operator should know
// about.
var ErrMediaUnavailable = errors.New("session: media is unavailable")

// Media exposes the media store for status reporting.
func (s *Session) Media() *mediastore.Store { return s.media }

// DownloadMedia fetches and decrypts the bytes behind a message.
//
// Fetched on demand rather than cached at arrival, so the operator's photos and
// voice notes are not duplicated onto this disk. The cost is that WhatsApp
// expires media server-side: a download attempted long enough after the fact
// fails, and that failure is reported rather than returned as an empty file.
func (s *Session) DownloadMedia(ctx context.Context, key string) (mediastore.Record, []byte, error) {
	record, err := s.media.Get(ctx, key)
	if err != nil {
		return mediastore.Record{}, nil, err
	}
	if !s.client.IsConnected() {
		return record, nil, fmt.Errorf("%w: not connected", ErrMediaUnavailable)
	}

	data, err := s.client.DownloadAny(ctx, record.Message)
	if err != nil {
		// Wrapped rather than passed through so callers can distinguish "gone
		// from WhatsApp" from "this transport is broken", and answer accordingly.
		return record, nil, fmt.Errorf("%w: %v", ErrMediaUnavailable, err)
	}
	return record, data, nil
}

// RequestHistory asks the operator's phone for messages older than one already
// held.
//
// ── What this can and cannot do ─────────────────────────────────────────────
// This is not scrollback. `BuildHistorySyncRequest` asks the PRIMARY DEVICE — the
// operator's phone — for the `count` messages immediately before the anchor, and
// the answer arrives asynchronously as an `ON_DEMAND` history-sync event, landing
// in the outbox like any other message.
//
// So the reachable depth is whatever the phone still holds, not whatever
// WhatsApp's servers hold, and a phone that is off or has deleted the
// conversation returns nothing. That is a real limit of this transport and it
// belongs in the operator's mental model, not buried in a retry loop.
//
// whatsmeow recommends 50 per request.
func (s *Session) RequestHistory(ctx context.Context, anchor types.MessageInfo, count int) error {
	if !s.Paired() {
		return ErrNotPaired
	}
	if anchor.ID == "" || anchor.Chat.IsEmpty() {
		return errors.New("session: a history request needs the id and chat of the oldest known message")
	}
	if count <= 0 {
		count = 50
	}

	request := s.client.BuildHistorySyncRequest(&anchor, count)
	if request == nil {
		return errors.New("session: could not build a history request for that anchor")
	}
	if _, err := s.client.SendPeerMessage(ctx, request); err != nil {
		return fmt.Errorf("session: requesting history: %w", err)
	}
	return nil
}
