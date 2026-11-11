// Package command holds the people context's write side: one handler per command. Each handler
// checks the permission and villa scope, loads, applies the domain rules, saves, and appends its
// events and audit line in one transaction.
package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Kind names a record table and how a missing record reads in NOT_FOUND.
type Kind struct{ Table, What string }

// The record kinds.
var (
	Employees   = Kind{"employees", "employee"}
	Shifts      = Kind{"shifts", "shift"}
	Assignments = Kind{"shift_assignments", "shift assignment"}
	AttendanceK = Kind{"attendance", "attendance"}
	Leaves      = Kind{"leave_requests", "leave request"}
	Overtimes   = Kind{"overtime_requests", "overtime request"}
	Loans       = Kind{"loans", "loan"}
	Notices     = Kind{"announcements", "announcement"}
	KpiReviews  = Kind{"kpi_reviews", "KPI review"}
)

// Row is a record with the columns the rules and scope filters use.
type Row struct {
	ID          string
	EmployeeID  string
	Key         string
	VillaIDs    []string
	LocationIDs []string
	Data        any
}

// Versioned pairs a record with its stored version.
type Versioned[T any] struct {
	Value   T
	Version int64
}

// Villa is what people knows of a villa, projected from property events.
type Villa struct{ ID, LocationID, Name string }

// Repository is the write model on the people schema. Loads lock the row for the transaction.
type Repository interface {
	Load(ctx context.Context, k Kind, id string, out any) (int64, error)
	FindBy(ctx context.Context, k Kind, employeeID, key string, out any) (int64, error)
	Save(ctx context.Context, k Kind, row Row, version int64) (int64, error)
	Delete(ctx context.Context, k Kind, id string) error

	CodeTaken(ctx context.Context, code, excludeID string) (bool, error)
	FindEmployee(ctx context.Context, id string) (*domain.Employee, error)
	Leaves(ctx context.Context, employeeID string) ([]domain.LeaveRequest, error)
	Loans(ctx context.Context, employeeID string) ([]domain.Loan, error)
	LockLoans(ctx context.Context, employeeID string) ([]Versioned[domain.Loan], error)
	Shift(ctx context.Context, id string) (*domain.Shift, error)
	ShiftOn(ctx context.Context, employeeID, date string) (*domain.Shift, error)
	Villa(ctx context.Context, id string) (Villa, error)
	Next(ctx context.Context, key string) (int, error)
}

// Deps is what every people command needs.
type Deps struct {
	DB    *db.DB
	Repo  Repository
	Authz rbac.Authorizer
	Audit audit.Recorder
	Clock clock.Clock
}

// Permission sets the commands check, taken from the application services' allow() calls.
var (
	hrCreate       = []rbac.Need{{Module: "hr", Action: "create"}}
	hrEdit         = []rbac.Need{{Module: "hr", Action: "edit"}}
	hrApprove      = []rbac.Need{{Module: "hr", Action: "approve"}}
	payrollApprove = []rbac.Need{{Module: "payroll", Action: "approve"}}
	// StaffWide reads every employee in scope; without it a user sees their own records only.
	StaffWide = []rbac.Need{{Module: "hr", Action: "view"}, {Module: "payroll", Action: "view"}}
)

// Can reports whether role holds one of needs, without refusing.
func Can(ctx context.Context, a rbac.Authorizer, role rbac.Role, needs ...rbac.Need) (bool, error) {
	err := a.Require(ctx, role, needs...)
	if errs.HasCode(err, errs.CodeForbidden) {
		return false, nil
	}
	return err == nil, err
}

func actorOf(p auth.Principal) audit.Actor {
	return audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}
}

func (d Deps) emit(ctx context.Context, eventType, aggregateType, id string, version int64, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: id, AggregateVersion: version, Payload: payload})
}

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, actorOf(p), l)
}

func (d Deps) today() string { return clock.Today(d.Clock) }

// villaInScope loads a villa and refuses one outside the principal's scope.
func (d Deps) villaInScope(ctx context.Context, p auth.Principal, id string) (Villa, error) {
	v, err := d.Repo.Villa(ctx, id)
	if err != nil {
		return v, err
	}
	if !p.Scope().AllowedVilla(v.ID, v.LocationID) {
		return v, errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", v.Name))
	}
	return v, nil
}

// locations resolves the location of every allocated villa, in allocation order.
func (d Deps) locations(ctx context.Context, e domain.Employee) ([]string, error) {
	out := make([]string, 0, len(e.Allocations))
	for _, a := range e.Allocations {
		v, err := d.Repo.Villa(ctx, a.VillaID)
		if err != nil {
			return nil, err
		}
		out = append(out, v.LocationID)
	}
	return out, nil
}

