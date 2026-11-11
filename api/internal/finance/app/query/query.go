// Package query holds the finance context's read side. Every read comes from the finance
// schema's write tables, consistent at once, in the console's JSON shape and order, narrowed to the
// signed-in user's villa and location scope the way the console's financeWorld and books() narrow.
package query

import (
	"context"
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/finance"
	"github.com/syabanf/wit-hospitality/api/internal/finance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Queries bundles the read handlers.
type Queries struct {
	Deps command.Deps
}

func (q Queries) repo() command.Repository { return q.Deps.Repo }

func (q Queries) scope(ctx context.Context) (domain.Scope, auth.Principal, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return domain.Scope{}, p, err
	}
	places, err := q.repo().Places(ctx)
	return domain.Scope{Scope: p.Scope(), Places: places}, p, err
}

func signedIn(ctx context.Context) error {
	_, err := auth.Require(ctx)
	return err
}

func nonNil[T any](v []T) []T {
	if v == nil {
		return []T{}
	}
	return v
}

// Accounts is GET /cash-accounts: petty cash follows its villa, a cashbox its location.
func (q Queries) Accounts(ctx context.Context) ([]domain.CashAccount, error) {
	sc, _, err := q.scope(ctx)
	if err != nil {
		return nil, err
	}
	all, err := q.repo().Accounts(ctx)
	out := []domain.CashAccount{}
	for _, a := range all {
		if sc.Account(a) {
			out = append(out, a)
		}
	}
	return out, err
}

// Categories is GET /categories.
func (q Queries) Categories(ctx context.Context) ([]domain.Category, error) {
	if err := signedIn(ctx); err != nil {
		return nil, err
	}
	out, err := q.repo().Categories(ctx)
	return nonNil(out), err
}

func (q Queries) accountMap(ctx context.Context) (map[string]domain.CashAccount, error) {
	all, err := q.repo().Accounts(ctx)
	m := map[string]domain.CashAccount{}
	for _, a := range all {
		m[a.ID] = a
	}
	return m, err
}

// Transactions is GET /transactions: entries at a location in scope on an account in scope.
func (q Queries) Transactions(ctx context.Context) ([]domain.Transaction, error) {
	sc, _, err := q.scope(ctx)
	if err != nil {
		return nil, err
	}
	accounts, err := q.accountMap(ctx)
	if err != nil {
		return nil, err
	}
	all, err := q.repo().Transactions(ctx)
	out := []domain.Transaction{}
	for _, t := range all {
		if sc.Transaction(t, accounts) {
			out = append(out, t)
		}
	}
	return out, err
}

// Reconciliations is GET /reconciliations: counts of accounts in scope.
func (q Queries) Reconciliations(ctx context.Context) ([]domain.Reconciliation, error) {
	sc, _, err := q.scope(ctx)
	if err != nil {
		return nil, err
	}
	accounts, err := q.accountMap(ctx)
	if err != nil {
		return nil, err
	}
	all, err := q.repo().Reconciliations(ctx)
	out := []domain.Reconciliation{}
	for _, r := range all {
		if a, ok := accounts[r.AccountID]; ok && sc.Account(a) {
			out = append(out, r)
		}
	}
	return out, err
}

// Rules is GET /approval-rules.
func (q Queries) Rules(ctx context.Context) ([]domain.ApprovalRule, error) {
	if err := signedIn(ctx); err != nil {
		return nil, err
	}
	out, err := q.repo().Rules(ctx)
	return nonNil(out), err
}

// ProofPolicy is GET /settings/proof-policy.
func (q Queries) ProofPolicy(ctx context.Context) (domain.ProofPolicy, error) {
	if err := signedIn(ctx); err != nil {
		return domain.ProofPolicy{}, err
	}
	return q.Deps.ProofPolicy(ctx)
}

// Chart is GET /ledger/accounts: every cash account mirrored, then the base chart.
func (q Queries) Chart(ctx context.Context) ([]domain.GlAccount, error) {
	if err := signedIn(ctx); err != nil {
		return nil, err
	}
	all, err := q.repo().Accounts(ctx)
	return domain.ChartOfAccounts(all), err
}

// CategoryAccounts is GET /ledger/category-accounts.
func (q Queries) CategoryAccounts(ctx context.Context) (map[string]string, error) {
	if err := signedIn(ctx); err != nil {
		return nil, err
	}
	return q.Deps.CategoryMap(ctx)
}

// Codes is GET /ledger/transaction-codes.
func (q Queries) Codes(ctx context.Context) ([]domain.TransactionCode, error) {
	if err := signedIn(ctx); err != nil {
		return nil, err
	}
	out, err := q.repo().Codes(ctx)
	return nonNil(out), err
}

// Tax is GET /ledger/tax-settings.
func (q Queries) Tax(ctx context.Context) (domain.TaxSettings, error) {
	if err := signedIn(ctx); err != nil {
		return domain.TaxSettings{}, err
	}
	return q.Deps.Tax(ctx)
}

func (q Queries) viewsBooks(ctx context.Context, p auth.Principal) (bool, error) {
	perms, err := q.Deps.Authz.Source.Permissions(ctx)
	return rbac.Can(perms, p.Role, "finance", "view"), err
}

// Journals is GET /ledger/journals. Without finance/view the list is empty: the room service
// menu reads it for everyone and shows partner balances only to those who see the books.
func (q Queries) Journals(ctx context.Context) ([]domain.JournalEntry, error) {
	sc, p, err := q.scope(ctx)
	if err != nil {
		return nil, err
	}
	if ok, err := q.viewsBooks(ctx, p); err != nil || !ok {
		return []domain.JournalEntry{}, err
	}
	all, err := q.repo().Journals(ctx)
	out := []domain.JournalEntry{}
	for _, e := range all {
		if sc.Journal(e.VillaID) {
			out = append(out, e)
		}
	}
	return out, err
}

