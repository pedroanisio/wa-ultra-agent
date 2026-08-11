package outbox

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/event"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/identity"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/translate"
)

func open(t *testing.T, opts ...Option) *Outbox {
	t.Helper()
	// A file rather than :memory:, because durability across reopen is one of
	// the properties under test and an in-memory database cannot show it.
	path := filepath.Join(t.TempDir(), "transport.db")
	box, err := Open(context.Background(), path, opts...)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = box.Close() })
	return box
}

func message(key, text string) event.Message {
	return event.Message{
		Key:        key,
		Chat:       identity.Identity{Key: "99887766554433@lid", Kind: identity.KindPerson},
		Sender:     identity.Identity{Key: "99887766554433@lid", Kind: identity.KindPerson},
		Kind:       translate.KindText,
		Text:       text,
		SentAt:     time.Date(2026, 8, 11, 14, 30, 0, 0, time.UTC),
		Recognised: true,
	}
}

func appendAll(t *testing.T, box *Outbox, keys ...string) {
	t.Helper()
	for _, key := range keys {
		if err := box.Append(context.Background(), message(key, "body of "+key)); err != nil {
			t.Fatalf("Append(%s): %v", key, err)
		}
	}
}

func keysOf(entries []Entry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		var msg event.Message
		if err := json.Unmarshal(e.Payload, &msg); err == nil {
			out = append(out, msg.Key)
		}
	}
	return out
}

func TestPendingReturnsMessagesInArrivalOrder(t *testing.T) {
	box := open(t)
	appendAll(t, box, "A", "B", "C")

	entries, err := box.Pending(context.Background(), 10)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}

	got := strings.Join(keysOf(entries), ",")
	if got != "A,B,C" {
		t.Fatalf("order = %q, want %q", got, "A,B,C")
	}
	// Sequence numbers must be strictly increasing: they are what an ack cites,
	// so a repeat or a gap in the wrong direction would ack the wrong message.
	for i := 1; i < len(entries); i++ {
		if entries[i].Seq <= entries[i-1].Seq {
			t.Fatalf("sequence not increasing: %d then %d", entries[i-1].Seq, entries[i].Seq)
		}
	}
}

func TestAckRemovesOnlyWhatWasAcknowledged(t *testing.T) {
	box := open(t)
	appendAll(t, box, "A", "B", "C")

	entries, _ := box.Pending(context.Background(), 10)
	removed, err := box.Ack(context.Background(), entries[1].Seq)
	if err != nil {
		t.Fatalf("Ack: %v", err)
	}
	if removed != 2 {
		t.Fatalf("removed = %d, want 2", removed)
	}

	rest, _ := box.Pending(context.Background(), 10)
	if got := strings.Join(keysOf(rest), ","); got != "C" {
		t.Fatalf("remaining = %q, want %q", got, "C")
	}
}

// The consumer may crash between receiving and acking, then re-ack on restart.
// A second ack of the same sequence must be a no-op rather than an error, or
// recovery would need to distinguish "already done" from "failed".
func TestAckIsIdempotent(t *testing.T) {
	box := open(t)
	appendAll(t, box, "A", "B")

	entries, _ := box.Pending(context.Background(), 10)
	last := entries[len(entries)-1].Seq

	if _, err := box.Ack(context.Background(), last); err != nil {
		t.Fatalf("first Ack: %v", err)
	}
	removed, err := box.Ack(context.Background(), last)
	if err != nil {
		t.Fatalf("second Ack: %v", err)
	}
	if removed != 0 {
		t.Fatalf("second ack removed %d rows, want 0", removed)
	}
}

func TestPendingRespectsTheLimit(t *testing.T) {
	box := open(t)
	appendAll(t, box, "A", "B", "C", "D")

	entries, err := box.Pending(context.Background(), 2)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("returned %d entries, want 2", len(entries))
	}
	if got := strings.Join(keysOf(entries), ","); got != "A,B" {
		t.Fatalf("got %q, want the two oldest %q", got, "A,B")
	}
}

// ── Why the queue is bounded, and why the loss is counted ───────────────────
//
// An unbounded outbox is a disk-space failure waiting for the archive to be down
// for a week. A silently truncating one is worse: it loses correspondence and
// reads afterwards as a quiet period, which is the failure mode this project
// refuses everywhere else.
//
// So the cap drops the OLDEST entries and counts every drop. Oldest rather than
// newest because the older a message is, the more likely on-demand history sync
// can still retrieve it from the phone — and the count is what turns an
// unrecoverable silence into a reported gap the agent must disclose.
func TestFullOutboxDropsOldestAndCountsIt(t *testing.T) {
	box := open(t, WithCapacity(3))
	appendAll(t, box, "A", "B", "C", "D", "E")

	entries, err := box.Pending(context.Background(), 10)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if got := strings.Join(keysOf(entries), ","); got != "C,D,E" {
		t.Fatalf("kept %q, want the three newest %q", got, "C,D,E")
	}

	stats, err := box.Stats(context.Background())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.Dropped != 2 {
		t.Fatalf("Dropped = %d, want 2", stats.Dropped)
	}
	if stats.Depth != 3 {
		t.Fatalf("Depth = %d, want 3", stats.Depth)
	}
}

