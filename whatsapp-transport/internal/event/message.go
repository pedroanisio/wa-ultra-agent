// Package event is the wire format between this transport and the archive.
//
// ── Why the transport does not write to SQLite ───────────────────────────────
// `whatsapp-bridge/src/store.js` stays the only writer. It owns the schema, the
// migrations, the provenance foreign keys and the FTS triggers, and it renders
// the placeholder text the model reads. Having Go write rows too would put the
// schema in two languages and the placeholder vocabulary in two
// implementations, which is the drift `store.js` argues against for
// `OWED_BY_USER_TYPES`.
//
// So this package produces a description of what arrived, and the archive
// decides what to store. The boundary is deliberately narrow: everything here
// is derived from one `events.Message` and nothing here reads configuration.
package event

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/identity"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/translate"
)

var (
	// ErrNoID guards the archive's UNIQUE key. An empty key is not a degraded
	// row, it is a row that collides with every other keyless row.
	ErrNoID = errors.New("event: message has no id")
)

// Message is one message, in the archive's terms.
//
// `Chat` and `Sender` are identities rather than strings so that the phone
// containment in `internal/identity` travels with them: this struct is what
// crosses the process boundary, and `TestEncodedEventNeverCarriesAPhoneNumber`
// is what holds that property in place.
type Message struct {
	// Key is the protocol's message id, unqualified.
	//
	// Deliberately not `<chat>:<id>`. A provisional identity is re-keyed when
	// its LID arrives, so a key embedding the chat would be rewritten by that
	// merge — and the archive's provenance foreign keys cite message keys, so
	// rewriting them would orphan every fact, obligation and transcript.
	//
	// The protocol's own formal address is the 4-tuple (account, chat, sender,
	// id); whatsmeow's message-secret table uses exactly that. The id alone is
	// `3EB0` plus 72 bits of hash, which for one person's correspondence makes
	// a collision negligible — and should one ever happen, the archive's UNIQUE
	// constraint rejects the insert loudly rather than corrupting a row.
	Key string `json:"key"`

	Chat   identity.Identity `json:"chat"`
	Sender identity.Identity `json:"sender"`

	// PushName is the display name the sender's own device advertises. Carried
	// because it is the only human-readable name the protocol offers, and kept
	// separate from identity because it is self-asserted and changes freely.
	PushName string `json:"pushName,omitempty"`

	Outgoing bool      `json:"outgoing"`
	SentAt   time.Time `json:"sentAt"`

	Kind            translate.Kind `json:"kind"`
	Text            string         `json:"text,omitempty"`
	Caption         string         `json:"caption,omitempty"`
	Filename        string         `json:"filename,omitempty"`
	Mimetype        string         `json:"mimetype,omitempty"`
	DurationSeconds *int           `json:"durationSeconds,omitempty"`

	// Recognised is false when no protobuf arm matched. The row still stores as
	// `unknown`; this field is what lets the bridge report how much of the
	// stream it cannot describe instead of silently averaging it away.
	Recognised bool `json:"recognised"`

	// FromHistory distinguishes a backfilled message from a live arrival. The
	// archive needs it to account for coverage honestly — SPEC §5.8 requires the
	// agent to state what it has and has not ingested, and "I received this as
	// it was sent" is different evidence from "I asked the phone for it".
	FromHistory bool `json:"fromHistory"`
}

// chatAlt picks the alternative address form that belongs to the CHAT, which is
// not the same field in both directions.
//
// whatsmeow sets `RecipientAlt` only on outgoing messages, where the recipient
// is the chat partner. On an incoming direct message it is empty, and the
// partner's other form sits in `SenderAlt` — because for an incoming DM the chat
// and the sender are the same person.
//
// Reading the wrong field fails quietly rather than loudly: the chat still
// resolves, only provisionally, so every incoming DM would open a second
// phone-keyed chat row beside the LID-keyed one. Groups need neither field, and
// `ResolvePair` ignores an alt for any non-user server anyway, so a participant's
// address cannot leak into a group's identity.
func chatAlt(evt *events.Message) types.JID {
	if evt.Info.IsGroup {
		return types.EmptyJID
	}
	if evt.Info.IsFromMe {
		return evt.Info.RecipientAlt
	}
	return evt.Info.SenderAlt
}

// FromMessage describes one decrypted message.
//
// Refuses only what cannot be stored: a message with no id, or one with no
// chat. Everything else degrades — an unmapped protobuf arm becomes `unknown`,
// and an unresolvable LID becomes a provisional identity — because the archive
// would rather hold an imperfect row than lose correspondence.
func FromMessage(ctx context.Context, r *identity.Resolver, evt *events.Message) (Message, error) {
	if evt == nil {
		return Message{}, errors.New("event: nil message")
	}
	if evt.Info.ID == "" {
		return Message{}, ErrNoID
	}

	chat, err := r.ResolvePair(ctx, evt.Info.Chat, chatAlt(evt))
	if err != nil {
		return Message{}, fmt.Errorf("event: resolving chat: %w", err)
	}

	sender, err := r.ResolvePair(ctx, evt.Info.Sender, evt.Info.SenderAlt)
	if err != nil {
		return Message{}, fmt.Errorf("event: resolving sender: %w", err)
	}

	content := translate.Classify(evt.Message)

	return Message{
		Key:      string(evt.Info.ID),
		Chat:     chat,
		Sender:   sender,
		PushName: evt.Info.PushName,
		Outgoing: evt.Info.IsFromMe,
		SentAt:   evt.Info.Timestamp,

		Kind:            content.Kind,
		Text:            content.Text,
		Caption:         content.Caption,
		Filename:        content.Filename,
		Mimetype:        content.Mimetype,
		DurationSeconds: content.DurationSeconds,
		Recognised:      content.Recognised,

		// whatsmeow sets SourceWebMsg only when the message was parsed from a
		// WebMessageInfo, which is history sync and unavailable-message replies
		// — never a live socket delivery.
		FromHistory: evt.SourceWebMsg != nil,
	}, nil
}
