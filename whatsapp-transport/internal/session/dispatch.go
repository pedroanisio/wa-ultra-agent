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
}

func (c *Counters) Snapshot() Snapshot {
	return Snapshot{
		Messages:        c.Messages.Load(),
		FromHistory:     c.FromHistory.Load(),
		Unrecognised:    c.Unrecognised.Load(),
		Undecryptable:   c.Undecryptable.Load(),
		Ignored:         c.Ignored.Load(),
		Failed:          c.Failed.Load(),
		MediaUnrecorded: c.MediaUnrecorded.Load(),
	}
}

// Dispatcher routes whatsmeow events into the sink.
type Dispatcher struct {
	resolver *identity.Resolver
	sink     Sink
	media    MediaSink
	parser   WebMessageParser
	counters Counters
}

func NewDispatcher(r *identity.Resolver, sink Sink, media MediaSink, parser WebMessageParser) *Dispatcher {
	return &Dispatcher{resolver: r, sink: sink, media: media, parser: parser}
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
		d.counters.Unrecognised.Add(1)
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
