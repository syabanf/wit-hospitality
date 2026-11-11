package bootstrap

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	servicesclients "github.com/syabanf/wit-hospitality/api/internal/services/adapters/clients"
	servicescommand "github.com/syabanf/wit-hospitality/api/internal/services/app/command"
	servicesdomain "github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// servicesBilling answers services' questions about money through billing's client: payment
// states, rebates and the open order link, the business date, the discount limit of the payment
// policy, and the guest's QRIS link. Without billing it answers as services' PendingBilling.
type servicesBilling struct {
	client func() billing.Client
}

var _ servicescommand.Billing = servicesBilling{}

func (s servicesBilling) billing() billing.Client {
	if s.client == nil {
		return nil
	}
	return s.client()
}

// Payments reads billing's view of the stay's room service money.
func (s servicesBilling) Payments(ctx context.Context, bookingID string) (servicescommand.Payments, error) {
	c := s.billing()
	if c == nil {
		return servicesclients.PendingBilling{}.Payments(ctx, bookingID)
	}
	p, err := c.OrderPayments(ctx, bookingID)
	return servicescommand.Payments{Status: p.Status, Rebated: p.Rebated, PayToken: p.PayToken}, err
}

// BusinessDate is billing's business date.
func (s servicesBilling) BusinessDate(ctx context.Context) (string, error) {
	c := s.billing()
	if c == nil {
		return servicesclients.PendingBilling{}.BusinessDate(ctx)
	}
	return c.BusinessDate(ctx)
}

// DiscountLimitPct is the payment policy's discount limit.
func (s servicesBilling) DiscountLimitPct(ctx context.Context) (float64, error) {
	c := s.billing()
	if c == nil {
		return servicesclients.PendingBilling{}.DiscountLimitPct(ctx)
	}
	p, err := c.Policy(ctx)
	return p.DiscountLimitPct, err
}

// PayOrders asks billing for the guest's room service link; billing works out what is unpaid from
// its own copy of the orders and payments.
func (s servicesBilling) PayOrders(ctx context.Context, stay reservation.Stay, orders []servicesdomain.ServiceOrder, amount int64, payer string) (json.RawMessage, error) {
	c := s.billing()
	if c == nil {
		return servicesclients.PendingBilling{}.PayOrders(ctx, stay, orders, amount, payer)
	}
	return c.PayOrders(ctx, stay.ID, payer)
}
