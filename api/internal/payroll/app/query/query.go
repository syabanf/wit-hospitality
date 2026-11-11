// Package query holds the payroll context's read side. Users with payroll/view read every period;
// a scoped user sees the payslips of employees at villas in their scope. Anyone else reads the
// periods with their own payslip only, once it is published (the employee area). Handlers hold no
// domain logic.
package query

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/payroll/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Workplace is an employee's villas and, in the same order, their locations.
type Workplace struct {
	VillaIDs    []string
	LocationIDs []string
}

// In reports whether the employee works at a villa in scope.
func (w Workplace) In(s rbac.Scope) bool {
	for i, v := range w.VillaIDs {
		loc := ""
		if i < len(w.LocationIDs) {
			loc = w.LocationIDs[i]
		}
		if s.AllowedVilla(v, loc) {
			return true
		}
	}
	return false
}

// ReadStore reads the read models.
type ReadStore interface {
	Settings(ctx context.Context) (domain.Settings, error)
	Periods(ctx context.Context) ([]domain.Period, error)
	Workplaces(ctx context.Context) (map[string]Workplace, error)
}

// Queries bundles the read handlers.
type Queries struct {
	Store ReadStore
	Authz rbac.Authorizer
}

var payrollView = rbac.Need{Module: "payroll", Action: "view"}

// Settings is GET /payroll/settings: every signed-in user reads them (a payslip explains itself
// with them).
func (q Queries) Settings(ctx context.Context) (domain.Settings, error) {
	if _, err := auth.Require(ctx); err != nil {
		return domain.Settings{}, err
	}
	return q.Store.Settings(ctx)
}

// Periods is GET /payroll/periods, oldest month first.
func (q Queries) Periods(ctx context.Context) ([]domain.Period, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	periods, err := q.Store.Periods(ctx)
	if err != nil {
		return nil, err
	}
	err = q.Authz.Require(ctx, p.Role, payrollView)
	if err != nil && !errs.HasCode(err, errs.CodeForbidden) {
		return nil, err
	}
	wide := err == nil
	if wide && !p.Scope().Restricted() {
		return periods, nil
	}
	places, err := q.Store.Workplaces(ctx)
	if err != nil {
		return nil, err
	}
	keep := func(per domain.Period, l domain.Line) bool {
		if wide {
			return places[l.EmployeeID].In(p.Scope())
		}
		return per.Published && p.EmployeeID != nil && *p.EmployeeID == l.EmployeeID
	}
	for i, per := range periods {
		lines := []domain.Line{}
		for _, l := range per.Lines {
			if keep(per, l) {
				lines = append(lines, l)
			}
		}
		periods[i].Lines = lines
	}
	return periods, nil
}
