// Package bus moves integration events between contexts with at-least-once delivery. The monolith
// uses the in-process bus; split services use NATS JetStream. Consumers dedupe through the inbox
// table (see package projector), so a redelivery is harmless.
package bus

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// Message is one published event. Type is versioned, for example property.unit.created.v1.
type Message struct {
	ID               string            `json:"id"`
	Type             string            `json:"type"`
	AggregateType    string            `json:"aggregateType"`
	AggregateID      string            `json:"aggregateId"`
	AggregateVersion int64             `json:"aggregateVersion"`
	OccurredAt       time.Time         `json:"occurredAt"`
	Payload          json.RawMessage   `json:"payload"`
	Metadata         map[string]string `json:"metadata,omitempty"`
}

// Handler consumes a message. An error asks for redelivery.
type Handler func(ctx context.Context, m Message) error

// Bus publishes and subscribes.
type Bus interface {
	// Publish returns once the message is durable (NATS) or every local handler ran (in-process).
	Publish(ctx context.Context, m Message) error
	// Subscribe registers a named, durable consumer for the given event types.
	Subscribe(consumer string, types []string, h Handler) error
	// Start begins delivery to the subscribers.
	Start(ctx context.Context) error
	// Ping reports whether the bus is reachable.
	Ping(ctx context.Context) error
	Close() error
	Kind() string
}

// InProcess delivers synchronously inside Publish. The relay calls Publish after the writing
// transaction commits, so handlers see committed data; a handler error leaves the outbox row
// pending and the relay retries it.
type InProcess struct {
	mu   sync.RWMutex
	subs []subscription
}

type subscription struct {
	consumer string
	types    map[string]bool
	h        Handler
}

// NewInProcess returns an empty bus.
func NewInProcess() *InProcess { return &InProcess{} }

// Subscribe adds a consumer.
func (b *InProcess) Subscribe(consumer string, types []string, h Handler) error {
	set := map[string]bool{}
	for _, t := range types {
		set[t] = true
	}
	b.mu.Lock()
	b.subs = append(b.subs, subscription{consumer: consumer, types: set, h: h})
	b.mu.Unlock()
	return nil
}

// Publish runs every matching handler and joins their errors.
func (b *InProcess) Publish(ctx context.Context, m Message) error {
	b.mu.RLock()
	subs := append([]subscription(nil), b.subs...)
	b.mu.RUnlock()
	var errs []error
	for _, s := range subs {
		if s.types[m.Type] {
			if err := s.h(ctx, m); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

// Start has nothing to do in process.
func (b *InProcess) Start(context.Context) error { return nil }

// Ping always succeeds.
func (b *InProcess) Ping(context.Context) error { return nil }

// Close has nothing to release.
func (b *InProcess) Close() error { return nil }

// Kind names the implementation for /health.
func (b *InProcess) Kind() string { return "inproc" }
