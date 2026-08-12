package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/identity"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/mediastore"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/outbox"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/sendguard"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/session"
)

const (
	token        = "test-token-not-a-real-secret"
	allowedLID   = "99887766554433"
	otherLID     = "11223344556677"
	allowedPhone = "15550001111"
)

// ── Fakes ───────────────────────────────────────────────────────────────────

type fakeSession struct {
	paired      bool
	contacts    map[types.JID]types.ContactInfo
	contactsErr error
	groups      []types.GroupInfo
	groupsErr   error
	connectErr  error

	mediaRecord mediastore.Record
	mediaBytes  []byte
	mediaErr    error

	historyAnchor types.MessageInfo
	historyCount  int
	historyErr    error
}

func (f *fakeSession) Paired() bool { return f.paired }

func (f *fakeSession) Status(context.Context) (session.Status, error) {
	return session.Status{Paired: f.paired}, nil
}
func (f *fakeSession) Connect(context.Context) error { return f.connectErr }
func (f *fakeSession) PairPhone(_ context.Context, phone string) (string, error) {
	if phone == "" {
		return "", errors.New("a phone number is required")
	}
	return "ABCD-EFGH", nil
}
func (f *fakeSession) BeginQRPairing(context.Context) (<-chan whatsmeow.QRChannelItem, error) {
	ch := make(chan whatsmeow.QRChannelItem, 2)
	ch <- whatsmeow.QRChannelItem{Event: "code", Code: "qr-payload-1"}
	ch <- whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelSuccess.Event}
	close(ch)
	return ch, nil
}
func (f *fakeSession) Contacts(context.Context) (map[types.JID]types.ContactInfo, error) {
	return f.contacts, f.contactsErr
}
func (f *fakeSession) Groups(context.Context) ([]types.GroupInfo, error) {
	return f.groups, f.groupsErr
}
func (f *fakeSession) Self() (types.JID, bool) {
	if !f.paired {
		return types.JID{}, false
	}
	return lidJID(allowedLID), true
}
func (f *fakeSession) DownloadMedia(_ context.Context, key string) (mediastore.Record, []byte, error) {
	if f.mediaErr != nil {
		return f.mediaRecord, nil, f.mediaErr
	}
	return f.mediaRecord, f.mediaBytes, nil
}
func (f *fakeSession) RequestHistory(_ context.Context, anchor types.MessageInfo, count int) error {
	f.historyAnchor = anchor
	f.historyCount = count
	return f.historyErr
}

type fakeQueue struct {
	entries []outbox.Entry
	stats   outbox.Stats
	acked   int64
}

func (q *fakeQueue) Pending(_ context.Context, limit int) ([]outbox.Entry, error) {
	if limit < len(q.entries) {
		return q.entries[:limit], nil
	}
	return q.entries, nil
}
func (q *fakeQueue) Ack(_ context.Context, through int64) (int64, error) {
	q.acked = through
	return through, nil
}
func (q *fakeQueue) Stats(context.Context) (outbox.Stats, error) { return q.stats, nil }

type fakeSender struct {
	sentTo   types.JID
	sentBody string
	sentMsg  *waE2E.Message
	err      error

	uploaded  []byte
	uploadErr error

	votedOn  *types.MessageInfo
	voteErr  error
	presence string
}

func (s *fakeSender) BuildPollVote(_ context.Context, poll *types.MessageInfo,
	options []string) (*waE2E.Message, error) {
	if s.voteErr != nil {
		return nil, s.voteErr
	}
	s.votedOn = poll
	return &waE2E.Message{PollUpdateMessage: &waE2E.PollUpdateMessage{}}, nil
}

func (s *fakeSender) SendChatPresence(_ context.Context, _ types.JID,
	state types.ChatPresence, _ types.ChatPresenceMedia) error {
	s.presence = string(state)
	return nil
}

func (s *fakeSender) SendMessage(_ context.Context, to types.JID, msg *waE2E.Message,
	_ ...whatsmeow.SendRequestExtra) (whatsmeow.SendResponse, error) {
	if s.err != nil {
		return whatsmeow.SendResponse{}, s.err
	}
	s.sentTo = to
	s.sentBody = msg.GetConversation()
	s.sentMsg = msg
	return whatsmeow.SendResponse{ID: "3EB0SENT", Timestamp: time.Unix(1786000000, 0)}, nil
}

// The builders are whatsmeow's real ones in production. Here they construct the
// same shapes so the handler's choice of arm and key is what is under test, not
// whatsmeow's protobuf assembly.
func (s *fakeSender) BuildRevoke(chat, sender types.JID, id types.MessageID) *waE2E.Message {
	return &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_REVOKE.Enum(),
		Key:  &waCommon.MessageKey{ID: proto.String(id)},
	}}
}

func (s *fakeSender) BuildEdit(chat types.JID, id types.MessageID,
	newContent *waE2E.Message) *waE2E.Message {
	return &waE2E.Message{EditedMessage: &waE2E.FutureProofMessage{Message: newContent}}
}

func (s *fakeSender) BuildReaction(chat, sender types.JID, id types.MessageID,
	reaction string) *waE2E.Message {
	return &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{
		Key:  &waCommon.MessageKey{ID: proto.String(id)},
		Text: proto.String(reaction),
	}}
}

func (s *fakeSender) BuildPollCreation(name string, options []string,
	selectableCount int) *waE2E.Message {
	poll := &waE2E.PollCreationMessage{Name: proto.String(name)}
	for _, option := range options {
		poll.Options = append(poll.Options, &waE2E.PollCreationMessage_Option{
			OptionName: proto.String(option),
		})
	}
	return &waE2E.Message{PollCreationMessage: poll}
}

func (s *fakeSender) Upload(_ context.Context, plaintext []byte,
	_ whatsmeow.MediaType) (whatsmeow.UploadResponse, error) {
	if s.uploadErr != nil {
		return whatsmeow.UploadResponse{}, s.uploadErr
	}
	s.uploaded = plaintext
	length := uint64(len(plaintext))
	return whatsmeow.UploadResponse{
		URL:           "https://mmg.whatsapp.net/fixture",
		DirectPath:    "/fixture/path",
		MediaKey:      []byte("fixture-media-key"),
		FileEncSHA256: []byte("fixture-enc-sha"),
		FileSHA256:    []byte("fixture-sha"),
		FileLength:    length,
	}, nil
}

