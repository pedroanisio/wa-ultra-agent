package session

import (
	"encoding/json"
	"strings"
	"testing"
)

// ── Why a tally and not just a count ────────────────────────────────────────
//
// The bare `Unrecognised` counter reached 446 on a real archive without ever
// saying what those messages were. The number proves a gap exists and is useless
// for closing it: the only way to learn the types was to read the protobuf by
// hand and guess, which is how they went unimplemented for months.
//
// The tally is deliberately keyed by protocol field name, which carries no
// correspondence — no text, no sender, no id. That is what makes it safe to
// expose on `/status`, the most casually-read surface here.
func TestUnrecognisedTallyNamesTypesAndCounts(t *testing.T) {
	var c Counters

	c.NoteUnrecognised("reactionMessage")
	c.NoteUnrecognised("reactionMessage")
	c.NoteUnrecognised("ptvMessage")

	got := c.Snapshot()
	if got.Unrecognised != 3 {
		t.Fatalf("Unrecognised = %d, want 3", got.Unrecognised)
	}
	if got.UnrecognisedTypes["reactionMessage"] != 2 {
		t.Fatalf("reactionMessage = %d, want 2", got.UnrecognisedTypes["reactionMessage"])
	}
	if got.UnrecognisedTypes["ptvMessage"] != 1 {
		t.Fatalf("ptvMessage = %d, want 1", got.UnrecognisedTypes["ptvMessage"])
	}
}

// A message whose arm could not be named at all must still be counted, or the
// total and the tally disagree and neither can be trusted.
func TestUnrecognisedTallyCountsAnUnnameableArm(t *testing.T) {
	var c Counters
	c.NoteUnrecognised("")

	got := c.Snapshot()
	if got.Unrecognised != 1 {
		t.Fatalf("Unrecognised = %d, want 1", got.Unrecognised)
	}
	var total int64
	for _, n := range got.UnrecognisedTypes {
		total += n
	}
	if total != 1 {
		t.Fatalf("tally sums to %d but the counter says 1", total)
	}
}

// The snapshot is serialised into /status on every poll.
func TestUnrecognisedTallySerialises(t *testing.T) {
	var c Counters
	c.NoteUnrecognised("ptvMessage")

	data, err := json.Marshal(c.Snapshot())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(data), "ptvMessage") {
		t.Fatalf("the tally did not reach the wire: %s", data)
	}
}

// An empty tally must serialise as an object rather than null, so a consumer can
// read it without a nil check and an empty one is visibly empty.
func TestUnrecognisedTallyIsEmptyObjectNotNull(t *testing.T) {
	var c Counters
	data, err := json.Marshal(c.Snapshot())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(data), `"unrecognisedTypes":null`) {
		t.Fatalf("an empty tally serialised as null: %s", data)
	}
}
