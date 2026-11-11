// Package people is the published language of the people context: the records it owns and the
// events it publishes. Payloads carry the full record, so payroll builds its copy of employees,
// attendance, overtime and loans from one event without calling back. Other contexts may import
// this package and nothing below it.
package people

// Event types; the suffix is the payload version.
const (
	EventEmployeeSaved       = "people.employee.saved.v1"
	EventShiftSaved          = "people.shift.saved.v1"
	EventAssignmentSaved     = "people.shift_assignment.saved.v1"
	EventAttendanceRecorded  = "people.attendance.recorded.v1"
	EventLeaveSaved          = "people.leave.saved.v1"
	EventOvertimeSaved       = "people.overtime.saved.v1"
	EventLoanSaved           = "people.loan.saved.v1"
	EventAnnouncementSaved   = "people.announcement.saved.v1"
	EventAnnouncementRemoved = "people.announcement.removed.v1"
	EventKpiSaved            = "people.kpi_review.saved.v1"
)

// Allowance is a fixed monthly allowance.
type Allowance struct {
	Name   string `json:"name"`
	Amount int64  `json:"amount"`
}

// VillaAllocation is one villa's share of an employee's cost; the shares add up to 100.
type VillaAllocation struct {
	VillaID string  `json:"villaId"`
	Percent float64 `json:"percent"`
}

// Employee is an employee's state.
type Employee struct {
	ID                    string            `json:"id"`
	Code                  string            `json:"code"`
	Name                  string            `json:"name"`
	Position              string            `json:"position"`
	Department            string            `json:"department"`
	Status                string            `json:"status"`
	JoinedOn              string            `json:"joinedOn"`
	LeftOn                *string           `json:"leftOn"`
	Phone                 string            `json:"phone"`
	Email                 string            `json:"email"`
	BankName              string            `json:"bankName"`
	BankAccount           string            `json:"bankAccount"`
	NPWP                  string            `json:"npwp"`
	Allocations           []VillaAllocation `json:"allocations"`
	BasicSalary           int64             `json:"basicSalary"`
	Allowances            []Allowance       `json:"allowances"`
	ServiceChargeEligible bool              `json:"serviceChargeEligible"`
	BPJSEnrolled          bool              `json:"bpjsEnrolled"`
	AnnualLeaveDays       int               `json:"annualLeaveDays"`
}

// VillaIDs lists the villas the employee works at.
func (e Employee) VillaIDs() []string {
	out := make([]string, 0, len(e.Allocations))
	for _, a := range e.Allocations {
		out = append(out, a.VillaID)
	}
	return out
}

// Shift is a named working shift; times are HH:MM.
type Shift struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Start string `json:"start"`
	End   string `json:"end"`
}

// ShiftAssignment is one employee's shift on one day; a nil shift is a day off.
type ShiftAssignment struct {
	ID         string  `json:"id"`
	EmployeeID string  `json:"employeeId"`
	Date       string  `json:"date"`
	ShiftID    *string `json:"shiftId"`
	VillaID    string  `json:"villaId"`
}

// Attendance is one employee's attendance on one day.
type Attendance struct {
	ID          string  `json:"id"`
	EmployeeID  string  `json:"employeeId"`
	Date        string  `json:"date"`
	Status      string  `json:"status"`
	ClockIn     *string `json:"clockIn"`
	ClockOut    *string `json:"clockOut"`
	LateMinutes int     `json:"lateMinutes"`
	Note        string  `json:"note"`
}

// Decision is who decided a request, when and why.
type Decision struct {
	DecidedOn    *string `json:"decidedOn"`
	DecidedBy    string  `json:"decidedBy"`
	DecisionNote string  `json:"decisionNote"`
}