// The drop counter is the record of a gap in someone's correspondence. Losing it
// on restart would turn a reported gap back into a silent one.
func TestDropCountSurvivesReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "transport.db")

	first, err := Open(context.Background(), path, WithCapacity(1))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	appendAll(t, first, "A", "B", "C")
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second, err := Open(context.Background(), path, WithCapacity(1))
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer second.Close()

	stats, err := second.Stats(context.Background())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.Dropped != 2 {
		t.Fatalf("Dropped after reopen = %d, want 2", stats.Dropped)
	}
}

// The whole reason the outbox exists: the archive can be down, restarting or
// mid-deploy, and messages that arrived meanwhile must still be there.
func TestQueuedMessagesSurviveReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "transport.db")

	first, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	appendAll(t, first, "A", "B")
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer second.Close()

	entries, err := second.Pending(context.Background(), 10)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if got := strings.Join(keysOf(entries), ","); got != "A,B" {
		t.Fatalf("after reopen got %q, want %q", got, "A,B")
	}
}

func TestPayloadRoundTripsTheMessage(t *testing.T) {
	box := open(t)
	original := message("3EB0ABCDEF", "chego às 15h")
	original.Kind = translate.KindVoice
	seconds := 222
	original.DurationSeconds = &seconds

	if err := box.Append(context.Background(), original); err != nil {
		t.Fatalf("Append: %v", err)
	}

	entries, _ := box.Pending(context.Background(), 1)
	var decoded event.Message
	if err := json.Unmarshal(entries[0].Payload, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if decoded.Key != original.Key || decoded.Text != original.Text {
		t.Fatalf("round trip lost content: %+v", decoded)
	}
	if decoded.Kind != translate.KindVoice {
		t.Fatalf("kind = %q, want voice", decoded.Kind)
	}
	if decoded.DurationSeconds == nil || *decoded.DurationSeconds != 222 {
		t.Fatalf("durationSeconds = %v, want 222", decoded.DurationSeconds)
	}
	if !decoded.SentAt.Equal(original.SentAt) {
		t.Fatalf("sentAt = %v, want %v", decoded.SentAt, original.SentAt)
	}
}

// A capacity of zero would mean "drop everything on arrival", which is a
// configuration mistake that must not be readable as "unbounded".
func TestNonPositiveCapacityIsRefused(t *testing.T) {
	for _, capacity := range []int64{0, -1} {
		if _, err := Open(context.Background(),
			filepath.Join(t.TempDir(), "x.db"), WithCapacity(capacity)); err == nil {
			t.Fatalf("Open accepted a capacity of %d", capacity)
		}
	}
}

func TestUnopenablePathIsReported(t *testing.T) {
	// A directory is not a database, and the failure must name the path rather
	// than surface later as an inexplicable query error.
	dir := t.TempDir()
	if _, err := Open(context.Background(), dir); err == nil {
		t.Fatal("Open succeeded against a directory")
	}
}

func TestNonPositiveLimitReturnsNothing(t *testing.T) {
	box := open(t)
	appendAll(t, box, "A")

	for _, limit := range []int{0, -5} {
		entries, err := box.Pending(context.Background(), limit)
		if err != nil {
			t.Fatalf("Pending(%d): %v", limit, err)
		}
		if len(entries) != 0 {
			t.Fatalf("Pending(%d) returned %d entries", limit, len(entries))
		}
	}
}

// Shutdown races a message arriving. Every operation must report the closure
// rather than panic, because the alternative is a crash on the way down that
// looks like a transport bug.
func TestOperationsAfterCloseReportAnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "transport.db")
	box, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	appendAll(t, box, "A")
	if err := box.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	ctx := context.Background()
	if err := box.Append(ctx, message("B", "after close")); err == nil {
		t.Error("Append succeeded after Close")
	}
	if _, err := box.Pending(ctx, 10); err == nil {
		t.Error("Pending succeeded after Close")
	}
	if _, err := box.Ack(ctx, 1); err == nil {
		t.Error("Ack succeeded after Close")
	}
	if _, err := box.Stats(ctx); err == nil {
		t.Error("Stats succeeded after Close")
	}
}

func TestEmptyOutboxIsNotAnError(t *testing.T) {
	box := open(t)

	entries, err := box.Pending(context.Background(), 10)
	if err != nil {
		t.Fatalf("Pending on an empty outbox: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("returned %d entries from an empty outbox", len(entries))
	}

	stats, err := box.Stats(context.Background())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.Depth != 0 || stats.Dropped != 0 {
		t.Fatalf("stats on an empty outbox = %+v", stats)
	}
}
