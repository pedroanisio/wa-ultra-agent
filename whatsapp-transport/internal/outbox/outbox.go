// Package outbox is the durable hand-off between this transport and the archive.
//
// ── Why a queue exists at all ───────────────────────────────────────────────
// Messages arrive on a socket whenever WhatsApp decides, and whatsmeow
// acknowledges them to the server as it decrypts them. The archive, meanwhile,
// is a separate process that restarts on deploy. Without something durable in
// between, every message that lands while the archive is down is acknowledged to
// WhatsApp and then dropped on the floor — and because it was acknowledged,
// WhatsApp will never send it again.
//
// On-demand history sync can sometimes recover such a gap, but only from the
// operator's phone and only for what the phone still holds. That makes it a
// mitigation, not a guarantee, which is why the hand-off is written down.
//
// ── Why this is not the archive's database ──────────────────────────────────
// `store.js` is the archive's only writer, deliberately, and this package is not
// going to be its second one. The transport keeps its own file: whatsmeow's
// session tables and this queue on one side, the operator's correspondence on
// the other. Each store then has exactly one writer, which is the property that
// makes both safe without cross-process locking.
package outbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	// Pure-Go SQLite: no CGO, so the transport cross-compiles and the container
	// needs no build toolchain. Registers itself as "sqlite".
	_ "modernc.org/sqlite"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/event"
)

// DefaultCapacity bounds the queue.
//
// Sized so that a normal personal message rate can survive an archive outage of
// days rather than minutes, while still being far short of a disk-space problem
// — each row is a small JSON object.
const DefaultCapacity = 50_000

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS outbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  payload     TEXT NOT NULL,
  enqueued_at TEXT NOT NULL
);

