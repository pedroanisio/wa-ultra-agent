package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/event"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/identity"
)

const (
	testLID   = "99887766554433"
	testGroup = "120363000000000000"
)

type recordingSink struct {
	appended []event.Message
	err      error
}

func (s *recordingSink) Append(_ context.Context, msg event.Message) error {
	if s.err != nil {
		return s.err
	}
	s.appended = append(s.appended, msg)
	return nil
}

// stubParser stands in for *whatsmeow.Client. It fabricates a plausible parsed
// message so the dispatcher's own walking logic is what is under test, not
// whatsmeow's protobuf handling.
type stubParser struct {
	failOn map[string]bool
}

func (p stubParser) ParseWebMessage(chatJID types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error) {
	id := webMsg.GetKey().GetID()
	if p.failOn[id] {
		return nil, errors.New("stub: refusing to parse")
	}
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:      chatJID,
				Sender:    types.NewJID(testLID, types.HiddenUserServer),
				IsGroup:   chatJID.Server == types.GroupServer,
				SenderAlt: types.EmptyJID,
			},
			ID:        id,
			Timestamp: time.Date(2026, 8, 11, 14, 30, 0, 0, time.UTC),
		},
		Message:      &waE2E.Message{Conversation: proto.String("from history")},
		SourceWebMsg: webMsg,
	}, nil
}

type recordingMedia struct {
	stored map[string]*waE2E.Message
	err    error
}

func newRecordingMedia() *recordingMedia {
	return &recordingMedia{stored: map[string]*waE2E.Message{}}
}

func (m *recordingMedia) Put(_ context.Context, id, _, _ string, msg *waE2E.Message) error {
	if m.err != nil {
		return m.err
	}
	m.stored[id] = msg
	return nil
}

func dispatcher(sink Sink, parser WebMessageParser) *Dispatcher {
	return NewDispatcher(identity.NewResolver(nil), sink, newRecordingMedia(), parser)
}

func dispatcherWithMedia(sink Sink, media MediaSink, parser WebMessageParser) *Dispatcher {
	return NewDispatcher(identity.NewResolver(nil), sink, media, parser)
}

func voiceMessage(id string) *events.Message {
	msg := liveMessage(id)
	msg.Message = &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
		PTT:        proto.Bool(true),
		Seconds:    proto.Uint32(222),
		Mimetype:   proto.String("audio/ogg; codecs=opus"),
		DirectPath: proto.String("/v/abc"),
	}}
	return msg
}

func liveMessage(id string) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:      types.NewJID(testGroup, types.GroupServer),
				Sender:    types.NewJID(testLID, types.HiddenUserServer),
				IsGroup:   true,
				SenderAlt: types.EmptyJID,
			},
			ID:        id,
			Timestamp: time.Date(2026, 8, 11, 14, 30, 0, 0, time.UTC),
		},
		Message: &waE2E.Message{Conversation: proto.String("olá")},
	}
}

func TestLiveMessageReachesTheSink(t *testing.T) {
	sink := &recordingSink{}
	d := dispatcher(sink, stubParser{})

	if err := d.Handle(context.Background(), liveMessage("3EB0AAA")); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	if len(sink.appended) != 1 || sink.appended[0].Key != "3EB0AAA" {
		t.Fatalf("sink holds %+v", sink.appended)
	}
	if got := d.Counters(); got.Messages != 1 || got.Failed != 0 {
		t.Fatalf("counters = %+v", got)
	}
}

// An event class nobody handles must be counted, not silently discarded. The
// count is what makes "4,000 events in, 12 messages stored" a diagnosable state
// rather than an unexplained quiet.
func TestUnhandledEventsAreCountedNotDiscarded(t *testing.T) {
	sink := &recordingSink{}
	d := dispatcher(sink, stubParser{})

	for _, evt := range []any{
		&events.Receipt{},
		&events.Presence{},
		&events.Connected{},
		"not an event at all",
	} {
		if err := d.Handle(context.Background(), evt); err != nil {
			t.Fatalf("Handle(%T) errored: %v", evt, err)
		}
	}

	if got := d.Counters(); got.Ignored != 4 {
		t.Fatalf("Ignored = %d, want 4", got.Ignored)
	}
	if len(sink.appended) != 0 {
		t.Fatalf("an ignored event reached the sink: %+v", sink.appended)
	}
}

