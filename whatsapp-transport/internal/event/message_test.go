package event

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/identity"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/translate"
)

const (
	testPhone = "15550001111"
	testLID   = "99887766554433"
	testGroup = "120363000000000000"
)

// The resolver needs no LID store: every fixture carries both address forms the
// way a real message does, which is the path `ResolvePair` exists for.
func resolver() *identity.Resolver { return identity.NewResolver(nil) }

func sentAt() time.Time { return time.Date(2026, 8, 11, 14, 30, 0, 0, time.UTC) }

func groupTextMessage() *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:      types.NewJID(testGroup, types.GroupServer),
				Sender:    types.NewJID(testLID, types.HiddenUserServer),
				SenderAlt: types.NewJID(testPhone, types.DefaultUserServer),
				IsGroup:   true,
			},
			ID:        "3EB0A1B2C3D4E5F60718",
			PushName:  "Pim",
			Timestamp: sentAt(),
		},
		Message: &waE2E.Message{Conversation: proto.String("chego às 15h")},
	}
}

func TestFromMessageCarriesTheArchiveRow(t *testing.T) {
	got, err := FromMessage(context.Background(), resolver(), groupTextMessage())
	if err != nil {
		t.Fatalf("FromMessage: %v", err)
	}

	// The key is the protocol's own message id, unqualified. It must not embed
	// the chat or sender key: those are LID-derived and a provisional one is
	// re-keyed when the LID arrives, which would rewrite every message key and
	// break the provenance foreign keys that cite them.
	if got.Key != "3EB0A1B2C3D4E5F60718" {
		t.Fatalf("key = %q, want the bare message id", got.Key)
	}
	if got.Chat.Kind != identity.KindGroup {
		t.Fatalf("chat kind = %q, want group", got.Chat.Kind)
	}
	if got.Sender.Key != types.NewJID(testLID, types.HiddenUserServer).String() {
		t.Fatalf("sender key = %q, want the LID", got.Sender.Key)
	}
	if got.Sender.Provisional {
		t.Fatal("a sender carrying both address forms was marked provisional")
	}
	if got.PushName != "Pim" {
		t.Fatalf("pushName = %q, want %q", got.PushName, "Pim")
	}
	if got.Kind != translate.KindText || got.Text != "chego às 15h" {
		t.Fatalf("got %s/%q, want text/%q", got.Kind, got.Text, "chego às 15h")
	}
	if got.Outgoing {
		t.Fatal("an incoming message was marked outgoing")
	}
	if !got.SentAt.Equal(sentAt()) {
		t.Fatalf("sentAt = %v, want %v", got.SentAt, sentAt())
	}
	if got.FromHistory {
		t.Fatal("a live message was marked as coming from history sync")
	}
}

// ── Which alternative address belongs to the chat ───────────────────────────
//
// whatsmeow populates `RecipientAlt` only on outgoing messages, where the
// recipient IS the chat partner. On an incoming direct message it is empty and
// the partner's other address form is in `SenderAlt` instead — because for an
// incoming DM the chat and the sender are the same person.
//
// Reading the wrong one is quiet rather than loud: the chat still resolves, just
// provisionally, so every incoming DM would open a second chat row keyed by
// phone number beside the LID-keyed one. Both directions are tested because
// only their asymmetry makes the bug possible.
func TestIncomingDirectMessageResolvesTheChatFromSenderAlt(t *testing.T) {
	msg := groupTextMessage()
	msg.Info.IsGroup = false
	msg.Info.Chat = types.NewJID(testPhone, types.DefaultUserServer)
	msg.Info.Sender = types.NewJID(testPhone, types.DefaultUserServer)
	msg.Info.SenderAlt = types.NewJID(testLID, types.HiddenUserServer)
	msg.Info.RecipientAlt = types.EmptyJID

	got, err := FromMessage(context.Background(), resolver(), msg)
	if err != nil {
		t.Fatalf("FromMessage: %v", err)
	}

	want := types.NewJID(testLID, types.HiddenUserServer).String()
	if got.Chat.Key != want {
		t.Fatalf("chat key = %q, want the LID %q", got.Chat.Key, want)
	}
	if got.Chat.Provisional {
		t.Fatal("an incoming DM produced a provisional chat despite SenderAlt carrying the LID")
	}
}

func TestOutgoingDirectMessageResolvesTheChatFromRecipientAlt(t *testing.T) {
	msg := groupTextMessage()
	msg.Info.IsGroup = false
	msg.Info.IsFromMe = true
	msg.Info.Chat = types.NewJID(testPhone, types.DefaultUserServer)
	// Sender is the operator's own account, and its alt is the operator's other
	// form — pairing that with the chat would key the conversation on the wrong
	// person entirely.
	msg.Info.Sender = types.NewJID("15559998888", types.DefaultUserServer)
	msg.Info.SenderAlt = types.NewJID("11112222333344", types.HiddenUserServer)
	msg.Info.RecipientAlt = types.NewJID(testLID, types.HiddenUserServer)

	got, err := FromMessage(context.Background(), resolver(), msg)
	if err != nil {
		t.Fatalf("FromMessage: %v", err)
	}

	want := types.NewJID(testLID, types.HiddenUserServer).String()
	if got.Chat.Key != want {
		t.Fatalf("chat key = %q, want the recipient's LID %q", got.Chat.Key, want)
	}
}

