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

	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
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

// ErrTimeout means the read models had not caught up when the wait ended.
var ErrTimeout = errors.New("read models still catching up")

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
