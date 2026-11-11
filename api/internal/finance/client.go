package finance

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Client is what billing, maintenance, inventory, payroll and reservation ask finance. The
// composition root hands a consumer the in-process implementation (finance/module) in the
// monolith and HTTPClient in split mode.
type Client interface {
	// Entries lists the cash entries written for a source record, oldest first; empty when none.
	// The approval status of an expense, a payment or a payroll is read here.
	Entries(ctx context.Context, src Source) ([]Entry, error)
	// ProofPolicy is the receipt rule, so a context can ask for the receipt before it publishes a
	// hand-written cash-out.
	ProofPolicy(ctx context.Context) (ProofPolicy, error)
	// OpenShift is the cashier shift open on a location's cashbox, nil when none; billing stamps
	// desk payments with it.
	OpenShift(ctx context.Context, locationID string) (*Shift, error)
	// BilledServiceCharge is what the folio billed onto Service charge payable (2400) in a month
	// ("YYYY-MM") across every villa; payroll shares it out as the service charge pool.
	BilledServiceCharge(ctx context.Context, month string) (int64, error)
}

// ProofPolicy is the receipt rule: cash-outs from Threshold need proof; 0 switches it off.
type ProofPolicy struct {
	Threshold int64 `json:"threshold"`
}

// Shift is an open cashier shift.
type Shift struct {
	ID          string `json:"id"`
	Number      string `json:"number"`
	AccountID   string `json:"accountId"`
	CashierID   string `json:"cashierId"`
	CashierName string `json:"cashierName"`
}

// HTTPClient calls the finance service's /internal/v1/finance routes with INTERNAL_TOKEN.
type HTTPClient struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Entries calls GET /internal/v1/finance/entries?sourceType=&sourceId=.
func (h HTTPClient) Entries(ctx context.Context, src Source) ([]Entry, error) {
	var out []Entry
	q := url.Values{"sourceType": {src.Type}, "sourceId": {src.ID}}
	err := h.call(ctx, "/internal/v1/finance/entries?"+q.Encode(), &out)
	return out, err
}

// ProofPolicy calls GET /internal/v1/finance/proof-policy.
func (h HTTPClient) ProofPolicy(ctx context.Context) (ProofPolicy, error) {
	var out ProofPolicy
	err := h.call(ctx, "/internal/v1/finance/proof-policy", &out)
	return out, err
}

// OpenShift calls GET /internal/v1/finance/open-shift?locationId=.
func (h HTTPClient) OpenShift(ctx context.Context, locationID string) (*Shift, error) {
	var out *Shift
	err := h.call(ctx, "/internal/v1/finance/open-shift?"+url.Values{"locationId": {locationID}}.Encode(), &out)
	return out, err
}

// BilledServiceCharge calls GET /internal/v1/finance/service-charge?month=.
func (h HTTPClient) BilledServiceCharge(ctx context.Context, month string) (int64, error) {
	var out struct {
		Amount int64 `json:"amount"`
	}
	err := h.call(ctx, "/internal/v1/finance/service-charge?"+url.Values{"month": {month}}.Encode(), &out)
	return out.Amount, err
}

func (h HTTPClient) call(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+path, bytes.NewReader(nil))
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
		return fmt.Errorf("finance GET %s: %s: %w", path, res.Status, err)
	}
	if envelope.Error != nil {
		return errs.New(envelope.Error.Code, envelope.Error.Message)
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("finance GET %s: %s", path, res.Status)
	}
	return json.Unmarshal(envelope.Data, out)
}