// ── Harness ─────────────────────────────────────────────────────────────────

type harness struct {
	api     *API
	session *fakeSession
	queue   *fakeQueue
	sender  *fakeSender
}

func newHarness(t *testing.T, allowlist string, sendEnabled bool) *harness {
	t.Helper()

	resolver := identity.NewResolver(nil)
	env := func(key string) string {
		switch key {
		case sendguard.EnvAllow:
			if sendEnabled {
				return "true"
			}
			return ""
		case sendguard.EnvAllowlist:
			return allowlist
		}
		return ""
	}
	guard, err := sendguard.New(context.Background(), env, resolver)
	if err != nil {
		t.Fatalf("sendguard.New: %v", err)
	}

	h := &harness{
		session: &fakeSession{paired: true},
		queue:   &fakeQueue{},
		sender:  &fakeSender{},
	}
	api, err := New(Config{
		Token: token, Session: h.session, Queue: h.queue,
		Sender: h.sender, Guard: guard, Resolver: resolver,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	h.api = api
	return h
}

func (h *harness) do(t *testing.T, method, path, body, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	req := httptest.NewRequest(method, path, reader)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	h.api.Handler().ServeHTTP(rec, req)
	return rec
}

func lidJID(user string) types.JID { return types.NewJID(user, types.HiddenUserServer) }

// stubLIDs makes a phone JID resolve to a LID, which is what makes one person
// appear under two addresses — the condition the roster has to collapse.
type stubLIDs struct{ pnToLID map[string]string }

func (s stubLIDs) GetLIDForPN(_ context.Context, pn types.JID) (types.JID, error) {
	if lid, ok := s.pnToLID[pn.User]; ok {
		return types.NewJID(lid, types.HiddenUserServer), nil
	}
	return types.JID{}, nil
}

// harnessWithLIDs is the harness with a resolver that knows one phone/LID pair.
func harnessWithLIDs(t *testing.T) *harness {
	t.Helper()
	resolver := identity.NewResolver(stubLIDs{pnToLID: map[string]string{allowedPhone: otherLID}})
	guard, err := sendguard.New(context.Background(), func(string) string { return "" }, resolver)
	if err != nil {
		t.Fatalf("sendguard.New: %v", err)
	}
	h := &harness{session: &fakeSession{paired: true}, queue: &fakeQueue{}, sender: &fakeSender{}}
	api, err := New(Config{
		Token: token, Session: h.session, Queue: h.queue,
		Sender: h.sender, Guard: guard, Resolver: resolver,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	h.api = api
	return h
}

func groupJID(user string) types.JID { return types.NewJID(user, types.GroupServer) }

// ── Authentication ──────────────────────────────────────────────────────────

// This API reads all correspondence and sends as the operator. An unset token
// would expose that to any process able to open a loopback socket.
func TestNewRefusesWithoutAToken(t *testing.T) {
	_, err := New(Config{
		Session: &fakeSession{}, Queue: &fakeQueue{},
		Guard: &sendguard.Guard{}, Resolver: identity.NewResolver(nil),
	})
	if err == nil {
		t.Fatal("New built an unauthenticated API")
	}
	if !strings.Contains(err.Error(), EnvToken) {
		t.Fatalf("error %q should name the missing variable", err)
	}
}

func TestEveryPrivilegedRouteRequiresTheToken(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)

	routes := []struct{ method, path string }{
		{"GET", "/status"},
		{"POST", "/connect"},
		{"POST", "/pair/phone"},
		{"GET", "/pair/qr"},
		{"GET", "/outbox"},
		{"POST", "/outbox/ack"},
		{"GET", "/contacts"},
		{"POST", "/send"},
		{"GET", "/media"},
		{"POST", "/history"},
	}

	for _, route := range routes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			for _, bearer := range []string{"", "wrong-token", token + "x"} {
				rec := h.do(t, route.method, route.path, "{}", bearer)
				if rec.Code != http.StatusUnauthorized {
					t.Fatalf("bearer %q got %d, want 401", bearer, rec.Code)
				}
			}
		})
	}
}

// A health check should not need a token that can send messages.
func TestHealthIsUnauthenticatedAndRevealsNothing(t *testing.T) {
	h := newHarness(t, "", false)

	rec := h.do(t, "GET", "/health", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "paired") || strings.Contains(rec.Body.String(), "queue") {
		t.Fatalf("/health leaked session detail: %s", rec.Body.String())
	}
}

// ── Send: the safety-critical path ──────────────────────────────────────────

func TestSendRefusesARecipientOffTheAllowlist(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)

	body := `{"to":"` + lidJID(otherLID).String() + `","message":"olá"}`
	rec := h.do(t, "POST", "/send", body, token)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	// The decisive assertion: nothing reached the socket.
	if !h.sender.sentTo.IsEmpty() {
		t.Fatalf("a refused send still reached the sender: %s", h.sender.sentTo)
	}
}

func TestSendRefusesWhenSendingIsDisabled(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), false)

	body := `{"to":"` + lidJID(allowedLID).String() + `","message":"olá"}`
	rec := h.do(t, "POST", "/send", body, token)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if !h.sender.sentTo.IsEmpty() {
		t.Fatal("a send reached the sender with sending disabled")
	}
}

func TestSendDeliversToAnAllowlistedRecipient(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)

	body := `{"to":"` + lidJID(allowedLID).String() + `","message":"chego às 15h"}`
	rec := h.do(t, "POST", "/send", body, token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if h.sender.sentBody != "chego às 15h" {
		t.Fatalf("body = %q", h.sender.sentBody)
	}
	if h.sender.sentTo.User != allowedLID {
		t.Fatalf("recipient = %s, want %s", h.sender.sentTo, allowedLID)
	}

	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got["id"] != "3EB0SENT" {
		t.Fatalf("id = %v", got["id"])
	}
}

