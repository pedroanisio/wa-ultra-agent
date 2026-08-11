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
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"

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
	err      error
}

func (s *fakeSender) SendMessage(_ context.Context, to types.JID, msg *waE2E.Message,
	_ ...whatsmeow.SendRequestExtra) (whatsmeow.SendResponse, error) {
	if s.err != nil {
		return whatsmeow.SendResponse{}, s.err
	}
	s.sentTo = to
	s.sentBody = msg.GetConversation()
	return whatsmeow.SendResponse{ID: "3EB0SENT", Timestamp: time.Unix(1786000000, 0)}, nil
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

func TestContactsReportsNotPairedAsAConflict(t *testing.T) {
	h := newHarness(t, "", false)
	h.session.contactsErr = session.ErrNotPaired

	if rec := h.do(t, "GET", "/contacts", "", token); rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
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