// A message that never decrypted is a message the archive will never hold.
// whatsmeow requests a retry on its own, so this is not fatal — but the counter
// is the only evidence the message existed.
func TestUndecryptableMessagesAreCounted(t *testing.T) {
	d := dispatcher(&recordingSink{}, stubParser{})

	if err := d.Handle(context.Background(), &events.UndecryptableMessage{}); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if got := d.Counters(); got.Undecryptable != 1 || got.Ignored != 0 {
		t.Fatalf("counters = %+v", got)
	}
}

func historySync(chatID string, ids ...string) *events.HistorySync {
	records := make([]*waHistorySync.HistorySyncMsg, 0, len(ids))
	for _, id := range ids {
		records = append(records, &waHistorySync.HistorySyncMsg{
			Message: &waWeb.WebMessageInfo{
				Key: &waCommon.MessageKey{ID: proto.String(id)},
			},
		})
	}
	return &events.HistorySync{
		Data: &waHistorySync.HistorySync{
			Conversations: []*waHistorySync.Conversation{
				{ID: proto.String(chatID), Messages: records},
			},
		},
	}
}

func TestHistorySyncStoresEveryRecordAndMarksThem(t *testing.T) {
	sink := &recordingSink{}
	d := dispatcher(sink, stubParser{})

	chat := types.NewJID(testGroup, types.GroupServer).String()
	if err := d.Handle(context.Background(), historySync(chat, "H1", "H2", "H3")); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	if len(sink.appended) != 3 {
		t.Fatalf("stored %d records, want 3", len(sink.appended))
	}
	for _, msg := range sink.appended {
		if !msg.FromHistory {
			t.Fatalf("record %s was not marked as history", msg.Key)
		}
	}
	if got := d.Counters(); got.Messages != 3 || got.FromHistory != 3 {
		t.Fatalf("counters = %+v", got)
	}
}

// ── The property that makes a backfill worth running ────────────────────────
//
// A history sync is thousands of records of whatever the phone happened to hold.
// Abandoning the batch on the first unparseable one would discard every message
// after it, and the operator would see a backfill that "worked" while silently
// covering a fraction of the window.
func TestHistorySyncContinuesPastABadRecord(t *testing.T) {
	sink := &recordingSink{}
	d := dispatcher(sink, stubParser{failOn: map[string]bool{"H2": true}})

	chat := types.NewJID(testGroup, types.GroupServer).String()
	err := d.Handle(context.Background(), historySync(chat, "H1", "H2", "H3"))

	// The failure is reported...
	if err == nil {
		t.Fatal("a batch with an unparseable record reported success")
	}
	// ...and the rest of the batch still landed.
	if len(sink.appended) != 2 {
		t.Fatalf("stored %d records, want the 2 good ones", len(sink.appended))
	}
	if got := d.Counters(); got.Messages != 2 || got.Failed != 1 {
		t.Fatalf("counters = %+v", got)
	}
}

// A conversation whose id will not parse cannot be attributed to anyone. Storing
// its messages against a guessed chat would be worse than losing them, so they
// are counted as failures — all of them, so the number reported matches what was
// actually lost.
func TestUnparseableConversationCountsEveryMessageItHeld(t *testing.T) {
	sink := &recordingSink{}
	d := dispatcher(sink, stubParser{})

	err := d.Handle(context.Background(), historySync("this is not a jid", "H1", "H2"))
	if err == nil {
		t.Fatal("an unparseable conversation id reported success")
	}
	if len(sink.appended) != 0 {
		t.Fatalf("messages from an unattributable conversation were stored: %+v", sink.appended)
	}
	if got := d.Counters(); got.Failed != 2 {
		t.Fatalf("Failed = %d, want 2 — one per lost message", got.Failed)
	}
}

func TestHistorySyncWithNoDataIsIgnored(t *testing.T) {
	d := dispatcher(&recordingSink{}, stubParser{})

	if err := d.Handle(context.Background(), &events.HistorySync{}); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if got := d.Counters(); got.Ignored != 1 || got.Failed != 0 {
		t.Fatalf("counters = %+v", got)
	}
}

