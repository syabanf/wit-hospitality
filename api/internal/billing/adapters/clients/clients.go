// Package clients holds billing's clients for the contexts it calls. Guests and Reservation call
// those contexts through their published clients. Finance, services (orders) and people (roster)
// are built in parallel; until the composition root swaps their clients in, PendingFinance answers
// with billing's own copies, NoOrders reports no room service and NoRoster no roster.
package clients

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// PendingFinance stands in for the finance context: every entry finance would make from a fact is
// submitted, every month is open, the cash accounts are the demo seed's, and the shift's cash is
// counted from billing's own cash payments.
type PendingFinance struct{ Store command.Store }

// ApprovalStatus answers submitted.
func (PendingFinance) ApprovalStatus(context.Context, string) (string, error) { return "submitted", nil }

// AssertOpen lets every date through.
func (PendingFinance) AssertOpen(context.Context, string) error { return nil }

// CashAccounts reads the seed's cash accounts.
func (f PendingFinance) CashAccounts(ctx context.Context) ([]command.CashAccount, error) {
	rows, err := f.Store.All(ctx, command.CashAccounts)
	if err != nil {
		return nil, err
	}
	out := make([]command.CashAccount, 0, len(rows))
	for _, r := range rows {
		var a command.CashAccount
		if err := json.Unmarshal(r.Doc, &a); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

// ShiftCash does not answer.
func (PendingFinance) ShiftCash(context.Context, string, string) (int64, int64, bool, error) {
	return 0, 0, false, nil
}

// Guests names guests through guest's published client; Client returns nil while no guest runs.
type Guests struct {
	Client func() guest.Client
}

// Name is the guest's name; an unknown guest has none.
func (g Guests) Name(ctx context.Context, guestID string) (string, error) {
	if g.Client == nil || g.Client() == nil {
		return "", nil
	}
	x, err := g.Client().Guest(ctx, guestID)
	if errs.HasCode(err, errs.CodeNotFound) {
		return "", nil
	}
	return x.Name, err
}

// NoOrders reports no room service until services publishes its orders.
type NoOrders struct{}

// StayOrders answers none.
func (NoOrders) StayOrders(context.Context, string) ([]domain.Order, error) { return nil, nil }

// NoRoster reports nobody rostered until people answers; managers still open shifts.
type NoRoster struct{}

// Rostered answers false.
func (NoRoster) Rostered(context.Context, string, string) (bool, error) { return false, nil }

// CheckOut closes a stay through reservation.
type CheckOut func(ctx context.Context, p auth.Principal, bookingID string, details json.RawMessage) error

// Reservation reaches reservation's check-out; Func returns nil while no reservation runs here.
type Reservation struct {
	Func func() CheckOut
}

// CheckOut closes the stay whose check-out link the guest paid.
func (r Reservation) CheckOut(ctx context.Context, p auth.Principal, bookingID string, details domain.Departure) error {
	var fn CheckOut
	if r.Func != nil {
		fn = r.Func()
	}
	if fn == nil {
		return errs.New("NOT_AVAILABLE", "Reservation is not available in this API yet.")
	}
	raw, err := json.Marshal(details)
	if err != nil {
		return err
	}
	return fn(ctx, p, bookingID, raw)
}

// ReservationHTTP checks a stay out through reservation's /internal/v1/stays/{id}/check-out.
type ReservationHTTP struct {
	BaseURL string
	Token   string
}

// CheckOut posts the check-out with the principal.
func (h ReservationHTTP) CheckOut(ctx context.Context, p auth.Principal, bookingID string, details json.RawMessage) error {
	raw, err := json.Marshal(map[string]any{"principal": p, "details": details})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.BaseURL+"/internal/v1/stays/"+bookingID+"/check-out", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("X-Internal-Token", h.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 300 {
		return nil
	}
	var envelope struct {
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.NewDecoder(res.Body).Decode(&envelope) == nil && envelope.Error != nil {
		return errs.New(envelope.Error.Code, envelope.Error.Message)
	}
	return fmt.Errorf("reservation check-out %s: %s", bookingID, res.Status)
}
