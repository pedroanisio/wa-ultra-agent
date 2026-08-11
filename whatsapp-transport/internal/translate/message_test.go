package translate

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

func TestClassifyText(t *testing.T) {
	got := Classify(&waE2E.Message{Conversation: proto.String("bom dia")})

	if got.Kind != KindText {
		t.Fatalf("kind = %q, want %q", got.Kind, KindText)
	}
	if got.Text != "bom dia" {
		t.Fatalf("text = %q, want %q", got.Text, "bom dia")
	}
}

func TestClassifyExtendedText(t *testing.T) {
	got := Classify(&waE2E.Message{
		ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("com link")},
	})

	if got.Kind != KindText || got.Text != "com link" {
		t.Fatalf("got %+v, want text/%q", got, "com link")
	}
}

// A voice note and an audio file are the same protobuf arm distinguished only by
// PTT. The archive treats them as different kinds because one is somebody
// speaking and the other is a file, so the flag has to be read.
func TestClassifyVoiceVersusAudio(t *testing.T) {
	voice := Classify(&waE2E.Message{
		AudioMessage: &waE2E.AudioMessage{PTT: proto.Bool(true), Seconds: proto.Uint32(222)},
	})
	if voice.Kind != KindVoice {
		t.Fatalf("PTT audio classified as %q, want %q", voice.Kind, KindVoice)
	}
	if voice.DurationSeconds == nil || *voice.DurationSeconds != 222 {
		t.Fatalf("duration = %v, want 222", voice.DurationSeconds)
	}

	file := Classify(&waE2E.Message{
		AudioMessage: &waE2E.AudioMessage{PTT: proto.Bool(false), Seconds: proto.Uint32(10)},
	})
	if file.Kind != KindAudio {
		t.Fatalf("non-PTT audio classified as %q, want %q", file.Kind, KindAudio)
	}
}

func TestClassifyImageCarriesCaptionSeparately(t *testing.T) {
	got := Classify(&waE2E.Message{
		ImageMessage: &waE2E.ImageMessage{Caption: proto.String("olha isso")},
	})

	if got.Kind != KindImage {
		t.Fatalf("kind = %q, want %q", got.Kind, KindImage)
	}
	// Text stays empty: the caption is structured data, and rendering it into a
	// placeholder is the archive's job, not the transport's.
	if got.Text != "" {
		t.Fatalf("text = %q, want empty", got.Text)
	}
	if got.Caption != "olha isso" {
		t.Fatalf("caption = %q, want %q", got.Caption, "olha isso")
	}
}

func TestClassifyDocumentCarriesFilename(t *testing.T) {
	got := Classify(&waE2E.Message{
		DocumentMessage: &waE2E.DocumentMessage{FileName: proto.String("boleto agosto.pdf")},
	})

	if got.Kind != KindDocument || got.Filename != "boleto agosto.pdf" {
		t.Fatalf("got %+v, want document/%q", got, "boleto agosto.pdf")
	}
}

func TestClassifyGifIsVideoWithPlaybackFlag(t *testing.T) {
	gif := Classify(&waE2E.Message{
		VideoMessage: &waE2E.VideoMessage{GifPlayback: proto.Bool(true)},
	})
	if gif.Kind != KindGIF {
		t.Fatalf("kind = %q, want %q", gif.Kind, KindGIF)
	}

	video := Classify(&waE2E.Message{
		VideoMessage: &waE2E.VideoMessage{Seconds: proto.Uint32(30)},
	})
	if video.Kind != KindVideo {
		t.Fatalf("kind = %q, want %q", video.Kind, KindVideo)
	}
	if video.DurationSeconds == nil || *video.DurationSeconds != 30 {
		t.Fatalf("duration = %v, want 30", video.DurationSeconds)
	}
}

func TestClassifySimpleArms(t *testing.T) {
	cases := []struct {
		name string
		msg  *waE2E.Message
		want Kind
	}{
		{"sticker", &waE2E.Message{StickerMessage: &waE2E.StickerMessage{}}, KindSticker},
		{"location", &waE2E.Message{LocationMessage: &waE2E.LocationMessage{}}, KindLocation},
		{"live location", &waE2E.Message{LiveLocationMessage: &waE2E.LiveLocationMessage{}}, KindLocation},
		{"contact", &waE2E.Message{ContactMessage: &waE2E.ContactMessage{}}, KindContact},
		{"contact array", &waE2E.Message{ContactsArrayMessage: &waE2E.ContactsArrayMessage{}}, KindContact},
		{"poll", &waE2E.Message{PollCreationMessage: &waE2E.PollCreationMessage{}}, KindPoll},
		{"poll v3", &waE2E.Message{PollCreationMessageV3: &waE2E.PollCreationMessage{}}, KindPoll},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Classify(tc.msg); got.Kind != tc.want {
				t.Fatalf("kind = %q, want %q", got.Kind, tc.want)
			}
		})
	}
}

func TestClassifyRevocationIsDeleted(t *testing.T) {
	got := Classify(&waE2E.Message{
		ProtocolMessage: &waE2E.ProtocolMessage{
			Type: waE2E.ProtocolMessage_REVOKE.Enum(),
		},
	})

	if got.Kind != KindDeleted {
		t.Fatalf("kind = %q, want %q", got.Kind, KindDeleted)
	}
}