// LeaveRequest is a leave request; To is the inclusive last day.
type LeaveRequest struct {
	ID          string `json:"id"`
	Number      string `json:"number"`
	EmployeeID  string `json:"employeeId"`
	Kind        string `json:"kind"`
	From        string `json:"from"`
	To          string `json:"to"`
	Days        int    `json:"days"`
	Reason      string `json:"reason"`
	Status      string `json:"status"`
	RequestedOn string `json:"requestedOn"`
	Decision
}

// OvertimeRequest is an overtime request.
type OvertimeRequest struct {
	ID          string  `json:"id"`
	Number      string  `json:"number"`
	EmployeeID  string  `json:"employeeId"`
	Date        string  `json:"date"`
	Hours       float64 `json:"hours"`
	VillaID     string  `json:"villaId"`
	Reason      string  `json:"reason"`
	Status      string  `json:"status"`
	RequestedOn string  `json:"requestedOn"`
	Decision
}

// Loan is money lent to an employee and repaid through payroll in monthly instalments.
type Loan struct {
	ID           string `json:"id"`
	Number       string `json:"number"`
	EmployeeID   string `json:"employeeId"`
	Kind         string `json:"kind"`
	Amount       int64  `json:"amount"`
	Installments int    `json:"installments"`
	Monthly      int64  `json:"monthly"`
	Repaid       int64  `json:"repaid"`
	Reason       string `json:"reason"`
	Status       string `json:"status"`
	RequestedOn  string `json:"requestedOn"`
	StartMonth   string `json:"startMonth"`
	Decision
}

// Announcement is a company notice; a nil villa reaches everyone.
type Announcement struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Body        string  `json:"body"`
	PublishedOn string  `json:"publishedOn"`
	By          string  `json:"by"`
	Pinned      bool    `json:"pinned"`
	VillaID     *string `json:"villaId"`
}

// KpiItem is one indicator of a scorecard.
type KpiItem struct {
	Name   string  `json:"name"`
	Target float64 `json:"target"`
	Actual float64 `json:"actual"`
	Weight float64 `json:"weight"`
	Unit   string  `json:"unit"`
}

// KpiReview is one employee's scorecard for a quarter.
type KpiReview struct {
	ID         string    `json:"id"`
	EmployeeID string    `json:"employeeId"`
	Period     string    `json:"period"`
	Items      []KpiItem `json:"items"`
	Status     string    `json:"status"`
	Reviewer   string    `json:"reviewer"`
	Note       string    `json:"note"`
	ReviewedOn string    `json:"reviewedOn"`
}

// EmployeeSaved is the payload of employee.saved. LocationIDs runs parallel to the allocations,
// so a consumer applies the villa and location scope without the property catalog.
type EmployeeSaved struct {
	Employee    Employee `json:"employee"`
	LocationIDs []string `json:"locationIds"`
}

// ShiftSaved is the payload of shift.saved.
type ShiftSaved struct {
	Shift Shift `json:"shift"`
}

// AssignmentSaved is the payload of shift_assignment.saved.
type AssignmentSaved struct {
	Assignment ShiftAssignment `json:"assignment"`
}

// AttendanceRecorded is the payload of attendance.recorded.
type AttendanceRecorded struct {
	Attendance Attendance `json:"attendance"`
}

// LeaveSaved is the payload of leave.saved.
type LeaveSaved struct {
	Leave LeaveRequest `json:"leave"`
}

// OvertimeSaved is the payload of overtime.saved.
type OvertimeSaved struct {
	Overtime OvertimeRequest `json:"overtime"`
}

// LoanSaved is the payload of loan.saved.
type LoanSaved struct {
	Loan Loan `json:"loan"`
}

// AnnouncementSaved is the payload of announcement.saved.
type AnnouncementSaved struct {
	Announcement Announcement `json:"announcement"`
	LocationID   string       `json:"locationId"`
}

// AnnouncementRemoved is the payload of announcement.removed.
type AnnouncementRemoved struct {
	ID string `json:"id"`
}

// KpiSaved is the payload of kpi_review.saved.
type KpiSaved struct {
	Review KpiReview `json:"review"`
}
