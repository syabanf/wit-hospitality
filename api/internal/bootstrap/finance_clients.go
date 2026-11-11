package bootstrap

import (
	"context"

	billingcommand "github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/finance"
	"github.com/syabanf/wit-hospitality/api/internal/owners"
)

// billingFinance answers billing's command.Finance from the finance client. Billing is built before
// finance, so it reads the client late; a process without finance falls back to billing's own
// PendingFinance.
type billingFinance struct {
	client  func() finance.Client
	pending billingcommand.Finance
}

func (b billingFinance) ApprovalStatus(ctx context.Context, ref string) (string, error) {
	if c := b.client(); c != nil {
		return c.ApprovalStatus(ctx, ref)
	}
	return b.pending.ApprovalStatus(ctx, ref)
}

func (b billingFinance) AssertOpen(ctx context.Context, date string) error {
	if c := b.client(); c != nil {
		return c.AssertOpen(ctx, date)
	}
	return b.pending.AssertOpen(ctx, date)
}

func (b billingFinance) CashAccounts(ctx context.Context) ([]billingcommand.CashAccount, error) {
	c := b.client()
	if c == nil {
		return b.pending.CashAccounts(ctx)
	}
	list, err := c.CashAccounts(ctx)
	out := make([]billingcommand.CashAccount, 0, len(list))
	for _, a := range list {
		out = append(out, billingcommand.CashAccount{ID: a.ID, Name: a.Name, Kind: a.Kind, LocationID: a.LocationID})
	}
	return out, err
}

func (b billingFinance) ShiftCash(ctx context.Context, shiftID, accountID string) (int64, int64, bool, error) {
	c := b.client()
	if c == nil {
		return b.pending.ShiftCash(ctx, shiftID, accountID)
	}
	cash, err := c.ShiftCash(ctx, shiftID, accountID)
	return cash.In, cash.Out, err == nil, err
}

// villaResults is owners.Results: the stays from owners' own copy of reservation's bookings (the
// stub's room rules) and the entries, payroll and pending count from finance.
type villaResults struct {
	stays   owners.Results
	finance finance.Client
}

func (v villaResults) VillaResults(ctx context.Context, villaID, month string) (owners.VillaResult, error) {
	out, err := v.stays.VillaResults(ctx, villaID, month)
	if err != nil {
		return out, err
	}
	books, err := v.finance.VillaBooks(ctx, villaID, month)
	if err != nil {
		return out, err
	}
	out.Entries, out.Payroll, out.Pending = books.Entries, books.Payroll, books.Pending
	if out.Entries == nil {
		out.Entries = []owners.ResultEntry{}
	}
	return out, nil
}
