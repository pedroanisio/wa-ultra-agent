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
func (k Kind) HasMedia() bool {
	switch k {
	case KindVoice, KindAudio, KindImage, KindVideo, KindGIF, KindSticker, KindDocument:
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

	// Recognised is false when no arm matched, which is the difference between
	// "this is a message with no describable content" and "this is a message
	// shape we have never seen". Both store as `unknown`; only the second is a
	// reason to look at the protocol again.
	Recognised bool
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

	case msg.GetProtocolMessage() != nil:
		return protocolContent(msg.GetProtocolMessage())
	}

	return Content{Kind: KindUnknown}
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