// ── Sending media ───────────────────────────────────────────────────────────

const fixturePNG = "iVBORw0KGgoAAAANSUhEUg==" // not a valid image; the API never decodes one

func TestSendMediaUploadsThenSendsAnImageCarryingTheUploadsFields(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)

	body := `{"to":"` + lidJID(allowedLID).String() + `","mimetype":"image/png",` +
		`"caption":"Autopsicografia","dataBase64":"` + fixturePNG + `","width":1080,"height":1350}`
	rec := h.do(t, "POST", "/send/media", body, token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if len(h.sender.uploaded) == 0 {
		t.Fatal("nothing was uploaded")
	}

	image := h.sender.sentMsg.GetImageMessage()
	if image == nil {
		t.Fatalf("the sent message is not an image: %v", h.sender.sentMsg)
	}
	// The whole contract of an image send: the upload's addressing fields must
	// arrive on the message, or the recipient gets an undecryptable bubble.
	if image.GetURL() != "https://mmg.whatsapp.net/fixture" {
		t.Fatalf("URL = %q", image.GetURL())
	}
	if image.GetDirectPath() != "/fixture/path" {
		t.Fatalf("DirectPath = %q", image.GetDirectPath())
	}
	if string(image.GetMediaKey()) != "fixture-media-key" {
		t.Fatalf("MediaKey = %q", image.GetMediaKey())
	}
	if string(image.GetFileEncSHA256()) != "fixture-enc-sha" {
		t.Fatalf("FileEncSHA256 = %q", image.GetFileEncSHA256())
	}
	if image.GetFileLength() != uint64(len(h.sender.uploaded)) {
		t.Fatalf("FileLength = %d, want %d", image.GetFileLength(), len(h.sender.uploaded))
	}
	if image.GetCaption() != "Autopsicografia" {
		t.Fatalf("Caption = %q", image.GetCaption())
	}
	if image.GetWidth() != 1080 || image.GetHeight() != 1350 {
		t.Fatalf("dimensions = %dx%d", image.GetWidth(), image.GetHeight())
	}
}

// Uploading before checking would put the operator's picture on WhatsApp's CDN
// on behalf of a recipient who was never permitted.
func TestSendMediaRefusesAnUnallowlistedRecipientWithoutUploading(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)

	body := `{"to":"` + lidJID(otherLID).String() + `","mimetype":"image/png","dataBase64":"` +
		fixturePNG + `"}`
	rec := h.do(t, "POST", "/send/media", body, token)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if h.sender.uploaded != nil {
		t.Fatal("the attachment was uploaded before the recipient was permitted")
	}
}

// SVG is the realistic mistake: it is the natural thing to generate, and every
// recipient's client would show a file it cannot render.
func TestSendMediaRejectsATypeWhatsAppCannotRender(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)

	body := `{"to":"` + lidJID(allowedLID).String() + `","mimetype":"image/svg+xml",` +
		`"dataBase64":"` + fixturePNG + `"}`
	rec := h.do(t, "POST", "/send/media", body, token)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "image/png") {
		t.Fatalf("the error does not say what IS accepted: %s", rec.Body.String())
	}
	if h.sender.uploaded != nil {
		t.Fatal("an unsendable type was uploaded anyway")
	}
}

func TestSendMediaRejectsAnEmptyOrUndecodableAttachment(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	to := lidJID(allowedLID).String()

	for _, tc := range []struct{ name, data string }{
		{"missing", ""},
		{"not base64", "!!!!not base64!!!!"},
		{"decodes to nothing", "===="},
	} {
		body := `{"to":"` + to + `","mimetype":"image/png","dataBase64":"` + tc.data + `"}`
		if rec := h.do(t, "POST", "/send/media", body, token); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400: %s", tc.name, rec.Code, rec.Body.String())
		}
	}
	if h.sender.uploaded != nil {
		t.Fatal("an empty attachment reached the upload")
	}
}

// A failed upload must not be reported as a failed SEND: the operator would go
// looking at the recipient for a fault that is in the media pipeline.
func TestSendMediaReportsAnUploadFailureDistinctly(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	h.sender.uploadErr = errors.New("cdn refused the upload")

	body := `{"to":"` + lidJID(allowedLID).String() + `","mimetype":"image/png","dataBase64":"` +
		fixturePNG + `"}`
	rec := h.do(t, "POST", "/send/media", body, token)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "uploading") {
		t.Fatalf("the error does not identify the failing step: %s", rec.Body.String())
	}
	if h.sender.sentMsg != nil {
		t.Fatal("a message was sent after the upload failed")
	}
}

// ── Every media kind, not just images ───────────────────────────────────────
//
// The upload is identical for all of them; what differs is the MediaType it is
// uploaded under and the protobuf arm it is sent in. Sending a video inside an
// ImageMessage produces a bubble that never renders, so the pairing is the whole
// contract and each kind is asserted separately.
func TestSendMediaBuildsTheArmThatMatchesTheKind(t *testing.T) {
	cases := []struct {
		kind     string
		mimetype string
		check    func(*testing.T, *waE2E.Message)
	}{
		{"image", "image/png", func(t *testing.T, m *waE2E.Message) {
			if m.GetImageMessage() == nil {
				t.Fatal("not an ImageMessage")
			}
		}},
		{"video", "video/mp4", func(t *testing.T, m *waE2E.Message) {
			if m.GetVideoMessage() == nil {
				t.Fatal("not a VideoMessage")
			}
		}},
		{"audio", "audio/mp4", func(t *testing.T, m *waE2E.Message) {
			if m.GetAudioMessage() == nil {
				t.Fatal("not an AudioMessage")
			}
			if m.GetAudioMessage().GetPTT() {
				t.Fatal("an audio file was marked as a voice note")
			}
		}},
		{"voice", "audio/ogg; codecs=opus", func(t *testing.T, m *waE2E.Message) {
			// PTT is the whole difference between somebody speaking and a file
			// somebody attached, and only the first shows as a voice note.
			if !m.GetAudioMessage().GetPTT() {
				t.Fatal("a voice note was sent without PTT, so it renders as a file")
			}
		}},
		{"document", "application/pdf", func(t *testing.T, m *waE2E.Message) {
			if m.GetDocumentMessage() == nil {
				t.Fatal("not a DocumentMessage")
			}
			if m.GetDocumentMessage().GetFileName() != "boleto.pdf" {
				t.Fatalf("filename = %q", m.GetDocumentMessage().GetFileName())
			}
		}},
		{"sticker", "image/webp", func(t *testing.T, m *waE2E.Message) {
			if m.GetStickerMessage() == nil {
				t.Fatal("not a StickerMessage")
			}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			h := newHarness(t, lidJID(allowedLID).String(), true)
			body := `{"to":"` + lidJID(allowedLID).String() + `","kind":"` + tc.kind +
				`","mimetype":"` + tc.mimetype + `","filename":"boleto.pdf","dataBase64":"` +
				fixturePNG + `"}`

			rec := h.do(t, "POST", "/send/media", body, token)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
			}
			tc.check(t, h.sender.sentMsg)
		})
	}
}

