package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Reservation reads the bookings, held nights and stay restrictions from the reservation service's
// /internal/v1/site routes with INTERNAL_TOKEN (split mode). Tax, menu and team answer as None.
type Reservation struct {
	None
	BaseURL string
	Token   string
	Client  *http.Client
}

// BookingCode calls GET /internal/v1/site/bookings/{id}.
func (h Reservation) BookingCode(ctx context.Context, id string) (string, bool, error) {
	var out struct {
		Code  string `json:"code"`
		Found bool   `json:"found"`
	}
	err := h.get(ctx, "/internal/v1/site/bookings/"+url.PathEscape(id), &out)
	return out.Code, out.Found, err
}

// Restrictions calls GET /internal/v1/site/restrictions.
func (h Reservation) Restrictions(ctx context.Context) ([]json.RawMessage, error) {
	out := []json.RawMessage{}
	err := h.get(ctx, "/internal/v1/site/restrictions", &out)
	return out, err
}

// Stays calls GET /internal/v1/site/holds?from=&to=.
func (h Reservation) Stays(ctx context.Context, from, to string) ([]domain.Hold, error) {
	var held []struct {
		UnitID       string `json:"unitId"`
		UnitAssigned bool   `json:"unitAssigned"`
		CheckIn      string `json:"checkIn"`
		CheckOut     string `json:"checkOut"`
	}
	if err := h.get(ctx, "/internal/v1/site/holds?"+url.Values{"from": {from}, "to": {to}}.Encode(), &held); err != nil {
		return nil, err
	}
	out := make([]domain.Hold, len(held))
	for i, s := range held {
		out[i] = domain.Hold{UnitID: s.UnitID, UnitAssigned: s.UnitAssigned, From: s.CheckIn, To: s.CheckOut}
	}
	return out, nil
}

func (h Reservation) get(ctx context.Context, path string, out any) error {
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
	var body struct {
		Data  json.RawMessage `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return fmt.Errorf("reservation %s: %s: %w", path, res.Status, err)
	}
	if body.Error != nil {
		return errs.New(body.Error.Code, body.Error.Message)
	}
	return json.Unmarshal(body.Data, out)
}
