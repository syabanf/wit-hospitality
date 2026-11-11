package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// employeeAudit is what the mock's audit line keeps of an employee.
type employeeAudit struct {
	Status      string `json:"status"`
	BasicSalary int64  `json:"basicSalary"`
	Position    string `json:"position"`
}

func employeeAuditOf(e domain.Employee) employeeAudit {
	return employeeAudit{Status: e.Status, BasicSalary: e.BasicSalary, Position: e.Position}
}

// allocationsInScope refuses an allocation to a villa outside the principal's scope.
func (d Deps) allocationsInScope(ctx context.Context, p auth.Principal, e domain.Employee) error {
	for _, a := range e.Allocations {
		if _, err := d.villaInScope(ctx, p, a.VillaID); err != nil {
			return err
		}
	}
	return nil
}

// CreateEmployee adds an employee; it needs hr/create and every allocated villa in scope.
type CreateEmployee struct{ Deps }

// Handle creates the employee.
func (h CreateEmployee) Handle(ctx context.Context, p auth.Principal, in domain.Employee) (domain.Employee, error) {
	if err := h.Authz.Require(ctx, p.Role, hrCreate...); err != nil {
		return domain.Employee{}, err
	}
	var e domain.Employee
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.CodeTaken(ctx, in.Code, "")
		if err != nil {
			return err
		}
		if err := domain.ValidateEmployee(in, taken); err != nil {
			return err
		}
		e = domain.NormalizeEmployee(in)
		if err := h.allocationsInScope(ctx, p, e); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "employee")
		if err != nil {
			return err
		}
		e.ID = fmt.Sprintf("emp-%03d", n)
		if _, err := h.saveEmployee(ctx, e, 0); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "employee", EntityID: e.Code, Summary: fmt.Sprintf("Added employee %s, %s", e.Name, e.Position)})
	})
	return e, err
}

// UpdateEmployee edits an employee; it needs hr/edit, the employee in scope and every new villa
// in scope.
type UpdateEmployee struct{ Deps }

// Handle edits the employee.
func (h UpdateEmployee) Handle(ctx context.Context, p auth.Principal, id string, in domain.Employee) (domain.Employee, error) {
	if err := h.Authz.Require(ctx, p.Role, hrEdit...); err != nil {
		return domain.Employee{}, err
	}
	var e domain.Employee
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.CodeTaken(ctx, in.Code, id)
		if err != nil {
			return err
		}
		if err := domain.ValidateEmployee(in, taken); err != nil {
			return err
		}
		version, err := h.Repo.Load(ctx, Employees, id, &e)
		if err != nil {
			return err
		}
		if err := h.employeeInScope(ctx, p, e); err != nil {
			return err
		}
		before := employeeAuditOf(e)
		next := domain.NormalizeEmployee(in)
		next.ID = e.ID
		if err := h.allocationsInScope(ctx, p, next); err != nil {
			return err
		}
		e = next
		if _, err := h.saveEmployee(ctx, e, version); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "employee", EntityID: e.Code, Summary: "Edited employee " + e.Name, Before: before, After: employeeAuditOf(e)})
	})
	return e, err
}

// AssignShift sets or clears one employee's shift on one day; it needs hr/edit and the villa in
// scope.
type AssignShift struct{ Deps }

// Handle saves the assignment.
func (h AssignShift) Handle(ctx context.Context, p auth.Principal, in domain.AssignmentInput) (domain.ShiftAssignment, error) {
	if err := h.Authz.Require(ctx, p.Role, hrEdit...); err != nil {
		return domain.ShiftAssignment{}, err
	}
	if err := domain.ValidateAssignment(in); err != nil {
		return domain.ShiftAssignment{}, err
	}
	var a domain.ShiftAssignment
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if _, err := h.employee(ctx, p, in.EmployeeID); err != nil {
			return err
		}
		if in.ShiftID != nil && *in.ShiftID != "" {
			s, err := h.Repo.Shift(ctx, *in.ShiftID)
			if err != nil {
				return err
			}
			if s == nil {
				return notFound("shift", *in.ShiftID)
			}
		} else {
			in.ShiftID = nil
		}
		if _, err := h.villaInScope(ctx, p, in.VillaID); err != nil {
			return err
		}
		version, err := h.Repo.FindBy(ctx, Assignments, in.EmployeeID, in.Date, &a)
		if err != nil {
			return err
		}
		if version == 0 {
			n, err := h.Repo.Next(ctx, "assignment")
			if err != nil {
				return err
			}
			a = domain.ShiftAssignment{ID: fmt.Sprintf("asg-%d", n), EmployeeID: in.EmployeeID, Date: in.Date}
		}
		a.ShiftID, a.VillaID = in.ShiftID, in.VillaID
		v, err := h.Repo.Save(ctx, Assignments, Row{ID: a.ID, EmployeeID: a.EmployeeID, Key: a.Date, Data: a}, version)
		if err != nil {
			return err
		}
		return h.emit(ctx, people.EventAssignmentSaved, "shift_assignment", a.ID, v, people.AssignmentSaved{Assignment: a})
	})
	return a, err
}

// RecordAttendance records one employee's day; it needs hr/edit and the employee in scope. A day
// cannot be recorded ahead, and a late arrival counts at least one minute.
type RecordAttendance struct{ Deps }

// Handle records the day.
func (h RecordAttendance) Handle(ctx context.Context, p auth.Principal, in domain.AttendanceInput) (domain.Attendance, error) {
	if err := h.Authz.Require(ctx, p.Role, hrEdit...); err != nil {
		return domain.Attendance{}, err
	}
	if err := domain.ValidateAttendance(in); err != nil {
		return domain.Attendance{}, err
	}
	var a domain.Attendance
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		e, err := h.employee(ctx, p, in.EmployeeID)
		if err != nil {
			return err
		}
		if in.Date > h.today() {
			return invalid("Attendance is recorded on or after the day.")
		}
		shift, err := h.Repo.ShiftOn(ctx, e.ID, in.Date)
		if err != nil {
			return err
		}
		late := 0
		if in.Status == "late" {
			late = max(1, domain.LateMinutes(in.ClockIn, shift))
		}
		var existing domain.Attendance
		version, err := h.Repo.FindBy(ctx, AttendanceK, e.ID, in.Date, &existing)
		if err != nil {
			return err
		}
		id := existing.ID
		if version == 0 {
			n, err := h.Repo.Next(ctx, "attendance")
			if err != nil {
				return err
			}
			id = fmt.Sprintf("att-%d", n)
		}
		a = domain.Attendance{ID: id, EmployeeID: e.ID, Date: in.Date, Status: in.Status, ClockIn: in.ClockIn, ClockOut: in.ClockOut, LateMinutes: late, Note: strings.TrimSpace(in.Note)}
		if err := h.saveAttendance(ctx, a, version); err != nil {
			return err
		}
		action := audit.Create
		if version > 0 {
			action = audit.Update
		}
		return h.record(ctx, p, audit.Line{Action: action, Entity: "attendance", EntityID: a.ID, Summary: fmt.Sprintf("%s %s on %s", e.Name, in.Status, in.Date)})
	})
	return a, err
}
