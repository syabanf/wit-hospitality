// Package query holds the billing context's reads. Billing serves its own records from the write
// tables, which are consistent at once, filtered to the caller's villa and location scope.
package query

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Reader is the part of the store reads use.
type Reader interface {
	All(ctx context.Context, table string) ([]command.Stored, error)
	Setting(ctx context.Context, key string) (json.RawMessage, error)
}

// Queries serves the billing reads.
type Queries struct {
	Store Reader
	Authz rbac.Authorizer
	// Expire turns overdue links expired before payments and links are read.
	Expire func(ctx context.Context) error
}

// Needs of the reads, from the application services.
var (
	financeView = []rbac.Need{{Module: "finance", Action: "view"}}
	shiftsView  = []rbac.Need{{Module: "finance", Action: "view"}, {Module: "payments", Action: "create"}}
	bookingView = []rbac.Need{{Module: "booking", Action: "view"}}
)

// scoped lists a table, keeping the rows inside the caller's scope; rows without a villa or a
// location belong to no one villa and stay.
func (q Queries) scoped(ctx context.Context, p auth.Principal, table string) ([]json.RawMessage, error) {
	rows, err := q.Store.All(ctx, table)
	if err != nil {
		return nil, err
	}
	out := []json.RawMessage{}
	scope := p.Scope()
	for _, r := range rows {
		if (r.VillaID == "" && r.LocationID == "") || scope.AllowedVilla(r.VillaID, r.LocationID) {
			out = append(out, r.Doc)
		}
	}
	return out, nil
}

// List is a table read: signed in, scoped, after the needs.
func (q Queries) List(ctx context.Context, p auth.Principal, table string) ([]json.RawMessage, error) {
	var needs []rbac.Need
	switch table {
	case command.Shifts, command.HandOvers:
		needs = shiftsView
	case command.Invoices, command.LedgerPayments, command.WriteOffs:
		needs = financeView
	case command.Audits:
		needs = bookingView
	case command.Payments, command.Links:
		if q.Expire != nil {
			if err := q.Expire(ctx); err != nil {
				return nil, err
			}
		}
	}
	if len(needs) > 0 {
		if err := q.Authz.Require(ctx, p.Role, needs...); err != nil {
			return nil, err
		}
	}
	return q.scoped(ctx, p, table)
}

// Transfers lists the postings that moved a bill to the city ledger. It needs finance/view.
func (q Queries) Transfers(ctx context.Context, p auth.Principal) ([]json.RawMessage, error) {
	if err := q.Authz.Require(ctx, p.Role, financeView...); err != nil {
		return nil, err
	}
	rows, err := q.scoped(ctx, p, command.Postings)
	if err != nil {
		return nil, err
	}
	out := []json.RawMessage{}
	for _, raw := range rows {
		var posting struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(raw, &posting) == nil && posting.Kind == domain.KindTransfer {
			out = append(out, raw)
		}
	}
	return out, nil
}

// Codes lists the transaction codes, the defaults until finance edits one.
func (q Queries) Codes(ctx context.Context) ([]json.RawMessage, error) {
	rows, err := q.Store.All(ctx, command.Codes)
	if err != nil {
		return nil, err
	}
	out := []json.RawMessage{}
	for _, r := range rows {
		out = append(out, r.Doc)
	}
	if len(out) == 0 {
		for _, c := range domain.DefaultTransactionCodes() {
			raw, _ := json.Marshal(c)
			out = append(out, raw)
		}
	}
	return out, nil
}

// Setting reads a setting, or its default.
func (q Queries) Setting(ctx context.Context, key string) (any, error) {
	raw, err := q.Store.Setting(ctx, key)
	if err != nil {
		return nil, err
	}
	if raw != nil {
		return raw, nil
	}
	switch key {
	case command.SettingPaymentPolicy:
		return domain.DefaultPolicy, nil
	case command.SettingShiftPolicy:
		return domain.DefaultShiftPolicy, nil
	case command.SettingTax:
		return domain.DefaultTaxSettings(), nil
	}
	return nil, errs.NotFound("setting", key)
}

// BusinessDate is the open business date: the day after the last audit, else today.
func (q Queries) BusinessDate(ctx context.Context, today string) (string, error) {
	raw, err := q.Store.Setting(ctx, command.SettingBusinessDate)
	if err != nil || raw == nil {
		return today, err
	}
	var date string
	err = json.Unmarshal(raw, &date)
	return date, err
}
