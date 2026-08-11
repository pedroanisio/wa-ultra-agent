// Package e2e exercises the whole transport with real components.
//
// ── What is real here, and what is not ──────────────────────────────────────
// Real: the identity resolver, the translation layer, the event dispatcher, the
// SQLite outbox on disk, the media store on disk, the send guard, the HTTP API
// and an actual TCP listener answering actual requests.
//
// Not real: the WhatsApp socket. A message is injected into the dispatcher in the
// same shape whatsmeow delivers one, because the alternative is a test that
// cannot run without linking somebody's phone.
//
// So this proves the pipeline from "a message was decrypted" through to "the
// archive has acknowledged it". The one step it cannot prove is that whatsmeow
// decrypts correctly against the live service, which pairing proves instead.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/event"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/httpapi"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/identity"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/mediastore"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/outbox"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/sendguard"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/session"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/translate"
)

const (
	token     = "e2e-token"
	senderLID = "99887766554433"
	// Synthetic. A real number here would be the leak the transport exists to
	// make structurally impossible.
	senderPhone = "15550001111"
	groupID     = "120363000000000000"
)

// rig is the transport with everything real except the socket.
type rig struct {
	dispatcher *session.Dispatcher
	queue      *outbox.Outbox
	media      *mediastore.Store
	server     *httptest.Server
	sent       *captureSender
}

type captureSender struct {
	to   types.JID
	body string
}

func (c *captureSender) SendMessage(_ context.Context, to types.JID, msg *waE2E.Message,
	_ ...whatsmeow.SendRequestExtra) (whatsmeow.SendResponse, error) {
	c.to, c.body = to, msg.GetConversation()
	return whatsmeow.SendResponse{ID: "3EB0SENT", Timestamp: time.Unix(1786000000, 0)}, nil
}

// pairingStub stands in for the parts that need a linked device. Everything the
// data path touches is real.
type pairingStub struct {
	media *mediastore.Store
	queue *outbox.Outbox
}

func (p pairingStub) Paired() bool { return true }
func (p pairingStub) Status(ctx context.Context) (session.Status, error) {
	var s session.Status
	s.Paired, s.Connected, s.LoggedIn = true, true, true
	stats, err := p.queue.Stats(ctx)
	if err != nil {
		return s, err
	}
	s.Queue.Depth, s.Queue.Dropped = stats.Depth, stats.Dropped
	return s, nil
}
func (p pairingStub) Connect(context.Context) error                     { return nil }
func (p pairingStub) PairPhone(context.Context, string) (string, error) { return "ABCD-EFGH", nil }
func (p pairingStub) BeginQRPairing(context.Context) (<-chan whatsmeow.QRChannelItem, error) {
	ch := make(chan whatsmeow.QRChannelItem)
	close(ch)
	return ch, nil
}
func (p pairingStub) Contacts(context.Context) (map[types.JID]types.ContactInfo, error) {
	return map[types.JID]types.ContactInfo{
		types.NewJID(senderPhone, types.DefaultUserServer): {PushName: "Pim", FullName: "Pim Example"},
	}, nil
}
func (p pairingStub) DownloadMedia(ctx context.Context, key string) (mediastore.Record, []byte, error) {
	record, err := p.media.Get(ctx, key)
	if err != nil {
		return mediastore.Record{}, nil, err
	}
	// The real client would fetch from the CDN here. The pointer lookup — the
	// part this transport is responsible for — is real.
	return record, []byte("decrypted-bytes"), nil
}
func (p pairingStub) RequestHistory(context.Context, types.MessageInfo, int) error { return nil }

// parserStub stands in for whatsmeow's own history-record parser.
type parserStub struct{}

func (parserStub) ParseWebMessage(chat types.JID, web *waWeb.WebMessageInfo) (*events.Message, error) {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:    chat,
				Sender:  types.NewJID(senderLID, types.HiddenUserServer),
				IsGroup: chat.Server == types.GroupServer,
			},
			ID:        web.GetKey().GetID(),
			Timestamp: time.Date(2026, 8, 10, 9, 0, 0, 0, time.UTC),
		},
		Message:      &waE2E.Message{Conversation: proto.String("older message")},
		SourceWebMsg: web,
	}, nil
}