// An unknown kind must be refused rather than quietly sent as an image: a video
// in an ImageMessage is a bubble nobody can open.
func TestSendMediaRefusesAKindItCannotBuild(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() +
		`","kind":"hologram","mimetype":"image/png","dataBase64":"` + fixturePNG + `"}`

	rec := h.do(t, "POST", "/send/media", body, token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if h.sender.uploaded != nil {
		t.Fatal("an unbuildable kind was uploaded anyway")
	}
}

// The image restriction was right for images and wrong as a global rule: a PDF
// is not an image, and a transport that only sends PNGs cannot send a document.
func TestSendMediaAcceptsNonImageTypesForNonImageKinds(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() +
		`","kind":"document","mimetype":"application/pdf","dataBase64":"` + fixturePNG + `"}`

	if rec := h.do(t, "POST", "/send/media", body, token); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
}

// Defaulting to image keeps every existing caller working: the route was
// image-only when it shipped and `kind` did not exist.
func TestSendMediaWithoutAKindIsStillAnImage(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() +
		`","mimetype":"image/png","dataBase64":"` + fixturePNG + `"}`

	if rec := h.do(t, "POST", "/send/media", body, token); rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if h.sender.sentMsg.GetImageMessage() == nil {
		t.Fatal("an unspecified kind did not default to an image")
	}
}

// ── Reactions, edits, deletions, polls ──────────────────────────────────────

func TestSendReactionCarriesTheEmojiAndItsTarget(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() + `","messageId":"3EB0TARGET","emoji":"❤️"}`

	rec := h.do(t, "POST", "/send/reaction", body, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	reaction := h.sender.sentMsg.GetReactionMessage()
	if reaction.GetText() != "❤️" {
		t.Fatalf("emoji = %q", reaction.GetText())
	}
	if reaction.GetKey().GetID() != "3EB0TARGET" {
		t.Fatalf("target = %q", reaction.GetKey().GetID())
	}
}

// An empty reaction is how WhatsApp REMOVES one, so it must not be rejected as
// a missing field — that would make an applied reaction impossible to undo.
func TestSendReactionAcceptsTheEmptyEmojiThatRemovesOne(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() + `","messageId":"3EB0TARGET","emoji":""}`

	if rec := h.do(t, "POST", "/send/reaction", body, token); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if h.sender.sentMsg.GetReactionMessage() == nil {
		t.Fatal("removing a reaction sent no reaction message")
	}
}

func TestSendRevokeDeletesForEveryone(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() + `","messageId":"3EB0TARGET"}`

	rec := h.do(t, "POST", "/send/revoke", body, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if h.sender.sentMsg.GetProtocolMessage().GetType() != waE2E.ProtocolMessage_REVOKE {
		t.Fatalf("not a revocation: %v", h.sender.sentMsg)
	}
}

func TestSendEditReplacesTheTextOfAnEarlierMessage(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() + `","messageId":"3EB0TARGET","message":"corrigido"}`

	rec := h.do(t, "POST", "/send/edit", body, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if h.sender.sentMsg.GetEditedMessage() == nil {
		t.Fatalf("not an edit: %v", h.sender.sentMsg)
	}
}

func TestSendPollCarriesItsQuestionAndOptions(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() +
		`","name":"Jantar?","options":["Pizza","Sushi"],"selectableCount":1}`

	rec := h.do(t, "POST", "/send/poll", body, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	poll := h.sender.sentMsg.GetPollCreationMessage()
	if poll.GetName() != "Jantar?" || len(poll.GetOptions()) != 2 {
		t.Fatalf("poll = %v", poll)
	}
}

// A poll with one option is not a poll, and WhatsApp renders it as a dead end.
func TestSendPollRefusesFewerThanTwoOptions(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() + `","name":"Jantar?","options":["Pizza"]}`

	if rec := h.do(t, "POST", "/send/poll", body, token); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// Every one of these sends as the operator, so every one is behind the same
// allowlist as a plain message. A gate on `/send` alone would be no gate.
func TestEveryOutboundRouteIsBehindTheAllowlist(t *testing.T) {
	stranger := lidJID(otherLID).String()
	for _, route := range []struct{ path, body string }{
		{"/send/reaction", `{"to":"` + stranger + `","messageId":"X","emoji":"👍"}`},
		{"/send/revoke", `{"to":"` + stranger + `","messageId":"X"}`},
		{"/send/edit", `{"to":"` + stranger + `","messageId":"X","message":"hi"}`},
		{"/send/poll", `{"to":"` + stranger + `","name":"?","options":["a","b"]}`},
	} {
		h := newHarness(t, lidJID(allowedLID).String(), true)
		rec := h.do(t, "POST", route.path, route.body, token)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s: status = %d, want 403", route.path, rec.Code)
		}
		if h.sender.sentMsg != nil {
			t.Fatalf("%s: sent to someone off the allowlist", route.path)
		}
	}
}

// ── Replying to a specific message ──────────────────────────────────────────
//
// An assistant that drafts replies could previously only send INTO a chat, never
// reply TO the thing it was answering. In a group that is the difference between
// an answer and a non sequitur.
func TestSendQuotingAMessageCarriesTheContext(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() + `","message":"às 15h",` +
		`"quoted":{"messageId":"3EB0QUOTED","sender":"` + lidJID(otherLID).String() + `"}}`

	rec := h.do(t, "POST", "/send", body, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	// A quote cannot ride on Conversation — that arm carries no context — so a
	// quoting send must become an ExtendedTextMessage or the quote is dropped
	// and the reply silently arrives unattached.
	extended := h.sender.sentMsg.GetExtendedTextMessage()
	if extended == nil {
		t.Fatalf("a quoting send stayed a plain Conversation: %v", h.sender.sentMsg)
	}
	if extended.GetText() != "às 15h" {
		t.Fatalf("text = %q", extended.GetText())
	}
	if extended.GetContextInfo().GetStanzaID() != "3EB0QUOTED" {
		t.Fatalf("stanza = %q", extended.GetContextInfo().GetStanzaID())
	}
	if extended.GetContextInfo().GetParticipant() != lidJID(otherLID).String() {
		t.Fatalf("participant = %q", extended.GetContextInfo().GetParticipant())
	}
}

func TestSendWithoutAQuoteStaysAPlainConversation(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() + `","message":"oi"}`

	h.do(t, "POST", "/send", body, token)
	if h.sender.sentMsg.GetConversation() != "oi" {
		t.Fatalf("an unquoted send was wrapped anyway: %v", h.sender.sentMsg)
	}
}

func TestSendMediaCanQuoteTheMessageItAnswers(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() + `","mimetype":"image/png","dataBase64":"` +
		fixturePNG + `","quoted":{"messageId":"3EB0QUOTED"}}`

	rec := h.do(t, "POST", "/send/media", body, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if h.sender.sentMsg.GetImageMessage().GetContextInfo().GetStanzaID() != "3EB0QUOTED" {
		t.Fatalf("the image did not carry the quote: %v", h.sender.sentMsg)
	}
}

// ── Voting in a poll ────────────────────────────────────────────────────────
//
// The vote is encrypted against a secret whatsmeow stored when the poll arrived,
// keyed by the poll's chat, sender and id — so a caller needs only to name the
// poll, and this transport keeps no extra state to make it possible.
func TestSendPollVoteEncryptsAgainstTheNamedPoll(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() + `","messageId":"3EB0POLL",` +
		`"sender":"` + lidJID(otherLID).String() + `","options":["Pizza"]}`

	rec := h.do(t, "POST", "/send/poll/vote", body, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if h.sender.votedOn == nil {
		t.Fatal("no poll was identified to vote in")
	}
	if h.sender.votedOn.ID != "3EB0POLL" {
		t.Fatalf("voted in %q", h.sender.votedOn.ID)
	}
	if h.sender.votedOn.Sender.User != otherLID {
		t.Fatalf("the poll's author was recorded as %s", h.sender.votedOn.Sender)
	}
	if h.sender.sentMsg.GetPollUpdateMessage() == nil {
		t.Fatalf("not a poll vote: %v", h.sender.sentMsg)
	}
}

// A vote encrypted against a poll this account never saw cannot be built, and
// saying so beats sending a vote that decrypts to nothing at every recipient.
func TestSendPollVoteReportsAnUnknownPollRatherThanSendingNothing(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	h.sender.voteErr = errors.New("no message secret for that poll")

	body := `{"to":"` + lidJID(allowedLID).String() + `","messageId":"3EB0GONE","options":["Pizza"]}`
	rec := h.do(t, "POST", "/send/poll/vote", body, token)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
	if h.sender.sentMsg != nil {
		t.Fatal("a vote was sent despite failing to encrypt")
	}
}

// ── Typing ──────────────────────────────────────────────────────────────────

func TestPresenceTellsTheChatSomeoneIsTyping(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() + `","state":"composing"}`

	rec := h.do(t, "POST", "/presence", body, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if h.sender.presence != "composing" {
		t.Fatalf("presence = %q", h.sender.presence)
	}
}

func TestPresenceRefusesAStateThatIsNotOne(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(allowedLID).String() + `","state":"dancing"}`

	if rec := h.do(t, "POST", "/presence", body, token); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// Typing at somebody is a signal this account emits into their chat, so it is
// gated exactly like a message. Without this an unallowlisted contact could be
// shown "typing…" indefinitely.
func TestPresenceIsBehindTheAllowlist(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	body := `{"to":"` + lidJID(otherLID).String() + `","state":"composing"}`

	if rec := h.do(t, "POST", "/presence", body, token); rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if h.sender.presence != "" {
		t.Fatal("presence was sent to someone off the allowlist")
	}
}

// ── Sending media to oneself ────────────────────────────────────────────────
//
// The self routes carry no allowlist on purpose: there is exactly one possible
// recipient and it is the operator. That reasoning holds for a picture as much
// as for a line of text, and an attachment that had to be allowlisted to reach
// your own chat would be a gate protecting you from yourself.
func TestSendSelfMediaGoesToTheOwnAccountWithNoAllowlist(t *testing.T) {
	// Empty allowlist and sending disabled: neither gates the self route.
	h := newHarness(t, "", false)
	h.session.paired = true

	body := `{"mimetype":"image/png","caption":"final board","dataBase64":"` + fixturePNG + `"}`
	rec := h.do(t, "POST", "/send/self/media", body, token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if len(h.sender.uploaded) == 0 {
		t.Fatal("nothing was uploaded")
	}
	if h.sender.sentTo.User != allowedLID {
		t.Fatalf("sent to %s, want the operator's own address", h.sender.sentTo)
	}
	image := h.sender.sentMsg.GetImageMessage()
	if image == nil || image.GetCaption() != "final board" {
		t.Fatalf("not an image with its caption: %v", h.sender.sentMsg)
	}
}

func TestSendSelfMediaRejectsATypeWhatsAppCannotRender(t *testing.T) {
	h := newHarness(t, "", false)
	h.session.paired = true

	body := `{"mimetype":"image/svg+xml","dataBase64":"` + fixturePNG + `"}`
	if rec := h.do(t, "POST", "/send/self/media", body, token); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if h.sender.uploaded != nil {
		t.Fatal("an unsendable type was uploaded anyway")
	}
}

// Not paired means there is no "self" to send to — a state the operator fixes by
// pairing, not a fault at WhatsApp.
func TestSendSelfMediaReportsNoSelfAsAConflict(t *testing.T) {
	h := newHarness(t, "", false)
	h.session.paired = false

	body := `{"mimetype":"image/png","dataBase64":"` + fixturePNG + `"}`
	if rec := h.do(t, "POST", "/send/self/media", body, token); rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}

// An unpaired or disconnected session is a state the operator can fix. Reporting
// it as 502 would point them at WhatsApp for a fault that is local.
func TestSendReportsNotLoggedInAsAConflict(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	h.sender.err = whatsmeow.ErrNotLoggedIn

	body := `{"to":"` + lidJID(allowedLID).String() + `","message":"olá"}`
	if rec := h.do(t, "POST", "/send", body, token); rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}

func TestSendReportsAnUpstreamFailureAsBadGateway(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)
	h.sender.err = errors.New("socket exploded")

	body := `{"to":"` + lidJID(allowedLID).String() + `","message":"olá"}`
	if rec := h.do(t, "POST", "/send", body, token); rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
}

func TestSendRejectsAnEmptyMessage(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)

	body := `{"to":"` + lidJID(allowedLID).String() + `","message":""}`
	if rec := h.do(t, "POST", "/send", body, token); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestSendRejectsAMalformedRecipient(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)

	// `types.ParseJID` accepts this, so the refusal must come from the guard
	// rather than the parser — which is the case worth pinning down.
	body := `{"to":"not a jid","message":"olá"}`
	rec := h.do(t, "POST", "/send", body, token)
	if rec.Code != http.StatusForbidden && rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 or 403", rec.Code)
	}
	if !h.sender.sentTo.IsEmpty() {
		t.Fatal("a malformed recipient reached the sender")
	}
}

// A typo in a field name must not become an empty message sent to a real person.
func TestSendRejectsUnknownFields(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String(), true)

	body := `{"to":"` + lidJID(allowedLID).String() + `","messsage":"typo"}`
	if rec := h.do(t, "POST", "/send", body, token); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !h.sender.sentTo.IsEmpty() {
		t.Fatal("a body with a misspelled field reached the sender")
	}
}

// ── Outbox ──────────────────────────────────────────────────────────────────

func TestOutboxReturnsEntriesAndTheDropCount(t *testing.T) {
	h := newHarness(t, "", false)
	h.queue.entries = []outbox.Entry{
		{Seq: 1, Payload: json.RawMessage(`{"key":"A"}`)},
		{Seq: 2, Payload: json.RawMessage(`{"key":"B"}`)},
	}
	h.queue.stats = outbox.Stats{Depth: 2, Dropped: 7}

	rec := h.do(t, "GET", "/outbox", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	var got struct {
		Entries []outbox.Entry `json:"entries"`
		Depth   int64          `json:"depth"`
		Dropped int64          `json:"dropped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(got.Entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(got.Entries))
	}
	// The drop count rides along on every drain, so a consumer cannot process
	// the queue for weeks without learning that messages were lost.
	if got.Dropped != 7 {
		t.Fatalf("dropped = %d, want 7", got.Dropped)
	}
}

func TestOutboxCapsAnOversizedLimit(t *testing.T) {
	h := newHarness(t, "", false)
	for i := range make([]struct{}, MaxDrainLimit+50) {
		h.queue.entries = append(h.queue.entries,
			outbox.Entry{Seq: int64(i + 1), Payload: json.RawMessage(`{}`)})
	}

	rec := h.do(t, "GET", "/outbox?limit=99999", "", token)
	var got struct {
		Entries []outbox.Entry `json:"entries"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &got)

	if len(got.Entries) > MaxDrainLimit {
		t.Fatalf("returned %d entries, want at most %d", len(got.Entries), MaxDrainLimit)
	}
}

func TestOutboxRejectsANonNumericLimit(t *testing.T) {
	h := newHarness(t, "", false)

	if rec := h.do(t, "GET", "/outbox?limit=lots", "", token); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestEmptyOutboxReturnsAnArrayNotNull(t *testing.T) {
	h := newHarness(t, "", false)

	rec := h.do(t, "GET", "/outbox", "", token)
	if !strings.Contains(rec.Body.String(), `"entries":[]`) {
		t.Fatalf("empty outbox encoded as %s; a null would break a consumer that iterates",
			rec.Body.String())
	}
}

func TestAckPassesTheSequenceThrough(t *testing.T) {
	h := newHarness(t, "", false)

	rec := h.do(t, "POST", "/outbox/ack", `{"through":42}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if h.queue.acked != 42 {
		t.Fatalf("acked = %d, want 42", h.queue.acked)
	}
}

// A missing `through` must not be read as 0: that would ack nothing while
// reporting success, and the consumer would loop on the same entries forever.
func TestAckRequiresAnExplicitSequence(t *testing.T) {
	h := newHarness(t, "", false)

	if rec := h.do(t, "POST", "/outbox/ack", `{}`, token); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if h.queue.acked != 0 {
		t.Fatalf("a rejected ack still removed through %d", h.queue.acked)
	}
}

// ── Contacts ────────────────────────────────────────────────────────────────

func TestContactsAreKeyedByIdentityAndCarryNoPhoneNumber(t *testing.T) {
	h := newHarness(t, "", false)
	h.session.contacts = map[types.JID]types.ContactInfo{
		types.NewJID(allowedPhone, types.DefaultUserServer): {PushName: "Pim", FullName: "Pim Example"},
		lidJID(otherLID): {PushName: "Tuca"},
	}

	rec := h.do(t, "GET", "/contacts", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	// The store is keyed by JID and half of those JIDs ARE phone numbers. The
	// response must key by identity so the number never crosses the boundary.
	if strings.Contains(rec.Body.String(), allowedPhone) {
		t.Fatalf("a phone number reached the contacts response: %s", rec.Body.String())
	}

	var got struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got.Count != 2 {
		t.Fatalf("count = %d, want 2", got.Count)
	}
}

// ── One row per person, not per address ─────────────────────────────────────
//
// whatsmeow's contact store is keyed by JID, and one person routinely holds two:
// their phone JID and their LID. Both resolve to the SAME identity key, so a
// roster built one-row-per-JID lists them twice — and `resolveRecipient` then
// refuses them as ambiguous, because two candidates matched.
//
// On the operator's own account this made 108 of 479 contacts unaddressable,
// including the operator themselves. The duplicates are not two people to choose
// between; they are one person seen twice, so they are collapsed here.
func TestContactsListOnePersonOnceEvenWithTwoAddresses(t *testing.T) {
	h := harnessWithLIDs(t)
	h.session.contacts = map[types.JID]types.ContactInfo{
		// The same person, reachable both ways. The resolver maps the phone JID
		// onto the LID, so both rows carry one key.
		lidJID(otherLID):                                   {PushName: "Tuca"},
		types.NewJID(allowedPhone, types.DefaultUserServer): {PushName: "Tuca"},
	}

	rec := h.do(t, "GET", "/contacts", "", token)
	var got struct {
		Contacts []struct {
			Key      string `json:"key"`
			PushName string `json:"pushName"`
		} `json:"contacts"`
		Count int `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	seen := map[string]int{}
	for _, entry := range got.Contacts {
		seen[entry.Key]++
	}
	for key, n := range seen {
		if n > 1 {
			t.Fatalf("%s appears %d times; a person with two addresses is still one recipient", key, n)
		}
	}
	if got.Count != len(got.Contacts) {
		t.Fatalf("count = %d but %d entries were returned", got.Count, len(got.Contacts))
	}
}

// Collapsing must not lose the name: the phone-JID row is often the one with a
// push name on it, and dropping it would leave a nameless, unaddressable key.
func TestContactsKeepTheNameWhenCollapsingDuplicates(t *testing.T) {
	h := harnessWithLIDs(t)
	h.session.contacts = map[types.JID]types.ContactInfo{
		lidJID(otherLID): {},
		types.NewJID(allowedPhone, types.DefaultUserServer): {PushName: "Tuca"},
	}

	rec := h.do(t, "GET", "/contacts", "", token)
	if !strings.Contains(rec.Body.String(), "Tuca") {
		t.Fatalf("collapsing dropped the only name there was: %s", rec.Body.String())
	}
}

func TestContactsReportsNotPairedAsAConflict(t *testing.T) {
	h := newHarness(t, "", false)
	h.session.contactsErr = session.ErrNotPaired

	if rec := h.do(t, "GET", "/contacts", "", token); rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}

// A group is a recipient, and until it appears in the roster it is an
// unaddressable one: the bridge resolves the name the operator types against
// this response, so a groupless roster cannot send to a group at all — and
// worse, a short group name prefix-matches a PERSON and sends there instead.
func TestContactsCarryJoinedGroupsWithTheirSubject(t *testing.T) {
	h := newHarness(t, "", false)
	h.session.contacts = map[types.JID]types.ContactInfo{
		lidJID(otherLID): {PushName: "Tuca"},
	}
	h.session.groups = []types.GroupInfo{
		{JID: groupJID("120363000000000001"), GroupName: types.GroupName{Name: "We"}},
	}

	rec := h.do(t, "GET", "/contacts", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	var got struct {
		Contacts []struct {
			Key     string `json:"key"`
			Kind    string `json:"kind"`
			Subject string `json:"subject"`
		} `json:"contacts"`
		Count int `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got.Count != 2 {
		t.Fatalf("count = %d, want 2 (one person, one group)", got.Count)
	}

	var found bool
	for _, entry := range got.Contacts {
		if entry.Kind != "group" {
			continue
		}
		found = true
		if entry.Subject != "We" {
			t.Fatalf("group subject = %q, want %q", entry.Subject, "We")
		}
		if entry.Key != "120363000000000001@g.us" {
			t.Fatalf("group key = %q, want the group JID", entry.Key)
		}
	}
	if !found {
		t.Fatalf("no group in the roster: %s", rec.Body.String())
	}
}

// Group subjects come from a live IQ, so they fail independently of the contact
// store. Failing the whole roster would take away the ability to message PEOPLE
// because a group listing timed out — but answering as though the account had
// joined no groups is worse, because "no contact matches" is indistinguishable
// from a name that was never there. So: degrade, and say so.
func TestContactsDegradeToPeopleWhenGroupsCannotBeListed(t *testing.T) {
	h := newHarness(t, "", false)
	h.session.contacts = map[types.JID]types.ContactInfo{
		lidJID(otherLID): {PushName: "Tuca"},
	}
	h.session.groupsErr = errors.New("iq timed out")

	rec := h.do(t, "GET", "/contacts", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want the people to still be usable: %s", rec.Code, rec.Body.String())
	}

	var got struct {
		Count             int    `json:"count"`
		GroupsUnavailable string `json:"groupsUnavailable"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got.Count != 1 {
		t.Fatalf("count = %d, want the one person", got.Count)
	}
	if got.GroupsUnavailable == "" {
		t.Fatal("the roster dropped every group silently")
	}
}

// ── Pairing ─────────────────────────────────────────────────────────────────

func TestPairPhoneReturnsTheCode(t *testing.T) {
	h := newHarness(t, "", false)

	rec := h.do(t, "POST", "/pair/phone", `{"phone":"`+allowedPhone+`"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ABCD-EFGH") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPairPhoneWithoutANumberIsAConflict(t *testing.T) {
	h := newHarness(t, "", false)

	if rec := h.do(t, "POST", "/pair/phone", `{"phone":""}`, token); rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}

// The QR code rotates every few seconds, so the endpoint streams rather than
// answering once with a code that expires before the operator can aim a phone.
func TestPairQRStreamsCodesAndEndsOnSuccess(t *testing.T) {
	h := newHarness(t, "", false)

	rec := h.do(t, "GET", "/pair/qr", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}

	body := rec.Body.String()
	if !strings.Contains(body, "qr-payload-1") {
		t.Fatalf("the stream carried no code: %s", body)
	}
	if !strings.Contains(body, whatsmeow.QRChannelSuccess.Event) {
		t.Fatalf("the stream did not report success: %s", body)
	}
}

func TestConnectReportsAStateConflict(t *testing.T) {
	h := newHarness(t, "", false)
	h.session.connectErr = session.ErrNotPaired

	if rec := h.do(t, "POST", "/connect", "{}", token); rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}

// ── Status ──────────────────────────────────────────────────────────────────

// A status response is the most casually-logged thing the transport produces.
// Reporting the allowlist's size rather than its contents is what keeps it from
// publishing a list of real people.
func TestStatusReportsAllowlistSizeNotContents(t *testing.T) {
	h := newHarness(t, lidJID(allowedLID).String()+","+lidJID(otherLID).String(), true)

	rec := h.do(t, "GET", "/status", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	body := rec.Body.String()
	if strings.Contains(body, allowedLID) || strings.Contains(body, otherLID) {
		t.Fatalf("/status published allowlist entries: %s", body)
	}
	if !strings.Contains(body, `"allowlistedSize":2`) {
		t.Fatalf("/status did not report the allowlist size: %s", body)
	}
}

// ── Media ───────────────────────────────────────────────────────────────────

// The three failures must not look alike. "There was never a file", "the file
// existed and WhatsApp no longer serves it" and "the transport is broken" have
// different remedies, and an agent reporting a gap needs to know which it hit.
func TestMediaDistinguishesItsThreeFailures(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"never recorded", mediastore.ErrNotStored, http.StatusNotFound},
		{"expired at WhatsApp", session.ErrMediaUnavailable, http.StatusGone},
		{"transport broken", errors.New("socket exploded"), http.StatusBadGateway},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, "", false)
			h.session.mediaErr = tc.err

			rec := h.do(t, "GET", "/media?key=3EB0AAA", "", token)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

func TestMediaStreamsTheBytesWithItsType(t *testing.T) {
	h := newHarness(t, "", false)
	h.session.mediaBytes = []byte("OggS-fake-audio")
	h.session.mediaRecord = mediastore.Record{Mimetype: "audio/ogg; codecs=opus"}

	rec := h.do(t, "GET", "/media?key=3EB0AAA", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "OggS-fake-audio" {
		t.Fatalf("body = %q", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "audio/ogg; codecs=opus" {
		t.Fatalf("Content-Type = %q", ct)
	}
}

// A filename arrives from the sender and is entirely under their control. Quoting
// it is what stops a crafted name forging a second header parameter.
func TestMediaQuotesTheFilenameItWasGiven(t *testing.T) {
	h := newHarness(t, "", false)
	h.session.mediaBytes = []byte("%PDF-fake")
	h.session.mediaRecord = mediastore.Record{
		Mimetype: "application/pdf",
		Filename: `evil"; x=y.pdf`,
	}

	rec := h.do(t, "GET", "/media?key=3EB0DOC", "", token)
	disposition := rec.Header().Get("Content-Disposition")
	if strings.Contains(disposition, `; x=y`) && !strings.Contains(disposition, `\"`) {
		t.Fatalf("a crafted filename forged a header parameter: %q", disposition)
	}
}

func TestMediaRequiresAKey(t *testing.T) {
	h := newHarness(t, "", false)

	if rec := h.do(t, "GET", "/media", "", token); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// ── History ─────────────────────────────────────────────────────────────────

func TestHistoryForwardsTheAnchorAndAccepts(t *testing.T) {
	h := newHarness(t, "", false)

	chat := types.NewJID("120363000000000000", types.GroupServer).String()
	body := `{"chat":"` + chat + `","oldestId":"3EB0OLD","oldestFromMe":true,"oldestTimestamp":1786000000,"count":50}`
	rec := h.do(t, "POST", "/history", body, token)

	// 202, not 200: the messages arrive later, in the outbox. Reporting success
	// would claim a delivery that has not happened.
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", rec.Code, rec.Body.String())
	}
	if h.session.historyAnchor.ID != "3EB0OLD" {
		t.Fatalf("anchor id = %q", h.session.historyAnchor.ID)
	}
	if !h.session.historyAnchor.IsFromMe {
		t.Fatal("oldestFromMe was not carried through; the anchor addresses the wrong message")
	}
	if h.session.historyCount != 50 {
		t.Fatalf("count = %d, want 50", h.session.historyCount)
	}
}

// Without an anchor there is nothing to request history relative to, and the
// request would silently do nothing.
func TestHistoryRequiresAnAnchor(t *testing.T) {
	h := newHarness(t, "", false)
	chat := types.NewJID("120363000000000000", types.GroupServer).String()

	for _, body := range []string{
		`{"chat":"` + chat + `","oldestTimestamp":1786000000}`,
		`{"chat":"` + chat + `","oldestId":"3EB0OLD"}`,
		`{"chat":"not a jid","oldestId":"3EB0OLD","oldestTimestamp":1786000000}`,
	} {
		if rec := h.do(t, "POST", "/history", body, token); rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s got %d, want 400", body, rec.Code)
		}
	}
}

func TestHistoryReportsNotPairedAsAConflict(t *testing.T) {
	h := newHarness(t, "", false)
	h.session.historyErr = session.ErrNotPaired

	chat := types.NewJID("120363000000000000", types.GroupServer).String()
	body := `{"chat":"` + chat + `","oldestId":"3EB0OLD","oldestTimestamp":1786000000}`
	if rec := h.do(t, "POST", "/history", body, token); rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}
