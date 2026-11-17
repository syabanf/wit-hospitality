package postgres

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

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

// Swaps returns the swaps the filter shows: wide by the villa of the shift, else the user's own as
// requester or coworker.
func (s ReadStore) Swaps(ctx context.Context, f query.Filter) ([]domain.ShiftSwap, error) {
	return collect[domain.ShiftSwap](s.DB.Q(ctx).Query(ctx, `
		SELECT data FROM people.v_shift_swaps
		WHERE ($3 AND `+inScope+`) OR (NOT $3 AND $4 <> '' AND (employee_id = $4 OR data->>'counterpartId' = $4))
		ORDER BY seq`, args(f)...))
}

// Team returns the employee and the active coworkers who share a villa, with their roster rows in
// [from, to).
func (s ReadStore) Team(ctx context.Context, employeeID, from, to string) ([]domain.TeamMember, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT e.data, coalesce((SELECT json_agg(a.data ORDER BY a.key, a.seq) FROM people.v_shift_assignments a
			WHERE a.employee_id = e.id AND a.key >= $2 AND a.key < $3), '[]'::json)
		FROM people.v_employees e, (SELECT villa_ids FROM people.v_employees WHERE id = $1) me
		WHERE e.villa_ids && me.villa_ids AND e.data->>'status' <> 'inactive'
		ORDER BY e.seq`, employeeID, from, to)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.TeamMember, error) {
		var rawEmployee, rawAssignments []byte
		if err := r.Scan(&rawEmployee, &rawAssignments); err != nil {
			return domain.TeamMember{}, err
		}
		var e domain.Employee
		m := domain.TeamMember{}
		if err := json.Unmarshal(rawEmployee, &e); err != nil {
			return m, err
		}
		m.ID, m.Name, m.Position, m.VillaIDs = e.ID, e.Name, e.Position, e.VillaIDs()
		return m, json.Unmarshal(rawAssignments, &m.Assignments)
	})
}

// AttendanceSettings returns the clock-in radius, the default until HR saves one.
func (s ReadStore) AttendanceSettings(ctx context.Context) (domain.AttendanceSettings, error) {
	out, err := collect[domain.AttendanceSettings](s.DB.Q(ctx).Query(ctx, `SELECT data FROM people.settings WHERE id = 'attendance'`))
	if err != nil || len(out) == 0 {
		return domain.DefaultAttendanceSettings, err
	}
	return out[0], nil
}
