package finance

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/owners"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Client is what billing, owners, payroll, maintenance and inventory ask finance. The
// composition root hands a consumer the in-process implementation (finance/module) in the
// monolith and HTTPClient in split mode.
type Client interface {
	// Entries lists the cash entries written for a source record, oldest first; empty when none.
	Entries(ctx context.Context, src Source) ([]Entry, error)
	// ApprovalStatus is where the record finance made from the fact named ref (a payment, refund,
	// city ledger payment, write-off or payout request id) stands: submitted, approved, posted,
	// rejected or reversed; submitted while finance has not booked it yet.
	ApprovalStatus(ctx context.Context, ref string) (string, error)
	// AssertOpen refuses a date in a month finance closed with PERIOD_CLOSED.
	AssertOpen(ctx context.Context, date string) error
	// CashAccounts lists the cashboxes, the bank and the petty cash.
	CashAccounts(ctx context.Context) ([]CashAccount, error)
	// ShiftCash is the cash in and out the entries stamped with a cashier shift moved through its
	// cashbox.
	ShiftCash(ctx context.Context, shiftID, accountID string) (ShiftCash, error)
	// ProofPolicy is the receipt rule, so a context can ask for the receipt before it publishes a
	// hand-written cash-out.
	ProofPolicy(ctx context.Context) (ProofPolicy, error)
	// BilledServiceCharge is what the folio billed onto Service charge payable (2400) in a month
	// ("YYYY-MM") across every villa; payroll shares it out as the service charge pool.
	BilledServiceCharge(ctx context.Context, month string) (int64, error)
	// VillaBooks is a villa's month in the books: its posted entries with their role in the villa
	// P&L, its share of the month's closed payroll and how many entries still wait.
	VillaBooks(ctx context.Context, villaID, month string) (VillaBooks, error)
}

// CashAccount is a cash account as other contexts see it.
type CashAccount struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"`
	LocationID *string `json:"locationId"`
}

// ShiftCash is the cash a shift moved.
type ShiftCash struct {
	In  int64 `json:"in"`
	Out int64 `json:"out"`
}

// VillaBooks answers Client.VillaBooks.
type VillaBooks struct {
	Entries []owners.ResultEntry `json:"entries"`
	Payroll int64                `json:"payroll"`
	Pending int                  `json:"pending"`
}

// ProofPolicy is the receipt rule: cash-outs from Threshold need proof; 0 switches it off.
type ProofPolicy struct {
	Threshold int64 `json:"threshold"`
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
	err := h.get(ctx, "/entries", url.Values{"sourceType": {src.Type}, "sourceId": {src.ID}}, &out)
	return out, err
}

// ApprovalStatus calls GET /internal/v1/finance/approval-status?ref=.
func (h HTTPClient) ApprovalStatus(ctx context.Context, ref string) (string, error) {
	var out struct {
		Status string `json:"status"`
	}
	err := h.get(ctx, "/approval-status", url.Values{"ref": {ref}}, &out)
	return out.Status, err
}

// AssertOpen calls GET /internal/v1/finance/open-period?date=, which answers 204 or PERIOD_CLOSED.
func (h HTTPClient) AssertOpen(ctx context.Context, date string) error {
	return h.get(ctx, "/open-period", url.Values{"date": {date}}, nil)
}

// CashAccounts calls GET /internal/v1/finance/cash-accounts.
func (h HTTPClient) CashAccounts(ctx context.Context) ([]CashAccount, error) {
	var out []CashAccount
	err := h.get(ctx, "/cash-accounts", nil, &out)
	return out, err
}

// ShiftCash calls GET /internal/v1/finance/shift-cash?shiftId=&accountId=.
func (h HTTPClient) ShiftCash(ctx context.Context, shiftID, accountID string) (ShiftCash, error) {
	var out ShiftCash
	err := h.get(ctx, "/shift-cash", url.Values{"shiftId": {shiftID}, "accountId": {accountID}}, &out)
	return out, err
}

// ProofPolicy calls GET /internal/v1/finance/proof-policy.
func (h HTTPClient) ProofPolicy(ctx context.Context) (ProofPolicy, error) {
	var out ProofPolicy
	err := h.get(ctx, "/proof-policy", nil, &out)
	return out, err
}

// BilledServiceCharge calls GET /internal/v1/finance/service-charge?month=.
func (h HTTPClient) BilledServiceCharge(ctx context.Context, month string) (int64, error) {
	var out struct {
		Amount int64 `json:"amount"`
	}
	err := h.get(ctx, "/service-charge", url.Values{"month": {month}}, &out)
	return out.Amount, err
}

// VillaBooks calls GET /internal/v1/finance/villa-books?villaId=&month=.
func (h HTTPClient) VillaBooks(ctx context.Context, villaID, month string) (VillaBooks, error) {
	var out VillaBooks
	err := h.get(ctx, "/villa-books", url.Values{"villaId": {villaID}, "month": {month}}, &out)
	return out, err
}

func (h HTTPClient) get(ctx context.Context, path string, q url.Values, out any) error {
	target := h.BaseURL + "/internal/v1/finance" + path
	if len(q) > 0 {
		target += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
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
	if res.StatusCode == http.StatusNoContent {
		return nil
	}
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
	if out == nil {
		return nil
	}
	return json.Unmarshal(envelope.Data, out)
}
