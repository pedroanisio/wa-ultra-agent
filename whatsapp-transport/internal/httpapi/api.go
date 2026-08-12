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
	"encoding/base64"
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
//
// `Upload` is here rather than on a separate interface because an image send is
// two calls that cannot be separated: the upload's response fields ARE the
// addressing of the message that follows, so a test that fakes one and not the
// other proves nothing about the pair.
type Sender interface {
	SendMessage(ctx context.Context, to types.JID, message *waE2E.Message,
		extra ...whatsmeow.SendRequestExtra) (whatsmeow.SendResponse, error)
	Upload(ctx context.Context, plaintext []byte,
		appInfo whatsmeow.MediaType) (whatsmeow.UploadResponse, error)

	// ── The builders ────────────────────────────────────────────────────────
	// A reaction, an edit and a revocation are not free-form messages: each is a
	// precise protobuf shape keyed to a message that already exists, and getting
	// the key wrong produces a message that silently applies to nothing.
	// whatsmeow constructs them correctly, so they are used rather than
	// reproduced — the alternative is a second implementation of a format whose
	// details are WhatsApp's to change.
	BuildRevoke(chat, sender types.JID, id types.MessageID) *waE2E.Message
	BuildEdit(chat types.JID, id types.MessageID, newContent *waE2E.Message) *waE2E.Message
	BuildReaction(chat, sender types.JID, id types.MessageID, reaction string) *waE2E.Message
	BuildPollCreation(name string, options []string, selectableCount int) *waE2E.Message

	// A vote is encrypted against a secret whatsmeow stored when the poll
	// arrived, keyed by the poll's chat, sender and id. That is why voting needs
	// no state of this transport's own: naming the poll is enough, and a poll
	// this account never received simply has no secret and fails loudly.
	BuildPollVote(ctx context.Context, poll *types.MessageInfo,
		options []string) (*waE2E.Message, error)

	SendChatPresence(ctx context.Context, to types.JID,
		state types.ChatPresence, media types.ChatPresenceMedia) error
}

// quotedRef names the message a send is a reply to.
type quotedRef struct {
	MessageID string `json:"messageId"`
	// Sender is who wrote the quoted message. Required for a group quote to
	// attribute correctly; in a direct chat WhatsApp infers it.
	Sender string `json:"sender"`
}

