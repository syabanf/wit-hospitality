package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// decided writes the audit line of a decision.
func (d Deps) decided(ctx context.Context, p auth.Principal, entity, number, before, to string) error {
	return d.record(ctx, p, audit.Line{Action: decisionAction(to), Entity: entity, EntityID: number, Summary: capitalized(to) + " " + number,
		Before: map[string]any{"status": before}, After: map[string]any{"status": to}})
}

// RequestLeave asks for leave. Employees ask for themselves; asking for someone else needs the
// staff-wide permission and the employee in scope. Annual leave cannot exceed the balance.
type RequestLeave struct{ Deps }

// Handle files the request.
func (h RequestLeave) Handle(ctx context.Context, p auth.Principal, in domain.LeaveInput) (domain.LeaveRequest, error) {
	var l domain.LeaveRequest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		e, err := h.Repo.FindEmployee(ctx, in.EmployeeID)
		if err != nil {
			return err
		}
		if err := h.forEmployee(ctx, p, e); err != nil {
			return err
		}
		balance := 0
		if e != nil && len(in.From) >= 4 {
			leaves, err := h.Repo.Leaves(ctx, e.ID)
			if err != nil {
				return err
			}
			balance = domain.LeaveBalance(*e, leaves, in.From[:4])
		}
		if err := domain.ValidateLeave(in, e, balance); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "leave")
		if err != nil {
			return err
		}
		l = domain.LeaveRequest{ID: fmt.Sprintf("lv-%d", n), Number: fmt.Sprintf("LV-%d", 200+n), EmployeeID: e.ID, Kind: in.Kind, From: in.From, To: in.To,
			Days: domain.LeaveDays(in.From, in.To), Reason: strings.TrimSpace(in.Reason), Status: "pending", RequestedOn: h.today()}
		if err := h.saveLeave(ctx, l, 0); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "leave", EntityID: l.Number, Summary: fmt.Sprintf("%s requested %d days of %s leave", e.Name, l.Days, in.Kind)})
	})
	return l, err
}

// DecideLeave approves, rejects or cancels a pending request. Approving and rejecting need
// hr/approve; the requester may cancel their own. Approval marks the days up to today as leave
// on the attendance sheet.
type DecideLeave struct{ Deps }

// Handle decides the request.
func (h DecideLeave) Handle(ctx context.Context, p auth.Principal, id, to, note string) (domain.LeaveRequest, error) {
	if err := domain.CheckDecision(to, note); err != nil {
		return domain.LeaveRequest{}, err
	}
	var l domain.LeaveRequest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		version, err := h.Repo.Load(ctx, Leaves, id, &l)
		if err != nil {
			return err
		}
		if err := h.mayDecide(ctx, p, to, l.EmployeeID, hrApprove); err != nil {
			return err
		}
		if _, err := h.employee(ctx, p, l.EmployeeID); err != nil {
			return err
		}
		before := l.Status
		if l.Status, err = domain.Decide(l.Number, l.Status, &l.Decision, to, note, p.Name, h.today()); err != nil {
			return err
		}
		if err := h.saveLeave(ctx, l, version); err != nil {
			return err
		}
		if to == domain.Approved {
			if err := h.markLeave(ctx, l); err != nil {
				return err
			}
		}
		return h.decided(ctx, p, "leave", l.Number, before, to)
	})
	return l, err
}

// markLeave writes a leave day for every day of the request up to today.
func (h DecideLeave) markLeave(ctx context.Context, l domain.LeaveRequest) error {
	today := h.today()
	for date := l.From; date <= l.To && date <= today; date = domain.AddDays(date, 1) {
		var existing domain.Attendance
		version, err := h.Repo.FindBy(ctx, AttendanceK, l.EmployeeID, date, &existing)
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
		a := domain.Attendance{ID: id, EmployeeID: l.EmployeeID, Date: date, Status: "leave", Note: l.Number}
		if err := h.saveAttendance(ctx, a, version); err != nil {
			return err
		}
	}
	return nil
}

// RequestOvertime asks for overtime at a villa in scope, on the same terms as leave.
type RequestOvertime struct{ Deps }

