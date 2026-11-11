// Package outbox writes integration events in the same transaction as the change they describe
// and relays them to the bus after commit. A crash between commit and publish only delays an
// event; it never loses one.
package outbox

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
)

// NotifyChannel is the Postgres channel the relay listens on; Append notifies it, and Postgres
// delivers the notification at commit.
const NotifyChannel = "platform_outbox"

// Event is what a command appends.
type Event struct {
	Type             string
	AggregateType    string
	AggregateID      string
	AggregateVersion int64
	Payload          any
}

// Pending names an appended event, so the HTTP layer can wait for local read models to apply it.
type Pending struct {
	ID   string
	Type string
}

// Collector gathers the events appended while handling one request.
type Collector struct {
	mu     sync.Mutex
	events []Pending
}

// Events returns what was appended.
func (c *Collector) Events() []Pending {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Pending(nil), c.events...)
}

type collectorKey struct{}

// WithCollector starts collecting appended events on ctx.
func WithCollector(ctx context.Context) (context.Context, *Collector) {
	c := &Collector{}
	return context.WithValue(ctx, collectorKey{}, c), c
}

// Append inserts the event through q, which must be the writing transaction.
func Append(ctx context.Context, q db.Querier, now time.Time, e Event) error {
	payload, err := json.Marshal(e.Payload)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", e.Type, err)
	}
	meta := map[string]string{}
	if id := logging.RequestID(ctx); id != "" {
		meta["requestId"] = id
	}
	if id := logging.UserID(ctx); id != "" {
		meta["userId"] = id
	}
	metadata, _ := json.Marshal(meta)
	id := ids.UUID()
	if _, err := q.Exec(ctx, `
		INSERT INTO platform.outbox (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, metadata, occurred_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		id, e.Type, e.AggregateType, e.AggregateID, e.AggregateVersion, payload, metadata, now); err != nil {
		return fmt.Errorf("append %s: %w", e.Type, err)
	}
	if _, err := q.Exec(ctx, `SELECT pg_notify($1, '')`, NotifyChannel); err != nil {
		return fmt.Errorf("notify outbox: %w", err)
	}
	if c, ok := ctx.Value(collectorKey{}).(*Collector); ok {
		c.mu.Lock()
		c.events = append(c.events, Pending{ID: id, Type: e.Type})
		c.mu.Unlock()
	}
	return nil
}
