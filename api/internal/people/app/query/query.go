// Package query holds the people context's read side. Users with hr/view or payroll/view read
// every employee who works at a villa in their scope, and those employees' records; anyone else
// reads their own employee record and requests only (the employee area). Handlers hold no domain
// logic.
package query

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/people/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Filter narrows a read: Wide reads employees in Scope; otherwise only EmployeeID's records, or
// nothing when the login has no employee record.
type Filter struct {
	Wide       bool
	Scope      rbac.Scope
	EmployeeID string
}

// ReadStore reads the read models through a filter.
type ReadStore interface {
	Employees(ctx context.Context, f Filter) ([]domain.Employee, error)
	Shifts(ctx context.Context) ([]domain.Shift, error)
	Assignments(ctx context.Context, f Filter) ([]domain.ShiftAssignment, error)
	Attendance(ctx context.Context, f Filter) ([]domain.Attendance, error)
	Leaves(ctx context.Context, f Filter) ([]domain.LeaveRequest, error)
	Overtime(ctx context.Context, f Filter) ([]domain.OvertimeRequest, error)
	Loans(ctx context.Context, f Filter) ([]domain.Loan, error)
	Announcements(ctx context.Context, s rbac.Scope) ([]domain.Announcement, error)
	Kpis(ctx context.Context, f Filter) ([]domain.KpiReview, error)
}

// Queries bundles the read handlers.
type Queries struct {
	Store ReadStore
	Authz rbac.Authorizer
}

func (q Queries) filter(ctx context.Context) (Filter, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return Filter{}, err
	}
	wide, err := command.Can(ctx, q.Authz, p.Role, command.StaffWide...)
	if err != nil {
		return Filter{}, err
	}
	f := Filter{Wide: wide, Scope: p.Scope()}
	if p.EmployeeID != nil {
		f.EmployeeID = *p.EmployeeID
	}
	return f, nil
}

func read[T any](q Queries, ctx context.Context, fn func(context.Context, Filter) ([]T, error)) ([]T, error) {
	f, err := q.filter(ctx)
	if err != nil {
		return nil, err
	}
	return fn(ctx, f)
}

// Employees is GET /employees.
func (q Queries) Employees(ctx context.Context) ([]domain.Employee, error) {
	return read(q, ctx, q.Store.Employees)
}

// Shifts is GET /shifts: every signed-in user reads the shift list.
func (q Queries) Shifts(ctx context.Context) ([]domain.Shift, error) {
	if _, err := auth.Require(ctx); err != nil {
		return nil, err
	}
	return q.Store.Shifts(ctx)
}

// Assignments is GET /shift-assignments.
func (q Queries) Assignments(ctx context.Context) ([]domain.ShiftAssignment, error) {
	return read(q, ctx, q.Store.Assignments)
}

// Attendance is GET /attendance.
func (q Queries) Attendance(ctx context.Context) ([]domain.Attendance, error) {
	return read(q, ctx, q.Store.Attendance)
}

// Leaves is GET /leave-requests.
func (q Queries) Leaves(ctx context.Context) ([]domain.LeaveRequest, error) {
	return read(q, ctx, q.Store.Leaves)
}

// Overtime is GET /overtime-requests.
func (q Queries) Overtime(ctx context.Context) ([]domain.OvertimeRequest, error) {
	return read(q, ctx, q.Store.Overtime)
}

// Loans is GET /loans.
func (q Queries) Loans(ctx context.Context) ([]domain.Loan, error) {
	return read(q, ctx, q.Store.Loans)
}

// Kpis is GET /kpi-reviews.
func (q Queries) Kpis(ctx context.Context) ([]domain.KpiReview, error) {
	return read(q, ctx, q.Store.Kpis)
}

// Announcements is GET /announcements, newest first: notices for everyone and for villas in scope.
func (q Queries) Announcements(ctx context.Context) ([]domain.Announcement, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Announcements(ctx, p.Scope())
}