// contextFor turns a quote reference into the ContextInfo a message carries.
//
// Returns nil when nothing was quoted, which is the difference between a reply
// and an ordinary message — an empty ContextInfo is not the same as none, and
// attaching one would mark every message as a reply to nothing.
func contextFor(quoted *quotedRef) *waE2E.ContextInfo {
	if quoted == nil || quoted.MessageID == "" {
		return nil
	}
	info := &waE2E.ContextInfo{
		StanzaID: proto.String(quoted.MessageID),
		// The quoted content itself is optional and deliberately omitted: it is
		// what the recipient's client renders in the little grey box, and this
		// transport does not hold the original message's body. WhatsApp resolves
		// the quote from the id, so an absent copy costs a preview, never the
		// link between the two messages.
		QuotedMessage: &waE2E.Message{Conversation: proto.String("")},
	}
	if quoted.Sender != "" {
		info.Participant = proto.String(quoted.Sender)
	}
	return info
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
	// Self is the operator's own address. See handleSendSelf.
	Self() (types.JID, bool)
	Status(ctx context.Context) (session.Status, error)
	Connect(ctx context.Context) error
	PairPhone(ctx context.Context, phone string) (string, error)
	BeginQRPairing(ctx context.Context) (<-chan whatsmeow.QRChannelItem, error)
	Contacts(ctx context.Context) (map[types.JID]types.ContactInfo, error)
	Groups(ctx context.Context) ([]types.GroupInfo, error)
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
	mux.Handle("POST /send/media", a.authed(a.handleSendMedia))
	mux.Handle("POST /send/reaction", a.authed(a.handleSendReaction))
	mux.Handle("POST /send/revoke", a.authed(a.handleSendRevoke))
	mux.Handle("POST /send/edit", a.authed(a.handleSendEdit))
	mux.Handle("POST /send/poll", a.authed(a.handleSendPoll))
	mux.Handle("POST /send/poll/vote", a.authed(a.handleSendPollVote))
	mux.Handle("POST /presence", a.authed(a.handlePresence))
	mux.Handle("POST /send/self", a.authed(a.handleSendSelf))
	mux.Handle("POST /send/self/media", a.authed(a.handleSendSelfMedia))
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
//
// ── Why groups are in the same roster as people ─────────────────────────────
// Because the bridge resolves ONE typed name against this response before
// sending. While the roster held only people, a group was not merely
// unaddressable — a two-character group name like "We" prefix-matched a person
// and the message went to them instead. Listing groups here is what makes a
// group name resolvable to the group, and the bridge's requested-vs-resolved
// check is what makes a near-miss refuse. Both are required; neither suffices.
func (a *API) handleContacts(w http.ResponseWriter, r *http.Request) {
	contacts, err := a.cfg.Session.Contacts(r.Context())
	if err != nil {
		writeError(w, statusForPairing(err), err.Error())
		return
	}

	// ── One row per PERSON, not per address ─────────────────────────────────
	// whatsmeow's store is keyed by JID and one person routinely holds two —
	// their phone JID and their LID — which resolve to the same identity key.
	// Emitted as two rows, the bridge's resolver refuses them as ambiguous and
	// the contact becomes unaddressable: on this account that was 108 people of
	// 479, including the operator. They are not two candidates to choose
	// between; they are one person seen twice.
	byKey := make(map[string]map[string]any, len(contacts))
	order := make([]string, 0, len(contacts))

	for jid, info := range contacts {
		id, err := a.cfg.Resolver.Resolve(r.Context(), jid)
		if err != nil {
			continue // unusable address; nothing to key a contact on
		}

		existing, seen := byKey[id.Key]
		if !seen {
			byKey[id.Key] = map[string]any{
				"key":          id.Key,
				"kind":         id.Kind,
				"provisional":  id.Provisional,
				"pushName":     info.PushName,
				"fullName":     info.FullName,
				"businessName": info.BusinessName,
			}
			order = append(order, id.Key)
			continue
		}

		// Merge rather than overwrite: the two rows carry different fields as
		// often as not — the phone-JID row is frequently the only one with a push
		// name — and taking whichever arrived last would drop a name at random,
		// leaving a key nothing can address by name.
		for field, value := range map[string]string{
			"pushName": info.PushName, "fullName": info.FullName, "businessName": info.BusinessName,
		} {
			if value != "" && existing[field] == "" {
				existing[field] = value
			}
		}
		// A resolved LID beats a provisional digest for the same person.
		if provisional, ok := existing["provisional"].(bool); ok && provisional && !id.Provisional {
			existing["provisional"] = false
		}
	}

	out := make([]map[string]any, 0, len(order))
	for _, key := range order {
		out = append(out, byKey[key])
	}

	body := map[string]any{}

	// Group subjects are a live IQ, not a store read, so they fail on their own
	// schedule. A failure here must not take the people down with it — but it
	// must not pass for "this account is in no groups" either, because the
	// bridge would then report a missing group exactly the way it reports a name
	// that never existed. The caller is told, and says so in its own error.
	groups, err := a.cfg.Session.Groups(r.Context())
	if err != nil {
		body["groupsUnavailable"] = err.Error()
	}
	for _, group := range groups {
		id, err := a.cfg.Resolver.Resolve(r.Context(), group.JID)
		if err != nil {
			continue
		}
		out = append(out, map[string]any{
			"key":         id.Key,
			"kind":        id.Kind,
			"provisional": id.Provisional,
			"subject":     group.Name,
		})
	}

	body["contacts"] = out
	body["count"] = len(out)
	writeJSON(w, http.StatusOK, body)
}

func (a *API) handleSend(w http.ResponseWriter, r *http.Request) {
	var body struct {
		To      string     `json:"to"`
		Message string     `json:"message"`
		Quoted  *quotedRef `json:"quoted"`
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

	// A quote cannot ride on `Conversation` — that arm carries no ContextInfo —
	// so a quoting send becomes an ExtendedTextMessage. Wrapping every send would
	// work too and is deliberately not done: a plain message should stay the
	// plain arm, which is what every other client emits for one.
	outgoing := &waE2E.Message{Conversation: proto.String(body.Message)}
	if context := contextFor(body.Quoted); context != nil {
		outgoing = &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text:        proto.String(body.Message),
			ContextInfo: context,
		}}
	}

	resp, err := a.cfg.Sender.SendMessage(r.Context(), to, outgoing)
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

// MaxSendMediaBytes bounds an inbound attachment.
//
// Both processes hold the bytes in memory — base64 in the request, plaintext for
// the upload, ciphertext after encryption — so an unbounded body is an
// out-of-memory kill of the transport, which would also stop RECEIVING messages.
const MaxSendMediaBytes = 16 << 20

// handleSendMedia uploads an attachment and sends it as an image.
//
// ── Why the guard runs before the upload ────────────────────────────────────
// Uploading first would put the operator's picture on WhatsApp's CDN before
// discovering the recipient was never permitted. The bytes would be encrypted
// and unreferenced, but they would be THERE, uploaded from this account, because
// a check ran in the wrong order. So the JID is parsed and permitted first, and
// only then does anything leave the process.
func (a *API) handleSendMedia(w http.ResponseWriter, r *http.Request) {
	var body mediaRequest
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Decoded and bounded BEFORE the recipient is resolved, and the recipient is
	// permitted before anything is uploaded. Uploading first would put the
	// operator's picture on WhatsApp's CDN on behalf of someone who was never
	// allowed to receive it — encrypted and unreferenced, but uploaded from this
	// account because a check ran in the wrong order.
	data, ok := a.decodeAttachment(w, body)
	if !ok {
		return
	}

	to, err := types.ParseJID(body.To)
	if err != nil {
		writeError(w, http.StatusBadRequest, "to must be a JID")
		return
	}
	if err := a.cfg.Guard.Permit(r.Context(), to); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}

	a.uploadAndSendImage(w, r, to, body, data)
}

