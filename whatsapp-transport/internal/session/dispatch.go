// Package session owns the WhatsApp connection and turns its events into
// archive events.
//
// The package splits deliberately in two:
//
//   - `dispatch.go` decides what each event means, and depends only on
//     interfaces. It is unit tested.
//   - `session.go` owns the socket, the device store and the pairing flow. It
//     cannot be unit tested without a WhatsApp account, and does as little
//     decision-making as possible for exactly that reason.
//
// This is the same split `whatsapp-bridge` already makes between `watch.js`
// (rules, browser-free, tested) and `session.js` (the browser). The lesson
// carried over is that every interesting case is a failure case, and failure
// cases need to be reachable from a test.
package session

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/event"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/identity"
)

// Sink is where described messages go. Satisfied by `internal/outbox`.
type Sink interface {
	Append(ctx context.Context, msg event.Message) error
}

// MediaSink remembers how to fetch a message's media later. Satisfied by
// `internal/mediastore`.
//
// Separate from Sink because the two have different lifetimes: the outbox is
// drained and emptied within seconds, while media must stay fetchable for as long
// as the agent might want to transcribe or view it.
type MediaSink interface {
	Put(ctx context.Context, id, mimetype, filename string, msg *waE2E.Message) error
}

// WebMessageParser turns a history-sync record into the same shape a live
// message arrives in. Satisfied by `*whatsmeow.Client`.
//
// Injected rather than called on a concrete client so that history dispatch —
// the branch with the most ways to go wrong — is reachable from a test.
type WebMessageParser interface {
	ParseWebMessage(chatJID types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error)
}

// Counters are what the transport can honestly say about what it has seen.
//
// `Ignored` and `Undecryptable` matter as much as `Messages`: an event class
// nobody handles and a message that never decrypted are both silent absences in
// the archive, and SPEC §5.8 requires the agent to state what it does not have.
type Counters struct {
	Messages      atomic.Int64
	FromHistory   atomic.Int64
	Unrecognised  atomic.Int64
	Undecryptable atomic.Int64
	Ignored       atomic.Int64
	Failed        atomic.Int64

	// MediaUnrecorded counts messages stored without their media pointer. The
	// message is in the archive and readable; only its bytes are unreachable, so
	// this is a distinct and lesser failure than Failed and must not be folded
	// into it.
	MediaUnrecorded atomic.Int64

	// unrecognisedTypes tallies WHICH protobuf arms went undescribed.
	//
	// The bare Unrecognised count reached 446 on a real archive while saying
	// nothing about what those messages were, so the gap could not be
	// prioritised and stayed open. Keyed by protocol field name only — no text,
	// no sender, no id — which is what makes it safe on a status endpoint.
	unrecognisedTypesMu sync.Mutex
	unrecognisedTypes   map[string]int64
}

// NoteUnrecognised records one message nothing could describe.
//
// `field` is the protobuf arm that was set, or empty when even that could not be
// determined; the empty case is tallied under a placeholder so that the tally
// always sums to Unrecognised. Two numbers that disagree are worse than one.
func (c *Counters) NoteUnrecognised(field string) {
	c.Unrecognised.Add(1)

	if field == "" {
		field = "(unnameable)"
	}
	c.unrecognisedTypesMu.Lock()
	defer c.unrecognisedTypesMu.Unlock()
	if c.unrecognisedTypes == nil {
		c.unrecognisedTypes = make(map[string]int64)
	}
	c.unrecognisedTypes[field]++
}

// Snapshot is a Counters reading, safe to serialise.
type Snapshot struct {
	Messages        int64 `json:"messages"`
	FromHistory     int64 `json:"fromHistory"`
	Unrecognised    int64 `json:"unrecognised"`
	Undecryptable   int64 `json:"undecryptable"`
	Ignored         int64 `json:"ignored"`
	Failed          int64 `json:"failed"`
	MediaUnrecorded int64 `json:"mediaUnrecorded"`

	// UnrecognisedTypes is the breakdown behind Unrecognised, keyed by protobuf
	// field name. Never nil, so a consumer needs no nil check and an empty tally
	// reads as visibly empty rather than as absent.
	UnrecognisedTypes map[string]int64 `json:"unrecognisedTypes"`
}

