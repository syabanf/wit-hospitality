package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/finance"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/services"
)

// orderSigner is who delivered or voided the order; System when the event names nobody.
func orderSigner(e services.OrderBilled) domain.Signer {
	if e.By == "" {
		return System
	}
	return domain.Signer{ID: e.ByID, Name: e.By, Role: e.ByRole}
}

// Refs of the order facts finance books, keyed by the order id.
func deliveredRef(orderID string) string { return "order-delivered:" + orderID }
func voidedRef(orderID string) string    { return "order-voided:" + orderID }

// SourcePartnerBill is the source type of a partner's bill for a delivered order; its source id is
// the order id, and finance.cash_out.decided.v1 tells services where each bill stands.
const SourcePartnerBill = "service_order"

// OrderDelivered is recordOrder with the partner bills of the mock's delivery
// (services.order.delivered.v1): one entry with each code's charge on the stay's receivable, its
// service and PB1 split out of the menu price, and Dr Service partner costs, Cr Payables to service
// partners per partner; then one bill per partner from the bank for approval. Billing posts no
// folio line for a delivery, so the revenue is booked here once.
func (p Policies) OrderDelivered(ctx context.Context, e services.OrderBilled) error {
	date := e.On
	if date == "" {
		date = p.today()
	}
	if err := p.partnerBills(ctx, e, date); err != nil {
		return err
	}
	if p.assertOpen(ctx, date) != nil {
		return nil
	}
	ref := deliveredRef(e.OrderID)
	if ok, err := p.seen(ctx, ref); err != nil || ok {
		return err
	}
	codes, err := p.Repo.Codes(ctx)
	if err != nil {
		return err
	}
	tax, err := p.Tax(ctx)
	if err != nil {
		return err
	}
	rates := tax.RatesOn(date)
	revenue := make([]domain.CodeLine, 0, len(e.Codes))
	for _, c := range e.Codes {
		revenue = append(revenue, domain.CodeLine{Code: c.Code, Account: domain.CodeAccount(codes, c.Code), TaxSplit: domain.InclusiveSplit(c.Amount, c.Code, rates)})
	}
	costs := make([]domain.PartnerCost, 0, len(e.PartnerCosts))
	for _, c := range e.PartnerCosts {
		costs = append(costs, domain.PartnerCost{PartnerID: c.PartnerID, Amount: c.Amount})
	}
	draft, err := domain.OrderJournal(domain.StayRef{BookingID: e.BookingID, VillaID: ptrOr(e.VillaID)}, e.OrderID, e.Number, date, revenue, costs)
	if err != nil || draft == nil {
		return err
	}
	j, err := p.writeJournal(ctx, draft, System)
	if err != nil {
		return err
	}
	return p.Repo.SaveRef(ctx, ref, RefJournal, j.ID)
}

// partnerBills writes each partner's bill as a cash-out from the bank submitted for approval, as
// the mock's delivery does; without a bank nothing is billed. Posting a bill pays its partner's
// payable down.
func (p Policies) partnerBills(ctx context.Context, e services.OrderBilled, date string) error {
	if len(e.PartnerCosts) == 0 {
		return nil
	}
	src := Source{Type: SourcePartnerBill, ID: e.OrderID}
	if done, err := p.written(ctx, src); err != nil || done {
		return err
	}
	accounts, err := p.Repo.Accounts(ctx)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(accounts, func(a domain.CashAccount) bool { return a.Kind == domain.Bank })
	if i < 0 {
		return nil
	}
	for _, c := range e.PartnerCosts {
		var names []string
		for _, l := range e.Lines {
			if l.PartnerID != nil && *l.PartnerID == c.PartnerID && l.UnitCost > 0 {
				names = append(names, l.Name)
			}
		}
		t := domain.Transaction{AccountID: accounts[i].ID, Kind: domain.CashOut, CategoryID: services.PartnerCostCategory, Amount: c.Amount, Date: date, LocationID: e.LocationID,
			VillaID: ptrOr(e.VillaID), UnitID: ptrOr(e.UnitID), BookingID: ptrOr(e.BookingID), Description: fmt.Sprintf("%s %s: %s", e.Number, c.PartnerName, strings.Join(names, ", ")),
			Reference: e.Number, Attachments: []domain.Attachment{}, Origin: "room_service"}
		partner := c.PartnerID
		if _, err := p.askFor(ctx, t, Entry{By: orderSigner(e), Source: &src, Link: &domain.EntryLink{PartnerID: &partner}}); err != nil {
			return err
		}
	}
	return nil
}

// OrderVoided withdraws the partner bills and turns the delivery's partner cost lines around on
// the day of the void (services.order.voided.v1), as voidDelivery does. Billing's
// folio_line.voided reverses the revenue.
func (p Policies) OrderVoided(ctx context.Context, e services.OrderBilled) error {
	date := e.On
	if date == "" {
		date = p.today()
	}
	if err := p.withdrawBills(ctx, e, date); err != nil {
		return err
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
		turned.Lines = slices.DeleteFunc(turned.Lines, func(l domain.JournalLine) bool {
			return l.AccountID != domain.GLPartnerCost && l.AccountID != domain.GLPartnerPayable
		})
		if len(turned.Lines) == 0 {
			return p.Repo.SaveRef(ctx, ref, RefJournal, "")
		}
		j, err := p.writeJournal(ctx, &turned, System)
		if err != nil {
			return err
		}
		return p.Repo.SaveRef(ctx, ref, RefJournal, j.ID)
	}
	return nil
}

// withdrawBills rejects the order's partner bills still waiting, with the mock's wording. A posted
// bill stays: services refuses the void of an order whose bill is paid.
func (p Policies) withdrawBills(ctx context.Context, e services.OrderBilled, date string) error {
	bills, err := p.Repo.BySource(ctx, Source{Type: SourcePartnerBill, ID: e.OrderID})
	if err != nil {
		return err
	}
	reason, by := e.Number+" voided", orderSigner(e)
	for _, t := range bills {
		if t.Status != domain.Submitted && t.Status != domain.Approved && t.Status != domain.Draft {
			continue
		}
		t.Status, t.RejectionReason = domain.Rejected, &reason
		t.History = append(t.History, domain.Event("rejected", by, date, reason+": "+e.Reason))
		if err := p.Repo.UpdateTransaction(ctx, &t); err != nil {
			return err
		}
		if err := p.decided(ctx, t); err != nil {
			return err
		}
		if err := p.entryEvent(ctx, finance.EventEntryRejected, t, by); err != nil {
			return err
		}
	}
	return nil
}