// mediaRequest is the body both attachment routes take. `To` is ignored by the
// self route, which addresses the operator's own account instead.
type mediaRequest struct {
	To string `json:"to"`
	// Kind selects the protobuf arm: image, video, audio, voice, document or
	// sticker. Empty means image, which is what the route did before it could
	// carry anything else.
	Kind            string `json:"kind"`
	Mimetype        string `json:"mimetype"`
	Caption         string `json:"caption"`
	Filename        string `json:"filename"`
	Data            string `json:"dataBase64"`
	Width           uint32 `json:"width"`
	Height          uint32 `json:"height"`
	DurationSeconds uint32     `json:"durationSeconds"`
	Quoted          *quotedRef `json:"quoted"`
}

// mediaKinds maps this API's vocabulary onto whatsmeow's upload types.
//
// The upload type is not cosmetic: it selects the key derivation WhatsApp uses
// for that media class, so uploading a video as MediaImage produces bytes the
// recipient's client decrypts to nothing.
var mediaKinds = map[string]whatsmeow.MediaType{
	"image":    whatsmeow.MediaImage,
	"video":    whatsmeow.MediaVideo,
	"audio":    whatsmeow.MediaAudio,
	"voice":    whatsmeow.MediaAudio,
	"document": whatsmeow.MediaDocument,
	"sticker":  whatsmeow.MediaImage,
}

