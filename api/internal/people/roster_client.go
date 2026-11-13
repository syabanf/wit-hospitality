package people

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
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

// StaffMember is an employee as another context checks them: the name, whether they still work
// here and the villas their cost is allocated to.
type StaffMember struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Status   string   `json:"status"`
	VillaIDs []string `json:"villaIds"`
}

// AllocatedTo reports an active employee allocated to the villa.
func (m StaffMember) AllocatedTo(villaID string) bool {
	return m.Status != "inactive" && slices.Contains(m.VillaIDs, villaID)
}

// Staff looks an employee up: property and reservation check that a villa host is allocated to the
// villa, services names the host on a setup request. found is false when no employee has the id.
// The composition root hands a consumer the in-process implementation (people/module) in the
// monolith and HTTPClient in split mode.
type Staff interface {
	StaffMember(ctx context.Context, id string) (m StaffMember, found bool, err error)
}

// HTTPClient calls the people service's /internal/v1 routes with the shared INTERNAL_TOKEN.
type HTTPClient struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Rostered calls GET /internal/v1/people/rostered?employeeId=&date=.
func (h HTTPClient) Rostered(ctx context.Context, employeeID, date string) (bool, error) {
	var out struct {
		Rostered bool `json:"rostered"`
	}
	err := h.get(ctx, "/internal/v1/people/rostered?"+url.Values{"employeeId": {employeeID}, "date": {date}}.Encode(), &out)
	return out.Rostered, err
}

// StaffMember calls GET /internal/v1/people/staff/{id}; NOT_FOUND reads as not found.
func (h HTTPClient) StaffMember(ctx context.Context, id string) (StaffMember, bool, error) {
	var out StaffMember
	err := h.get(ctx, "/internal/v1/people/staff/"+url.PathEscape(id), &out)
	if errs.HasCode(err, errs.CodeNotFound) {
		return StaffMember{}, false, nil
	}
	return out, err == nil, err
}

func (h HTTPClient) get(ctx context.Context, path string, out any) error {
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
		return fmt.Errorf("people GET %s: %s: %w", path, res.Status, err)
	}
	if envelope.Error != nil {
		return errs.New(envelope.Error.Code, envelope.Error.Message)
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("people GET %s: %s", path, res.Status)
	}
	return json.Unmarshal(envelope.Data, out)
}
