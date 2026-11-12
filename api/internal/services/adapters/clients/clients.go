// Package clients holds services' clients for the contexts it calls. Guests asks the guest context
// through its published client. The composition root answers billing's questions through
// bootstrap.servicesBilling; PendingBilling stands in only in a process without billing (a module
// test, the route list, a split service without BILLING_URL), where commands read seeded payment
// ids as paid, take today as the business date and the default discount limit, and refuse an
// order payment link.
package clients

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/services/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// Guests reads guest names through guest's published client. Client returns it once the
// composition root has built it, nil while no guest context runs.
type Guests struct {
	Client func() guest.Client
}

// Name returns the guest's full name.
func (g Guests) Name(ctx context.Context, guestID string) (string, error) {
	var c guest.Client
	if g.Client != nil {
		c = g.Client()
	}
	if c == nil {
		return "", command.NotAvailable("Guest profiles")
	}
	x, err := c.Guest(ctx, guestID)
	return x.Name, err
}

// PendingBilling stands in for the billing context.
type PendingBilling struct{}

const billing = "Billing"

// Payments is not available.
func (PendingBilling) Payments(context.Context, string) (command.Payments, error) {
	return command.Payments{}, command.NotAvailable(billing)
}

// BusinessDate is not available.
func (PendingBilling) BusinessDate(context.Context) (string, error) {
	return "", command.NotAvailable(billing)
}

// DiscountLimitPct is not available.
func (PendingBilling) DiscountLimitPct(context.Context) (float64, error) {
	return 0, command.NotAvailable(billing)
}

// PayOrders is not available: billing opens the QRIS link for an order bill.
func (PendingBilling) PayOrders(context.Context, reservation.Stay, []domain.ServiceOrder, int64, string) (json.RawMessage, error) {
	return nil, command.NotAvailable("Paying room service")
}