func newRig(t *testing.T, allowlist string) *rig {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()

	queue, err := outbox.Open(ctx, filepath.Join(dir, "outbox.db"))
	if err != nil {
		t.Fatalf("outbox.Open: %v", err)
	}
	t.Cleanup(func() { _ = queue.Close() })

	media, err := mediastore.Open(ctx, filepath.Join(dir, "media.db"))
	if err != nil {
		t.Fatalf("mediastore.Open: %v", err)
	}
	t.Cleanup(func() { _ = media.Close() })

	resolver := identity.NewResolver(nil)
	guard, err := sendguard.New(ctx, func(key string) string {
		switch key {
		case sendguard.EnvAllow:
			return "true"
		case sendguard.EnvAllowlist:
			return allowlist
		}
		return ""
	}, resolver)
	if err != nil {
		t.Fatalf("sendguard.New: %v", err)
	}

	sender := &captureSender{}
	api, err := httpapi.New(httpapi.Config{
		Token:    token,
		Session:  pairingStub{media: media, queue: queue},
		Queue:    queue,
		Sender:   sender,
		Guard:    guard,
		Resolver: resolver,
	})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}

	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)

	return &rig{
		dispatcher: session.NewDispatcher(resolver, queue, media, parserStub{}),
		queue:      queue,
		media:      media,
		server:     server,
		sent:       sender,
	}
}

func (r *rig) request(t *testing.T, method, path, body string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, r.server.URL+path, bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := r.server.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading body: %v", err)
	}
	return resp.StatusCode, data
}

func incoming(id, text string) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:      types.NewJID(groupID, types.GroupServer),
				Sender:    types.NewJID(senderPhone, types.DefaultUserServer),
				SenderAlt: types.NewJID(senderLID, types.HiddenUserServer),
				IsGroup:   true,
			},
			ID:        id,
			PushName:  "Pim",
			Timestamp: time.Date(2026, 8, 11, 14, 30, 0, 0, time.UTC),
		},
		Message: &waE2E.Message{Conversation: proto.String(text)},
	}
}

// ── The whole loop ──────────────────────────────────────────────────────────
//
// A message is decrypted, described, queued durably, drained over HTTP by the
// archive, acknowledged, and gone. This is the path every message takes.
func TestMessageTravelsFromSocketToAcknowledgement(t *testing.T) {
	r := newRig(t, "")
	ctx := context.Background()

	if err := r.dispatcher.Handle(ctx, incoming("3EB0AAA", "chego às 15h")); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	code, body := r.request(t, "GET", "/outbox?limit=10", "")
	if code != http.StatusOK {
		t.Fatalf("GET /outbox = %d: %s", code, body)
	}

	var drained struct {
		Entries []outbox.Entry `json:"entries"`
		Depth   int64          `json:"depth"`
		Dropped int64          `json:"dropped"`
	}
	if err := json.Unmarshal(body, &drained); err != nil {
		t.Fatalf("decoding drain: %v", err)
	}
	if len(drained.Entries) != 1 {
		t.Fatalf("drained %d entries, want 1", len(drained.Entries))
	}

	var msg event.Message
	if err := json.Unmarshal(drained.Entries[0].Payload, &msg); err != nil {
		t.Fatalf("decoding payload: %v", err)
	}

	if msg.Key != "3EB0AAA" {
		t.Errorf("key = %q", msg.Key)
	}
	if msg.Text != "chego às 15h" {
		t.Errorf("text = %q", msg.Text)
	}
	if msg.Kind != translate.KindText {
		t.Errorf("kind = %q", msg.Kind)
	}
	if msg.PushName != "Pim" {
		t.Errorf("pushName = %q", msg.PushName)
	}
	// The sender arrived addressed by phone number with the LID in SenderAlt.
	// The archive must receive the LID, because that is what survives the
	// migration and what everything derived will cite.
	want := types.NewJID(senderLID, types.HiddenUserServer).String()
	if msg.Sender.Key != want {
		t.Errorf("sender key = %q, want the LID %q", msg.Sender.Key, want)
	}
	if msg.Sender.Provisional {
		t.Error("the sender was marked provisional despite SenderAlt carrying the LID")
	}

	// Acknowledge, and confirm it is gone rather than merely marked.
	code, body = r.request(t, "POST", "/outbox/ack",
		fmt.Sprintf(`{"through":%d}`, drained.Entries[0].Seq))
	if code != http.StatusOK {
		t.Fatalf("POST /outbox/ack = %d: %s", code, body)
	}

	_, body = r.request(t, "GET", "/outbox", "")
	if err := json.Unmarshal(body, &drained); err != nil {
		t.Fatalf("decoding second drain: %v", err)
	}
	if len(drained.Entries) != 0 {
		t.Fatalf("%d entries survived acknowledgement", len(drained.Entries))
	}
}

