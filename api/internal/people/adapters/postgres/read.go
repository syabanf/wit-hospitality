package postgres

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/people/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ReadStore reads the v_* views.
type ReadStore struct{ DB *db.DB }

var _ query.ReadStore = ReadStore{}

// inScope is the allowedVilla rule over a row's villa and location arrays: $1 villa ids, $2
// location ids; empty lists allow all.
const inScope = `((cardinality($1::text[]) > 0 AND villa_ids && $1) OR
	(cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR location_ids && $2)))`

// visible picks the rows of employees the filter shows: $3 says wide, $4 is the user's employee.
const visible = `employee_id IN (SELECT id FROM people.v_employees WHERE ($3 AND ` + inScope + `) OR (NOT $3 AND id = $4 AND $4 <> ''))`

func args(f query.Filter) []any {
	vil, loc := f.Scope.VillaIDs, f.Scope.LocationIDs
	return []any{list(vil), list(loc), f.Wide, f.EmployeeID}
}

func (s ReadStore) rows(ctx context.Context, view string, f query.Filter) (string, []any) {
	return `SELECT data FROM people.` + view + ` WHERE ` + visible + ` ORDER BY seq`, args(f)
}

func byFilter[T any](s ReadStore, ctx context.Context, view string, f query.Filter) ([]T, error) {
	sql, a := s.rows(ctx, view, f)
	return collect[T](s.DB.Q(ctx).Query(ctx, sql, a...))
}

// Employees returns the employees the filter shows.
func (s ReadStore) Employees(ctx context.Context, f query.Filter) ([]domain.Employee, error) {
	return byFilter[domain.Employee](s, ctx, "v_employees", f)
}

// Shifts returns every shift.
func (s ReadStore) Shifts(ctx context.Context) ([]domain.Shift, error) {
	return collect[domain.Shift](s.DB.Q(ctx).Query(ctx, `SELECT data FROM people.v_shifts ORDER BY seq`))
}

// Assignments returns the roster rows the filter shows.
func (s ReadStore) Assignments(ctx context.Context, f query.Filter) ([]domain.ShiftAssignment, error) {
	return byFilter[domain.ShiftAssignment](s, ctx, "v_shift_assignments", f)
}

// Attendance returns the attendance rows the filter shows.
func (s ReadStore) Attendance(ctx context.Context, f query.Filter) ([]domain.Attendance, error) {
	return byFilter[domain.Attendance](s, ctx, "v_attendance", f)
}

// Leaves returns the leave requests the filter shows.
func (s ReadStore) Leaves(ctx context.Context, f query.Filter) ([]domain.LeaveRequest, error) {
	return byFilter[domain.LeaveRequest](s, ctx, "v_leave_requests", f)
}

// Overtime returns the overtime requests the filter shows.
func (s ReadStore) Overtime(ctx context.Context, f query.Filter) ([]domain.OvertimeRequest, error) {
	return byFilter[domain.OvertimeRequest](s, ctx, "v_overtime_requests", f)
}

// Loans returns the loans the filter shows.
func (s ReadStore) Loans(ctx context.Context, f query.Filter) ([]domain.Loan, error) {
	return byFilter[domain.Loan](s, ctx, "v_loans", f)
}

// Kpis returns the reviews the filter shows.
func (s ReadStore) Kpis(ctx context.Context, f query.Filter) ([]domain.KpiReview, error) {
	return byFilter[domain.KpiReview](s, ctx, "v_kpi_reviews", f)
}

// Announcements returns notices for everyone and for villas in scope, newest first as the mock
// keeps them.
func (s ReadStore) Announcements(ctx context.Context, sc rbac.Scope) ([]domain.Announcement, error) {
	return collect[domain.Announcement](s.DB.Q(ctx).Query(ctx, `
		SELECT data FROM people.v_announcements WHERE cardinality(villa_ids) = 0 OR `+inScope+` ORDER BY seq DESC`,
		list(sc.VillaIDs), list(sc.LocationIDs)))
}