// ManualJournals is GET /ledger/manual-journals: portfolio journals and those of villas in scope.
func (q Queries) ManualJournals(ctx context.Context) ([]domain.ManualJournal, error) {
	sc, p, err := q.scope(ctx)
	if err != nil {
		return nil, err
	}
	if ok, err := q.viewsBooks(ctx, p); err != nil || !ok {
		return []domain.ManualJournal{}, err
	}
	all, err := q.repo().ManualJournals(ctx)
	out := []domain.ManualJournal{}
	for _, m := range all {
		if m.VillaID == nil || sc.VillaSeen(*m.VillaID) {
			out = append(out, m)
		}
	}
	return out, err
}

// Periods is GET /ledger/periods: the closed months, oldest first.
func (q Queries) Periods(ctx context.Context) ([]domain.PeriodClose, error) {
	if err := signedIn(ctx); err != nil {
		return nil, err
	}
	out, err := q.repo().PeriodCloses(ctx)
	return nonNil(out), err
}

// Budgets is GET /budgets: the budgets of villas in scope.
func (q Queries) Budgets(ctx context.Context) ([]domain.Budget, error) {
	sc, _, err := q.scope(ctx)
	if err != nil {
		return nil, err
	}
	all, err := q.repo().Budgets(ctx)
	out := []domain.Budget{}
	for _, b := range all {
		if sc.VillaSeen(b.VillaID) {
			out = append(out, b)
		}
	}
	return out, err
}

// Shifts is GET /cashier-shifts: drawers on cashboxes in scope.
func (q Queries) Shifts(ctx context.Context) ([]domain.CashierShift, error) {
	sc, _, err := q.scope(ctx)
	if err != nil {
		return nil, err
	}
	accounts, err := q.accountMap(ctx)
	if err != nil {
		return nil, err
	}
	all, err := q.repo().Shifts(ctx, false)
	out := []domain.CashierShift{}
	for _, s := range all {
		if a, ok := accounts[s.AccountID]; ok && sc.Account(a) {
			out = append(out, s)
		}
	}
	return out, err
}

// HandOvers is GET /cashier-shifts/hand-overs.
func (q Queries) HandOvers(ctx context.Context) ([]domain.HandOver, error) {
	sc, _, err := q.scope(ctx)
	if err != nil {
		return nil, err
	}
	accounts, err := q.accountMap(ctx)
	if err != nil {
		return nil, err
	}
	all, err := q.repo().HandOvers(ctx)
	out := []domain.HandOver{}
	for _, h := range all {
		if a, ok := accounts[h.AccountID]; ok && sc.Account(a) {
			out = append(out, h)
		}
	}
	return out, err
}

// ShiftPolicy is GET /cashier-shifts/policy.
func (q Queries) ShiftPolicy(ctx context.Context) (domain.ShiftPolicy, error) {
	if err := signedIn(ctx); err != nil {
		return domain.ShiftPolicy{}, err
	}
	return q.Deps.ShiftPolicy(ctx)
}

// Client is the in-process finance.Client.
type Client struct{ Queries }

var _ finance.Client = Client{}

// Entries lists the entries written for a source record.
func (c Client) Entries(ctx context.Context, src finance.Source) ([]finance.Entry, error) {
	list, err := c.repo().BySource(ctx, src)
	out := []finance.Entry{}
	for _, t := range list {
		out = append(out, finance.Entry{TransactionID: t.ID, Number: t.Number, Status: t.Status, Kind: t.Kind, CategoryID: t.CategoryID, AccountID: t.AccountID, Amount: t.Amount,
			Date: t.Date, LocationID: t.LocationID, VillaID: t.VillaID, BookingID: t.BookingID, Reference: t.Reference, RejectionReason: t.RejectionReason,
			ReversalOf: t.ReversalOf, ReversedBy: t.ReversedBy, Source: &finance.Source{Type: src.Type, ID: src.ID}})
	}
	return out, err
}

// ProofPolicy is the receipt rule.
func (c Client) ProofPolicy(ctx context.Context) (finance.ProofPolicy, error) {
	p, err := c.Deps.ProofPolicy(ctx)
	return finance.ProofPolicy{Threshold: p.Threshold}, err
}

// OpenShift is the shift open on the location's cashbox, nil when none.
func (c Client) OpenShift(ctx context.Context, locationID string) (*finance.Shift, error) {
	accounts, err := c.repo().Accounts(ctx)
	if err != nil {
		return nil, err
	}
	shifts, err := c.repo().Shifts(ctx, false)
	if err != nil {
		return nil, err
	}
	for _, a := range accounts {
		if a.Kind != domain.Cashbox || a.Location() != locationID {
			continue
		}
		if s := domain.OpenShiftOn(shifts, a.ID); s != nil {
			return &finance.Shift{ID: s.ID, Number: s.Number, AccountID: s.AccountID, CashierID: s.CashierID, CashierName: s.CashierName}, nil
		}
		return nil, nil
	}
	return nil, nil
}

// BilledServiceCharge is payableBilled on Service charge payable for the month across every
// villa: what the folio billed onto it, without the cash and payroll entries that pay it down.
func (c Client) BilledServiceCharge(ctx context.Context, month string) (int64, error) {
	entries, err := c.repo().Journals(ctx)
	var s int64
	for _, e := range entries {
		if domain.MonthOf(e.Date) != month || slices.Contains([]string{domain.SourceTransaction, domain.SourcePayroll}, e.Source) {
			continue
		}
		for _, l := range e.Lines {
			if l.AccountID == domain.GLServicePayable {
				s += l.Credit - l.Debit
			}
		}
	}
	return s, err
}