// Handle files the request.
func (h RequestOvertime) Handle(ctx context.Context, p auth.Principal, in domain.OvertimeInput) (domain.OvertimeRequest, error) {
	if err := domain.ValidateOvertime(in); err != nil {
		return domain.OvertimeRequest{}, err
	}
	var o domain.OvertimeRequest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		e, err := h.Repo.FindEmployee(ctx, in.EmployeeID)
		if err != nil {
			return err
		}
		if e == nil {
			return notFound("employee", in.EmployeeID)
		}
		if err := h.forEmployee(ctx, p, e); err != nil {
			return err
		}
		if _, err := h.Repo.Villa(ctx, in.VillaID); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "overtime")
		if err != nil {
			return err
		}
		o = domain.OvertimeRequest{ID: fmt.Sprintf("ot-%d", n), Number: fmt.Sprintf("OT-%d", 300+n), EmployeeID: e.ID, Date: in.Date, Hours: in.Hours, VillaID: in.VillaID,
			Reason: strings.TrimSpace(in.Reason), Status: "pending", RequestedOn: h.today()}
		if err := h.saveOvertime(ctx, o, 0); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "overtime", EntityID: o.Number, Summary: fmt.Sprintf("%s requested %g h overtime on %s", e.Name, in.Hours, in.Date)})
	})
	return o, err
}

// DecideOvertime approves, rejects or cancels a pending request; hr/approve as for leave.
type DecideOvertime struct{ Deps }

// Handle decides the request.
func (h DecideOvertime) Handle(ctx context.Context, p auth.Principal, id, to, note string) (domain.OvertimeRequest, error) {
	if err := domain.CheckDecision(to, note); err != nil {
		return domain.OvertimeRequest{}, err
	}
	var o domain.OvertimeRequest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		version, err := h.Repo.Load(ctx, Overtimes, id, &o)
		if err != nil {
			return err
		}
		if err := h.mayDecide(ctx, p, to, o.EmployeeID, hrApprove); err != nil {
			return err
		}
		if _, err := h.employee(ctx, p, o.EmployeeID); err != nil {
			return err
		}
		before := o.Status
		if o.Status, err = domain.Decide(o.Number, o.Status, &o.Decision, to, note, p.Name, h.today()); err != nil {
			return err
		}
		if err := h.saveOvertime(ctx, o, version); err != nil {
			return err
		}
		return h.decided(ctx, p, "overtime", o.Number, before, to)
	})
	return o, err
}

// RequestLoan asks for a loan or salary advance: at most three months of basic salary and one
// open loan per employee.
type RequestLoan struct{ Deps }

// Handle files the request.
func (h RequestLoan) Handle(ctx context.Context, p auth.Principal, in domain.LoanInput) (domain.Loan, error) {
	var l domain.Loan
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		e, err := h.Repo.FindEmployee(ctx, in.EmployeeID)
		if err != nil {
			return err
		}
		if err := h.forEmployee(ctx, p, e); err != nil {
			return err
		}
		var open []domain.Loan
		if e != nil {
			if open, err = h.Repo.Loans(ctx, e.ID); err != nil {
				return err
			}
		}
		if err := domain.ValidateLoan(in, e, open); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "loan")
		if err != nil {
			return err
		}
		l = domain.Loan{ID: fmt.Sprintf("ln-%d", n), Number: fmt.Sprintf("LN-%d", 400+n), EmployeeID: e.ID, Kind: in.Kind, Amount: in.Amount, Installments: in.Installments,
			Monthly: domain.LoanInstalment(in.Amount, in.Installments), Reason: strings.TrimSpace(in.Reason), Status: "pending", RequestedOn: h.today(), StartMonth: in.StartMonth}
		if err := h.saveLoan(ctx, l, 0); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "loan", EntityID: l.Number, Summary: fmt.Sprintf("%s requested a %s of %d", e.Name, in.Kind, in.Amount)})
	})
	return l, err
}

// DecideLoan approves, rejects or cancels a pending loan; approving and rejecting need
// payroll/approve. An approved loan starts repaying.
type DecideLoan struct{ Deps }

// Handle decides the loan.
func (h DecideLoan) Handle(ctx context.Context, p auth.Principal, id, to, note string) (domain.Loan, error) {
	if err := domain.CheckDecision(to, note); err != nil {
		return domain.Loan{}, err
	}
	var l domain.Loan
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		version, err := h.Repo.Load(ctx, Loans, id, &l)
		if err != nil {
			return err
		}
		if err := h.mayDecide(ctx, p, to, l.EmployeeID, payrollApprove); err != nil {
			return err
		}
		if _, err := h.employee(ctx, p, l.EmployeeID); err != nil {
			return err
		}
		before := l.Status
		if l.Status, err = domain.Decide(l.Number, l.Status, &l.Decision, to, note, p.Name, h.today()); err != nil {
			return err
		}
		if to == domain.Approved {
			l.Status = "active"
		}
		if err := h.saveLoan(ctx, l, version); err != nil {
			return err
		}
		return h.decided(ctx, p, "loan", l.Number, before, to)
	})
	return l, err
}
