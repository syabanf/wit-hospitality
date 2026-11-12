package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/services"
)

// Refs of the order facts finance books, keyed by the order id.
func deliveredRef(orderID string) string { return "order-delivered:" + orderID }
func voidedRef(orderID string) string    { return "order-voided:" + orderID }

// OrderDelivered books the partner half of recordOrder (services.order.delivered.v1): Dr Service
// partner costs, Cr Payables to service partners per partner, sourced on the order. The payable
// lines name the partner, so the partner balances read them off the journals.
func (p Policies) OrderDelivered(ctx context.Context, e services.OrderBilled) error {
	date := e.On
	if date == "" {
		date = p.today()
	}
	if p.assertOpen(ctx, date) != nil {
		return nil
	}
	ref := deliveredRef(e.OrderID)
	if ok, err := p.seen(ctx, ref); err != nil || ok {
		return err
	}
	costs := make([]domain.PartnerCost, 0, len(e.PartnerCosts))
	for _, c := range e.PartnerCosts {
		costs = append(costs, domain.PartnerCost{PartnerID: c.PartnerID, Amount: c.Amount})
	}
	draft, err := domain.PartnerCostJournal(ptrOr(e.VillaID), e.OrderID, e.Number, date, costs)
	if err != nil || draft == nil {
		return err
	}
	j, err := p.writeJournal(ctx, draft, System)
	if err != nil {
		return err
	}
	return p.Repo.SaveRef(ctx, ref, RefJournal, j.ID)
}

// OrderVoided turns the delivery's partner cost entry around on the day of the void
// (services.order.voided.v1), as voidJournal does. Billing's folio_line.voided reverses the revenue.
func (p Policies) OrderVoided(ctx context.Context, e services.OrderBilled) error {
	date := e.On
	if date == "" {
		date = p.today()
	}
	if p.assertOpen(ctx, date) != nil {
		return nil
	}
	ref := voidedRef(e.OrderID)
	if ok, err := p.seen(ctx, ref); err != nil || ok {
		return err
	}
	_, id, ok, err := p.Repo.Ref(ctx, deliveredRef(e.OrderID))
	if err != nil || !ok {
		return err
	}
	have, err := p.Repo.JournalsOf(ctx, domain.SourceOrder, e.OrderID)
	if err != nil {
		return err
	}
	for _, d := range have {
		if d.ID != id {
			continue
		}
		turned := domain.Turned(d, date, e.Number+" voided: partner costs reversed")
		j, err := p.writeJournal(ctx, &turned, System)
		if err != nil {
			return err
		}
		return p.Repo.SaveRef(ctx, ref, RefJournal, j.ID)
	}
	return nil
}
