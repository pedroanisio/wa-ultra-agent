// Package translate is the Anti-Corruption Layer between WhatsApp's protocol
// vocabulary and this project's archive model.
//
// SPEC §3.5 names the pattern for the DOM transport — `selectors.js`,
// `message-kind.js` and `history.js` on one side, `{key, kind, outgoing,
// sent_at_iso}` on the other. This package is the same layer for the protocol
// transport, and it exists for the same reason: WhatsApp's vocabulary changes
// on WhatsApp's schedule, and it must break in one place rather than five.
//
// What changes versus the DOM layer is the reliability of the input, not the
// need for the boundary. `message-kind.js` guesses a kind from rendered labels
// in English and Portuguese, so its rules are heuristics that decay as the UI
// is retranslated. Here the input is a typed protobuf and classification is a
// total function over a closed set — but the set is closed by WhatsApp, not by
// us, so an unrecognised arm is a routine event rather than a bug.
//
// This package deliberately does not render placeholder text. That belongs to
// `placeholderText` in `message-kind.js`, and duplicating it here would put two
// copies of one semantic claim in two languages, which is the drift that
// `store.js` argues against for `OWED_BY_USER_TYPES`.
package translate

import (
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// Kind is the archive's closed vocabulary for what a message turned out to be.
//
// Held identical to `LABEL` in `whatsapp-bridge/src/message-kind.js` plus
// `text`, and `TestKindVocabularyMatchesArchive` fails when the two disagree.
type Kind string

const (
	KindText     Kind = "text"
	KindVoice    Kind = "voice"
	KindAudio    Kind = "audio"
	KindImage    Kind = "image"
	KindVideo    Kind = "video"
	KindGIF      Kind = "gif"
	KindSticker  Kind = "sticker"
	KindDocument Kind = "document"
	KindLocation Kind = "location"
	KindContact  Kind = "contact"
	KindPoll     Kind = "poll"
	KindDeleted  Kind = "deleted"
	KindSystem   Kind = "system"
	KindUnknown  Kind = "unknown"

	// ── Added after the coverage audit ──────────────────────────────────────
	// Every one of these was arriving as `unknown`, which is how the archive
	// accumulated 446 messages it could not describe. They are ordinary traffic
	// on a personal account, not protocol exotica.
	KindReaction    Kind = "reaction"
	KindVideoNote   Kind = "video_note"
	KindAlbum       Kind = "album"
	KindPollVote    Kind = "poll_vote"
	KindEvent       Kind = "event"
	KindPinned      Kind = "pinned"
	KindKept        Kind = "kept"
	KindGroupInvite Kind = "group_invite"
	KindComment     Kind = "comment"
	KindCallLog     Kind = "call_log"

	// Two families rather than a kind per arm. WhatsApp ships a dozen shapes for
	// "a business sent you a structured thing" and another eight for payments,
	// and an archive that named each one would carry twenty kinds no query
	// distinguishes. The family is what a reader needs; the arm is recoverable
	// from the protocol if it ever matters.
	KindBusiness Kind = "business"
	KindPayment  Kind = "payment"
)

// AllKinds returns every kind this package can emit.
//
// Exported for the drift test rather than for callers: a vocabulary that can
// only be enumerated by reading the source is one a test cannot check.
func AllKinds() []Kind {
	return []Kind{
		KindText, KindVoice, KindAudio, KindImage, KindVideo, KindGIF, KindSticker,
		KindDocument, KindLocation, KindContact, KindPoll, KindDeleted, KindSystem,
		KindUnknown,
		KindReaction, KindVideoNote, KindAlbum, KindPollVote, KindEvent, KindPinned,
		KindKept, KindGroupInvite, KindComment, KindCallLog, KindBusiness, KindPayment,
	}
}

// HasMedia reports whether a kind has bytes that can be fetched later.
//
// Kept beside the vocabulary rather than at the call site because it is a claim
// ABOUT the vocabulary: adding a kind without deciding this question is how a new
// media type ends up permanently undownloadable, with nothing to indicate why.
//
// Location and contact are excluded deliberately — they carry structured data
// inline, not an encrypted blob on a media server, so there is nothing to fetch.
// An album carries no bytes of its own — it is a header whose children are the
// images — so it is excluded despite being visually a media message.
func (k Kind) HasMedia() bool {
	switch k {
	case KindVoice, KindAudio, KindImage, KindVideo, KindGIF, KindSticker, KindDocument,
		KindVideoNote:
		return true
	default:
		return false
	}
}

// Content is what a message turned out to be, in the archive's terms.
//
// Media detail stays structured — `DurationSeconds`, `Filename`, `Caption` as
// separate fields rather than pre-rendered into `Text` — because the archive
// stores those columns separately and renders the placeholder itself.
type Content struct {
	Kind Kind

	// Text is the readable body, and is empty for everything that has none.
	// A media message carries its human-readable stand-in nowhere in this
	// struct; the archive builds it from the fields below.
	Text    string
	Caption string

	Filename        string
	Mimetype        string
	DurationSeconds *int

	// TargetKey is the message this one is ABOUT: what a reaction was aimed at,
	// which poll was voted in, what was pinned. Without it a reaction stores as
	// "somebody reacted to something", which no query can use.
	TargetKey string

	// Recognised is false when no arm matched, which is the difference between
	// "this is a message with no describable content" and "this is a message
	// shape we have never seen". Both store as `unknown`; only the second is a
	// reason to look at the protocol again.
	Recognised bool

	// UnknownType names the protobuf arm that was set when nothing matched, and
	// is empty otherwise. It turns "446 unrecognised" — a number nobody can act
	// on — into a ranked list of what to implement next.
	UnknownType string
}

// Classify maps one decrypted message onto the archive vocabulary.
//
// Total by construction: every return path sets a Kind, and the default is
// `unknown` rather than a dropped message. whatsmeow has already unwrapped the
// ephemeral, view-once, device-sent and edit envelopes by the time an
// `events.Message` is emitted, so this sees real content.
//
// Order matters where arms overlap. Text is checked first because it is the
// common case; `DocumentWithCaptionMessage` is unwrapped upstream into
// `DocumentMessage`, so it needs no arm here.
func Classify(msg *waE2E.Message) Content {
	if msg == nil {
		return Content{Kind: KindUnknown}
	}

	switch {
	case msg.GetConversation() != "":
		return Content{Kind: KindText, Text: msg.GetConversation(), Recognised: true}

	case msg.GetExtendedTextMessage() != nil:
		return Content{
			Kind:       KindText,
			Text:       msg.GetExtendedTextMessage().GetText(),
			Recognised: true,
		}

	case msg.GetAudioMessage() != nil:
		audio := msg.GetAudioMessage()
		// PTT is the whole difference between somebody speaking and a file
		// somebody attached, and only the first is worth transcribing.
		kind := KindAudio
		if audio.GetPTT() {
			kind = KindVoice
		}
		return Content{
			Kind:            kind,
			Mimetype:        audio.GetMimetype(),
			DurationSeconds: seconds(audio.GetSeconds()),
			Recognised:      true,
		}

	case msg.GetImageMessage() != nil:
		image := msg.GetImageMessage()
		return Content{
			Kind:       KindImage,
			Caption:    image.GetCaption(),
			Mimetype:   image.GetMimetype(),
			Recognised: true,
		}

	case msg.GetVideoMessage() != nil:
		video := msg.GetVideoMessage()
		kind := KindVideo
		if video.GetGifPlayback() {
			kind = KindGIF
		}
		return Content{
			Kind:            kind,
			Caption:         video.GetCaption(),
			Mimetype:        video.GetMimetype(),
			DurationSeconds: seconds(video.GetSeconds()),
			Recognised:      true,
		}

	case msg.GetDocumentMessage() != nil:
		document := msg.GetDocumentMessage()
		return Content{
			Kind:       KindDocument,
			Caption:    document.GetCaption(),
			Filename:   document.GetFileName(),
			Mimetype:   document.GetMimetype(),
			Recognised: true,
		}

	case msg.GetStickerMessage() != nil:
		return Content{
			Kind:       KindSticker,
			Mimetype:   msg.GetStickerMessage().GetMimetype(),
			Recognised: true,
		}

	case msg.GetLocationMessage() != nil, msg.GetLiveLocationMessage() != nil:
		return Content{Kind: KindLocation, Recognised: true}

	case msg.GetContactMessage() != nil, msg.GetContactsArrayMessage() != nil:
		return Content{Kind: KindContact, Recognised: true}

	// Six versions of one concept, and WhatsApp keeps adding them. Listed
	// exhaustively rather than matched by name so that a seventh arrives as
	// `unknown` — visible — instead of being guessed at.
	case msg.GetPollCreationMessage() != nil,
		msg.GetPollCreationMessageV2() != nil,
		msg.GetPollCreationMessageV3() != nil,
		msg.GetPollCreationMessageV4() != nil,
		msg.GetPollCreationMessageV5() != nil,
		msg.GetPollCreationMessageV6() != nil:
		return Content{Kind: KindPoll, Recognised: true}

	case msg.GetReactionMessage() != nil:
		reaction := msg.GetReactionMessage()
		return Content{
			Kind:       KindReaction,
			Text:       reaction.GetText(),
			TargetKey:  reaction.GetKey().GetID(),
			Recognised: true,
		}

	// The emoji is inside an encrypted payload this package has no key for, so
	// the reaction is recorded without it. That is a smaller loss than dropping
	// the row: "she reacted to this" is most of the meaning.
	case msg.GetEncReactionMessage() != nil:
		return Content{
			Kind:       KindReaction,
			TargetKey:  msg.GetEncReactionMessage().GetTargetMessageKey().GetID(),
			Recognised: true,
		}

	// A round video note. Same VideoMessage shape as a normal video, on a
	// different arm — so it needs its own case or it lands as unknown, which is
	// exactly what was happening.
	case msg.GetPtvMessage() != nil:
		ptv := msg.GetPtvMessage()
		return Content{
			Kind:            KindVideoNote,
			Mimetype:        ptv.GetMimetype(),
			DurationSeconds: seconds(ptv.GetSeconds()),
			Recognised:      true,
		}

	case msg.GetAlbumMessage() != nil:
		return Content{Kind: KindAlbum, Recognised: true}

	case msg.GetPollUpdateMessage() != nil:
		return Content{
			Kind:       KindPollVote,
			TargetKey:  msg.GetPollUpdateMessage().GetPollCreationMessageKey().GetID(),
			Recognised: true,
		}

	case msg.GetEventMessage() != nil,
		msg.GetEventInviteMessage() != nil,
		msg.GetEncEventResponseMessage() != nil:
		return Content{Kind: KindEvent, Recognised: true}

	case msg.GetPinInChatMessage() != nil:
		return Content{
			Kind:       KindPinned,
			TargetKey:  msg.GetPinInChatMessage().GetKey().GetID(),
			Recognised: true,
		}

	case msg.GetKeepInChatMessage() != nil:
		return Content{
			Kind:       KindKept,
			TargetKey:  msg.GetKeepInChatMessage().GetKey().GetID(),
			Recognised: true,
		}

	case msg.GetGroupInviteMessage() != nil:
		return Content{
			Kind:       KindGroupInvite,
			Text:       msg.GetGroupInviteMessage().GetCaption(),
			Recognised: true,
		}

	case msg.GetCommentMessage() != nil, msg.GetEncCommentMessage() != nil:
		return Content{Kind: KindComment, Recognised: true}

	// whatsmeow spells the field with three s's. Matching their typo is the only
	// way to read the field; it is not one of ours.
	case msg.GetCallLogMesssage() != nil:
		return Content{Kind: KindCallLog, Recognised: true}

	case msg.GetTemplateMessage() != nil,
		msg.GetTemplateButtonReplyMessage() != nil,
		msg.GetHighlyStructuredMessage() != nil,
		msg.GetButtonsMessage() != nil,
		msg.GetButtonsResponseMessage() != nil,
		msg.GetListMessage() != nil,
		msg.GetListResponseMessage() != nil,
		msg.GetInteractiveMessage() != nil,
		msg.GetInteractiveResponseMessage() != nil,
		msg.GetProductMessage() != nil,
		msg.GetOrderMessage() != nil,
		msg.GetInvoiceMessage() != nil:
		return Content{Kind: KindBusiness, Recognised: true}

	case msg.GetSendPaymentMessage() != nil,
		msg.GetRequestPaymentMessage() != nil,
		msg.GetDeclinePaymentRequestMessage() != nil,
		msg.GetCancelPaymentRequestMessage() != nil,
		msg.GetPaymentInviteMessage() != nil:
		return Content{Kind: KindPayment, Recognised: true}

	case msg.GetProtocolMessage() != nil:
		return protocolContent(msg.GetProtocolMessage())
	}

	return Content{Kind: KindUnknown, UnknownType: populatedField(msg)}
}

// populatedField names the arm that was set, by reflection over the protobuf.
//
// ── Why reflection rather than a list ───────────────────────────────────────
// The point of naming an unrecognised arm is to learn about types this code does
// NOT know. A hardcoded list can only name types somebody already thought of,
// which is the blind spot the bare counter already had — 446 unrecognised
// messages and no way to ask what they were.
//
// Reflection inverts that: a message type invented after this code was written
// still reports its own field name, and the operator gets a ranked list instead
// of a number.
func populatedField(msg *waE2E.Message) string {
	if msg == nil {
		return ""
	}

	name := ""
	msg.ProtoReflect().Range(func(field protoreflect.FieldDescriptor, _ protoreflect.Value) bool {
		// Context and secret-distribution ride along on messages of every kind,
		// so naming one of them would mislabel half the stream.
		switch field.TextName() {
		case "messageContextInfo", "senderKeyDistributionMessage":
			return true // keep looking
		}
		name = field.TextName()
		return false // first real arm wins
	})
	return name
}

// protocolContent handles the control arm.
//
// Only revocation is a message in the archive's sense — somebody deleted
// something, and that is a fact about the conversation worth keeping. The rest
// (key requests, app-state sync, ephemeral settings) are machinery between
// devices, and storing them would put rows in the archive that no human ever
// sent.
func protocolContent(protocol *waE2E.ProtocolMessage) Content {
	if protocol.GetType() == waE2E.ProtocolMessage_REVOKE {
		return Content{Kind: KindDeleted, Recognised: true}
	}
	return Content{Kind: KindSystem, Recognised: true}
}

// seconds converts a protobuf duration to a pointer, treating absent and zero
// alike: a zero-length voice note is a protocol artefact, not a fact worth
// storing, and `[voice note · 0:00]` reads as a bug to anyone who sees it.
func seconds(value uint32) *int {
	if value == 0 {
		return nil
	}
	out := int(value)
	return &out
}
