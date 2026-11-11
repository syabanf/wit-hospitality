package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
)

// ConsumerPeople keeps housekeeping's copy of employees, the roster and leave.
const ConsumerPeople = "housekeeping.people"

// Staff answers command.People from the copy of people's records in the housekeeping schema.
type Staff struct{ DB *db.DB }

// Day returns every employee, the day's roster and the approved leave covering the day.
func (s Staff) Day(ctx context.Context, date string) (domain.StaffDay, error) {
	q := s.DB.Q(ctx)
	day := domain.StaffDay{}
	rows, err := q.Query(ctx, `SELECT id, name, department, position, status, villa_ids FROM housekeeping.staff_employees ORDER BY seq`)
	if err != nil {
		return day, err
	}
	if day.Employees, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Employee, error) {
		var e domain.Employee
		err := r.Scan(&e.ID, &e.Name, &e.Department, &e.Position, &e.Status, &e.VillaIDs)
		return e, err
	}); err != nil {
		return day, err
	}
	rows, err = q.Query(ctx, `SELECT employee_id, to_char(day, 'YYYY-MM-DD'), shift_id, villa_id FROM housekeeping.staff_roster WHERE day = $1::date ORDER BY id`, date)
	if err != nil {
		return day, err
	}
	if day.Roster, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.RosterDay, error) {
		var d domain.RosterDay
		err := r.Scan(&d.EmployeeID, &d.Date, &d.ShiftID, &d.VillaID)
		return d, err
	}); err != nil {
		return day, err
	}
	rows, err = q.Query(ctx, `
		SELECT employee_id, status, to_char(from_day, 'YYYY-MM-DD'), to_char(to_day, 'YYYY-MM-DD') FROM housekeeping.staff_leaves
		WHERE status = 'approved' AND from_day <= $1::date AND $1::date <= to_day`, date)
	if err != nil {
		return day, err
	}
	day.Leaves, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Leave, error) {
		var l domain.Leave
		err := r.Scan(&l.EmployeeID, &l.Status, &l.From, &l.To)
		return l, err
	})
	return day, err
}

func (pr Projections) registerPeople(p *projector.Projector) {
	p.On(ConsumerPeople, people.EventEmployeeSaved, pr.employee)
	p.On(ConsumerPeople, people.EventAssignmentSaved, pr.assignment)
	p.On(ConsumerPeople, people.EventLeaveSaved, pr.leave)
}

func (pr Projections) employee(ctx context.Context, m bus.Message) error {
	e, err := decode[people.EmployeeSaved](m)
	if err != nil {
		return err
	}
	x := e.Employee
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.staff_employees (id, name, department, position, status, villa_ids, version) VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, department = EXCLUDED.department, position = EXCLUDED.position, status = EXCLUDED.status,
			villa_ids = EXCLUDED.villa_ids, version = EXCLUDED.version
		WHERE housekeeping.staff_employees.version < EXCLUDED.version`, x.ID, x.Name, x.Department, x.Position, x.Status, x.VillaIDs(), m.AggregateVersion)
	return err
}

func (pr Projections) assignment(ctx context.Context, m bus.Message) error {
	e, err := decode[people.AssignmentSaved](m)
	if err != nil {
		return err
	}
	a := e.Assignment
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.staff_roster (id, employee_id, day, shift_id, villa_id, version) VALUES ($1, $2, $3::date, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET employee_id = EXCLUDED.employee_id, day = EXCLUDED.day, shift_id = EXCLUDED.shift_id, villa_id = EXCLUDED.villa_id, version = EXCLUDED.version
		WHERE housekeeping.staff_roster.version < EXCLUDED.version`, a.ID, a.EmployeeID, a.Date, a.ShiftID, a.VillaID, m.AggregateVersion)
	return err
}

func (pr Projections) leave(ctx context.Context, m bus.Message) error {
	e, err := decode[people.LeaveSaved](m)
	if err != nil {
		return err
	}
	l := e.Leave
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.staff_leaves (id, employee_id, status, from_day, to_day, version) VALUES ($1, $2, $3, $4::date, $5::date, $6)
		ON CONFLICT (id) DO UPDATE SET employee_id = EXCLUDED.employee_id, status = EXCLUDED.status, from_day = EXCLUDED.from_day, to_day = EXCLUDED.to_day, version = EXCLUDED.version
		WHERE housekeeping.staff_leaves.version < EXCLUDED.version`, l.ID, l.EmployeeID, l.Status, l.From, l.To, m.AggregateVersion)
	return err
}