// If the queue cannot accept a message, that must surface. The alternative is a
// transport that reports healthy while dropping correspondence.
func TestSinkFailureIsReported(t *testing.T) {
	sink := &recordingSink{err: errors.New("disk full")}
	d := dispatcher(sink, stubParser{})

	err := d.Handle(context.Background(), liveMessage("3EB0AAA"))
	if err == nil {
		t.Fatal("a failed append reported success")
	}
	if got := d.Counters(); got.Failed != 1 || got.Messages != 0 {
		t.Fatalf("counters = %+v", got)
	}
}

func TestMalformedMessageIsCountedAsFailed(t *testing.T) {
	sink := &recordingSink{}
	d := dispatcher(sink, stubParser{})

	broken := liveMessage("3EB0AAA")
	broken.Info.ID = "" // no id: unstorable, per event.ErrNoID

	if err := d.Handle(context.Background(), broken); err == nil {
		t.Fatal("a message with no id was accepted")
	}
	if got := d.Counters(); got.Failed != 1 {
		t.Fatalf("Failed = %d, want 1", got.Failed)
	}
}

func TestUnrecognisedMessagesAreCountedButStored(t *testing.T) {
	sink := &recordingSink{}
	d := dispatcher(sink, stubParser{})

	msg := liveMessage("3EB0AAA")
	msg.Message = &waE2E.Message{
		CancelPaymentRequestMessage: &waE2E.CancelPaymentRequestMessage{},
	}

	if err := d.Handle(context.Background(), msg); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if len(sink.appended) != 1 {
		t.Fatal("an unrecognised message was not stored")
	}
	if got := d.Counters(); got.Unrecognised != 1 || got.Messages != 1 {
		t.Fatalf("counters = %+v", got)
	}
}

// ── Media capture ───────────────────────────────────────────────────────────

func TestMediaMessagesRecordTheirDownloadPointer(t *testing.T) {
	sink, media := &recordingSink{}, newRecordingMedia()
	d := dispatcherWithMedia(sink, media, stubParser{})

	if err := d.Handle(context.Background(), voiceMessage("3EB0VOICE")); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	stored, ok := media.stored["3EB0VOICE"]
	if !ok {
		t.Fatal("a voice note recorded no media pointer; its bytes would be unfetchable")
	}
	if stored.GetAudioMessage().GetDirectPath() != "/v/abc" {
		t.Fatalf("the stored message lost its direct path")
	}
}

// A text message has no blob on a media server, so recording one would keep a
// useless row per message and evict real media pointers out of the store.
func TestTextMessagesRecordNoMediaPointer(t *testing.T) {
	sink, media := &recordingSink{}, newRecordingMedia()
	d := dispatcherWithMedia(sink, media, stubParser{})

	if err := d.Handle(context.Background(), liveMessage("3EB0TEXT")); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if len(media.stored) != 0 {
		t.Fatalf("a text message recorded a media pointer: %v", media.stored)
	}
}

// Losing the pointer costs the media, not the message. The message is still in
// the archive and readable, so this must not be counted as a lost message — the
// two failures have different remedies.
func TestAFailedMediaRecordStillQueuesTheMessage(t *testing.T) {
	sink := &recordingSink{}
	media := newRecordingMedia()
	media.err = errors.New("disk full")
	d := dispatcherWithMedia(sink, media, stubParser{})

	if err := d.Handle(context.Background(), voiceMessage("3EB0VOICE")); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	if len(sink.appended) != 1 {
		t.Fatal("the message was lost because its media pointer could not be stored")
	}
	got := d.Counters()
	if got.MediaUnrecorded != 1 {
		t.Fatalf("MediaUnrecorded = %d, want 1", got.MediaUnrecorded)
	}
	if got.Failed != 0 {
		t.Fatalf("Failed = %d, want 0 — the message itself was fine", got.Failed)
	}
	if got.Messages != 1 {
		t.Fatalf("Messages = %d, want 1", got.Messages)
	}
}
