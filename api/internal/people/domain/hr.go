// Package domain holds the people rules ported from src/domain/hr.ts and people.ts: validators
// with the TypeScript field order and wording, leave days and balance, late minutes, loan
// instalments and the request decision. The records are the published types of the people
// package.
package domain

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Records are the published types.
type (
	Employee        = people.Employee
	Allowance       = people.Allowance
	VillaAllocation = people.VillaAllocation
	Shift           = people.Shift
	ShiftAssignment = people.ShiftAssignment
	Attendance      = people.Attendance
	LeaveRequest    = people.LeaveRequest
	OvertimeRequest = people.OvertimeRequest
	Loan            = people.Loan
	Decision        = people.Decision
)

// Departments, attendance statuses and leave kinds as the TypeScript unions list them.
var (
	Departments        = []string{"front_desk", "housekeeping", "maintenance", "security", "fnb", "management", "finance"}
	AttendanceStatuses = []string{"present", "late", "absent", "leave", "off"}
	LeaveKinds         = []string{"annual", "sick", "permission", "unpaid"}
)

var (
	datePattern  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	monthPattern = regexp.MustCompile(`^\d{4}-\d{2}$`)
	codePattern  = regexp.MustCompile(`^EMP-\d{3}$`)
	timePattern  = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	phonePattern = regexp.MustCompile(`^\+?[\d\s-]{7,}$`)
	emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
)

// IsDate reports whether s looks like YYYY-MM-DD.
func IsDate(s string) bool { return datePattern.MatchString(s) }

func length(s string) int { return utf8.RuneCountInString(strings.TrimSpace(s)) }

// set writes a field error the way a TypeScript `errors.x = ...` does: a later message for the
// same field replaces the earlier one in place.
func set(f *errs.Fields, field, message string) {
	for i := range *f {
		if (*f)[i].Field == field {
			(*f)[i].Message = message
			return
		}
	}
	f.Add(field, message)
}

// pct prints a share as JavaScript does: 100%, 62.5%.
func pct(v float64) string { return fmt.Sprintf("%g%%", v) }

// ValidateEmployee is validateEmployee. codeTaken reports another employee with the code.
func ValidateEmployee(in Employee, codeTaken bool) error {
	var f errs.Fields
	if !codePattern.MatchString(in.Code) {
		set(&f, "code", "The code is EMP- and three digits, for example EMP-021.")
	} else if codeTaken {
		set(&f, "code", in.Code+" is already used.")
	}
	if length(in.Name) < 2 {
		set(&f, "name", "Enter the employee’s name.")
	}
	if length(in.Position) < 2 {
		set(&f, "position", "Enter the position.")
	}
	if !slices.Contains(Departments, in.Department) {
		set(&f, "department", "Pick the department.")
	}
	if !IsDate(in.JoinedOn) {
		set(&f, "joinedOn", "Pick the join date.")
	}
	if in.LeftOn != nil && *in.LeftOn != "" && *in.LeftOn < in.JoinedOn {
		set(&f, "leftOn", "The leaving date is before the join date.")
	}
	if in.Status == "inactive" && (in.LeftOn == nil || *in.LeftOn == "") {
		set(&f, "leftOn", "Record when the employee left.")
	}
	if in.Phone != "" && !phonePattern.MatchString(in.Phone) {
		set(&f, "phone", "Enter a phone number with the country code.")
	}
	if in.Email != "" && !emailPattern.MatchString(in.Email) {
		set(&f, "email", "Enter a valid email address.")
	}
	if in.BasicSalary <= 0 {
		set(&f, "basicSalary", "Enter the basic salary in whole rupiah.")
	}
	if len(in.Allocations) == 0 {
		set(&f, "allocations", "Assign at least one villa.")
	} else {
		var total float64
		seen := map[string]bool{}
		blank := false
		for _, a := range in.Allocations {
			total += a.Percent
			seen[a.VillaID] = true
			blank = blank || a.VillaID == ""
		}
		if total != 100 {
			set(&f, "allocations", fmt.Sprintf("The villa shares add up to %s, not 100%%.", pct(total)))
		}
		if blank {
			set(&f, "allocations", "Pick a villa for every share.")
		}
		if len(seen) != len(in.Allocations) {
			set(&f, "allocations", "A villa is listed twice.")
		}
	}
	for _, a := range in.Allowances {
		if length(a.Name) < 2 || a.Amount < 0 {
			set(&f, "allowances", "Each allowance needs a name and a whole rupiah amount.")
			break
		}
	}
	if in.AnnualLeaveDays < 0 || in.AnnualLeaveDays > 30 {
		set(&f, "annualLeaveDays", "Annual leave is 0 to 30 days.")
	}
	return f.Err()
}

