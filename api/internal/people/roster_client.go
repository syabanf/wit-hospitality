package people

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Roster says whether the roster puts an employee on a shift that day (YYYY-MM-DD): billing asks
// before a cashier who is not a manager opens a cash shift. It needs no session, since the caller
// already checked its own. The composition root hands a consumer the in-process implementation
// (people/module) in the monolith and HTTPClient in split mode.
type Roster interface {
	Rostered(ctx context.Context, employeeID, date string) (bool, error)
}

// HTTPClient calls the people service's /internal/v1 routes with the shared INTERNAL_TOKEN.
type HTTPClient struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Rostered calls GET /internal/v1/people/rostered?employeeId=&date=.
func (h HTTPClient) Rostered(ctx context.Context, employeeID, date string) (bool, error) {
	path := "/internal/v1/people/rostered?" + url.Values{"employeeId": {employeeID}, "date": {date}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+path, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("X-Internal-Token", h.Token)
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	var envelope struct {
		Data struct {
			Rostered bool `json:"rostered"`
		} `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return false, fmt.Errorf("people GET %s: %s: %w", path, res.Status, err)
	}
	if envelope.Error != nil {
		return false, errs.New(envelope.Error.Code, envelope.Error.Message)
	}
	if res.StatusCode >= 300 {
		return false, fmt.Errorf("people GET %s: %s", path, res.Status)
	}
	return envelope.Data.Rostered, nil
}
