package bus

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// StreamName holds every integration event; subjects are "events.<type>".
const StreamName = "EVENTS"

// Subject is the NATS subject of an event type.
func Subject(eventType string) string { return "events." + eventType }

// NATS is the JetStream bus for split mode. Publish dedupes on the event id, and each consumer is a
// durable pull consumer, so replicas of one service share the work and a crash redelivers.
type NATS struct {
	nc   *nats.Conn
	js   jetstream.JetStream
	log  *slog.Logger
	mu   sync.Mutex
	subs []subscription
	runs []jetstream.ConsumeContext
}

// DialNATS connects and makes sure the stream exists.
func DialNATS(ctx context.Context, url, name string, log *slog.Logger) (*NATS, error) {
	nc, err := nats.Connect(url, nats.Name(name), nats.MaxReconnects(-1), nats.ReconnectWait(time.Second))
	if err != nil {
		return nil, fmt.Errorf("connect to NATS at %s: %w", url, err)
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("jetstream: %w", err)
	}
	if _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:       StreamName,
		Subjects:   []string{"events.>"},
		Storage:    jetstream.FileStorage,
		Retention:  jetstream.LimitsPolicy,
		MaxAge:     7 * 24 * time.Hour,
		Duplicates: 10 * time.Minute,
	}); err != nil {
		nc.Close()
		return nil, fmt.Errorf("create stream %s: %w", StreamName, err)
	}
	return &NATS{nc: nc, js: js, log: log}, nil
}

// Publish waits for the stream's acknowledgement.
func (b *NATS) Publish(ctx context.Context, m Message) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = b.js.Publish(ctx, Subject(m.Type), data, jetstream.WithMsgID(m.ID))
	return err
}

// Subscribe records a consumer; Start creates it on the server.
func (b *NATS) Subscribe(consumer string, types []string, h Handler) error {
	set := map[string]bool{}
	for _, t := range types {
		set[t] = true
	}
	b.mu.Lock()
	b.subs = append(b.subs, subscription{consumer: consumer, types: set, h: h})
	b.mu.Unlock()
	return nil
}

func durableName(consumer string) string {
	return strings.NewReplacer(".", "_", " ", "_", "*", "_", ">", "_").Replace(consumer)
}

// Start creates or updates each durable consumer and begins consuming.
func (b *NATS) Start(ctx context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, s := range b.subs {
		var filters []string
		for t := range s.types {
			filters = append(filters, Subject(t))
		}
		cons, err := b.js.CreateOrUpdateConsumer(ctx, StreamName, jetstream.ConsumerConfig{
			Durable:        durableName(s.consumer),
			FilterSubjects: filters,
			AckPolicy:      jetstream.AckExplicitPolicy,
			AckWait:        30 * time.Second,
			MaxDeliver:     -1,
			DeliverPolicy:  jetstream.DeliverAllPolicy,
		})
		if err != nil {
			return fmt.Errorf("consumer %s: %w", s.consumer, err)
		}
		sub := s
		run, err := cons.Consume(func(msg jetstream.Msg) {
			var m Message
			if err := json.Unmarshal(msg.Data(), &m); err != nil {
				b.log.Error("drop malformed event", slog.String("consumer", sub.consumer), slog.String("error", err.Error()))
				_ = msg.Term()
				return
			}
			if err := sub.h(context.Background(), m); err != nil {
				b.log.Warn("event handler failed; redelivering", slog.String("consumer", sub.consumer), slog.String("event", m.Type), slog.String("error", err.Error()))
				_ = msg.NakWithDelay(2 * time.Second)
				return
			}
			_ = msg.Ack()
		})
		if err != nil {
			return fmt.Errorf("consume %s: %w", s.consumer, err)
		}
		b.runs = append(b.runs, run)
	}
	return nil
}

// Ping checks the connection.
func (b *NATS) Ping(context.Context) error {
	if b.nc.Status() != nats.CONNECTED {
		return fmt.Errorf("nats %s", b.nc.Status())
	}
	return nil
}

// Close stops consumers and drains the connection.
func (b *NATS) Close() error {
	for _, r := range b.runs {
		r.Stop()
	}
	return b.nc.Drain()
}

// Kind names the implementation for /health.
func (b *NATS) Kind() string { return "nats" }