// The phone number is present in the input and must not be present in the output.
// This is the assertion the whole containment design exists to satisfy, made at
// the point where bytes actually leave the process.
func TestNoPhoneNumberCrossesTheWire(t *testing.T) {
	r := newRig(t, "")
	ctx := context.Background()

	if err := r.dispatcher.Handle(ctx, incoming("3EB0AAA", "olá")); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	for _, probe := range []struct{ method, path, body string }{
		{"GET", "/outbox", ""},
		{"GET", "/status", ""},
		{"GET", "/contacts", ""},
	} {
		code, body := r.request(t, probe.method, probe.path, probe.body)
		if code != http.StatusOK {
			t.Fatalf("%s %s = %d: %s", probe.method, probe.path, code, body)
		}
		if bytes.Contains(body, []byte(senderPhone)) {
			t.Fatalf("%s %s leaked a phone number: %s", probe.method, probe.path, body)
		}
	}
}

// Media: the pointer is captured at arrival and the bytes are fetched later by
// key, which is exactly how the agent transcribes a voice note.
func TestVoiceNoteBecomesFetchableBytes(t *testing.T) {
	r := newRig(t, "")
	ctx := context.Background()

	voice := incoming("3EB0VOICE", "")
	voice.Message = &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
		PTT:        proto.Bool(true),
		Seconds:    proto.Uint32(222),
		Mimetype:   proto.String("audio/ogg; codecs=opus"),
		DirectPath: proto.String("/v/abc"),
		MediaKey:   []byte("media-key-32-bytes-placeholder!!"),
	}}

	if err := r.dispatcher.Handle(ctx, voice); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	_, body := r.request(t, "GET", "/outbox", "")
	var drained struct {
		Entries []outbox.Entry `json:"entries"`
	}
	_ = json.Unmarshal(body, &drained)

	var msg event.Message
	_ = json.Unmarshal(drained.Entries[0].Payload, &msg)

	if msg.Kind != translate.KindVoice {
		t.Fatalf("kind = %q, want voice", msg.Kind)
	}
	if msg.DurationSeconds == nil || *msg.DurationSeconds != 222 {
		t.Fatalf("durationSeconds = %v", msg.DurationSeconds)
	}
	// Empty on purpose: `[voice note · 3:42]` is the archive's to render, from
	// these fields. The transport does not duplicate placeholderText.
	if msg.Text != "" {
		t.Fatalf("text = %q, want empty for media", msg.Text)
	}

	code, data := r.request(t, "GET", "/media?key=3EB0VOICE", "")
	if code != http.StatusOK {
		t.Fatalf("GET /media = %d: %s", code, data)
	}
	if string(data) != "decrypted-bytes" {
		t.Fatalf("media body = %q", data)
	}

	// A message that never carried media is a 404, distinct from a 410.
	code, _ = r.request(t, "GET", "/media?key=3EB0AAA", "")
	if code != http.StatusNotFound {
		t.Fatalf("GET /media for a text message = %d, want 404", code)
	}
}

