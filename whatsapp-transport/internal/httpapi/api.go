// Package httpapi exposes the transport to the Node bridge over loopback HTTP.
//
// ── What this is and is not ─────────────────────────────────────────────────
// It is the protocol surface: pairing, connection status, the outbox, the contact
// roster, and sending. It is NOT the archive's API. Everything the agent reads —
// search, the twin, people, obligations — stays on `whatsapp-bridge`'s existing
// HTTP surface, backed by `store.js`, untouched by the transport change.
//
// So the Node bridge is a client here and a server to the agent. That is the
// shape that keeps `store.js` the archive's only writer.
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/identity"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/mediastore"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/outbox"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/sendguard"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/session"
)

// EnvToken names the shared secret the Node bridge presents.
const EnvToken = "WA_TRANSPORT_TOKEN"

// DefaultDrainLimit bounds an unspecified outbox read.
const DefaultDrainLimit = 200

// MaxDrainLimit bounds a specified one. A consumer asking for everything at once
// would build a response larger than either process wants to hold.
const MaxDrainLimit = 1000

// Sender is the send capability, narrowed for testability. Satisfied by
// `*whatsmeow.Client`.
type Sender interface {
	SendMessage(ctx context.Context, to types.JID, message *waE2E.Message,
		extra ...whatsmeow.SendRequestExtra) (whatsmeow.SendResponse, error)
}

// Queue is the outbox, narrowed so tests need no database.
type Queue interface {
	Pending(ctx context.Context, limit int) ([]outbox.Entry, error)
	Ack(ctx context.Context, through int64) (int64, error)
	Stats(ctx context.Context) (outbox.Stats, error)
}

// Pairing is the subset of the session the API drives.
type Pairing interface {
	Paired() bool
	Status(ctx context.Context) (session.Status, error)
	Connect(ctx context.Context) error
	PairPhone(ctx context.Context, phone string) (string, error)
	BeginQRPairing(ctx context.Context) (<-chan whatsmeow.QRChannelItem, error)
	Contacts(ctx context.Context) (map[types.JID]types.ContactInfo, error)
	DownloadMedia(ctx context.Context, key string) (mediastore.Record, []byte, error)
	RequestHistory(ctx context.Context, anchor types.MessageInfo, count int) error
}

type Config struct {
	// Token is required. See New.
	Token string

	Session  Pairing
	Queue    Queue
	Sender   Sender
	Guard    *sendguard.Guard
	Resolver *identity.Resolver
}

type API struct {
	cfg Config
}

// New refuses to build an unauthenticated API.
//
// This process can read every message the account receives and send as the
// operator. An empty token would make that reachable by anything that can open a
// loopback socket, including any other process on the host — so an unset token is
// a startup failure, not a permissive default.
func New(cfg Config) (*API, error) {
	if cfg.Token == "" {
		return nil, fmt.Errorf("httpapi: %s is required — this API can read all "+
			"correspondence and send as the operator, so it does not run unauthenticated", EnvToken)
	}
	if cfg.Session == nil || cfg.Queue == nil || cfg.Guard == nil || cfg.Resolver == nil {
		return nil, errors.New("httpapi: Session, Queue, Guard and Resolver are all required")
	}
	return &API{cfg: cfg}, nil
}

func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()

	// Unauthenticated: liveness only, and it reveals nothing but "the process is
	// up". Container health checks should not need the send-capable token.
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.Handle("GET /status", a.authed(a.handleStatus))
	mux.Handle("POST /connect", a.authed(a.handleConnect))
	mux.Handle("POST /pair/phone", a.authed(a.handlePairPhone))
	mux.Handle("GET /pair/qr", a.authed(a.handlePairQR))
	mux.Handle("GET /outbox", a.authed(a.handleOutbox))
	mux.Handle("POST /outbox/ack", a.authed(a.handleAck))
	mux.Handle("GET /contacts", a.authed(a.handleContacts))
	mux.Handle("POST /send", a.authed(a.handleSend))
	mux.Handle("GET /media", a.authed(a.handleMedia))
	mux.Handle("POST /history", a.authed(a.handleHistory))

	return mux
}

// authed enforces the bearer token in constant time.
//
// `subtle.ConstantTimeCompare` rather than `==` because a token check that
// short-circuits on the first wrong byte leaks the token's prefix to anything
// that can time the response, and this token authorises sending as the operator.
func (a *API) authed(next func(http.ResponseWriter, *http.Request)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		presented := r.Header.Get("Authorization")
		expected := "Bearer " + a.cfg.Token

		if subtle.ConstantTimeCompare([]byte(presented), []byte(expected)) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	})
}