-- One row, holding counters that must outlive both a restart and the rows they
-- describe. A dropped message is a gap in somebody's correspondence: if the
-- count of drops did not survive a restart, the gap would become unreportable,
-- which is precisely the silent failure the cap exists to avoid.
CREATE TABLE IF NOT EXISTS outbox_meta (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  dropped INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO outbox_meta (id, dropped) VALUES (1, 0);
`

// Entry is one queued message together with the sequence an ack cites.
type Entry struct {
	Seq     int64           `json:"seq"`
	Payload json.RawMessage `json:"payload"`
}

// Stats is what the transport reports about its own backlog.
//
// `Dropped` is cumulative and never resets. It is the only record that a gap
// exists, and SPEC §5.8 requires the agent to state what it does not have rather
// than let an absence read as a quiet period.
type Stats struct {
	Depth   int64 `json:"depth"`
	Dropped int64 `json:"dropped"`
}

type Outbox struct {
	db       *sql.DB
	capacity int64
}

type Option func(*Outbox)

// WithCapacity overrides DefaultCapacity. A capacity of zero or less is refused
// by Open rather than silently treated as unbounded.
func WithCapacity(n int64) Option {
	return func(o *Outbox) { o.capacity = n }
}

// Open prepares the transport's own database at `path`, creating it if needed.
func Open(ctx context.Context, path string, opts ...Option) (*Outbox, error) {
	box := &Outbox{capacity: DefaultCapacity}
	for _, opt := range opts {
		opt(box)
	}
	if box.capacity <= 0 {
		return nil, errors.New("outbox: capacity must be positive")
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("outbox: opening %s: %w", path, err)
	}
	// One writer, so a single connection removes SQLITE_BUSY entirely rather
	// than managing it. Readers are the same process and are serialised here.
	db.SetMaxOpenConns(1)

	if _, err := db.ExecContext(ctx, schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("outbox: preparing schema: %w", err)
	}

	box.db = db
	return box, nil
}

func (o *Outbox) Close() error { return o.db.Close() }

// Append queues one message, evicting the oldest entries if the queue is full.
//
// The insert and any eviction happen in one transaction, so the queue is never
// observed over capacity and a drop is never counted without having happened.
func (o *Outbox) Append(ctx context.Context, msg event.Message) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("outbox: encoding message %s: %w", msg.Key, err)
	}

	tx, err := o.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("outbox: begin: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		"INSERT INTO outbox (payload, enqueued_at) VALUES (?, ?)",
		string(payload), time.Now().UTC().Format(time.RFC3339Nano),
	); err != nil {
		return fmt.Errorf("outbox: enqueueing %s: %w", msg.Key, err)
	}

	if err := o.evict(ctx, tx); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("outbox: commit: %w", err)
	}
	return nil
}

// evict trims the queue to capacity, oldest first, and records how many were
// lost. Oldest rather than newest because the older a message is, the better the
// chance on-demand history sync can still fetch it from the phone.
func (o *Outbox) evict(ctx context.Context, tx *sql.Tx) error {
	var depth int64
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM outbox").Scan(&depth); err != nil {
		return fmt.Errorf("outbox: measuring depth: %w", err)
	}

	excess := depth - o.capacity
	if excess <= 0 {
		return nil
	}

	if _, err := tx.ExecContext(ctx,
		"DELETE FROM outbox WHERE seq IN (SELECT seq FROM outbox ORDER BY seq LIMIT ?)", excess,
	); err != nil {
		return fmt.Errorf("outbox: evicting %d entries: %w", excess, err)
	}
	if _, err := tx.ExecContext(ctx,
		"UPDATE outbox_meta SET dropped = dropped + ? WHERE id = 1", excess,
	); err != nil {
		return fmt.Errorf("outbox: recording %d drops: %w", excess, err)
	}
	return nil
}

// Pending returns up to `limit` of the oldest queued messages.
//
// Non-destructive: entries stay until acknowledged, so a consumer that dies
// mid-write loses nothing and simply sees them again.
func (o *Outbox) Pending(ctx context.Context, limit int) ([]Entry, error) {
	if limit <= 0 {
		return nil, nil
	}

	rows, err := o.db.QueryContext(ctx,
		"SELECT seq, payload FROM outbox ORDER BY seq LIMIT ?", limit)
	if err != nil {
		return nil, fmt.Errorf("outbox: reading queue: %w", err)
	}
	defer rows.Close()

	entries := make([]Entry, 0, limit)
	for rows.Next() {
		var (
			seq     int64
			payload string
		)
		if err := rows.Scan(&seq, &payload); err != nil {
			return nil, fmt.Errorf("outbox: scanning entry: %w", err)
		}
		entries = append(entries, Entry{Seq: seq, Payload: json.RawMessage(payload)})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("outbox: iterating queue: %w", err)
	}
	return entries, nil
}

// Ack discards every entry up to and including `through`, returning how many
// were removed.
//
// Idempotent, because the consumer may well have committed the messages to the
// archive and then died before the ack landed. A repeat ack removing nothing is
// the expected shape of that recovery, not an error to report.
func (o *Outbox) Ack(ctx context.Context, through int64) (int64, error) {
	result, err := o.db.ExecContext(ctx, "DELETE FROM outbox WHERE seq <= ?", through)
	if err != nil {
		return 0, fmt.Errorf("outbox: acknowledging through %d: %w", through, err)
	}
	removed, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("outbox: counting acknowledged entries: %w", err)
	}
	return removed, nil
}

// Stats reports the backlog and the cumulative loss.
func (o *Outbox) Stats(ctx context.Context) (Stats, error) {
	var stats Stats
	if err := o.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM outbox").Scan(&stats.Depth); err != nil {
		return Stats{}, fmt.Errorf("outbox: measuring depth: %w", err)
	}
	if err := o.db.QueryRowContext(ctx,
		"SELECT dropped FROM outbox_meta WHERE id = 1").Scan(&stats.Dropped); err != nil {
		return Stats{}, fmt.Errorf("outbox: reading drop count: %w", err)
	}
	return stats, nil
}
