package mediastore

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

func open(t *testing.T, opts ...Option) *Store {
	t.Helper()
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "media.db"), opts...)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// A voice note carrying everything Download needs: the CDN path, the key that
// decrypts it and the integrity hashes.
func voiceNote(path string) *waE2E.Message {
	return &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
		DirectPath:    proto.String(path),
		MediaKey:      []byte("media-key-32-bytes-placeholder!!"),
		FileSHA256:    []byte("file-sha"),
		FileEncSHA256: []byte("file-enc-sha"),
		Mimetype:      proto.String("audio/ogg; codecs=opus"),
		Seconds:       proto.Uint32(222),
		PTT:           proto.Bool(true),
	}}
}

func TestStoredMessageRoundTripsWithTheFieldsDownloadNeeds(t *testing.T) {
	s := open(t)
	ctx := context.Background()

	if err := s.Put(ctx, "3EB0AAA", "audio/ogg; codecs=opus", "", voiceNote("/v/abc")); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := s.Get(ctx, "3EB0AAA")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	audio := got.Message.GetAudioMessage()
	if audio == nil {
		t.Fatal("the stored message lost its audio arm")
	}
	// These four are exactly whatsmeow's DownloadableMessage interface. Losing
	// any of them makes the media unfetchable, and the loss would only surface
	// when somebody tried to play a voice note.
	if audio.GetDirectPath() != "/v/abc" {
		t.Errorf("DirectPath = %q", audio.GetDirectPath())
	}
	if string(audio.GetMediaKey()) != "media-key-32-bytes-placeholder!!" {
		t.Errorf("MediaKey did not survive")
	}
	if string(audio.GetFileSHA256()) != "file-sha" {
		t.Errorf("FileSHA256 did not survive")
	}
	if string(audio.GetFileEncSHA256()) != "file-enc-sha" {
		t.Errorf("FileEncSHA256 did not survive")
	}
	if got.Mimetype != "audio/ogg; codecs=opus" {
		t.Errorf("Mimetype = %q", got.Mimetype)
	}
}

func TestUnknownMessageIsDistinguishableFromAFailure(t *testing.T) {
	s := open(t)

	_, err := s.Get(context.Background(), "3EB0NEVER")
	if !errors.Is(err, ErrNotStored) {
		t.Fatalf("error = %v, want ErrNotStored", err)
	}
}

// History sync redelivers messages that already arrived live. Storing the same
// id twice must replace the row, not fail on the primary key and abandon the
// rest of the batch.
func TestPutIsIdempotentOnMessageID(t *testing.T) {
	s := open(t)
	ctx := context.Background()

	if err := s.Put(ctx, "3EB0AAA", "audio/ogg", "", voiceNote("/v/first")); err != nil {
		t.Fatalf("first Put: %v", err)
	}
	if err := s.Put(ctx, "3EB0AAA", "audio/ogg", "", voiceNote("/v/second")); err != nil {
		t.Fatalf("second Put: %v", err)
	}

	count, err := s.Count(ctx)
	if err != nil {
		t.Fatalf("Count: %v", err)
	}
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}

	got, err := s.Get(ctx, "3EB0AAA")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if path := got.Message.GetAudioMessage().GetDirectPath(); path != "/v/second" {
		t.Fatalf("DirectPath = %q, want the later value", path)
	}
}

func TestDocumentFilenameIsRecorded(t *testing.T) {
	s := open(t)
	ctx := context.Background()

	doc := &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
		DirectPath: proto.String("/d/xyz"),
		FileName:   proto.String("boleto agosto.pdf"),
	}}
	if err := s.Put(ctx, "3EB0DOC", "application/pdf", "boleto agosto.pdf", doc); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := s.Get(ctx, "3EB0DOC")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	// Recorded alongside the payload so the download response can name the file
	// without unmarshalling and re-inspecting the protobuf arm.
	if got.Filename != "boleto agosto.pdf" {
		t.Fatalf("Filename = %q", got.Filename)
	}
}

func TestCapacityEvictsTheOldestFirst(t *testing.T) {
	s := open(t, WithCapacity(3))
	ctx := context.Background()

	for _, id := range []string{"A", "B", "C", "D", "E"} {
		if err := s.Put(ctx, id, "audio/ogg", "", voiceNote("/v/"+id)); err != nil {
			t.Fatalf("Put(%s): %v", id, err)
		}
	}

	count, _ := s.Count(ctx)
	if count != 3 {
		t.Fatalf("count = %d, want 3", count)
	}
	for _, gone := range []string{"A", "B"} {
		if _, err := s.Get(ctx, gone); !errors.Is(err, ErrNotStored) {
			t.Errorf("%s should have been evicted", gone)
		}
	}
	for _, kept := range []string{"C", "D", "E"} {
		if _, err := s.Get(ctx, kept); err != nil {
			t.Errorf("%s should have been kept: %v", kept, err)
		}
	}
}

// Re-storing an existing id refreshes its position, so a message that keeps
// arriving is not evicted while messages that arrived after it survive.
func TestReStoringRefreshesEvictionOrder(t *testing.T) {
	s := open(t, WithCapacity(2))
	ctx := context.Background()

	_ = s.Put(ctx, "A", "audio/ogg", "", voiceNote("/v/A"))
	_ = s.Put(ctx, "B", "audio/ogg", "", voiceNote("/v/B"))
	_ = s.Put(ctx, "A", "audio/ogg", "", voiceNote("/v/A2")) // A moves to newest
	_ = s.Put(ctx, "C", "audio/ogg", "", voiceNote("/v/C"))  // evicts B, not A

	if _, err := s.Get(ctx, "B"); !errors.Is(err, ErrNotStored) {
		t.Error("B should have been evicted")
	}
	if _, err := s.Get(ctx, "A"); err != nil {
		t.Errorf("A was refreshed and should have survived: %v", err)
	}
}

func TestStoredMediaSurvivesReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "media.db")
	ctx := context.Background()

	first, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := first.Put(ctx, "3EB0AAA", "audio/ogg", "", voiceNote("/v/abc")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer second.Close()

	got, err := second.Get(ctx, "3EB0AAA")
	if err != nil {
		t.Fatalf("Get after reopen: %v", err)
	}
	if got.Message.GetAudioMessage().GetDirectPath() != "/v/abc" {
		t.Fatal("the stored message did not survive reopen")
	}
}

func TestPutRejectsIncompleteInput(t *testing.T) {
	s := open(t)
	ctx := context.Background()

	if err := s.Put(ctx, "", "audio/ogg", "", voiceNote("/v/a")); err == nil {
		t.Error("Put accepted an empty message id")
	}
	if err := s.Put(ctx, "3EB0AAA", "audio/ogg", "", nil); err == nil {
		t.Error("Put accepted a nil message")
	}
}

func TestNonPositiveCapacityIsRefused(t *testing.T) {
	for _, capacity := range []int64{0, -1} {
		if _, err := Open(context.Background(),
			filepath.Join(t.TempDir(), "m.db"), WithCapacity(capacity)); err == nil {
			t.Errorf("Open accepted capacity %d", capacity)
		}
	}
}

func TestOperationsAfterCloseReportAnError(t *testing.T) {
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "media.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	ctx := context.Background()
	if err := s.Put(ctx, "A", "audio/ogg", "", voiceNote("/v/a")); err == nil {
		t.Error("Put succeeded after Close")
	}
	if _, err := s.Get(ctx, "A"); err == nil {
		t.Error("Get succeeded after Close")
	}
	if _, err := s.Count(ctx); err == nil {
		t.Error("Count succeeded after Close")
	}
}
