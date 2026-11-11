package domain_test

import (
	"reflect"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/payroll/domain"
	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

var s = domain.DefaultSettings

func wayan() people.Employee {
	return people.Employee{
		ID: "emp-002", Name: "Wayan Sudiarta", Status: "active", JoinedOn: "2024-08-18", BasicSalary: 4_200_000,
		Allowances:  []people.Allowance{{Name: "Meal", Amount: 600_000}, {Name: "Transport", Amount: 400_000}},
		Allocations: []people.VillaAllocation{{VillaID: "vil-saka", Percent: 100}}, ServiceChargeEligible: true, BPJSEnrolled: true,
	}
}

func TestPPh21TaxesTheAmountAbovePTKPInTwoBands(t *testing.T) {
	cases := []struct {
		gross, bpjs, want int64
	}{
		{4_000_000, 168_000, 0},              // below PTKP
		{4_668_000, 168_000, 0},              // exactly PTKP
		{6_109_249, 168_000, 72_062},         // lower band only: 1 441 249 × 5%
		{10_000_000, 400_000, 265_000},       // 5 000 000 × 5% + 100 000 × 15%
		{20_000_000, 0, 250_000 + 1_575_000}, // 5 000 000 × 5% + 10 500 000 × 15%
	}
	for _, c := range cases {
		if got := domain.PPh21(c.gross, c.bpjs, s); got != c.want {
			t.Errorf("PPh21(%d, %d) = %d, want %d", c.gross, c.bpjs, got, c.want)
		}
	}
}

func TestBPJSSharesFollowTheSettings(t *testing.T) {
	line := domain.ComputeLine(domain.LineInputs{Employee: wayan(), Settings: s, Month: "2026-11"})
	if line.BPJSHealth != 42_000 || line.BPJSEmployment != 126_000 || line.CompanyBPJS != 168_000+262_080 {
		t.Fatalf("BPJS: health %d employment %d company %d", line.BPJSHealth, line.BPJSEmployment, line.CompanyBPJS)
	}
	e := wayan()
	e.BPJSEnrolled = false
	if l := domain.ComputeLine(domain.LineInputs{Employee: e, Settings: s, Month: "2026-11"}); l.BPJSHealth+l.BPJSEmployment+l.CompanyBPJS != 0 {
		t.Fatalf("not enrolled pays no BPJS: %+v", l)
	}
}

func TestOvertimeIsBasicOver173TimesOneAndAHalf(t *testing.T) {
	overtime := []people.OvertimeRequest{
		{EmployeeID: "emp-002", Date: "2026-11-03", Hours: 3, Status: "approved"},
		{EmployeeID: "emp-002", Date: "2026-11-04", Hours: 2, Status: "pending"},
		{EmployeeID: "emp-002", Date: "2026-10-30", Hours: 4, Status: "approved"},
	}
	line := domain.ComputeLine(domain.LineInputs{Employee: wayan(), Settings: s, Month: "2026-11", Overtime: overtime})
	// 4 200 000 / 173 × 1.5 × 3 = 109 248.55
	if line.OvertimeHours != 3 || line.OvertimePay != 109_249 {
		t.Fatalf("overtime: %v h, %d", line.OvertimeHours, line.OvertimePay)
	}
}

func TestLoanDeductsTheInstalmentUpToWhatIsLeft(t *testing.T) {
	loans := []people.Loan{
		{EmployeeID: "emp-002", Status: "active", Amount: 6_000_000, Monthly: 1_000_000, Repaid: 5_500_000, StartMonth: "2026-06"},
		{EmployeeID: "emp-002", Status: "active", Amount: 2_000_000, Monthly: 1_000_000, StartMonth: "2026-12"},
		{EmployeeID: "emp-002", Status: "pending", Amount: 2_000_000, Monthly: 1_000_000, StartMonth: "2026-01"},
	}
	line := domain.ComputeLine(domain.LineInputs{Employee: wayan(), Settings: s, Month: "2026-11", Loans: loans})
	if line.LoanDeduction != 500_000 {
		t.Fatalf("only the active loan that has started deducts, capped at the balance: %d", line.LoanDeduction)
	}
}

func TestTHRIsPaidProRataInTheConfiguredMonth(t *testing.T) {
	e := wayan()
	e.JoinedOn = "2026-09-01"
	if got := domain.THRFor(e, s, "2027-03"); got != 1_750_000 {
		t.Fatalf("five months of service: %d", got)
	}
	e.JoinedOn = "2020-01-01"
	if got := domain.THRFor(e, s, "2027-03"); got != 4_200_000 {
		t.Fatalf("a full year: %d", got)
	}
	if got := domain.THRFor(e, s, "2027-04"); got != 0 {
		t.Fatalf("outside the THR month: %d", got)
	}
	e.JoinedOn = "2027-02-15"
	if got := domain.THRFor(e, s, "2027-03"); got != 0 {
		t.Fatalf("under a month: %d", got)
	}
	if got := domain.TenureMonths("2026-09-01", "2027-03"); got != 5 {
		t.Fatalf("tenure: %d", got)
	}
}

func TestServiceChargeShareSplitsThePoolEvenlyToTheThousand(t *testing.T) {
	if got := domain.ServiceChargeShare(10_000_000, s, 12); got != 833_000 {
		t.Fatalf("share: %d", got)
	}
	if got := domain.ServiceChargeShare(10_000_000, s, 0); got != 0 {
		t.Fatalf("nobody eligible: %d", got)
	}
}

func TestComputeLineAddsUpEveryComponent(t *testing.T) {
	in := domain.LineInputs{
		Employee: wayan(), Settings: s, Month: "2026-11", ServiceCharge: 500_000,
		Attendance: []people.Attendance{
			{EmployeeID: "emp-002", Date: "2026-11-02", Status: "late", LateMinutes: 25},
			{EmployeeID: "emp-002", Date: "2026-11-03", Status: "absent"},
			{EmployeeID: "emp-002", Date: "2026-11-04", Status: "late", LateMinutes: 5},
			{EmployeeID: "emp-003", Date: "2026-11-03", Status: "absent"},
		},
		Overtime: []people.OvertimeRequest{{EmployeeID: "emp-002", Date: "2026-11-03", Hours: 3, Status: "approved"}},
		Loans:    []people.Loan{{EmployeeID: "emp-002", Status: "active", Amount: 6_000_000, Monthly: 1_000_000, Repaid: 2_000_000, StartMonth: "2026-09"}},
		Adjustments: []domain.Adjustment{
			{Kind: "bonus", Amount: 300_000}, {Kind: "reimbursement", Amount: 250_000}, {Kind: "deduction", Amount: -100_000},
		},
	}
	l := domain.ComputeLine(in)
	want := domain.Line{
		Allowances: 1_000_000, OvertimePay: 109_249, ServiceCharge: 500_000, Bonus: 300_000, Reimbursement: 250_000, Gross: 6_359_249,
		LateMinutes: 15, LateDeduction: 15_000, AbsentDays: 1, AbsentDeduction: 168_000, LoanDeduction: 1_000_000,
		PPh21: 72_062, OtherDeduction: 100_000, Deductions: 1_523_062, Net: 4_836_187, CompanyBPJS: 430_080,
	}
	got := domain.Line{
		Allowances: l.Allowances, OvertimePay: l.OvertimePay, ServiceCharge: l.ServiceCharge, Bonus: l.Bonus, Reimbursement: l.Reimbursement, Gross: l.Gross,
		LateMinutes: l.LateMinutes, LateDeduction: l.LateDeduction, AbsentDays: l.AbsentDays, AbsentDeduction: l.AbsentDeduction, LoanDeduction: l.LoanDeduction,
		PPh21: l.PPh21, OtherDeduction: l.OtherDeduction, Deductions: l.Deductions, Net: l.Net, CompanyBPJS: l.CompanyBPJS,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("line\n got %+v\nwant %+v", got, want)
	}
	if len(l.Allocation) != 1 || l.Allocation[0].Amount != 4_836_187+430_080 {
		t.Fatalf("allocation: %+v", l.Allocation)
	}
	e := wayan()
	e.ServiceChargeEligible = false
	if domain.ComputeLine(domain.LineInputs{Employee: e, Settings: s, Month: "2026-11", ServiceCharge: 500_000}).ServiceCharge != 0 {
		t.Fatal("an ineligible employee gets no share")
	}
}

func TestStaffLeavesOutThoseWhoLeftBeforeTheMonth(t *testing.T) {
	left, later := "2026-10-20", "2026-11-05"
	staff := domain.Staff([]people.Employee{
		{ID: "a", Status: "active"}, {ID: "b", Status: "inactive", LeftOn: &left}, {ID: "c", Status: "inactive", LeftOn: &later}, {ID: "d", Status: "probation"},
	}, "2026-11")
	if len(staff) != 3 || staff[1].ID != "c" {
		t.Fatalf("staff: %+v", staff)
	}
}

func TestPeriodTransitionsAndChecks(t *testing.T) {
	p := domain.Period{Month: "2026-11", Status: domain.Calculated, History: []domain.History{{Kind: "calculated", By: "Nia Kusuma"}}}
	if err := domain.CheckTransition(p, domain.Closed, "", "bank-bca"); !errs.HasCode(err, "PAYROLL_INVALID_STATE") || err.(*errs.Error).Message != "Payroll 2026-11 is calculated; it cannot become closed." {
		t.Fatalf("close before approval: %v", err)
	}
	if err := domain.CheckTransition(p, domain.Draft, "no", ""); !errs.HasCode(err, errs.CodeValidation) {
		t.Fatalf("reopen without a reason: %v", err)
	}
	if err := domain.CheckTransition(domain.Period{Status: domain.Approved}, domain.Closed, "", ""); err == nil || err.(*errs.Error).Message != "Pick the account the salaries are paid from." {
		t.Fatalf("close without an account: %v", err)
	}
	if err := domain.CheckApprover(p, "Nia Kusuma", "hr"); !errs.HasCode(err, "APPROVAL_SELF") {
		t.Fatalf("self approval: %v", err)
	}
	if err := domain.CheckApprover(p, "Nia Kusuma", "owner"); err != nil {
		t.Fatalf("the owner may approve their own: %v", err)
	}
	if err := domain.Editable(domain.Period{Month: "2026-10", Status: domain.Closed}, "; reopen it to recalculate."); err == nil || err.(*errs.Error).Message != "Payroll 2026-10 is closed; reopen it to recalculate." {
		t.Fatalf("locked: %v", err)
	}
}

func TestValidators(t *testing.T) {
	bad := s
	bad.THRMonth = 13
	bad.BPJSHealthCompanyPct = 120
	err := domain.ValidateSettings(bad)
	if e, ok := errs.As(err); !ok || e.Message != "A percentage from 0 to 100." || len(e.Fields) != 2 {
		t.Fatalf("settings: %v", err)
	}
	if err := domain.ValidateSettings(s); err != nil {
		t.Fatalf("defaults are valid: %v", err)
	}
	if err := domain.ValidateAdjustment(domain.AdjustmentInput{Kind: "bonus", Amount: 100, Reason: "ok"}); err == nil || err.(*errs.Error).Message != "Give the reason; it stays on the payslip." {
		t.Fatalf("adjustment: %v", err)
	}
	if a := domain.NewAdjustment("adj-1", domain.AdjustmentInput{Kind: "deduction", Amount: 50_000, Reason: " Broken glass "}, "Nia", "2026-11-11"); a.Amount != -50_000 || a.Reason != "Broken glass" {
		t.Fatalf("deduction is stored negative: %+v", a)
	}
	if err := domain.ValidateMonth("2026-13"); err == nil {
		t.Fatal("month 13")
	}
	owed := domain.StatutoryOwed("2026-11", []domain.Line{{BPJSHealth: 1, BPJSEmployment: 2, CompanyBPJS: 3, PPh21: 4}})
	if owed[0].Amount != 6 || owed[0].Reference != "BPJS-2026-11" || owed[1].Amount != 4 || owed[1].CategoryID != "cat-pph21" {
		t.Fatalf("statutory: %+v", owed)
	}
}