// Backfill lands in the same queue as live traffic, flagged so the archive can
// tell "I received this as it was sent" from "I asked the phone for it".
func TestHistorySyncLandsInTheQueueFlagged(t *testing.T) {
	r := newRig(t, "")
	ctx := context.Background()

	chat := types.NewJID(groupID, types.GroupServer)
	sync := &events.HistorySync{Data: &waHistorySync.HistorySync{
		Conversations: []*waHistorySync.Conversation{{
			ID: proto.String(chat.String()),
			Messages: []*waHistorySync.HistorySyncMsg{
				{Message: &waWeb.WebMessageInfo{Key: &waCommon.MessageKey{ID: proto.String("H1")}}},
				{Message: &waWeb.WebMessageInfo{Key: &waCommon.MessageKey{ID: proto.String("H2")}}},
			},
		}},
	}}

	if err := r.dispatcher.Handle(ctx, sync); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	_, body := r.request(t, "GET", "/outbox", "")
	var drained struct {
		Entries []outbox.Entry `json:"entries"`
	}
	_ = json.Unmarshal(body, &drained)

	if len(drained.Entries) != 2 {
		t.Fatalf("drained %d entries, want 2", len(drained.Entries))
	}
	for _, entry := range drained.Entries {
		var msg event.Message
		_ = json.Unmarshal(entry.Payload, &msg)
		if !msg.FromHistory {
			t.Fatalf("%s was not flagged as history", msg.Key)
		}
	}
}

// The guard is the last thing before the socket, so this asserts on what the
// sender actually received rather than on a status code alone.
func TestSendIsRefusedOffTheAllowlistAndDeliveredOnIt(t *testing.T) {
	allowed := types.NewJID(senderLID, types.HiddenUserServer)
	r := newRig(t, allowed.String())

	other := types.NewJID("11223344556677", types.HiddenUserServer)
	code, _ := r.request(t, "POST", "/send",
		fmt.Sprintf(`{"to":%q,"message":"olá"}`, other.String()))
	if code != http.StatusForbidden {
		t.Fatalf("send to a stranger = %d, want 403", code)
	}
	if !r.sent.to.IsEmpty() {
		t.Fatalf("a refused send reached the socket: %s", r.sent.to)
	}

	code, body := r.request(t, "POST", "/send",
		fmt.Sprintf(`{"to":%q,"message":"chego às 15h"}`, allowed.String()))
	if code != http.StatusOK {
		t.Fatalf("send to an allowlisted recipient = %d: %s", code, body)
	}
	if r.sent.body != "chego às 15h" {
		t.Fatalf("delivered body = %q", r.sent.body)
	}
}

// Restarting the archive must not lose messages that arrived meanwhile. This is
// the property the outbox exists for, and it is asserted against a real file.
func TestQueuedMessagesSurviveAConsumerThatNeverAcknowledged(t *testing.T) {
	r := newRig(t, "")
	ctx := context.Background()

	for _, id := range []string{"3EB0AAA", "3EB0BBB", "3EB0CCC"} {
		if err := r.dispatcher.Handle(ctx, incoming(id, "body")); err != nil {
			t.Fatalf("dispatch: %v", err)
		}
	}

	// Drain without acknowledging — the archive read them and then died.
	_, body := r.request(t, "GET", "/outbox", "")
	var first struct {
		Entries []outbox.Entry `json:"entries"`
	}
	_ = json.Unmarshal(body, &first)
	if len(first.Entries) != 3 {
		t.Fatalf("first drain returned %d, want 3", len(first.Entries))
	}

	// A second drain must see them all again, or the crash lost correspondence.
	_, body = r.request(t, "GET", "/outbox", "")
	var second struct {
		Entries []outbox.Entry `json:"entries"`
	}
	_ = json.Unmarshal(body, &second)
	if len(second.Entries) != 3 {
		t.Fatalf("after an unacknowledged drain, %d entries remain; want 3", len(second.Entries))
	}
}
