package command

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/owners"
)

// StatementClosed writes the close entry owners worked out for a statement; StatementReopened
// writes its reversal. A statement's owner entries alternate close and reopen, so a replay writes
// nothing twice.
func (p Policies) StatementClosed(ctx context.Context, e owners.StatementEvent) error {
	return p.ownerJournal(ctx, e, 0)
}

// StatementReopened writes the reversal of the close entry on the same month end.
func (p Policies) StatementReopened(ctx context.Context, e owners.StatementEvent) error {
	return p.ownerJournal(ctx, e, 1)
}

func (p Policies) ownerJournal(ctx context.Context, e owners.StatementEvent, parity int) error {
	if len(e.Journal) == 0 {
		return nil
	}
	var d domain.JournalEntry
	if err := json.Unmarshal(e.Journal, &d); err != nil {
		return err
	}
	have, err := p.Repo.JournalsOf(ctx, domain.SourceOwner, d.SourceID)
	if err != nil || len(have)%2 != parity {
		return err
	}
	draft, err := domain.OwnerJournal(d)
	if err != nil {
		return err
	}
	_, err = p.writeJournal(ctx, draft, System)
	return err
}

// PayoutRequested submits the cash entry that settles an approved statement: the payout to the
// owner from the bank, or the owner's top-up. sourceRef keys it in every entry event.
func (p Policies) PayoutRequested(ctx context.Context, r owners.PayoutRequested) error {
	if ok, err := p.seen(ctx, r.SourceRef); err != nil || ok {
		return err
	}
	a, err := p.Repo.Account(ctx, r.AccountID, false)
	if err != nil {
		return nil
	}
	date := r.Date
	if date == "" {
		date = p.today()
	}
	kind := r.Kind
	if kind != domain.CashIn {
		kind = domain.CashOut
	}
	origin := r.Origin
	if origin == "" {
		origin = "owner_payout"
	}
	src := Source{Type: "owner_payout", ID: r.SourceRef}
	t, err := p.newEntry(ctx, domain.Transaction{AccountID: a.ID, Kind: kind, CategoryID: r.CategoryID, Amount: r.Amount, Date: date, LocationID: r.LocationID, VillaID: ptrOr(r.VillaID),
		Description: r.Description, Reference: r.Reference, Attachments: []domain.Attachment{}, Origin: origin}, Entry{Submit: true, By: System, Source: &src})
	if err != nil {
		return err
	}
	return p.Repo.SaveRef(ctx, r.SourceRef, RefTransaction, t.ID)
}

// villaRole is villaEntryRole: where a posted villa entry sits in the villa P&L.
func villaRole(t domain.Transaction) string {
	if !domain.Counts(t.Status) || slices.Contains([]string{"transfer", "adjustment", "reconciliation", "owner_payout"}, t.Origin) || t.ReversalOf != nil || t.ReversedBy != nil {
		return ""
	}
	if t.Kind == domain.CashIn {
		if slices.Contains([]string{"cat-room", "cat-airbnb", "cat-deposit"}, t.CategoryID) {
			return ""
		}
		return "other"
	}
	if t.Origin == "payroll" || (t.CategoryID == "cat-other" && t.BookingID != nil) {
		return ""
	}
	return "expense"
}

// VillaBooks is the finance part of owners.Results: the villa's posted entries in the month with
// their role in the villa P&L, its share of the month's closed payroll, and how many of its
// entries dated in the month still wait.
func (d Deps) VillaBooks(ctx context.Context, villaID, month string) ([]owners.ResultEntry, int64, int, error) {
	txs, err := d.Repo.Transactions(ctx)
	if err != nil {
		return nil, 0, 0, err
	}
	categories, err := d.Repo.Categories(ctx)
	if err != nil {
		return nil, 0, 0, err
	}
	name := map[string]string{}
	for _, c := range categories {
		name[c.ID] = c.Name
	}
	entries := []owners.ResultEntry{}
	pending := 0
	for _, t := range txs {
		if t.Villa() != villaID || domain.MonthOf(t.Date) != month {
			continue
		}
		if domain.AwaitsApproval(t.Status) {
			pending++
		}
		role := villaRole(t)
		if role == "" {
			continue
		}
		category := name[t.CategoryID]
		if category == "" {
			category = t.CategoryID
		}
		entries = append(entries, owners.ResultEntry{TransactionID: t.ID, Number: t.Number, Date: t.Date, Description: t.Description, Category: category,
			CategoryID: t.CategoryID, Origin: t.Origin, Role: role, Amount: t.Amount})
	}
	slices.SortStableFunc(entries, func(a, b owners.ResultEntry) int {
		if a.Date < b.Date {
			return -1
		}
		if a.Date > b.Date {
			return 1
		}
		return 0
	})
	payroll, err := d.Repo.PayrollCost(ctx, month, villaID)
	return entries, payroll, pending, err
}