// employeeInScope refuses an employee who works at no villa in the principal's scope.
func (d Deps) employeeInScope(ctx context.Context, p auth.Principal, e domain.Employee) error {
	s := p.Scope()
	if !s.Restricted() {
		return nil
	}
	locs, err := d.locations(ctx, e)
	if err != nil && !errs.HasCode(err, errs.CodeNotFound) {
		return err
	}
	for i, a := range e.Allocations {
		if i < len(locs) && s.AllowedVilla(a.VillaID, locs[i]) {
			return nil
		}
	}
	return errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", e.Name))
}

func self(p auth.Principal, employeeID string) bool {
	return p.EmployeeID != nil && *p.EmployeeID == employeeID
}

// forEmployee lets a user act for themselves, and for an employee in scope with the staff-wide
// permission; anyone else is refused.
func (d Deps) forEmployee(ctx context.Context, p auth.Principal, e *domain.Employee) error {
	if e == nil || self(p, e.ID) {
		return nil
	}
	if err := d.Authz.Require(ctx, p.Role, StaffWide...); err != nil {
		return err
	}
	return d.employeeInScope(ctx, p, *e)
}

// mayDecide checks a decision on a request: approving or rejecting needs the approve permission;
// cancelling is open to the requester or the approver.
func (d Deps) mayDecide(ctx context.Context, p auth.Principal, to, employeeID string, approve []rbac.Need) error {
	if to != domain.Approved && to != domain.Rejected && to != domain.Cancelled {
		return errs.Invalid("to", "Pick approve, reject or cancel.")
	}
	if to == domain.Cancelled && self(p, employeeID) {
		return nil
	}
	return d.Authz.Require(ctx, p.Role, approve...)
}

// employee loads an employee for a request, scope checked.
func (d Deps) employee(ctx context.Context, p auth.Principal, id string) (domain.Employee, error) {
	e, err := d.Repo.FindEmployee(ctx, id)
	if err != nil {
		return domain.Employee{}, err
	}
	if e == nil {
		return domain.Employee{}, errs.NotFound("employee", id)
	}
	if self(p, id) {
		return *e, nil
	}
	return *e, d.employeeInScope(ctx, p, *e)
}

func (d Deps) saveEmployee(ctx context.Context, e domain.Employee, version int64) (int64, error) {
	locs, err := d.locations(ctx, e)
	if err != nil {
		return 0, err
	}
	v, err := d.Repo.Save(ctx, Employees, Row{ID: e.ID, EmployeeID: e.ID, Key: e.Code, VillaIDs: e.VillaIDs(), LocationIDs: locs, Data: e}, version)
	if err != nil {
		return 0, err
	}
	return v, d.emit(ctx, people.EventEmployeeSaved, "employee", e.ID, v, people.EmployeeSaved{Employee: e, LocationIDs: locs})
}

func (d Deps) saveAttendance(ctx context.Context, a domain.Attendance, version int64) error {
	v, err := d.Repo.Save(ctx, AttendanceK, Row{ID: a.ID, EmployeeID: a.EmployeeID, Key: a.Date, Data: a}, version)
	if err != nil {
		return err
	}
	return d.emit(ctx, people.EventAttendanceRecorded, "attendance", a.ID, v, people.AttendanceRecorded{Attendance: a})
}

func (d Deps) saveLeave(ctx context.Context, l domain.LeaveRequest, version int64) error {
	v, err := d.Repo.Save(ctx, Leaves, Row{ID: l.ID, EmployeeID: l.EmployeeID, Data: l}, version)
	if err != nil {
		return err
	}
	return d.emit(ctx, people.EventLeaveSaved, "leave", l.ID, v, people.LeaveSaved{Leave: l})
}

func (d Deps) saveOvertime(ctx context.Context, o domain.OvertimeRequest, version int64) error {
	v, err := d.Repo.Save(ctx, Overtimes, Row{ID: o.ID, EmployeeID: o.EmployeeID, Data: o}, version)
	if err != nil {
		return err
	}
	return d.emit(ctx, people.EventOvertimeSaved, "overtime", o.ID, v, people.OvertimeSaved{Overtime: o})
}

func (d Deps) saveLoan(ctx context.Context, l domain.Loan, version int64) error {
	v, err := d.Repo.Save(ctx, Loans, Row{ID: l.ID, EmployeeID: l.EmployeeID, Data: l}, version)
	if err != nil {
		return err
	}
	return d.emit(ctx, people.EventLoanSaved, "loan", l.ID, v, people.LoanSaved{Loan: l})
}

// decisionAction is the audit action of a decision.
func decisionAction(to string) string {
	switch to {
	case domain.Approved:
		return audit.Approve
	case domain.Rejected:
		return audit.Reject
	}
	return audit.Status
}

func capitalized(s string) string {
	if s == "" {
		return s
	}
	return string(s[0]-'a'+'A') + s[1:]
}

func notFound(what, id string) error { return errs.NotFound(what, id) }

func invalid(message string) error { return errs.New(errs.CodeValidation, message) }