func (a *API) handleStatus(w http.ResponseWriter, r *http.Request) {
	status, err := a.cfg.Session.Status(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"session": status,
		// The count, never the entries: a status response is the most
		// casually-logged thing here, and the allowlist is a list of real people.
		"send": map[string]any{
			"enabled":         a.cfg.Guard.Enabled(),
			"allowlistedSize": a.cfg.Guard.Size(),
		},
	})
}

func (a *API) handleConnect(w http.ResponseWriter, r *http.Request) {
	if err := a.cfg.Session.Connect(r.Context()); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"connected": true})
}

func (a *API) handlePairPhone(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Phone string `json:"phone"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	code, err := a.cfg.Session.PairPhone(r.Context(), body.Phone)
	if err != nil {
		writeError(w, statusForPairing(err), err.Error())
		return
	}
	// The code is the point of the call, and it is short-lived and useless
	// without the operator's own phone.
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
}

// handlePairQR streams QR codes as server-sent events.
//
// A stream rather than a single response because WhatsApp rotates the code every
// twenty seconds or so; a one-shot endpoint would hand back a code that expired
// before the operator finished aiming their phone.
func (a *API) handlePairQR(w http.ResponseWriter, r *http.Request) {
	codes, err := a.cfg.Session.BeginQRPairing(r.Context())
	if err != nil {
		writeError(w, statusForPairing(err), err.Error())
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case item, open := <-codes:
			if !open {
				return
			}
			payload, err := json.Marshal(map[string]string{
				"event": item.Event,
				"code":  item.Code,
			})
			if err != nil {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()

			// `success` and the timeout/error events are terminal; whatsmeow
			// closes the channel after them, but returning here means the
			// operator's client sees the stream end immediately rather than
			// waiting on a closed-channel read.
			if item.Event == whatsmeow.QRChannelSuccess.Event {
				return
			}
		}
	}
}

func (a *API) handleOutbox(w http.ResponseWriter, r *http.Request) {
	limit := DefaultDrainLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "limit must be an integer")
			return
		}
		limit = parsed
	}
	if limit > MaxDrainLimit {
		limit = MaxDrainLimit
	}

	entries, err := a.cfg.Queue.Pending(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	stats, err := a.cfg.Queue.Stats(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if entries == nil {
		entries = []outbox.Entry{}
	}
	// `dropped` rides along on every drain rather than living only on /status,
	// so a consumer cannot process the queue for weeks without ever being told
	// that messages were lost.
	writeJSON(w, http.StatusOK, map[string]any{
		"entries": entries,
		"depth":   stats.Depth,
		"dropped": stats.Dropped,
	})
}

func (a *API) handleAck(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Through *int64 `json:"through"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// A pointer, so that a missing field is distinguishable from zero. Treating
	// an absent `through` as 0 would silently ack nothing and look like success.
	if body.Through == nil {
		writeError(w, http.StatusBadRequest, "through is required")
		return
	}

	removed, err := a.cfg.Queue.Ack(r.Context(), *body.Through)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"removed": removed})
}

