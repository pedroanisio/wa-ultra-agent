// Package mediastore remembers how to fetch a message's media after the fact.
//
// ── Why anything is stored at all ───────────────────────────────────────────
// WhatsApp media is an encrypted blob on a CDN. Fetching it needs the direct
// path, the media key that decrypts it and the integrity hashes — all of which
// arrive once, inside the message, and are gone from memory the moment the event
// is handled. `GET /media?key=…` happens minutes or days later, when the agent
// decides a voice note is worth transcribing.
//
// So the message protobuf is kept, and `Client.DownloadAny` is handed it back.
// Storing the marshalled message rather than picking the fields out is
// deliberate: the field set differs per media arm and changes upstream, and
// whatsmeow already knows how to read it.
//
// ── Why the bytes themselves are NOT stored ─────────────────────────────────
// Media is fetched on demand and streamed straight through. Caching it would
// duplicate the operator's photos, voice notes and documents into a second place
// on disk, for a saving that matters only if the same media is fetched twice.
//
// The cost of that choice is honest and worth stating: WhatsApp expires media
// server-side, so a download attempted long enough after the fact fails. That is
// reported as a failure rather than hidden, because "the file is gone" and "the
// file is empty" must not look alike.
//
// ── Sensitivity ─────────────────────────────────────────────────────────────
// A row here contains the key that decrypts one piece of the operator's
// correspondence. The file lives beside the paired session, which is already
// handled as a credential; nothing weaker is adequate.
package mediastore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

// DefaultCapacity bounds how many messages are remembered.
//
// Generous, because a row is small and the point is to still be able to fetch a
// voice note somebody sent last month. Eviction is by age of arrival, and the
// oldest rows are the ones whose media WhatsApp has most likely expired anyway.
const DefaultCapacity = 100_000

// ErrNotStored means nothing is known about that message id — it was never a
// media message, or it has been evicted.
var ErrNotStored = errors.New("mediastore: no media recorded for that message")

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS media (
  message_id TEXT PRIMARY KEY,
  mimetype   TEXT NOT NULL DEFAULT '',
  filename   TEXT NOT NULL DEFAULT '',
  stored_at  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  payload    BLOB NOT NULL
);

-- Eviction orders by arrival, not by stored_at: two messages can share a
-- timestamp to the second, and an ordering that ties is an ordering that can
-- evict the wrong row.
CREATE TABLE IF NOT EXISTS media_seq (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  next INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO media_seq (id, next) VALUES (1, 1);

CREATE INDEX IF NOT EXISTS media_by_seq ON media(seq);
`

// Record is what is known about a stored message's media.
type Record struct {
	Message  *waE2E.Message
	Mimetype string
	Filename string
}

type Store struct {
	db       *sql.DB
	capacity int64
}

type Option func(*Store)

func WithCapacity(n int64) Option {
	return func(s *Store) { s.capacity = n }
}

func Open(ctx context.Context, path string, opts ...Option) (*Store, error) {
	store := &Store{capacity: DefaultCapacity}
	for _, opt := range opts {
		opt(store)
	}
	if store.capacity <= 0 {
		return nil, errors.New("mediastore: capacity must be positive")
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("mediastore: opening %s: %w", path, err)
	}
	db.SetMaxOpenConns(1)

	if _, err := db.ExecContext(ctx, schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("mediastore: preparing schema: %w", err)
	}

	store.db = db
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Put records a message so its media can be fetched later.
//
// Idempotent on message id: a message redelivered by history sync replaces its
// own row rather than accumulating duplicates or failing on the primary key.
func (s *Store) Put(ctx context.Context, id string, mimetype, filename string, msg *waE2E.Message) error {
	if id == "" {
		return errors.New("mediastore: message id is required")
	}
	if msg == nil {
		return errors.New("mediastore: message is required")
	}

	payload, err := proto.Marshal(msg)
	if err != nil {
		return fmt.Errorf("mediastore: encoding message %s: %w", id, err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("mediastore: begin: %w", err)
	}
	defer tx.Rollback()

	var seq int64
	if err := tx.QueryRowContext(ctx,
		"UPDATE media_seq SET next = next + 1 WHERE id = 1 RETURNING next-1").Scan(&seq); err != nil {
		return fmt.Errorf("mediastore: allocating sequence: %w", err)
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO media (message_id, mimetype, filename, stored_at, seq, payload)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(message_id) DO UPDATE SET
		   mimetype = excluded.mimetype,
		   filename = excluded.filename,
		   stored_at = excluded.stored_at,
		   seq = excluded.seq,
		   payload = excluded.payload`,
		id, mimetype, filename, time.Now().UTC().Format(time.RFC3339Nano), seq, payload,
	); err != nil {
		return fmt.Errorf("mediastore: recording %s: %w", id, err)
	}

	if err := s.evict(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("mediastore: commit: %w", err)
	}
	return nil
}

func (s *Store) evict(ctx context.Context, tx *sql.Tx) error {
	var count int64
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM media").Scan(&count); err != nil {
		return fmt.Errorf("mediastore: counting rows: %w", err)
	}

	excess := count - s.capacity
	if excess <= 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx,
		"DELETE FROM media WHERE message_id IN (SELECT message_id FROM media ORDER BY seq LIMIT ?)",
		excess,
	); err != nil {
		return fmt.Errorf("mediastore: evicting %d rows: %w", excess, err)
	}
	return nil
}

// Get returns what is needed to download a message's media.
func (s *Store) Get(ctx context.Context, id string) (Record, error) {
	var (
		payload  []byte
		mimetype string
		filename string
	)

	err := s.db.QueryRowContext(ctx,
		"SELECT payload, mimetype, filename FROM media WHERE message_id = ?", id,
	).Scan(&payload, &mimetype, &filename)

	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, ErrNotStored
	}
	if err != nil {
		return Record{}, fmt.Errorf("mediastore: reading %s: %w", id, err)
	}

	msg := &waE2E.Message{}
	if err := proto.Unmarshal(payload, msg); err != nil {
		return Record{}, fmt.Errorf("mediastore: decoding stored message %s: %w", id, err)
	}
	return Record{Message: msg, Mimetype: mimetype, Filename: filename}, nil
}

// Count reports how many messages are remembered, for status output.
func (s *Store) Count(ctx context.Context) (int64, error) {
	var count int64
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM media").Scan(&count); err != nil {
		return 0, fmt.Errorf("mediastore: counting rows: %w", err)
	}
	return count, nil
}
