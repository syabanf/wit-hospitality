// Package command holds the payroll context's write side: settings and the period lifecycle. Each
// handler checks the permission, loads, applies the domain rules, saves, and appends its events
// and audit line in one transaction.
package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/payroll"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/domain"
	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Repository is the write model on the payroll schema. Loads lock the row for the transaction.
type Repository interface {
	// Settings returns the stored settings, or the defaults at version 0.
	Settings(ctx context.Context) (domain.Settings, int64, error)
	SaveSettings(ctx context.Context, s domain.Settings, version int64) (int64, error)
	Period(ctx context.Context, id string) (domain.Period, int64, error)
	MonthTaken(ctx context.Context, month string) (bool, error)
	// SavePeriod inserts at version 1 when version is 0, else updates when the version matches.
	SavePeriod(ctx context.Context, p domain.Period, version int64) (int64, error)
	Next(ctx context.Context, key string) (int, error)
}

// Inputs reads payroll's copies of the people records, projected from people events.
type Inputs interface {
	// Employees lists every employee in the order people created them.
	Employees(ctx context.Context) ([]people.Employee, error)
	Attendance(ctx context.Context, month string) ([]people.Attendance, error)
	Overtime(ctx context.Context, month string) ([]people.OvertimeRequest, error)
	Loans(ctx context.Context) ([]people.Loan, error)
}

// ServicePool answers how much Service charge payable the folio billed in a month. Billing owns
// the folio; until it runs, the in-process client (adapters/billing) answers zero.
type ServicePool interface {
	BilledServiceCharge(ctx context.Context, month string) (int64, error)
}

// PayrollPosting posts a closed payroll's salary payment and journal. Finance owns cash accounts
// and the ledger; until it runs, the in-process client (adapters/finance) records the request as
// payroll.period.closed.v1 in this context's outbox and returns no transaction id. Whatever posts
// the payment must leave that event in the outbox: people books loan repayments from it.
type PayrollPosting interface {
	PostSalaryPayment(ctx context.Context, closed payroll.PeriodClosed) (transactionID *string, err error)
}

// Deps is what every payroll command needs.
type Deps struct {
	DB      *db.DB
	Repo    Repository
	Inputs  Inputs
	Pool    ServicePool
	Posting PayrollPosting
	Authz   rbac.Authorizer
	Audit   audit.Recorder
	Clock   clock.Clock
}

// Permission sets the commands check, taken from the application services' allow() calls.
var (
	payrollCreate  = []rbac.Need{{Module: "payroll", Action: "create"}}
	payrollEdit    = []rbac.Need{{Module: "payroll", Action: "edit"}}
	payrollApprove = []rbac.Need{{Module: "payroll", Action: "approve"}}
	payrollPost    = []rbac.Need{{Module: "payroll", Action: "post"}}
)

func (d Deps) today() string { return clock.Today(d.Clock) }

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}, l)
}

// savePeriod stores the period and appends period.saved.
func (d Deps) savePeriod(ctx context.Context, p domain.Period, version int64) error {
	v, err := d.Repo.SavePeriod(ctx, p, version)
	if err != nil {
		return err
	}
	return appendEvent(ctx, d, payroll.EventPeriodSaved, "payroll_period", p.ID, v, payroll.PeriodSaved{Period: p})
}

func appendEvent(ctx context.Context, d Deps, eventType, aggregateType, id string, version int64, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: id, AggregateVersion: version, Payload: payload})
}

// compute is computePeriodLines over the current people copies, settings and service charge
// pool; it sets the period's revenue base.
func (d Deps) compute(ctx context.Context, p *domain.Period, keep []domain.Line) error {
	settings, _, err := d.Repo.Settings(ctx)
	if err != nil {
		return err
	}
	in := domain.PeriodInputs{Settings: settings}
	if in.Employees, err = d.Inputs.Employees(ctx); err != nil {
		return err
	}
	if in.Attendance, err = d.Inputs.Attendance(ctx, p.Month); err != nil {
		return err
	}
	if in.Overtime, err = d.Inputs.Overtime(ctx, p.Month); err != nil {
		return err
	}
	if in.Loans, err = d.Inputs.Loans(ctx); err != nil {
		return err
	}
	if in.Pool, err = d.Pool.BilledServiceCharge(ctx, p.Month); err != nil {
		return err
	}
	p.RevenueBase = in.Pool
	p.Lines = domain.ComputeLines(p.Month, in, keep)
	return nil
}
