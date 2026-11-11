// Package domain holds the payroll rules ported from src/domain/payroll.ts: settings and
// adjustment validators, the period lifecycle, and the payslip calculation (salary, allowances,
// overtime, service charge share, THR, bonus, reimbursement, late and absence deductions, loan
// instalments, BPJS and simplified PPh 21). The records are the published types of the payroll
// package; employee inputs are the published types of the people package.
package domain

import (
	"math"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/payroll"
	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Records are the published types.
type (
	Settings   = payroll.Settings
	Period     = payroll.Period
	Line       = payroll.Line
	Adjustment = payroll.Adjustment
	History    = payroll.History
	VillaShare = payroll.VillaShare
	Totals     = payroll.Totals
)

// DefaultSettings is DEFAULT_PAYROLL_SETTINGS.
var DefaultSettings = Settings{
	WorkingDaysPerMonth: 25, OvertimeDivisor: 173, OvertimeMultiplier: 1.5, LateDeductionPerMinute: 1_000, LateGraceMinutes: 10,
	BPJSHealthEmployeePct: 1, BPJSHealthCompanyPct: 4, BPJSEmploymentEmployeePct: 3, BPJSEmploymentCompanyPct: 6.24,
	PTKPMonthly: 4_500_000, PPh21LowerPct: 5, PPh21Band: 5_000_000, PPh21UpperPct: 15, THRMonth: 3, ServiceChargePct: 100,
}

// ValidateSettings is validatePayrollSettings.
func ValidateSettings(s Settings) error {
	var f errs.Fields
	pct := func(field string, v float64) {
		if !(v >= 0 && v <= 100) {
			f.Add(field, "A percentage from 0 to 100.")
		}
	}
	if s.WorkingDaysPerMonth < 20 || s.WorkingDaysPerMonth > 31 {
		f.Add("workingDaysPerMonth", "20 to 31 days.")
	}
	if !(s.OvertimeDivisor > 0) {
		f.Add("overtimeDivisor", "Above zero.")
	}
	if !(s.OvertimeMultiplier >= 1) {
		f.Add("overtimeMultiplier", "At least 1.")
	}
	if s.LateDeductionPerMinute < 0 {
		f.Add("lateDeductionPerMinute", "Whole rupiah, zero or more.")
	}
	if s.LateGraceMinutes < 0 {
		f.Add("lateGraceMinutes", "Whole minutes, zero or more.")
	}
	pct("bpjsHealthEmployeePct", s.BPJSHealthEmployeePct)
	pct("bpjsHealthCompanyPct", s.BPJSHealthCompanyPct)
	pct("bpjsEmploymentEmployeePct", s.BPJSEmploymentEmployeePct)
	pct("bpjsEmploymentCompanyPct", s.BPJSEmploymentCompanyPct)
	pct("pph21LowerPct", s.PPh21LowerPct)
	pct("pph21UpperPct", s.PPh21UpperPct)
	pct("serviceChargePct", s.ServiceChargePct)
	if s.PTKPMonthly < 0 {
		f.Add("ptkpMonthly", "Whole rupiah, zero or more.")
	}
	if s.PPh21Band <= 0 {
		f.Add("pph21Band", "Whole rupiah above zero.")
	}
	if s.THRMonth < 1 || s.THRMonth > 12 {
		f.Add("thrMonth", "A month from 1 to 12.")
	}
	return f.Err()
}

// Statuses of a period.
const (
	Draft      = "draft"
	Calculated = "calculated"
	Approved   = "approved"
	Closed     = "closed"
)

// Transitions is PAYROLL_TRANSITIONS.
var Transitions = map[string][]string{
	Draft:      {Calculated},
	Calculated: {Approved, Draft},
	Approved:   {Closed, Draft},
	Closed:     {},
}

// CanTransition is canTransitionPayroll.
func CanTransition(from, to string) bool { return slices.Contains(Transitions[from], to) }

var monthPattern = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)

// ValidateMonth is the services check on createPeriod.
func ValidateMonth(month string) error {
	if !monthPattern.MatchString(month) {
		return errs.Invalid("month", "Pick a month.")
	}
	return nil
}

