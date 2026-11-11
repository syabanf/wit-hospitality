package reservation

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Stay is a booking as other contexts see it: who stays in which unit, from when to when, and in
// which lifecycle state. Services orders room service against it.
type Stay struct {
	ID           string `json:"id"`
	Code         string `json:"code"`
	GuestID      string `json:"guestId"`
	UnitID       string `json:"unitId"`
	UnitAssigned bool   `json:"unitAssigned"`
	VillaID      string `json:"villaId"`
	Status       string `json:"status"`
	CheckIn      string `json:"checkIn"`
	CheckOut     string `json:"checkOut"`
}

// Stays answers other contexts' questions about stays. The composition root hands a consumer the
// in-process answer (reservation/module) in the monolith and StaysHTTP in split mode.
type Stays interface {
	// Stay returns one booking; NOT_FOUND ("No booking with id ...") when none has the id.
	Stay(ctx context.Context, id string) (Stay, error)
	// InUnit lists the confirmed and checked-in stays with the unit assigned, oldest first.
	InUnit(ctx context.Context, unitID string) ([]Stay, error)
}

// StaysHTTP calls the reservation service's /internal/v1/stays routes with INTERNAL_TOKEN.
type StaysHTTP struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Stay calls GET /internal/v1/stays/booking/{id}.
func (h StaysHTTP) Stay(ctx context.Context, id string) (Stay, error) {
	var out Stay
	err := h.get(ctx, "/internal/v1/stays/booking/"+url.PathEscape(id), &out)
	return out, err
}

// InUnit calls GET /internal/v1/stays/unit/{unitId}.
func (h StaysHTTP) InUnit(ctx context.Context, unitID string) ([]Stay, error) {
	var out []Stay
	err := h.get(ctx, "/internal/v1/stays/unit/"+url.PathEscape(unitID), &out)
	return out, err
}

func (h StaysHTTP) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Internal-Token", h.Token)
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var envelope struct {
		Data  json.RawMessage `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return fmt.Errorf("reservation GET %s: %s: %w", path, res.Status, err)
	}
	if envelope.Error != nil {
		return errs.New(envelope.Error.Code, envelope.Error.Message)
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("reservation GET %s: %s", path, res.Status)
	}
	return json.Unmarshal(envelope.Data, out)
}
