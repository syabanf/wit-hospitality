// Package stays answers property's questions about stays from the reservation context, which
// owns them. The monolith passes reservation's in-process answers straight to property; a property
// service on its own calls the reservation service's internal endpoints through HTTP.
package stays

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// HTTP calls GET {BaseURL}/internal/v1/stays/... on the reservation service.
type HTTP struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

func (h HTTP) get(ctx context.Context, path string, q url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+"/internal/v1/stays/"+path+"?"+q.Encode(), nil)
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
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("reservation stays %s: %s", path, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(&struct {
		Data any `json:"data"`
	}{Data: out})
}

// OverlappingStay asks for a stay holding the unit on a night in [from, to).
func (h HTTP) OverlappingStay(ctx context.Context, unitID, from, to string) (string, bool, error) {
	var out struct {
		Code  string `json:"code"`
		Found bool   `json:"found"`
	}
	err := h.get(ctx, "overlap", url.Values{"unitId": {unitID}, "from": {from}, "to": {to}}, &out)
	return out.Code, out.Found, err
}

// HasUpcomingStays asks for confirmed stays on the unit that leave after today.
func (h HTTP) HasUpcomingStays(ctx context.Context, unitID, today string) (bool, error) {
	var out struct {
		Found bool `json:"found"`
	}
	err := h.get(ctx, "upcoming", url.Values{"unitId": {unitID}, "today": {today}}, &out)
	return out.Found, err
}

// WaitingForRoom asks for open stays booked against the room type without a room yet.
func (h HTTP) WaitingForRoom(ctx context.Context, groupID string) ([]string, error) {
	var out struct {
		Codes []string `json:"codes"`
	}
	err := h.get(ctx, "waiting", url.Values{"groupId": {groupID}}, &out)
	return out.Codes, err
}