// buildMediaMessage puts the upload into the arm that matches the kind.
//
// One function rather than a branch at each call site, because the pairing of
// upload type to protobuf arm is the entire contract of a media send: a video in
// an ImageMessage is a bubble that never renders, and nothing downstream would
// report it.
func buildMediaMessage(kind string, body mediaRequest, upload whatsmeow.UploadResponse) *waE2E.Message {
	// Applied at the end, to whichever arm was built: every media type carries
	// ContextInfo in the same field, so setting it once is what keeps a quoted
	// video from being the one kind that loses its reply.
	quoted := contextFor(body.Quoted)
	caption := func() *string {
		if body.Caption == "" {
			return nil
		}
		return proto.String(body.Caption)
	}
	seconds := func() *uint32 {
		if body.DurationSeconds == 0 {
			return nil
		}
		return proto.Uint32(body.DurationSeconds)
	}

	switch kind {
	case "video":
		return &waE2E.Message{VideoMessage: &waE2E.VideoMessage{
			ContextInfo: quoted,
			Caption: caption(), Seconds: seconds(),
			Mimetype: proto.String(body.Mimetype), URL: &upload.URL, DirectPath: &upload.DirectPath,
			MediaKey: upload.MediaKey, FileEncSHA256: upload.FileEncSHA256,
			FileSHA256: upload.FileSHA256, FileLength: &upload.FileLength,
		}}

	case "audio", "voice":
		return &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
			ContextInfo: quoted,
			// PTT is the whole difference between somebody speaking and a file
			// somebody attached, and only the first renders as a voice note.
			PTT: proto.Bool(kind == "voice"), Seconds: seconds(),
			Mimetype: proto.String(body.Mimetype), URL: &upload.URL, DirectPath: &upload.DirectPath,
			MediaKey: upload.MediaKey, FileEncSHA256: upload.FileEncSHA256,
			FileSHA256: upload.FileSHA256, FileLength: &upload.FileLength,
		}}

	case "document":
		return &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
			ContextInfo: quoted,
			Caption: caption(), FileName: proto.String(body.Filename),
			Mimetype: proto.String(body.Mimetype), URL: &upload.URL, DirectPath: &upload.DirectPath,
			MediaKey: upload.MediaKey, FileEncSHA256: upload.FileEncSHA256,
			FileSHA256: upload.FileSHA256, FileLength: &upload.FileLength,
		}}

	case "sticker":
		return &waE2E.Message{StickerMessage: &waE2E.StickerMessage{
			ContextInfo: quoted,
			Mimetype: proto.String(body.Mimetype), URL: &upload.URL, DirectPath: &upload.DirectPath,
			MediaKey: upload.MediaKey, FileEncSHA256: upload.FileEncSHA256,
			FileSHA256: upload.FileSHA256, FileLength: &upload.FileLength,
		}}
	}

	image := &waE2E.ImageMessage{
		Caption:  caption(),
		Mimetype: proto.String(body.Mimetype), URL: &upload.URL, DirectPath: &upload.DirectPath,
		MediaKey: upload.MediaKey, FileEncSHA256: upload.FileEncSHA256,
		FileSHA256: upload.FileSHA256, FileLength: &upload.FileLength,
	}
	image.ContextInfo = quoted
	// Dimensions let a client lay the bubble out before the bytes arrive. Omitted
	// rather than guessed when the caller does not know them.
	if body.Width > 0 && body.Height > 0 {
		image.Width, image.Height = proto.Uint32(body.Width), proto.Uint32(body.Height)
	}
	return &waE2E.Message{ImageMessage: image}
}

// decodeAttachment validates a media body and returns its bytes.
//
// Shared by both attachment routes so that the type restriction and the size
// ceiling cannot drift apart: a limit enforced on one path and not the other is
// the same class of hole as an allowlist checked in one place of two.
//
// Writes its own error response and returns ok=false, because every failure here
// is a 4xx with a specific explanation and collapsing them would lose it.
func (a *API) decodeAttachment(w http.ResponseWriter, body mediaRequest) ([]byte, bool) {
	if body.Data == "" {
		writeError(w, http.StatusBadRequest, "dataBase64 is required")
		return nil, false
	}
	kind := body.Kind
	if kind == "" {
		kind = "image"
	}
	if _, known := mediaKinds[kind]; !known {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("kind %q is not one this transport can build — use image, video, audio, "+
				"voice, document or sticker", body.Kind))
		return nil, false
	}
	// WhatsApp renders a fixed set of IMAGE types, and SVG is not among them:
	// accepting one would send an attachment that every recipient's client shows
	// as broken. The rule belongs to the image kinds and to nothing else — a PDF
	// is not an image, and applying it globally is what made documents
	// unsendable.
	if (kind == "image" || kind == "sticker") &&
		body.Mimetype != "image/jpeg" && body.Mimetype != "image/png" &&
		body.Mimetype != "image/webp" {
		writeError(w, http.StatusBadRequest,
			"an image or sticker must be image/jpeg, image/png or image/webp — "+
				"WhatsApp renders no other image type")
		return nil, false
	}
	if body.Mimetype == "" {
		writeError(w, http.StatusBadRequest, "mimetype is required")
		return nil, false
	}

	data, err := base64.StdEncoding.DecodeString(body.Data)
	if err != nil {
		writeError(w, http.StatusBadRequest, "dataBase64 is not valid base64")
		return nil, false
	}
	if len(data) == 0 {
		writeError(w, http.StatusBadRequest, "dataBase64 decoded to nothing")
		return nil, false
	}
	if len(data) > MaxSendMediaBytes {
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("attachment is %d bytes; the limit is %d", len(data), MaxSendMediaBytes))
		return nil, false
	}
	return data, true
}