// NormalizeEmployee trims the text the mock trims and copies the lists.
func NormalizeEmployee(in Employee) Employee {
	in.Name = strings.TrimSpace(in.Name)
	in.Position = strings.TrimSpace(in.Position)
	in.Allocations = append([]VillaAllocation{}, in.Allocations...)
	in.Allowances = append([]Allowance{}, in.Allowances...)
	if in.LeftOn != nil && *in.LeftOn == "" {
		in.LeftOn = nil
	}
	return in
}

// AssignmentInput sets or clears one employee's shift on one day.
type AssignmentInput struct {
	EmployeeID string  `json:"employeeId"`
	Date       string  `json:"date"`
	ShiftID    *string `json:"shiftId"`
	VillaID    string  `json:"villaId"`
}

// ValidateAssignment is the services check on assignShift.
func ValidateAssignment(in AssignmentInput) error {
	if !IsDate(in.Date) {
		return errs.Invalid("date", "Pick the day.")
	}
	return nil
}

// AttendanceInput records one day.
type AttendanceInput struct {
	EmployeeID string  `json:"employeeId"`
	Date       string  `json:"date"`
	Status     string  `json:"status"`
	ClockIn    *string `json:"clockIn"`
	ClockOut   *string `json:"clockOut"`
	Note       string  `json:"note"`
}

func isTime(s *string) bool { return s != nil && timePattern.MatchString(*s) }

// MinutesOf is minutesOf: minutes since midnight of HH:MM.
func MinutesOf(hhmm string) int {
	if len(hhmm) < 5 {
		return 0
	}
	return int(hhmm[0]-'0')*600 + int(hhmm[1]-'0')*60 + int(hhmm[3]-'0')*10 + int(hhmm[4]-'0')
}

// LateMinutes is lateMinutes: minutes after the shift start, zero when on time or without a shift.
func LateMinutes(clockIn *string, shift *Shift) int {
	if clockIn == nil || *clockIn == "" || shift == nil {
		return 0
	}
	return max(0, MinutesOf(*clockIn)-MinutesOf(shift.Start))
}

// ValidateAttendance is validateAttendance.
func ValidateAttendance(in AttendanceInput) error {
	var f errs.Fields
	if in.EmployeeID == "" {
		set(&f, "employeeId", "Pick the employee.")
	}
	if !IsDate(in.Date) {
		set(&f, "date", "Pick the date.")
	}
	if !slices.Contains(AttendanceStatuses, in.Status) {
		set(&f, "status", "Pick the status.")
	}
	if (in.Status == "present" || in.Status == "late") && !isTime(in.ClockIn) {
		set(&f, "clockIn", "Enter the clock-in time as HH:MM.")
	}
	if in.ClockOut != nil && *in.ClockOut != "" && !isTime(in.ClockOut) {
		set(&f, "clockOut", "Enter the clock-out time as HH:MM.")
	}
	if isTime(in.ClockIn) && isTime(in.ClockOut) && MinutesOf(*in.ClockOut) <= MinutesOf(*in.ClockIn) {
		set(&f, "clockOut", "Clock-out is before clock-in.")
	}
	return f.Err()
}

// LeaveInput asks for leave.
type LeaveInput struct {
	EmployeeID string `json:"employeeId"`
	Kind       string `json:"kind"`
	From       string `json:"from"`
	To         string `json:"to"`
	Reason     string `json:"reason"`
}

func parse(d string) time.Time {
	t, _ := time.Parse("2006-01-02", d)
	return t
}

func daysBetween(from, to string) int { return int(parse(to).Sub(parse(from)).Hours() / 24) }

// LeaveDays is leaveDays: working days Monday to Saturday between two inclusive dates.
func LeaveDays(from, to string) int {
	start := parse(from)
	days := 0
	for i := 0; i <= daysBetween(from, to); i++ {
		if start.AddDate(0, 0, i).Weekday() != time.Sunday {
			days++
		}
	}
	return days
}

// LeaveBalance is leaveBalance: the entitlement less approved annual leave starting in the year.
func LeaveBalance(e Employee, leaves []LeaveRequest, year string) int {
	used := 0
	for _, l := range leaves {
		if l.EmployeeID == e.ID && l.Kind == "annual" && l.Status == "approved" && strings.HasPrefix(l.From, year) {
			used += l.Days
		}
	}
	return max(0, e.AnnualLeaveDays-used)
}