func (c *Counters) Snapshot() Snapshot {
	c.unrecognisedTypesMu.Lock()
	// Copied rather than shared: the snapshot is serialised on a request
	// goroutine while the dispatcher keeps writing on whatsmeow's read loop, and
	// handing out the live map would be a data race on every status poll.
	types := make(map[string]int64, len(c.unrecognisedTypes))
	for field, n := range c.unrecognisedTypes {
		types[field] = n
	}
	c.unrecognisedTypesMu.Unlock()

	return Snapshot{
		Messages:          c.Messages.Load(),
		FromHistory:       c.FromHistory.Load(),
		Unrecognised:      c.Unrecognised.Load(),
		Undecryptable:     c.Undecryptable.Load(),
		Ignored:           c.Ignored.Load(),
		Failed:            c.Failed.Load(),
		MediaUnrecorded:   c.MediaUnrecorded.Load(),
		UnrecognisedTypes: types,
	}
}

// Dispatcher routes whatsmeow events into the sink.
// Contacts supplies a correspondent's advertised name when the message itself
// carries none.
//
// Narrow on purpose: whatsmeow's ContactStore has seven methods, six of which
// write. The dispatcher must never write to the contact store — it describes
// messages — so it accepts only the read it actually needs.
type Contacts interface {
	GetContact(ctx context.Context, user types.JID) (types.ContactInfo, error)
}

type Dispatcher struct {
	resolver *identity.Resolver
	sink     Sink
	media    MediaSink
	parser   WebMessageParser
	contacts Contacts
	counters Counters
}

func NewDispatcher(r *identity.Resolver, sink Sink, media MediaSink, parser WebMessageParser, contacts Contacts) *Dispatcher {
	return &Dispatcher{resolver: r, sink: sink, media: media, parser: parser, contacts: contacts}
}

// nameFor recovers a display name the message did not carry.
//
// ── Why this is necessary ───────────────────────────────────────────────────
// `evt.Info.PushName` is set by the sending device on a live message and left
// EMPTY on everything replayed by history sync. A first pairing is almost
// entirely history: of the first thousand messages drained here, 991 came from
// history and not one carried a push name. The bridge hangs a chat's label on
// `pushName` (see `chatDisplayName` in transport.js), so without this the whole
// archive lands keyed by `@lid` addresses with no human name anywhere in it —
// 199 of 201 chats, in the run that prompted this.
//
// ── Why the phone number and not the LID ────────────────────────────────────
// whatsmeow's contact store is keyed by phone JID (`whatsmeow_contacts.their_jid`
// is `<number>@s.whatsapp.net`), while a resolved identity is a LID. The number
// is reached through `Identity.PhoneNumber` rather than re-derived, because that
// accessor is the single audited disclosure point for it — see the `identity`
// package comment. Nothing here logs or stores it.
func (d *Dispatcher) nameFor(ctx context.Context, sender identity.Identity, evt *events.Message) string {
	if d.contacts == nil {
		return ""
	}

	candidates := make([]types.JID, 0, 3)
	if phone, ok := sender.PhoneNumber(); ok && phone != "" {
		candidates = append(candidates, types.NewJID(phone, types.DefaultUserServer))
	}
	// History messages may carry the phone form directly, in either field.
	for _, jid := range [2]types.JID{evt.Info.Sender, evt.Info.SenderAlt} {
		if jid.Server == types.DefaultUserServer && jid.User != "" {
			candidates = append(candidates, jid.ToNonAD())
		}
	}

	for _, jid := range candidates {
		info, err := d.contacts.GetContact(ctx, jid)
		if err != nil || !info.Found {
			continue
		}
		// FullName is the name the OPERATOR gave the contact, so it beats the
		// name the contact chose for themselves. RedactedPhone is deliberately
		// never used: a partially-masked number is still a number.
		for _, name := range [3]string{info.FullName, info.PushName, info.BusinessName} {
			if name != "" {
				return name
			}
		}
	}
	return ""
}