// uploadAndSendImage performs the two calls that make an image send, in order.
//
// The upload's response fields ARE the addressing of the message that follows,
// so they are copied here rather than at each call site: a route that forgot one
// would send a bubble no recipient can decrypt.
func (a *API) uploadAndSendImage(
	w http.ResponseWriter, r *http.Request, to types.JID, body mediaRequest, data []byte,
) {
	if a.cfg.Sender == nil {
		writeError(w, http.StatusServiceUnavailable, "not connected")
		return
	}

	kind := body.Kind
	if kind == "" {
		kind = "image"
	}

	upload, err := a.cfg.Sender.Upload(r.Context(), data, mediaKinds[kind])
	if err != nil {
		if errors.Is(err, whatsmeow.ErrNotLoggedIn) || errors.Is(err, session.ErrNotPaired) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusBadGateway, "uploading the attachment: "+err.Error())
		return
	}

	resp, err := a.cfg.Sender.SendMessage(r.Context(), to, buildMediaMessage(kind, body, upload))
	if err != nil {
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
		"bytes":  len(data),
	})
}

// handleSendSelfMedia sends an attachment to the operator's own chat.
//
// No allowlist, for the reason the text self route gives: there is exactly one
// possible recipient and it is the operator. A gate here would protect them from
// themselves. The type and size checks still apply — those are about what
// WhatsApp can render and what this process can hold, not about who may be
// written to.
func (a *API) handleSendSelfMedia(w http.ResponseWriter, r *http.Request) {
	var body mediaRequest
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	data, ok := a.decodeAttachment(w, body)
	if !ok {
		return
	}

	self, found := a.cfg.Session.Self()
	if !found {
		writeError(w, http.StatusConflict, session.ErrNotPaired.Error())
		return
	}

	a.uploadAndSendImage(w, r, self, body, data)
}

// targetRequest addresses an EXISTING message: a reaction, an edit, a deletion.
type targetRequest struct {
	To        string `json:"to"`
	MessageID string `json:"messageId"`
	// Sender is who wrote the message being acted on. Empty means the operator,
	// which is the only correct default: you may edit and revoke your own
	// messages, and the common reaction is to your own chat partner's — the
	// caller says so explicitly when it is not you.
	Sender string `json:"sender"`
	Emoji  string `json:"emoji"`
	Text   string `json:"message"`
}

// resolveTarget parses and permits a message-directed request.
//
// The allowlist runs here for the same reason it runs on `/send`: a reaction,
// an edit and a deletion are all things the operator's account DOES to someone
// else's conversation. A gate on plain messages alone would be no gate at all.
func (a *API) resolveTarget(
	w http.ResponseWriter, r *http.Request, body targetRequest,
) (chat types.JID, sender types.JID, ok bool) {
	if body.MessageID == "" {
		writeError(w, http.StatusBadRequest, "messageId is required")
		return chat, sender, false
	}

	chat, err := types.ParseJID(body.To)
	if err != nil {
		writeError(w, http.StatusBadRequest, "to must be a JID")
		return chat, sender, false
	}
	if err := a.cfg.Guard.Permit(r.Context(), chat); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return chat, sender, false
	}

	if body.Sender != "" {
		sender, err = types.ParseJID(body.Sender)
		if err != nil {
			writeError(w, http.StatusBadRequest, "sender must be a JID")
			return chat, sender, false
		}
	} else if self, found := a.cfg.Session.Self(); found {
		sender = self
	}

	if a.cfg.Sender == nil {
		writeError(w, http.StatusServiceUnavailable, "not connected")
		return chat, sender, false
	}
	return chat, sender, true
}