// AdjustmentKinds is ADJUSTMENT_KINDS.
var AdjustmentKinds = []string{"bonus", "reimbursement", "deduction", "other"}

// AdjustmentInput is a manual change to one payslip.
type AdjustmentInput struct {
	Kind   string `json:"kind"`
	Amount int64  `json:"amount"`
	Reason string `json:"reason"`
}

func length(s string) int { return utf8.RuneCountInString(strings.TrimSpace(s)) }

// ValidateAdjustment is validateAdjustment.
func ValidateAdjustment(in AdjustmentInput) error {
	var f errs.Fields
	if !slices.Contains(AdjustmentKinds, in.Kind) {
		f.Add("kind", "Pick the kind.")
	}
	if in.Amount <= 0 {
		f.Add("amount", "Enter a whole rupiah amount above zero.")
	}
	if length(in.Reason) < 5 {
		f.Add("reason", "Give the reason; it stays on the payslip.")
	}
	return f.Err()
}

// NewAdjustment stores a deduction negative, as the mock does.
func NewAdjustment(id string, in AdjustmentInput, by, on string) Adjustment {
	amount := in.Amount
	if in.Kind == "deduction" {
		amount = -amount
	}
	return Adjustment{ID: id, Kind: in.Kind, Amount: amount, Reason: strings.TrimSpace(in.Reason), By: by, On: on}
}

// LineInputs is what one payslip is computed from.
type LineInputs struct {
	Employee    people.Employee
	Settings    Settings
	Month       string
	Attendance  []people.Attendance
	Overtime    []people.OvertimeRequest
	Loans       []people.Loan
	Adjustments []Adjustment
	// ServiceCharge is this employee's share of the month's pool, already split.
	ServiceCharge int64
}

// round is Math.round for the non-negative amounts payroll rounds.
func round(v float64) int64 { return int64(math.Floor(v + 0.5)) }

func pct(base int64, p float64) int64 { return round(float64(base) * p / 100) }

func parse(d string) time.Time {
	t, _ := time.Parse("2006-01-02", d)
	return t
}

// TenureMonths is tenureMonths: months of service completed at the first of month.
func TenureMonths(joinedOn, month string) int {
	first := month + "-01"
	if joinedOn > first {
		return 0
	}
	days := math.Round(parse(first).Sub(parse(joinedOn)).Hours() / 24)
	return int(math.Floor(days / 30.4375))
}

// THRFor is thrFor: one basic salary after a year in the THR month, pro rata from one month.
func THRFor(e people.Employee, s Settings, month string) int64 {
	if len(month) < 7 || int(month[5]-'0')*10+int(month[6]-'0') != s.THRMonth {
		return 0
	}
	months := min(12, TenureMonths(e.JoinedOn, month))
	if months < 1 {
		return 0
	}
	return round(float64(e.BasicSalary) * float64(months) / 12)
}

// PPh21 is pph21: two bands over the amount above PTKP.
func PPh21(gross, employeeBPJS int64, s Settings) int64 {
	taxable := gross - employeeBPJS - s.PTKPMonthly
	if taxable <= 0 {
		return 0
	}
	lower := min(taxable, s.PPh21Band)
	upper := max(0, taxable-s.PPh21Band)
	return round(float64(lower)*s.PPh21LowerPct/100 + float64(upper)*s.PPh21UpperPct/100)
}

