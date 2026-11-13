// Package projector runs the event handlers that keep read models current. Each handler belongs to
// a named consumer; the inbox table (platform.processed_events) makes delivery idempotent: the
// handler and the inbox row commit in one transaction, and a redelivered event is skipped.
//
// In the monolith the relay publishes on the in-process bus right after commit, so handlers run
// in-process. In split mode each service subscribes its own consumers on NATS.
package projector

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/snapshot"
)

// Handler applies one event inside the inbox transaction (db.Q(ctx) is that transaction).
type Handler func(ctx context.Context, m bus.Message) error

// Projector holds the handlers of the contexts running in this process.
type Projector struct {
	db       *db.DB
	log      *slog.Logger
	handlers map[string]map[string]Handler // consumer -> event type -> handler
}

// New returns an empty projector.
func New(d *db.DB, log *slog.Logger) *Projector {
	return &Projector{db: d, log: log, handlers: map[string]map[string]Handler{}}
}

// On registers h for eventType under consumer.
func (p *Projector) On(consumer, eventType string, h Handler) {
	if p.handlers[consumer] == nil {
		p.handlers[consumer] = map[string]Handler{}
	}
	p.handlers[consumer][eventType] = h
}

// Handles reports whether consumer has a handler for eventType.
func (p *Projector) Handles(consumer, eventType string) bool {
	return p.handlers[consumer][eventType] != nil
}

// Consumers lists the registered consumer names.
func (p *Projector) Consumers() []string {
	var out []string
	for c := range p.handlers {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// Attach subscribes every consumer on b.
func (p *Projector) Attach(b bus.Bus) error {
	for _, consumer := range p.Consumers() {
		hs := p.handlers[consumer]
		var types []string
		for t := range hs {
			types = append(types, t)
		}
		sort.Strings(types)
		c := consumer
		if err := b.Subscribe(c, types, func(ctx context.Context, m bus.Message) error {
			return p.apply(ctx, c, m)
		}); err != nil {
			return err
		}
	}
	return nil
}

// apply runs the handler once per (consumer, event).
func (p *Projector) apply(ctx context.Context, consumer string, m bus.Message) error {
	h := p.handlers[consumer][m.Type]
	if h == nil {
		return nil
	}
	// Events a handler appends carry the request id of the write that caused them, so
	// ReadYourWrites can wait for a reaction in another context too.
	if id := m.Metadata["requestId"]; id != "" && logging.RequestID(ctx) == "" {
		ctx = logging.WithRequestID(ctx, id)
	}
	err := p.db.InTx(ctx, func(ctx context.Context) error {
		tag, err := p.db.Q(ctx).Exec(ctx, `
			INSERT INTO platform.processed_events (consumer, event_id, event_type) VALUES ($1, $2, $3)
			ON CONFLICT DO NOTHING`, consumer, m.ID, m.Type)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		return h(ctx, m)
	})
	if err != nil {
		p.log.ErrorContext(ctx, "projection failed", slog.String("consumer", consumer), slog.String("event", m.Type), slog.String("event_id", m.ID), slog.String("error", err.Error()))
		return fmt.Errorf("%s on %s: %w", consumer, m.Type, err)
	}
	return nil
}

// Replay runs consumer's handler for eventType over a source's current records, in one
// transaction and without inbox rows, so a copy that missed those events catches up. The
// handlers are versioned upserts (rule 6), so a replay keeps any newer row and can run again.
func (p *Projector) Replay(ctx context.Context, consumer, eventType string, records []snapshot.Record) error {
	h := p.handlers[consumer][eventType]
	if h == nil {
		return fmt.Errorf("replay: %s has no handler for %s", consumer, eventType)
	}
	return p.db.InTx(ctx, func(ctx context.Context) error {
		for _, r := range records {
			m := bus.Message{ID: "snapshot:" + eventType + ":" + r.AggregateID, Type: eventType, AggregateID: r.AggregateID,
				AggregateVersion: r.Version, OccurredAt: time.Now(), Payload: r.Payload}
			if err := h(ctx, m); err != nil {
				return fmt.Errorf("replay %s on %s %s: %w", consumer, eventType, r.AggregateID, err)
			}
		}
		return nil
	})
}

// ErrTimeout means the read models had not caught up when the wait ended.
var ErrTimeout = errors.New("read models still catching up")

// AwaitConsumer blocks until consumer has processed the eventType an aggregate emitted at version,
// or timeout passes. It reads the shared platform tables, so it also waits for a consumer running
// in another process, as in split mode, where Await sees only local handlers.
func AwaitConsumer(ctx context.Context, d *db.DB, consumer, eventType, aggregateID string, version int64, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		var done bool
		if err := d.Pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM platform.outbox o
				JOIN platform.processed_events pe ON pe.event_id = o.event_id AND pe.consumer = $1
				WHERE o.event_type = $2 AND o.aggregate_id = $3 AND o.aggregate_version = $4)`,
			consumer, eventType, aggregateID, version).Scan(&done); err != nil {
			return err
		}
		if done {
			return nil
		}
		if time.Now().After(deadline) {
			return ErrTimeout
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// Await blocks until every local consumer that handles one of the events has processed it, or
// timeout passes. Commands use it so a page that reloads after a save reads its own write.
func (p *Projector) Await(ctx context.Context, events []outbox.Pending, timeout time.Duration) error {
	var consumers, eventIDs []string
	for _, e := range events {
		for consumer, hs := range p.handlers {
			if hs[e.Type] != nil {
				consumers = append(consumers, consumer)
				eventIDs = append(eventIDs, e.ID)
			}
		}
	}
	if len(consumers) == 0 {
		return nil
	}
	deadline := time.Now().Add(timeout)
	for {
		var done int
		if err := p.db.Pool.QueryRow(ctx, `
			SELECT count(*) FROM platform.processed_events pe
			JOIN unnest($1::text[], $2::uuid[]) AS w(consumer, event_id) USING (consumer, event_id)`,
			consumers, eventIDs).Scan(&done); err != nil {
			return err
		}
		if done >= len(consumers) {
			return nil
		}
		if time.Now().After(deadline) {
			return ErrTimeout
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// AwaitChain is Await followed by the events local handlers appended in reaction, which carry the
// same request id: a write whose event makes another context change its records (property moving
// a unit to its listing's base price) is read-your-writes too. It shares one timeout.
func (p *Projector) AwaitChain(ctx context.Context, requestID string, events []outbox.Pending, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	seen := map[string]bool{}
	for _, e := range events {
		seen[e.ID] = true
	}
	for len(events) > 0 {
		if err := p.Await(ctx, events, time.Until(deadline)); err != nil || requestID == "" {
			return err
		}
		ids := make([]string, 0, len(seen))
		for id := range seen {
			ids = append(ids, id)
		}
		rows, err := p.db.Pool.Query(ctx, `
			SELECT event_id::text, event_type FROM platform.outbox
			WHERE id > (SELECT min(id) FROM platform.outbox WHERE event_id = ANY($2::uuid[]))
			  AND metadata->>'requestId' = $1 AND NOT (event_id = ANY($2::uuid[]))
			ORDER BY id`, requestID, ids)
		if err != nil {
			return err
		}
		next, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (outbox.Pending, error) {
			var e outbox.Pending
			err := r.Scan(&e.ID, &e.Type)
			return e, err
		})
		if err != nil {
			return err
		}
		events = next
		for _, e := range next {
			seen[e.ID] = true
		}
	}
	return nil
}