// dispatch sends an already-built message and answers with its id.
func (a *API) dispatch(w http.ResponseWriter, r *http.Request, to types.JID, msg *waE2E.Message) {
	resp, err := a.cfg.Sender.SendMessage(r.Context(), to, msg)
	if err != nil {
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

// handleSendReaction reacts to a message, or removes a reaction.
//
// An EMPTY emoji is not a missing field — it is how WhatsApp expresses "take my
// reaction off". Rejecting it as absent would make an applied reaction
// impossible to undo through this API.
func (a *API) handleSendReaction(w http.ResponseWriter, r *http.Request) {
	var body targetRequest
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	chat, sender, ok := a.resolveTarget(w, r, body)
	if !ok {
		return
	}
	a.dispatch(w, r, chat, a.cfg.Sender.BuildReaction(chat, sender, body.MessageID, body.Emoji))
}

// handleSendRevoke deletes a message for everyone.
func (a *API) handleSendRevoke(w http.ResponseWriter, r *http.Request) {
	var body targetRequest
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	chat, sender, ok := a.resolveTarget(w, r, body)
	if !ok {
		return
	}
	a.dispatch(w, r, chat, a.cfg.Sender.BuildRevoke(chat, sender, body.MessageID))
}

// handleSendEdit replaces the text of a message already sent.
func (a *API) handleSendEdit(w http.ResponseWriter, r *http.Request) {
	var body targetRequest
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Text == "" {
		writeError(w, http.StatusBadRequest,
			"message is required — an edit to nothing is a deletion, which is /send/revoke")
		return
	}
	chat, _, ok := a.resolveTarget(w, r, body)
	if !ok {
		return
	}

	edited := &waE2E.Message{Conversation: proto.String(body.Text)}
	a.dispatch(w, r, chat, a.cfg.Sender.BuildEdit(chat, body.MessageID, edited))
}

// handleSendPoll asks a question with fixed answers.
func (a *API) handleSendPoll(w http.ResponseWriter, r *http.Request) {
	var body struct {
		To              string   `json:"to"`
		Name            string   `json:"name"`
		Options         []string `json:"options"`
		SelectableCount int      `json:"selectableCount"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required — a poll needs a question")
		return
	}
	// One option is not a choice, and WhatsApp renders it as a dead end.
	if len(body.Options) < 2 {
		writeError(w, http.StatusBadRequest, "a poll needs at least two options")
		return
	}

	to, err := types.ParseJID(body.To)
	if err != nil {
		writeError(w, http.StatusBadRequest, "to must be a JID")
		return
	}
	if err := a.cfg.Guard.Permit(r.Context(), to); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	if a.cfg.Sender == nil {
		writeError(w, http.StatusServiceUnavailable, "not connected")
		return
	}

	a.dispatch(w, r, to,
		a.cfg.Sender.BuildPollCreation(body.Name, body.Options, body.SelectableCount))
}

// handleSendPollVote votes in a poll somebody else asked.
//
// ── Why this needs no state of ours ─────────────────────────────────────────
// A vote is not a message about a poll, it is a payload ENCRYPTED against that
// poll's message secret — which whatsmeow stored when the poll arrived, keyed by
// chat, sender and id. So naming the poll is enough, and a poll this account
// never received has no secret and fails here rather than arriving as a vote
// that every recipient decrypts to nothing.
func (a *API) handleSendPollVote(w http.ResponseWriter, r *http.Request) {
	var body struct {
		To        string   `json:"to"`
		MessageID string   `json:"messageId"`
		Sender    string   `json:"sender"`
		Options   []string `json:"options"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.MessageID == "" {
		writeError(w, http.StatusBadRequest, "messageId is required — a vote names the poll")
		return
	}
	if len(body.Options) == 0 {
		writeError(w, http.StatusBadRequest,
			"options is required — an empty vote is how a vote is WITHDRAWN, "+
				"which this route does not yet express")
		return
	}

	chat, sender, ok := a.resolveTarget(w, r, targetRequest{
		To: body.To, MessageID: body.MessageID, Sender: body.Sender,
	})
	if !ok {
		return
	}

	vote, err := a.cfg.Sender.BuildPollVote(r.Context(), &types.MessageInfo{
		MessageSource: types.MessageSource{Chat: chat, Sender: sender},
		ID:            body.MessageID,
	}, body.Options)
	if err != nil {
		// 422 rather than 502: the request was well-formed and the transport is
		// fine — it is the named poll that cannot be voted in, which is the
		// caller's to correct.
		writeError(w, http.StatusUnprocessableEntity,
			"this poll cannot be voted in: "+err.Error()+
				". A vote is encrypted against the poll's own secret, which exists only for "+
				"polls this account actually received.")
		return
	}

	a.dispatch(w, r, chat, vote)
}

// handlePresence shows or clears the typing indicator in a chat.
//
// Gated by the allowlist like any send: "typing…" is a signal this account emits
// into somebody's conversation, and an ungated version could show a stranger a
// typing indicator indefinitely.
func (a *API) handlePresence(w http.ResponseWriter, r *http.Request) {
	var body struct {
		To    string `json:"to"`
		State string `json:"state"`
		Media string `json:"media"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Only the two states WhatsApp defines. Anything else would be sent as a
	// stanza tag the server does not know.
	var state types.ChatPresence
	switch body.State {
	case string(types.ChatPresenceComposing):
		state = types.ChatPresenceComposing
	case string(types.ChatPresencePaused):
		state = types.ChatPresencePaused
	default:
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("state must be %q or %q", types.ChatPresenceComposing, types.ChatPresencePaused))
		return
	}

	to, err := types.ParseJID(body.To)
	if err != nil {
		writeError(w, http.StatusBadRequest, "to must be a JID")
		return
	}
	if err := a.cfg.Guard.Permit(r.Context(), to); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	if a.cfg.Sender == nil {
		writeError(w, http.StatusServiceUnavailable, "not connected")
		return
	}

	media := types.ChatPresenceMediaText
	if body.Media == string(types.ChatPresenceMediaAudio) {
		media = types.ChatPresenceMediaAudio
	}

	if err := a.cfg.Sender.SendChatPresence(r.Context(), to, state, media); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"state": string(state)})
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

// handleSendSelf writes a note to the operator's own chat.
//
// ── Why this is a separate route, and why it skips the send guard ───────────
// `POST /send` takes a JID and refuses any recipient not on the allowlist. That
// guard exists because the failure it prevents is messaging the WRONG PERSON as
// the operator. A self-note has no wrong person: the recipient is the account
// itself, resolved here from the device store rather than accepted from the
// caller, so there is no input that could redirect it. Putting the operator on
// their own send allowlist to enable it would weaken the allowlist's meaning —
// it would then contain an entry that is not a correspondent.
//
// The bearer token still applies, as it does to every route but /health. What
// this route grants an attacker holding that token is the ability to write to
// the operator's own chat, which is strictly less than `/send` already grants.
//
// The operator's number is never in the response: the JID is used to address
// the message and then dropped. See Session.Self.
func (a *API) handleSendSelf(w http.ResponseWriter, r *http.Request) {
	var body struct {
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

	self, ok := a.cfg.Session.Self()
	if !ok {
		writeError(w, http.StatusConflict, session.ErrNotPaired.Error())
		return
	}
	if a.cfg.Sender == nil {
		writeError(w, http.StatusServiceUnavailable, "not connected")
		return
	}

	resp, err := a.cfg.Sender.SendMessage(r.Context(), self,
		&waE2E.Message{Conversation: proto.String(body.Message)})
	if err != nil {
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
