package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
)

// Relay publishes pending outbox rows in id order. It wakes on the Postgres notification Append
// sends and polls every Interval in case one is missed.
type Relay struct {
	DB       *db.DB
	Bus      bus.Bus
	Log      *slog.Logger
	Interval time.Duration
	Batch    int
}

// Run publishes until ctx ends. It holds one connection that LISTENs, so a notification sent while
// a pass runs wakes the next wait at once.
func (r *Relay) Run(ctx context.Context) error {
	interval := r.Interval
	if interval <= 0 {
		interval = time.Second
	}
	for ctx.Err() == nil {
		if err := r.listen(ctx, interval); err != nil && ctx.Err() == nil {
			r.Log.Warn("outbox relay restarting", slog.String("error", err.Error()))
			select {
			case <-ctx.Done():
			case <-time.After(interval):
			}
		}
	}
	return nil
}

func (r *Relay) listen(ctx context.Context, interval time.Duration) error {
	conn, err := r.DB.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "LISTEN "+NotifyChannel); err != nil {
		return err
	}
	defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), "UNLISTEN "+NotifyChannel) }()
	for {
		if _, err := r.Drain(ctx); err != nil && ctx.Err() == nil {
			r.Log.Warn("outbox relay pass failed", slog.String("error", err.Error()))
		}
		wctx, cancel := context.WithTimeout(ctx, interval)
		_, err := conn.Conn().WaitForNotification(wctx)
		cancel()
		if ctx.Err() != nil {
			return nil
		}
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		if conn.Conn().IsClosed() {
			// A timed-out wait can close the connection; take a fresh one.
			return nil
		}
	}
}

// Drain publishes batches until nothing is pending and returns how many rows it published.
func (r *Relay) Drain(ctx context.Context) (int, error) {
	total := 0
	for {
		n, err := r.publishBatch(ctx)
		total += n
		if err != nil || n == 0 {
			return total, err
		}
	}
}

func (r *Relay) publishBatch(ctx context.Context) (int, error) {
	batch := r.Batch
	if batch <= 0 {
		batch = 100
	}
	tx, err := r.DB.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	rows, err := tx.Query(ctx, `
		SELECT id, event_id::text, event_type, aggregate_type, aggregate_id, aggregate_version, payload, metadata, occurred_at
		FROM platform.outbox
		WHERE published_at IS NULL
		ORDER BY id
		LIMIT $1
		FOR UPDATE SKIP LOCKED`, batch)
	if err != nil {
		return 0, err
	}
	type row struct {
		seq int64
		msg bus.Message
	}
	list, err := pgx.CollectRows(rows, func(rw pgx.CollectableRow) (row, error) {
		var x row
		var payload, metadata []byte
		err := rw.Scan(&x.seq, &x.msg.ID, &x.msg.Type, &x.msg.AggregateType, &x.msg.AggregateID, &x.msg.AggregateVersion, &payload, &metadata, &x.msg.OccurredAt)
		x.msg.Payload = payload
		_ = json.Unmarshal(metadata, &x.msg.Metadata)
		return x, err
	})
	if err != nil {
		return 0, err
	}
	published := 0
	for _, x := range list {
		if perr := r.Bus.Publish(ctx, x.msg); perr != nil {
			// Keep order: stop at the first failure and retry it on the next pass.
			if _, err := tx.Exec(ctx, `UPDATE platform.outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, x.seq, perr.Error()); err != nil {
				return published, err
			}
			if err := tx.Commit(ctx); err != nil {
				return published, err
			}
			return published, fmt.Errorf("publish %s %s: %w", x.msg.Type, x.msg.ID, perr)
		}
		if _, err := tx.Exec(ctx, `UPDATE platform.outbox SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, x.seq); err != nil {
			return published, err
		}
		published++
	}
	return published, tx.Commit(ctx)
}