// ValidateLeave is validateLeave; employee is nil when the id matches nobody.
func ValidateLeave(in LeaveInput, employee *Employee, balance int) error {
	var f errs.Fields
	if employee == nil {
		set(&f, "employeeId", "Pick the employee.")
	}
	if !slices.Contains(LeaveKinds, in.Kind) {
		set(&f, "kind", "Pick the kind of leave.")
	}
	switch {
	case !IsDate(in.From) || !IsDate(in.To):
		set(&f, "to", "Pick both dates.")
	case in.To < in.From:
		set(&f, "to", "The last day is before the first.")
	case daysBetween(in.From, in.To) > 30:
		set(&f, "to", "A request covers at most 31 days.")
	case in.Kind == "annual" && LeaveDays(in.From, in.To) > balance:
		set(&f, "to", fmt.Sprintf("Only %d annual leave days are left.", balance))
	}
	if length(in.Reason) < 3 {
		set(&f, "reason", "Say why.")
	}
	return f.Err()
}

// OvertimeInput asks for overtime.
type OvertimeInput struct {
	EmployeeID string  `json:"employeeId"`
	Date       string  `json:"date"`
	Hours      float64 `json:"hours"`
	VillaID    string  `json:"villaId"`
	Reason     string  `json:"reason"`
}

// ValidateOvertime is validateOvertime.
func ValidateOvertime(in OvertimeInput) error {
	var f errs.Fields
	if in.EmployeeID == "" {
		set(&f, "employeeId", "Pick the employee.")
	}
	if !IsDate(in.Date) {
		set(&f, "date", "Pick the date.")
	}
	if !(in.Hours >= 0.5 && in.Hours <= 8) || math.Round(in.Hours*2) != in.Hours*2 {
		set(&f, "hours", "Overtime is 0.5 to 8 hours, in half hours.")
	}
	if in.VillaID == "" {
		set(&f, "villaId", "Pick the villa the hours were worked at.")
	}
	if length(in.Reason) < 3 {
		set(&f, "reason", "Say what the hours were for.")
	}
	return f.Err()
}

// LoanInput asks for a loan or a salary advance.
type LoanInput struct {
	EmployeeID   string `json:"employeeId"`
	Kind         string `json:"kind"`
	Amount       int64  `json:"amount"`
	Installments int    `json:"installments"`
	Reason       string `json:"reason"`
	StartMonth   string `json:"startMonth"`
}

// LoanInstalment is loanInstalment: the monthly amount rounded up to a thousand.
func LoanInstalment(amount int64, installments int) int64 {
	return int64(math.Ceil(float64(amount)/float64(max(1, installments))/1000)) * 1000
}

// ValidateLoan is validateLoan; open lists the loans of every employee.
func ValidateLoan(in LoanInput, employee *Employee, open []Loan) error {
	var f errs.Fields
	if employee == nil {
		set(&f, "employeeId", "Pick the employee.")
	}
	if in.Amount <= 0 {
		set(&f, "amount", "Enter the amount in whole rupiah.")
	} else if employee != nil && in.Amount > employee.BasicSalary*3 {
		set(&f, "amount", "A loan is at most three months of basic salary.")
	}
	if in.Installments < 1 || in.Installments > 12 {
		set(&f, "installments", "Repay over 1 to 12 months.")
	}
	if in.Kind == "advance" && in.Installments != 1 {
		set(&f, "installments", "A salary advance is repaid from the next payroll.")
	}
	if !monthPattern.MatchString(in.StartMonth) {
		set(&f, "startMonth", "Pick the first repayment month.")
	}
	if length(in.Reason) < 3 {
		set(&f, "reason", "Say what the money is for.")
	}
	if employee != nil {
		for _, l := range open {
			if l.EmployeeID == employee.ID && (l.Status == "pending" || l.Status == "active" || l.Status == "approved") {
				set(&f, "amount", employee.Name+" still has an open loan.")
				break
			}
		}
	}
	return f.Err()
}

// Decide outcomes.
const (
	Approved  = "approved"
	Rejected  = "rejected"
	Cancelled = "cancelled"
)

// CheckDecision is the services check before a decision: a rejection needs a reason.
func CheckDecision(to, note string) error {
	if to == Rejected && length(note) < 3 {
		return errs.Invalid("note", "Say why.")
	}
	return nil
}

// Decide is the mock's decide: only a pending request changes, once.
func Decide(number, status string, d *Decision, to, note, by, today string) (string, error) {
	if status != "pending" {
		return status, errs.Newf("REQUEST_INVALID_STATE", "%s is %s; it can no longer change.", number, status)
	}
	d.DecidedOn = &today
	d.DecidedBy = by
	d.DecisionNote = strings.TrimSpace(note)
	return to, nil
}

// AddDays moves an ISO date.
func AddDays(date string, n int) string { return parse(date).AddDate(0, 0, n).Format("2006-01-02") }
