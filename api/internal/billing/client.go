package billing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Client is what reservation and services ask the billing context. Stays, groups and orders travel
// as the console's JSON (Booking, BookingGroup, ServiceOrder), so a caller can pass a record it has
// not committed yet. The composition root hands a consumer the in-process implementation
// (billing/module) in the monolith and HTTPClient in split mode. Refusals come back as *errs.Error
// with billing's codes and wording.
type Client interface {
	// Owed is what a direct stay still owes on its room: the stay's total with tax less the money in
	// and what moved to a city ledger account.
	Owed(ctx context.Context, stay json.RawMessage) (int64, error)
	// CheckOutHold refuses a plain check-out the folio holds: SETTLEMENT_PENDING, SERVICE_UNPAID,
	// GROUP_MASTER_OPEN, FOLIO_UNSETTLED.
	CheckOutHold(ctx context.Context, stay json.RawMessage) error
	// Settle takes the bill at check-out (SettleInput) and returns the check-out link, or null when
	// the desk took the money and the stay may close.
	Settle(ctx context.Context, p auth.Principal, stay, input json.RawMessage) (json.RawMessage, error)
	// GroupPayment takes one payment (GroupPaymentInput) over the group's stays in order, each up to
	// what it owes, and returns { payments, link }.
	GroupPayment(ctx context.Context, p auth.Principal, group json.RawMessage, stays []json.RawMessage, input json.RawMessage) (json.RawMessage, error)
	// PayBalance opens, or returns the open, gateway link for the room balance from the public
	// check-in page.
	PayBalance(ctx context.Context, stay json.RawMessage, method string) (json.RawMessage, error)
	// CityLedger checks a CityLedgerBillingInput against the account and its credit for the stays
	// and returns the CityLedgerBilling the stays carry; source is the booking's source.
	CityLedger(ctx context.Context, p auth.Principal, input json.RawMessage, source string, stays []json.RawMessage) (json.RawMessage, error)
	// Policy is the payment policy and the tax rates in force today.
	Policy(ctx context.Context) (Policy, error)
	// OrderPayments is what services reads for its orders: each payment's status, what rebates and
	// transfers took off each order, and the stay's open room service link.
	OrderPayments(ctx context.Context, bookingID string) (OrderPayments, error)
	// BusinessDate is the day the night audit has not closed yet; services voids a delivery only on it.
	BusinessDate(ctx context.Context) (string, error)
	// PayOrders opens, or returns the open, QRIS link for the stay's delivered and unpaid orders, as
	// the guest asks from the QR card; ORDER_NOT_BILLABLE when nothing waits to be paid.
	PayOrders(ctx context.Context, bookingID, payer string) (json.RawMessage, error)
	// Invoice is the stay's invoice in the console's InvoiceView shape, for the public e-invoice
	// link messaging serves.
	Invoice(ctx context.Context, bookingID string) (json.RawMessage, error)
}

// OrderPayments is billing's view of a stay's room service money.
type OrderPayments struct {
	Status   map[string]string `json:"status"`
	Rebated  map[string]int64  `json:"rebated"`
	PayToken string            `json:"payToken"`
}

// Policy is what reservation reads of the payment policy and the tax settings.
type Policy struct {
	DepositPct       float64 `json:"depositPct"`
	FreeCancelDays   int     `json:"freeCancelDays"`
	DiscountLimitPct float64 `json:"discountLimitPct"`
	DirectMode       string  `json:"directMode"`
	ServicePct       float64 `json:"servicePct"`
	PB1Pct           float64 `json:"pb1Pct"`
	PB1OnService     bool    `json:"pb1OnService"`
}

// HTTPClient calls the billing service's /internal/v1/billing routes with INTERNAL_TOKEN. The caller's
// principal travels in the body, so billing checks the same permissions as in process.
type HTTPClient struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Call is the body of every internal billing route.
type Call struct {
	Principal *auth.Principal   `json:"principal,omitempty"`
	Stay      json.RawMessage   `json:"stay,omitempty"`
	Group     json.RawMessage   `json:"group,omitempty"`
	Stays     []json.RawMessage `json:"stays,omitempty"`
	BookingID string            `json:"bookingId,omitempty"`
	Payer     string            `json:"payer,omitempty"`
	Input     json.RawMessage   `json:"input,omitempty"`
	Method    string            `json:"method,omitempty"`
	Source    string            `json:"source,omitempty"`
}

