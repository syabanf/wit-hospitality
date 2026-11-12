package guest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Client is what other contexts ask the guest context. The composition root hands a consumer the
// in-process implementation (guest/module) in the monolith and HTTPClient in split mode. Refusals
// come back as *errs.Error with the guest context's codes and wording, so a caller can return
// them to the console unchanged.
type Client interface {
	// Guest returns the profile summary; NOT_FOUND when no guest has the id.
	Guest(ctx context.Context, id string) (Guest, error)
	// BlacklistStatus says whether the guest is blacklisted and why; NOT_FOUND for an unknown id.
	// Reservation refuses a stay with GUEST_BLACKLISTED unless an approver gives a reason.
	BlacklistStatus(ctx context.Context, id string) (BlacklistStatus, error)
	// Registration lists the lead guest and the companions of a stay with what each still owes
	// Immigration, and how many adults on the booking nobody registered yet.
	Registration(ctx context.Context, stay StayPeople) (Registration, error)
	// CheckRegistration is the check-in gate: nil when every foreign adult on the stay has the APOA
	// fields and a valid document on stay.On, else FOREIGN_DATA_MISSING or DOCUMENT_EXPIRED.
	CheckRegistration(ctx context.Context, stay StayPeople) error
	// CreateGuest adds the profile a booking or group brings along (GuestInput in the console's
	// shape), as p, who needs guest/create or booking/create. A non-empty key makes it happen once:
	// a retry under the same key returns the profile the first call made.
	CreateGuest(ctx context.Context, p auth.Principal, input json.RawMessage, key string) (Guest, error)
}

// NewProfile is the body of POST /internal/v1/guests. The principal travels with the call, so
// guest checks the same permission as in process.
type NewProfile struct {
	Principal auth.Principal  `json:"principal"`
	Input     json.RawMessage `json:"input"`
	Key       string          `json:"key"`
}

// BlacklistStatus answers Client.BlacklistStatus.
type BlacklistStatus struct {
	GuestID     string     `json:"guestId"`
	Name        string     `json:"name"`
	Blacklisted bool       `json:"blacklisted"`
	Blacklist   *Blacklist `json:"blacklist"`
}

// StayPeople names a stay and its lead guest. Adults is the party size the booking or the
// check-in recorded, nil when unknown; On is the day the check applies to (YYYY-MM-DD).
type StayPeople struct {
	BookingID string `json:"bookingId"`
	GuestID   string `json:"guestId"`
	Adults    *int   `json:"adults"`
	On        string `json:"on"`
}

// RegisteredPerson is one person on a stay and what Immigration still needs from them.
type RegisteredPerson struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Kind    string   `json:"kind"`
	Adult   bool     `json:"adult"`
	Foreign bool     `json:"foreign"`
	Missing []string `json:"missing"`
	Expired bool     `json:"expired"`
}

// Registration answers Client.Registration.
type Registration struct {
	BookingID        string             `json:"bookingId"`
	RegisteredAdults int                `json:"registeredAdults"`
	Unregistered     int                `json:"unregistered"`
	People           []RegisteredPerson `json:"people"`
}

// HTTPClient calls the guest service's /internal/v1 routes with the shared INTERNAL_TOKEN.
type HTTPClient struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Guest calls GET /internal/v1/guests/{id}.
func (h HTTPClient) Guest(ctx context.Context, id string) (Guest, error) {
	var out Guest
	err := h.call(ctx, http.MethodGet, "/internal/v1/guests/"+url.PathEscape(id), nil, &out)
	return out, err
}

// BlacklistStatus calls GET /internal/v1/guests/{id}/blacklist.
func (h HTTPClient) BlacklistStatus(ctx context.Context, id string) (BlacklistStatus, error) {
	var out BlacklistStatus
	err := h.call(ctx, http.MethodGet, "/internal/v1/guests/"+url.PathEscape(id)+"/blacklist", nil, &out)
	return out, err
}

// Registration calls POST /internal/v1/registrations.
func (h HTTPClient) Registration(ctx context.Context, stay StayPeople) (Registration, error) {
	var out Registration
	err := h.call(ctx, http.MethodPost, "/internal/v1/registrations", stay, &out)
	return out, err
}

// CheckRegistration calls POST /internal/v1/registrations/check, which answers 204 or a refusal.
func (h HTTPClient) CheckRegistration(ctx context.Context, stay StayPeople) error {
	return h.call(ctx, http.MethodPost, "/internal/v1/registrations/check", stay, nil)
}

// CreateGuest calls POST /internal/v1/guests.
func (h HTTPClient) CreateGuest(ctx context.Context, p auth.Principal, input json.RawMessage, key string) (Guest, error) {
	var out Guest
	err := h.call(ctx, http.MethodPost, "/internal/v1/guests", NewProfile{Principal: p, Input: input, Key: key}, &out)
	return out, err
}

func (h HTTPClient) call(ctx context.Context, method, path string, body, out any) error {
	var raw []byte
	if body != nil {
		var err error
		if raw, err = json.Marshal(body); err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, h.BaseURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("X-Internal-Token", h.Token)
	req.Header.Set("Content-Type", "application/json")
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNoContent {
		return nil
	}
	var envelope struct {
		Data  json.RawMessage `json:"data"`
		Error *struct {
			Code    string            `json:"code"`
			Message string            `json:"message"`
			Fields  map[string]string `json:"fields"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return fmt.Errorf("guest %s %s: %s: %w", method, path, res.Status, err)
	}
	if envelope.Error != nil {
		e := errs.New(envelope.Error.Code, envelope.Error.Message)
		for field, msg := range envelope.Error.Fields {
			e.Fields = append(e.Fields, errs.FieldError{Field: field, Message: msg})
		}
		return e
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("guest %s %s: %s", method, path, res.Status)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(envelope.Data, out)
}
