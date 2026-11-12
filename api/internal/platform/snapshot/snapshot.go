// Package snapshot lets a context whose copy of another context's events started late catch up.
// The source context answers the current state of its records as the payloads its events carry
// (Sources, served on GET /internal/v1/snapshots/{eventType} in split mode), and the consumer runs
// them through its own projection handlers (projector.Replay). Handlers are versioned upserts, so
// a replay keeps any row an event already moved on and is safe to run again.
package snapshot

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Record is one aggregate's current state: the payload and version the event that last saved it
// carried.
type Record struct {
	AggregateID string          `json:"aggregateId"`
	Version     int64           `json:"version"`
	Payload     json.RawMessage `json:"payload"`
}

// Of builds a Record from a payload value.
func Of(id string, version int64, payload any) (Record, error) {
	raw, err := json.Marshal(payload)
	return Record{AggregateID: id, Version: version, Payload: raw}, err
}

// Source answers the current records behind an event type.
type Source interface {
	Snapshot(ctx context.Context, eventType string) ([]Record, error)
}

// Sources maps event types to what answers them; each source context's module builds one and the
// composition root merges those of the contexts a process runs.
type Sources map[string]func(ctx context.Context) ([]Record, error)

// Snapshot answers one event type; NOT_FOUND when no context here serves it.
func (s Sources) Snapshot(ctx context.Context, eventType string) ([]Record, error) {
	f := s[eventType]
	if f == nil {
		return nil, errs.NotFound("snapshot", eventType)
	}
	return f(ctx)
}

// Routes registers GET /snapshots/{eventType} for HTTP; mount it under /internal/v1.
func (s Sources) Routes(r chi.Router, log *slog.Logger) {
	r.Get("/snapshots/{eventType}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		list, err := s.Snapshot(r.Context(), chi.URLParam(r, "eventType"))
		if err != nil {
			return err
		}
		if list == nil {
			list = []Record{}
		}
		httpx.OK(w, list)
		return nil
	}))
}

// HTTP calls a source service's GET /internal/v1/snapshots/{eventType} with INTERNAL_TOKEN.
type HTTP struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Snapshot fetches the records behind eventType.
func (h HTTP) Snapshot(ctx context.Context, eventType string) ([]Record, error) {
	path := "/internal/v1/snapshots/" + url.PathEscape(eventType)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Internal-Token", h.Token)
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var envelope struct {
		Data  []Record `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("GET %s: %s: %w", path, res.Status, err)
	}
	if envelope.Error != nil {
		return nil, errs.New(envelope.Error.Code, envelope.Error.Message)
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("GET %s: %s", path, res.Status)
	}
	return envelope.Data, nil
}
