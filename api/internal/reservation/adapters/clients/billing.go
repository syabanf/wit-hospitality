package clients

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// Billing asks the billing context through its published client, passing stays and groups in the
// console's shape. Client returns the client once the composition root has built it, nil while no
// billing context runs; every call then answers NOT_AVAILABLE as PendingBilling does.
type Billing struct {
	Client func() billing.Client
}

func (b Billing) client() billing.Client {
	if b.Client == nil {
		return nil
	}
	return b.Client()
}

func stays(list []domain.Booking) []json.RawMessage {
	out := make([]json.RawMessage, len(list))
	for i, s := range list {
		out[i], _ = json.Marshal(s)
	}
	return out
}

func raw(v any) json.RawMessage {
	out, _ := json.Marshal(v)
	return out
}

// Owed is the room the stay still owes.
func (b Billing) Owed(ctx context.Context, s domain.Booking) (int64, error) {
	c := b.client()
	if c == nil {
		return PendingBilling{}.Owed(ctx, s)
	}
	return c.Owed(ctx, raw(s))
}

// CheckOutHold refuses a check-out the folio holds.
func (b Billing) CheckOutHold(ctx context.Context, s domain.Booking) error {
	c := b.client()
	if c == nil {
		return PendingBilling{}.CheckOutHold(ctx, s)
	}
	return c.CheckOutHold(ctx, raw(s))
}

// Settle takes the bill at check-out.
func (b Billing) Settle(ctx context.Context, p auth.Principal, s domain.Booking, input json.RawMessage) (json.RawMessage, error) {
	c := b.client()
	if c == nil {
		return PendingBilling{}.Settle(ctx, p, s, input)
	}
	return c.Settle(ctx, p, raw(s), input)
}

// GroupPayment takes one payment over the group's stays.
func (b Billing) GroupPayment(ctx context.Context, p auth.Principal, g domain.BookingGroup, list []domain.Booking, input json.RawMessage) (json.RawMessage, error) {
	c := b.client()
	if c == nil {
		return PendingBilling{}.GroupPayment(ctx, p, g, list, input)
	}
	return c.GroupPayment(ctx, p, raw(g), stays(list), input)
}

// PayBalance opens the balance link from the public check-in page.
func (b Billing) PayBalance(ctx context.Context, s domain.Booking, method string) (json.RawMessage, error) {
	c := b.client()
	if c == nil {
		return PendingBilling{}.PayBalance(ctx, s, method)
	}
	return c.PayBalance(ctx, raw(s), method)
}

// CityLedger checks who pays the stays.
func (b Billing) CityLedger(ctx context.Context, p auth.Principal, input json.RawMessage, source string, list []domain.Booking) (json.RawMessage, error) {
	c := b.client()
	if c == nil {
		return PendingBilling{}.CityLedger(ctx, p, input, source, list)
	}
	return c.CityLedger(ctx, p, input, source, stays(list))
}

// BillingSettings reads the payment policy and today's tax rates from billing, the TypeScript
// defaults while no billing runs.
type BillingSettings struct {
	Client func() billing.Client
}

// Policy returns billing's policy.
func (s BillingSettings) Policy(ctx context.Context) (domain.Policy, error) {
	var c billing.Client
	if s.Client != nil {
		c = s.Client()
	}
	if c == nil {
		return DefaultSettings{}.Policy(ctx)
	}
	p, err := c.Policy(ctx)
	return domain.Policy{DepositPct: p.DepositPct, FreeCancelDays: p.FreeCancelDays, DiscountLimitPct: p.DiscountLimitPct, DirectMode: p.DirectMode,
		ServicePct: p.ServicePct, PB1Pct: p.PB1Pct, PB1OnService: p.PB1OnService}, err
}