func (d *Dispatcher) Counters() Snapshot { return d.counters.Snapshot() }

// Handle routes one event.
//
// Returns an error only for a failure worth surfacing; an event class this
// transport does not care about is counted and ignored, not reported. That
// distinction is the point of the `Ignored` counter — "we saw 4,000 events and
// stored 12" is a diagnosable state, while a silent discard is not.
func (d *Dispatcher) Handle(ctx context.Context, raw any) error {
	switch evt := raw.(type) {
	case *events.Message:
		return d.handleMessage(ctx, evt)

	case *events.HistorySync:
		return d.handleHistorySync(ctx, evt)

	case *events.UndecryptableMessage:
		// whatsmeow asks the sender to retry automatically, so this is not
		// terminal — but if the retry never lands, this counter is the only
		// evidence a message existed at all.
		d.counters.Undecryptable.Add(1)
		return nil

	default:
		d.counters.Ignored.Add(1)
		return nil
	}
}

func (d *Dispatcher) handleMessage(ctx context.Context, evt *events.Message) error {
	msg, err := event.FromMessage(ctx, d.resolver, evt)
	if err != nil {
		d.counters.Failed.Add(1)
		return fmt.Errorf("session: describing message: %w", err)
	}

	// Only ever fills a gap: a name the sending device advertised is the more
	// current of the two, so it is never overwritten.
	if msg.PushName == "" {
		msg.PushName = d.nameFor(ctx, msg.Sender, evt)
	}

	if err := d.sink.Append(ctx, msg); err != nil {
		d.counters.Failed.Add(1)
		return fmt.Errorf("session: queueing message %s: %w", msg.Key, err)
	}

	// Recorded after the queue, not before: a message the archive will never see
	// needs no media pointer, and failing to store the pointer must not cost the
	// message itself. A media fetch that later finds nothing recorded reports
	// exactly that, which is recoverable; a lost message is not.
	if msg.Kind.HasMedia() && d.media != nil {
		if err := d.media.Put(ctx, msg.Key, msg.Mimetype, msg.Filename, evt.Message); err != nil {
			d.counters.MediaUnrecorded.Add(1)
		}
	}

	d.counters.Messages.Add(1)
	if msg.FromHistory {
		d.counters.FromHistory.Add(1)
	}
	if !msg.Recognised {
		d.counters.NoteUnrecognised(msg.UnknownType)
	}
	return nil
}

// handleHistorySync walks a backfill payload.
//
// ── Why one bad record does not abandon the batch ───────────────────────────
// A history sync carries thousands of messages across many conversations, and
// the payload is whatever the phone had — including records with no key, no
// chat, or a message shape this build cannot parse. Aborting on the first of
// those would discard every message after it, so each record is attempted
// independently and the failures are counted.
//
// The errors are joined rather than dropped so that a systematically broken
// batch is still visible as one.
func (d *Dispatcher) handleHistorySync(ctx context.Context, evt *events.HistorySync) error {
	if evt.Data == nil {
		d.counters.Ignored.Add(1)
		return nil
	}

	var problems []error

	for _, conversation := range evt.Data.GetConversations() {
		chatJID, err := types.ParseJID(conversation.GetID())
		if err != nil {
			// A conversation whose id will not parse cannot be attributed, and
			// storing its messages against a guessed chat would be worse than
			// counting them lost.
			d.counters.Failed.Add(int64(len(conversation.GetMessages())))
			problems = append(problems,
				fmt.Errorf("session: unparseable conversation id: %w", err))
			continue
		}

		for _, record := range conversation.GetMessages() {
			webMsg := record.GetMessage()
			if webMsg == nil {
				d.counters.Failed.Add(1)
				continue
			}

			parsed, err := d.parser.ParseWebMessage(chatJID, webMsg)
			if err != nil {
				d.counters.Failed.Add(1)
				problems = append(problems, fmt.Errorf("session: parsing history record: %w", err))
				continue
			}

			if err := d.handleMessage(ctx, parsed); err != nil {
				problems = append(problems, err)
			}
		}
	}

	return errors.Join(problems...)
}