// handleContacts returns the roster SPEC §3.4 records as not buildable.
//
// Each entry is keyed by canonical identity rather than by raw JID, so a phone
// number never appears in the response even though the store is full of them.
func (a *API) handleContacts(w http.ResponseWriter, r *http.Request) {
	contacts, err := a.cfg.Session.Contacts(r.Context())
	if err != nil {
		writeError(w, statusForPairing(err), err.Error())
		return
	}

	out := make([]map[string]any, 0, len(contacts))
	for jid, info := range contacts {
		id, err := a.cfg.Resolver.Resolve(r.Context(), jid)
		if err != nil {
			continue // unusable address; nothing to key a contact on
		}
		out = append(out, map[string]any{
			"key":          id.Key,
			"kind":         id.Kind,
			"provisional":  id.Provisional,
			"pushName":     info.PushName,
			"fullName":     info.FullName,
			"businessName": info.BusinessName,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{"contacts": out, "count": len(out)})
}

func (a *API) handleSend(w http.ResponseWriter, r *http.Request) {
	var body struct {
		To      string `json:"to"`
		Message string `json:"message"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Message == "" {
		writeError(w, http.StatusBadRequest, "message is required")
		return
	}

	to, err := types.ParseJID(body.To)
	if err != nil {
		writeError(w, http.StatusBadRequest, "to must be a JID")
		return
	}

	// The guard runs before anything else touches the socket. Ordering is the
	// point: a refusal must be impossible to reach past.
	if err := a.cfg.Guard.Permit(r.Context(), to); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}

	if a.cfg.Sender == nil {
		writeError(w, http.StatusServiceUnavailable, "not connected")
		return
	}

	resp, err := a.cfg.Sender.SendMessage(r.Context(), to,
		&waE2E.Message{Conversation: proto.String(body.Message)})
	if err != nil {
		// Not being logged in is a state the operator can fix by pairing or
		// reconnecting; reporting it as a bad gateway would send them looking
		// for a fault at WhatsApp instead.
		if errors.Is(err, whatsmeow.ErrNotLoggedIn) || errors.Is(err, session.ErrNotPaired) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":     resp.ID,
		"sentAt": resp.Timestamp.UTC().Format(time.RFC3339),
	})
}

// handleMedia streams the bytes behind one message.
//
// Three outcomes are deliberately distinct, because collapsing them would make an
// absent file and a broken transport look alike:
//
//	404 — nothing was ever recorded for that message (not media, or evicted)
//	410 — it was recorded, but WhatsApp no longer serves it
//	502 — the transport could not fetch it right now
func (a *API) handleMedia(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if key == "" {
		writeError(w, http.StatusBadRequest, "key is required")
		return
	}

	record, data, err := a.cfg.Session.DownloadMedia(r.Context(), key)
	switch {
	case errors.Is(err, mediastore.ErrNotStored):
		writeError(w, http.StatusNotFound, "no media recorded for that message")
		return
	case errors.Is(err, session.ErrMediaUnavailable):
		// Gone rather than Bad Gateway: the usual cause is WhatsApp expiring the
		// blob, which no retry fixes and which the agent must report as a gap.
		writeError(w, http.StatusGone, err.Error())
		return
	case err != nil:
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	contentType := record.Mimetype
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if record.Filename != "" {
		// Quoted and via %q so a filename containing a quote cannot forge a
		// second header parameter.
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", record.Filename))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// handleHistory asks the operator's phone for older messages.
//
// The caller supplies the anchor because only the archive knows what it already
// holds. The reply is asynchronous — it arrives as history-sync events in the
// outbox — so a 202 is the honest status: accepted, not delivered.
func (a *API) handleHistory(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Chat      string `json:"chat"`
		OldestID  string `json:"oldestId"`
		FromMe    bool   `json:"oldestFromMe"`
		Timestamp int64  `json:"oldestTimestamp"`
		Count     int    `json:"count"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	chat, err := types.ParseJID(body.Chat)
	if err == nil {
		// `types.ParseJID` accepts anything without an `@` by treating the whole
		// string as a server, so parsing alone is not validation. The resolver
		// holds the single rule for what counts as an addressable correspondent;
		// asking it here keeps that rule in one place.
		_, err = a.cfg.Resolver.Resolve(r.Context(), chat)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "chat must be a JID")
		return
	}
	if body.OldestID == "" {
		writeError(w, http.StatusBadRequest,
			"oldestId is required — history is requested relative to a message already held")
		return
	}
	if body.Timestamp <= 0 {
		writeError(w, http.StatusBadRequest, "oldestTimestamp (unix seconds) is required")
		return
	}

	anchor := types.MessageInfo{
		MessageSource: types.MessageSource{Chat: chat, IsFromMe: body.FromMe},
		ID:            body.OldestID,
		Timestamp:     time.Unix(body.Timestamp, 0),
	}

	if err := a.cfg.Session.RequestHistory(r.Context(), anchor, body.Count); err != nil {
		writeError(w, statusForPairing(err), err.Error())
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]string{
		"status": "requested",
		"note": "history arrives asynchronously in the outbox, and only reaches as far " +
			"back as the operator's phone still holds",
	})
}

// statusForPairing maps a pairing-state error onto a code the caller can branch
// on: 409 means "wrong state, fix it and retry", not "malformed request".
func statusForPairing(err error) int {
	if errors.Is(err, session.ErrNotPaired) {
		return http.StatusConflict
	}
	return http.StatusConflict
}

func decode(r *http.Request, into any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	// Unknown fields are an error rather than ignored: a caller sending
	// `{"messsage": "..."}` should be told, not have an empty message sent.
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, code int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, code int, message string) {
	writeJSON(w, code, map[string]string{"error": message})
}
