package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
)

// ConsumerPeople keeps payroll's copies of the people records.
const ConsumerPeople = "payroll.people"

// Projections copies the people records a payslip needs. Every upsert keeps the row when it
// already holds a newer version, so a late redelivery cannot roll a row back.
type Projections struct{ DB *db.DB }

// Register adds the handlers to p.
func (pr Projections) Register(p *projector.Projector) {
	p.On(ConsumerPeople, people.EventEmployeeSaved, pr.employee)
	p.On(ConsumerPeople, people.EventAttendanceRecorded, pr.attendance)
	p.On(ConsumerPeople, people.EventOvertimeSaved, pr.overtime)
	p.On(ConsumerPeople, people.EventLoanSaved, pr.loan)
}

func list(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (pr Projections) employee(ctx context.Context, m bus.Message) error {
	var e people.EmployeeSaved
	if err := json.Unmarshal(m.Payload, &e); err != nil {
		return err
	}
	data, _ := json.Marshal(e.Employee)
	_, err := pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO payroll.rm_employees (id, villa_ids, location_ids, data, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET villa_ids = EXCLUDED.villa_ids, location_ids = EXCLUDED.location_ids, data = EXCLUDED.data, version = EXCLUDED.version
		WHERE payroll.rm_employees.version < EXCLUDED.version`, e.Employee.ID, list(e.Employee.VillaIDs()), list(e.LocationIDs), data, m.AggregateVersion)
	return err
}

func (pr Projections) attendance(ctx context.Context, m bus.Message) error {
	var e people.AttendanceRecorded
	if err := json.Unmarshal(m.Payload, &e); err != nil {
		return err
	}
	a := e.Attendance
	return pr.dated(ctx, "rm_attendance", a.ID, a.EmployeeID, a.Date, a, m.AggregateVersion)
}

func (pr Projections) overtime(ctx context.Context, m bus.Message) error {
	var e people.OvertimeSaved
	if err := json.Unmarshal(m.Payload, &e); err != nil {
		return err
	}
	o := e.Overtime
	return pr.dated(ctx, "rm_overtime", o.ID, o.EmployeeID, o.Date, o, m.AggregateVersion)
}

func (pr Projections) dated(ctx context.Context, table, id, employeeID, day string, v any, version int64) error {
	data, _ := json.Marshal(v)
	_, err := pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO payroll.`+table+` (id, employee_id, day, data, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET employee_id = EXCLUDED.employee_id, day = EXCLUDED.day, data = EXCLUDED.data, version = EXCLUDED.version
		WHERE payroll.`+table+`.version < EXCLUDED.version`, id, employeeID, day, data, version)
	return err
}

func (pr Projections) loan(ctx context.Context, m bus.Message) error {
	var e people.LoanSaved
	if err := json.Unmarshal(m.Payload, &e); err != nil {
		return err
	}
	data, _ := json.Marshal(e.Loan)
	_, err := pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO payroll.rm_loans (id, employee_id, data, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET employee_id = EXCLUDED.employee_id, data = EXCLUDED.data, version = EXCLUDED.version
		WHERE payroll.rm_loans.version < EXCLUDED.version`, e.Loan.ID, e.Loan.EmployeeID, data, m.AggregateVersion)
	return err
}