// A group's identity never comes from an alternative address: the group JID is
// already the durable form, and a participant's alt must not leak into it.
func TestGroupChatIgnoresAlternativeAddresses(t *testing.T) {
	msg := groupTextMessage()
	msg.Info.RecipientAlt = types.NewJID("77778888999900", types.HiddenUserServer)

	got, err := FromMessage(context.Background(), resolver(), msg)
	if err != nil {
		t.Fatalf("FromMessage: %v", err)
	}

	want := types.NewJID(testGroup, types.GroupServer).String()
	if got.Chat.Key != want {
		t.Fatalf("chat key = %q, want the group JID %q", got.Chat.Key, want)
	}
}

func TestOutgoingMessagesAreMarked(t *testing.T) {
	msg := groupTextMessage()
	msg.Info.IsFromMe = true

	got, err := FromMessage(context.Background(), resolver(), msg)
	if err != nil {
		t.Fatalf("FromMessage: %v", err)
	}
	if !got.Outgoing {
		t.Fatal("IsFromMe did not produce an outgoing row")
	}
}

func TestMediaDetailSurvivesTranslation(t *testing.T) {
	msg := groupTextMessage()
	msg.Message = &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
		PTT:      proto.Bool(true),
		Seconds:  proto.Uint32(222),
		Mimetype: proto.String("audio/ogg; codecs=opus"),
	}}

	got, err := FromMessage(context.Background(), resolver(), msg)
	if err != nil {
		t.Fatalf("FromMessage: %v", err)
	}

	if got.Kind != translate.KindVoice {
		t.Fatalf("kind = %q, want voice", got.Kind)
	}
	if got.DurationSeconds == nil || *got.DurationSeconds != 222 {
		t.Fatalf("durationSeconds = %v, want 222", got.DurationSeconds)
	}
	if got.Mimetype != "audio/ogg; codecs=opus" {
		t.Fatalf("mimetype = %q", got.Mimetype)
	}
	// A voice note has no text of its own. Rendering `[voice note · 3:42]` is
	// the archive's job — see the note on placeholders in internal/translate.
	if got.Text != "" {
		t.Fatalf("text = %q, want empty for media", got.Text)
	}
}

// History-sync messages arrive parsed from a WebMessageInfo rather than off the
// socket. The archive needs the distinction to account for what it has covered:
// a backfilled window and a live arrival are different evidence about a chat.
func TestHistorySyncMessagesAreMarked(t *testing.T) {
	msg := groupTextMessage()
	msg.SourceWebMsg = &waWeb.WebMessageInfo{}

	got, err := FromMessage(context.Background(), resolver(), msg)
	if err != nil {
		t.Fatalf("FromMessage: %v", err)
	}
	if !got.FromHistory {
		t.Fatal("a message parsed from a WebMessageInfo was not marked as history")
	}
}

// Totality carried end to end: `translate` degrades an unmapped arm to
// `unknown`, and the event layer must still produce a storable row rather than
// deciding on its own that an undescribable message is not worth keeping.
func TestUnrecognisedMessagesStillProduceAnEvent(t *testing.T) {
	msg := groupTextMessage()
	// Payments are a described kind now, so this fixture moved to an arm the
	// archive genuinely has no vocabulary for.
	msg.Message = &waE2E.Message{
		BotPlatformRegistrationSuccessMessage: &waE2E.FutureProofMessage{},
	}

	got, err := FromMessage(context.Background(), resolver(), msg)
	if err != nil {
		t.Fatalf("FromMessage refused an unrecognised message: %v", err)
	}
	if got.Kind != translate.KindUnknown {
		t.Fatalf("kind = %q, want unknown", got.Kind)
	}
	if got.Recognised {
		t.Fatal("an unmapped arm was reported as recognised")
	}
	if got.Key == "" {
		t.Fatal("an unrecognised message produced no key and could not be stored")
	}
}

func TestMessageWithoutAnIDIsRejected(t *testing.T) {
	msg := groupTextMessage()
	msg.Info.ID = ""

	if _, err := FromMessage(context.Background(), resolver(), msg); err == nil {
		t.Fatal("a message with no id resolved; every row would collide on the empty key")
	}
}

func TestMessageWithoutAChatIsRejected(t *testing.T) {
	msg := groupTextMessage()
	msg.Info.Chat = types.EmptyJID

	if _, err := FromMessage(context.Background(), resolver(), msg); err == nil {
		t.Fatal("a message with no chat resolved; it would be unattributable")
	}
}

// ── The property that matters most ──────────────────────────────────────────
//
// This is the struct that crosses the process boundary, so it is the one whose
// serialisation actually decides whether phone numbers enter the archive. The
// containment in `internal/identity` is what makes this pass; this test is what
// proves the containment survives being embedded in something else.
func TestEncodedEventNeverCarriesAPhoneNumber(t *testing.T) {
	got, err := FromMessage(context.Background(), resolver(), groupTextMessage())
	if err != nil {
		t.Fatalf("FromMessage: %v", err)
	}

	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(encoded), testPhone) {
		t.Fatalf("the phone number reached the wire: %s", encoded)
	}
	// The number must still be reachable deliberately, or the transport could
	// never answer "what is this person's number?" when the operator asks.
	if number, ok := got.Sender.PhoneNumber(); !ok || number != testPhone {
		t.Fatalf("PhoneNumber() = %q,%v; the number should be retained, just not serialised", number, ok)
	}
}

// The archive stores `sent_at_iso` and sorts on it, so the wire format has to be
// the one `Date` and SQLite's string comparison both agree on.
func TestTimestampIsEncodedAsRFC3339(t *testing.T) {
	got, err := FromMessage(context.Background(), resolver(), groupTextMessage())
	if err != nil {
		t.Fatalf("FromMessage: %v", err)
	}

	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(encoded), `"sentAt":"2026-08-11T14:30:00Z"`) {
		t.Fatalf("sentAt is not RFC3339 in the payload: %s", encoded)
	}
}