// ── The totality property ───────────────────────────────────────────────────
//
// PALS's law applied to a protocol rather than to an LLM: the set of message
// arms is WhatsApp's to change, not ours, and it grows without notice —
// PollCreationMessage already ships in six versions. An arm this code has never
// seen must degrade to `unknown` and still produce a row.
//
// The failure this forbids is silent disappearance. A dropped message is
// indistinguishable from a quiet chat, so the archive would be wrong in a way
// no query could reveal.
func TestClassifyUnmappedArmIsUnknownNotDropped(t *testing.T) {
	got := Classify(&waE2E.Message{
		// A real arm, deliberately not mapped: nothing in the archive
		// vocabulary describes a payment cancellation.
		CancelPaymentRequestMessage: &waE2E.CancelPaymentRequestMessage{},
	})

	if got.Kind != KindUnknown {
		t.Fatalf("kind = %q, want %q", got.Kind, KindUnknown)
	}
	// Recognised=false is what lets the bridge count and report how much of the
	// stream it cannot describe, rather than silently averaging it away.
	if got.Recognised {
		t.Fatal("Recognised = true for an unmapped arm; want false")
	}
}

func TestClassifyEmptyMessageIsUnknown(t *testing.T) {
	for _, tc := range []struct {
		name string
		msg  *waE2E.Message
	}{
		{"nil", nil},
		{"empty", &waE2E.Message{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Classify(tc.msg)
			if got.Kind != KindUnknown {
				t.Fatalf("kind = %q, want %q", got.Kind, KindUnknown)
			}
			if got.Recognised {
				t.Fatalf("Recognised = true for a %s message; want false", tc.name)
			}
		})
	}
}

// ── Cross-language drift ────────────────────────────────────────────────────
//
// The kind vocabulary now lives in two languages: here, and as `LABEL` in
// `whatsapp-bridge/src/message-kind.js`, which renders each kind into the
// placeholder the model reads. Two copies of a vocabulary drift, and the
// failure is quiet — Go emitting a kind the archive has no label for produces
// `[unrecognised attachment]` for a message it classified perfectly well.
//
// So the JS file is the source of truth and this test reads it. `text` is the
// one kind absent from LABEL by design: a text row carries real text and never
// needs a placeholder.
func TestKindVocabularyMatchesArchive(t *testing.T) {
	path, err := findArchiveVocabulary()
	if err != nil {
		// ── Why this skips rather than fails ────────────────────────────────
		// The Docker build context is this module alone, so the sibling
		// JavaScript package genuinely is not on disk there. Failing would make
		// a correct build impossible; passing would be a lie.
		//
		// Go reports a skip as SKIP, never as PASS, which is the distinction
		// that matters — the same one `no-real-identities.test.js` makes when it
		// has no configuration to check against. The guard still runs where a
		// developer changes the vocabulary: `go test ./...` in a checkout, and
		// `npm run transport:test` from the repository root.
		t.Skipf("NOT CHECKED: %v. This guard compares the Go vocabulary with LABEL in "+
			"whatsapp-bridge/src/message-kind.js and needs both in one checkout. It is "+
			"skipped, not satisfied.", err)
	}

	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the archive's vocabulary: %v", err)
	}

	block := regexp.MustCompile(`(?s)const LABEL = \{(.*?)\n\};`).FindSubmatch(source)
	if block == nil {
		t.Fatalf("no `const LABEL = {...}` block in %s; the vocabulary moved and this test "+
			"must be pointed at its new home rather than deleted", path)
	}

	fromJS := map[string]bool{"text": true}
	for _, m := range regexp.MustCompile(`(?m)^\s*(\w+):`).FindAllSubmatch(block[1], -1) {
		fromJS[string(m[1])] = true
	}

	fromGo := map[string]bool{}
	for _, k := range AllKinds() {
		fromGo[string(k)] = true
	}

	if len(fromJS) < 2 {
		t.Fatalf("parsed only %d kinds out of %s; the regex stopped matching", len(fromJS), path)
	}

	for k := range fromGo {
		if !fromJS[k] {
			t.Errorf("Go emits kind %q, which the archive cannot label", k)
		}
	}
	for k := range fromJS {
		if !fromGo[k] {
			t.Errorf("the archive labels kind %q, which Go can never emit", k)
		}
	}

	if t.Failed() {
		t.Logf("go=%v js=%v", sorted(fromGo), sorted(fromJS))
	}
}

// findArchiveVocabulary walks up from the test's directory looking for the
// JavaScript half of the vocabulary.
//
// Searched rather than hardcoded as `../../../` because that relative path is
// correct in a checkout and wrong everywhere else — including the container
// build, where it silently became "no such file" and failed the image build.
func findArchiveVocabulary() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}

	for i := 0; i < 6; i++ {
		candidate := filepath.Join(dir, "whatsapp-bridge", "src", "message-kind.js")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", errors.New("whatsapp-bridge/src/message-kind.js is not in any parent directory")
}

func sorted(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// HasMedia is a claim about the vocabulary, so it is asserted over the whole
// vocabulary rather than over the two kinds that happened to come to mind. A kind
// added without deciding this question would otherwise be silently
// undownloadable.
func TestHasMediaCoversEveryKind(t *testing.T) {
	withMedia := map[Kind]bool{
		KindVoice: true, KindAudio: true, KindImage: true, KindVideo: true,
		KindGIF: true, KindSticker: true, KindDocument: true,
	}

	for _, k := range AllKinds() {
		if got, want := k.HasMedia(), withMedia[k]; got != want {
			t.Errorf("%s.HasMedia() = %v, want %v", k, got, want)
		}
	}

	// Location, contact and poll carry structured data inline rather than an
	// encrypted blob, so there is nothing on a media server to fetch.
	for _, k := range []Kind{KindLocation, KindContact, KindPoll, KindText, KindDeleted, KindSystem} {
		if k.HasMedia() {
			t.Errorf("%s claims media it has no way to produce", k)
		}
	}
}