// Owed calls POST /internal/v1/billing/owed.
func (h HTTPClient) Owed(ctx context.Context, stay json.RawMessage) (int64, error) {
	var out struct {
		Owed int64 `json:"owed"`
	}
	err := h.post(ctx, "/owed", Call{Stay: stay}, &out)
	return out.Owed, err
}

// CheckOutHold calls POST /internal/v1/billing/check-out-hold.
func (h HTTPClient) CheckOutHold(ctx context.Context, stay json.RawMessage) error {
	return h.post(ctx, "/check-out-hold", Call{Stay: stay}, nil)
}

// Settle calls POST /internal/v1/billing/settle.
func (h HTTPClient) Settle(ctx context.Context, p auth.Principal, stay, input json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := h.post(ctx, "/settle", Call{Principal: &p, Stay: stay, Input: input}, &out)
	return out, err
}

// GroupPayment calls POST /internal/v1/billing/group-payments.
func (h HTTPClient) GroupPayment(ctx context.Context, p auth.Principal, group json.RawMessage, stays []json.RawMessage, input json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := h.post(ctx, "/group-payments", Call{Principal: &p, Group: group, Stays: stays, Input: input}, &out)
	return out, err
}

// PayBalance calls POST /internal/v1/billing/pay-balance.
func (h HTTPClient) PayBalance(ctx context.Context, stay json.RawMessage, method string) (json.RawMessage, error) {
	var out json.RawMessage
	err := h.post(ctx, "/pay-balance", Call{Stay: stay, Method: method}, &out)
	return out, err
}

// CityLedger calls POST /internal/v1/billing/city-ledger.
func (h HTTPClient) CityLedger(ctx context.Context, p auth.Principal, input json.RawMessage, source string, stays []json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := h.post(ctx, "/city-ledger", Call{Principal: &p, Input: input, Source: source, Stays: stays}, &out)
	return out, err
}

// Policy calls POST /internal/v1/billing/policy.
func (h HTTPClient) Policy(ctx context.Context) (Policy, error) {
	var out Policy
	err := h.post(ctx, "/policy", Call{}, &out)
	return out, err
}

// OrderPayments calls POST /internal/v1/billing/order-payments.
func (h HTTPClient) OrderPayments(ctx context.Context, bookingID string) (OrderPayments, error) {
	var out OrderPayments
	err := h.post(ctx, "/order-payments", Call{BookingID: bookingID}, &out)
	return out, err
}

// BusinessDate calls POST /internal/v1/billing/business-date.
func (h HTTPClient) BusinessDate(ctx context.Context) (string, error) {
	var out struct {
		Date string `json:"date"`
	}
	err := h.post(ctx, "/business-date", Call{}, &out)
	return out.Date, err
}

// PayOrders calls POST /internal/v1/billing/pay-orders.
func (h HTTPClient) PayOrders(ctx context.Context, bookingID, payer string) (json.RawMessage, error) {
	var out json.RawMessage
	err := h.post(ctx, "/pay-orders", Call{BookingID: bookingID, Payer: payer}, &out)
	return out, err
}

// Invoice calls POST /internal/v1/billing/invoice.
func (h HTTPClient) Invoice(ctx context.Context, bookingID string) (json.RawMessage, error) {
	var out json.RawMessage
	err := h.post(ctx, "/invoice", Call{BookingID: bookingID}, &out)
	return out, err
}

func (h HTTPClient) post(ctx context.Context, path string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.BaseURL+"/internal/v1/billing"+path, bytes.NewReader(raw))
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
		return fmt.Errorf("billing %s: %s: %w", path, res.Status, err)
	}
	if envelope.Error != nil {
		e := errs.New(envelope.Error.Code, envelope.Error.Message)
		for field, msg := range envelope.Error.Fields {
			e.Fields = append(e.Fields, errs.FieldError{Field: field, Message: msg})
		}
		return e
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("billing %s: %s", path, res.Status)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(envelope.Data, out)
}