// ComputeLine is computeLine.
func ComputeLine(in LineInputs) Line {
	e, s, month := in.Employee, in.Settings, in.Month
	inMonth := func(d string) bool { return strings.HasPrefix(d, month) }
	late, absent := 0, 0
	for _, a := range in.Attendance {
		if a.EmployeeID != e.ID || !inMonth(a.Date) {
			continue
		}
		if a.Status == "late" {
			late += max(0, a.LateMinutes-s.LateGraceMinutes)
		}
		if a.Status == "absent" {
			absent++
		}
	}
	var overtimeHours float64
	for _, o := range in.Overtime {
		if o.EmployeeID == e.ID && o.Status == "approved" && inMonth(o.Date) {
			overtimeHours += o.Hours
		}
	}
	hourly := float64(e.BasicSalary) / s.OvertimeDivisor * s.OvertimeMultiplier
	var allowances, bonus, reimbursement, otherPlus, otherMinus int64
	for _, a := range e.Allowances {
		allowances += a.Amount
	}
	for _, a := range in.Adjustments {
		switch {
		case a.Kind == "bonus":
			bonus += a.Amount
		case a.Kind == "reimbursement":
			reimbursement += a.Amount
		case a.Kind == "other" && a.Amount > 0:
			otherPlus += a.Amount
		case a.Kind == "deduction" || (a.Kind == "other" && a.Amount < 0):
			otherMinus += abs(a.Amount)
		}
	}
	thr := THRFor(e, s, month)
	overtimePay := round(overtimeHours * hourly)
	var serviceCharge int64
	if e.ServiceChargeEligible {
		serviceCharge = in.ServiceCharge
	}
	gross := e.BasicSalary + allowances + overtimePay + serviceCharge + thr + bonus + reimbursement + otherPlus
	lateDeduction := int64(late) * s.LateDeductionPerMinute
	absentDeduction := round(float64(e.BasicSalary) / float64(s.WorkingDaysPerMonth) * float64(absent))
	var loanDeduction int64
	for _, l := range in.Loans {
		if l.EmployeeID == e.ID && l.Status == "active" && l.StartMonth <= month {
			loanDeduction += min(l.Monthly, max(0, l.Amount-l.Repaid))
		}
	}
	var bpjsHealth, bpjsEmployment, companyBPJS int64
	if e.BPJSEnrolled {
		bpjsHealth = pct(e.BasicSalary, s.BPJSHealthEmployeePct)
		bpjsEmployment = pct(e.BasicSalary, s.BPJSEmploymentEmployeePct)
		companyBPJS = pct(e.BasicSalary, s.BPJSHealthCompanyPct) + pct(e.BasicSalary, s.BPJSEmploymentCompanyPct)
	}
	tax := PPh21(gross-reimbursement, bpjsHealth+bpjsEmployment, s)
	deductions := lateDeduction + absentDeduction + loanDeduction + bpjsHealth + bpjsEmployment + tax + otherMinus
	net := max(0, gross-deductions)
	allocation := make([]VillaShare, 0, len(e.Allocations))
	for _, a := range e.Allocations {
		allocation = append(allocation, VillaShare{VillaID: a.VillaID, Percent: a.Percent, Amount: round(float64(net+companyBPJS) * a.Percent / 100)})
	}
	adjustments := in.Adjustments
	if adjustments == nil {
		adjustments = []Adjustment{}
	}
	return Line{
		EmployeeID: e.ID, EmployeeName: e.Name, Basic: e.BasicSalary, Allowances: allowances, OvertimeHours: overtimeHours, OvertimePay: overtimePay,
		ServiceCharge: serviceCharge, THR: thr, Bonus: bonus, Reimbursement: reimbursement, Gross: gross, LateMinutes: late, LateDeduction: lateDeduction,
		AbsentDays: absent, AbsentDeduction: absentDeduction, LoanDeduction: loanDeduction, BPJSHealth: bpjsHealth, BPJSEmployment: bpjsEmployment,
		PPh21: tax, OtherDeduction: otherMinus, Deductions: deductions, Net: net, CompanyBPJS: companyBPJS, Adjustments: adjustments, Allocation: allocation,
	}
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// ServiceChargeShare is serviceChargeShare: an equal split of the pool, floored to a thousand.
func ServiceChargeShare(revenue int64, s Settings, eligible int) int64 {
	if eligible <= 0 {
		return 0
	}
	return int64(math.Floor(float64(revenue)*s.ServiceChargePct/100/float64(eligible)/1000)) * 1000
}

// Staff is who a period pays: everyone not inactive, and leavers who left after the first.
func Staff(employees []people.Employee, month string) []people.Employee {
	from := month + "-01"
	var out []people.Employee
	for _, e := range employees {
		if e.Status != "inactive" || (e.LeftOn != nil && *e.LeftOn > from) {
			out = append(out, e)
		}
	}
	return out
}

// PeriodInputs is what computePeriodLines reads.
type PeriodInputs struct {
	Settings   Settings
	Employees  []people.Employee
	Attendance []people.Attendance
	Overtime   []people.OvertimeRequest
	Loans      []people.Loan
	// Pool is the month's service charge pool.
	Pool int64
}

// ComputeLines is the mock's computePeriodLines: one line per employee on the payroll, keeping
// the adjustments of keep.
func ComputeLines(month string, in PeriodInputs, keep []Line) []Line {
	staff := Staff(in.Employees, month)
	eligible := 0
	for _, e := range staff {
		if e.ServiceChargeEligible {
			eligible++
		}
	}
	share := ServiceChargeShare(in.Pool, in.Settings, eligible)
	lines := make([]Line, 0, len(staff))
	for _, e := range staff {
		var adjustments []Adjustment
		for _, l := range keep {
			if l.EmployeeID == e.ID {
				adjustments = l.Adjustments
			}
		}
		lines = append(lines, ComputeLine(LineInputs{Employee: e, Settings: in.Settings, Month: month, Attendance: in.Attendance, Overtime: in.Overtime,
			Loans: in.Loans, Adjustments: adjustments, ServiceCharge: share}))
	}
	return lines
}

// PeriodTotals is periodTotals.
func PeriodTotals(lines []Line) Totals {
	t := Totals{Employees: len(lines)}
	for _, l := range lines {
		t.Gross += l.Gross
		t.Deductions += l.Deductions
		t.Net += l.Net
		t.CompanyBPJS += l.CompanyBPJS
	}
	t.Cost = t.Net + t.CompanyBPJS
	return t
}

// CostByVilla is costByVilla, in first-seen order.
func CostByVilla(lines []Line) []payroll.VillaCost {
	var out []payroll.VillaCost
	index := map[string]int{}
	for _, l := range lines {
		for _, a := range l.Allocation {
			i, ok := index[a.VillaID]
			if !ok {
				i = len(out)
				index[a.VillaID] = i
				out = append(out, payroll.VillaCost{VillaID: a.VillaID})
			}
			out[i].Amount += a.Amount
		}
	}
	return out
}

// StatutoryOwed is what a period owes each office: BPJS from both sides and PPh 21 withheld, with
// the categories and references statutoryRemittances uses.
func StatutoryOwed(month string, lines []Line) []payroll.Statutory {
	var bpjs, pph21 int64
	for _, l := range lines {
		bpjs += l.BPJSHealth + l.BPJSEmployment + l.CompanyBPJS
		pph21 += l.PPh21
	}
	return []payroll.Statutory{
		{Key: "bpjs", Label: "BPJS", CategoryID: "cat-bpjs", Reference: "BPJS-" + month, Amount: bpjs},
		{Key: "pph21", Label: "PPh 21", CategoryID: "cat-pph21", Reference: "PPH21-" + month, Amount: pph21},
	}
}

// Editable refuses a change to a period past calculated.
func Editable(p Period, what string) error {
	if p.Status != Draft && p.Status != Calculated {
		return errs.Newf("PAYROLL_LOCKED", "Payroll %s is %s%s", p.Month, p.Status, what)
	}
	return nil
}

// Line finds an employee's line.
func LineOf(p Period, employeeID string) (int, bool) {
	for i, l := range p.Lines {
		if l.EmployeeID == employeeID {
			return i, true
		}
	}
	return -1, false
}

// CheckTransition is the services and mock checks before a transition, in their order.
func CheckTransition(p Period, to, note, accountID string) error {
	if to == Draft && length(note) < 3 {
		return errs.Invalid("note", "Say why the payroll reopens.")
	}
	if to == Closed && accountID == "" {
		return errs.Invalid("accountId", "Pick the account the salaries are paid from.")
	}
	if !CanTransition(p.Status, to) {
		return errs.Newf("PAYROLL_INVALID_STATE", "Payroll %s is %s; it cannot become %s.", p.Month, p.Status, to)
	}
	return nil
}

// CheckApprover is APPROVAL_SELF: whoever calculated the payroll cannot approve it, unless the
// approver is the owner.
func CheckApprover(p Period, name, role string) error {
	if role == "owner" {
		return nil
	}
	for _, h := range p.History {
		if h.Kind == Calculated && h.By == name {
			return errs.New("APPROVAL_SELF", "The person who calculated the payroll cannot approve it.")
		}
	}
	return nil
}
