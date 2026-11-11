// Package payroll is the published language of the payroll context: the period, settings and
// payslip records and the events it publishes. Other contexts may import this package and
// nothing below it.
package payroll

// Event types; the suffix is the payload version.
const (
	EventSettingsSaved = "payroll.settings.saved.v1"
	EventPeriodSaved   = "payroll.period.saved.v1"
	// EventPeriodClosed asks finance to post the salary payment and journal, and tells people to
	// book the loan repayments. It carries every amount, so the consumer needs no callback.
	EventPeriodClosed = "payroll.period.closed.v1"
)

// Settings are the payroll rules the client configures; percentages are of the basic salary.
type Settings struct {
	WorkingDaysPerMonth       int     `json:"workingDaysPerMonth"`
	OvertimeDivisor           float64 `json:"overtimeDivisor"`
	OvertimeMultiplier        float64 `json:"overtimeMultiplier"`
	LateDeductionPerMinute    int64   `json:"lateDeductionPerMinute"`
	LateGraceMinutes          int     `json:"lateGraceMinutes"`
	BPJSHealthEmployeePct     float64 `json:"bpjsHealthEmployeePct"`
	BPJSHealthCompanyPct      float64 `json:"bpjsHealthCompanyPct"`
	BPJSEmploymentEmployeePct float64 `json:"bpjsEmploymentEmployeePct"`
	BPJSEmploymentCompanyPct  float64 `json:"bpjsEmploymentCompanyPct"`
	PTKPMonthly               int64   `json:"ptkpMonthly"`
	PPh21LowerPct             float64 `json:"pph21LowerPct"`
	PPh21Band                 int64   `json:"pph21Band"`
	PPh21UpperPct             float64 `json:"pph21UpperPct"`
	THRMonth                  int     `json:"thrMonth"`
	ServiceChargePct          float64 `json:"serviceChargePct"`
}

// Adjustment is a manual change to one payslip; a deduction is stored negative.
type Adjustment struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Amount int64  `json:"amount"`
	Reason string `json:"reason"`
	By     string `json:"by"`
	On     string `json:"on"`
}

// VillaShare is one villa's share of a payslip's cost.
type VillaShare struct {
	VillaID string  `json:"villaId"`
	Percent float64 `json:"percent"`
	Amount  int64   `json:"amount"`
}

// Line is one employee's pay for the month, every component shown.
type Line struct {
	EmployeeID      string       `json:"employeeId"`
	EmployeeName    string       `json:"employeeName"`
	Basic           int64        `json:"basic"`
	Allowances      int64        `json:"allowances"`
	OvertimeHours   float64      `json:"overtimeHours"`
	OvertimePay     int64        `json:"overtimePay"`
	ServiceCharge   int64        `json:"serviceCharge"`
	THR             int64        `json:"thr"`
	Bonus           int64        `json:"bonus"`
	Reimbursement   int64        `json:"reimbursement"`
	Gross           int64        `json:"gross"`
	LateMinutes     int          `json:"lateMinutes"`
	LateDeduction   int64        `json:"lateDeduction"`
	AbsentDays      int          `json:"absentDays"`
	AbsentDeduction int64        `json:"absentDeduction"`
	LoanDeduction   int64        `json:"loanDeduction"`
	BPJSHealth      int64        `json:"bpjsHealth"`
	BPJSEmployment  int64        `json:"bpjsEmployment"`
	PPh21           int64        `json:"pph21"`
	OtherDeduction  int64        `json:"otherDeduction"`
	Deductions      int64        `json:"deductions"`
	Net             int64        `json:"net"`
	CompanyBPJS     int64        `json:"companyBpjs"`
	Adjustments     []Adjustment `json:"adjustments"`
	Allocation      []VillaShare `json:"allocation"`
}

// History is one step in a period's life.
type History struct {
	Kind string `json:"kind"`
	By   string `json:"by"`
	On   string `json:"on"`
	Note string `json:"note"`
}

// Period is one month's payroll.
type Period struct {
	ID                string    `json:"id"`
	Month             string    `json:"month"`
	Status            string    `json:"status"`
	Lines             []Line    `json:"lines"`
	RevenueBase       int64     `json:"revenueBase"`
	History           []History `json:"history"`
	TransactionID     *string   `json:"transactionId"`
	PaidFromAccountID *string   `json:"paidFromAccountId"`
	Published         bool      `json:"published"`
}

// Totals sums a period.
type Totals struct {
	Employees   int   `json:"employees"`
	Gross       int64 `json:"gross"`
	Deductions  int64 `json:"deductions"`
	Net         int64 `json:"net"`
	CompanyBPJS int64 `json:"companyBpjs"`
	Cost        int64 `json:"cost"`
}

// VillaCost is one villa's payroll cost (net pay plus company BPJS) for a period.
type VillaCost struct {
	VillaID string `json:"villaId"`
	Amount  int64  `json:"amount"`
}

// Statutory is what a closed period owes one office, with the category and reference the
// remittance cash-out uses (statutoryRemittances in journal.ts).
type Statutory struct {
	Key        string `json:"key"`
	Label      string `json:"label"`
	CategoryID string `json:"categoryId"`
	Reference  string `json:"reference"`
	Amount     int64  `json:"amount"`
}

// SettingsSaved is the payload of settings.saved.
type SettingsSaved struct {
	Settings Settings `json:"settings"`
}

// PeriodSaved is the payload of period.saved.
type PeriodSaved struct {
	Period Period `json:"period"`
}

// PeriodClosed is the payload of period.closed: the salary payment to post from AccountID (a
// cash-out of Totals.Net on category cat-payroll with reference PAY-<month>), the cost per villa
// for the journal, the statutory amounts to prefill the remittances, and every payslip.
type PeriodClosed struct {
	PeriodID   string      `json:"periodId"`
	Month      string      `json:"month"`
	AccountID  string      `json:"accountId"`
	CategoryID string      `json:"categoryId"`
	Reference  string      `json:"reference"`
	ClosedOn   string      `json:"closedOn"`
	ClosedBy   string      `json:"closedBy"`
	Totals     Totals      `json:"totals"`
	ByVilla    []VillaCost `json:"byVilla"`
	Statutory  []Statutory `json:"statutory"`
	Lines      []Line      `json:"lines"`
}
