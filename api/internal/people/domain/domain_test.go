package domain_test

import (
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func message(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Message
	}
	return ""
}

func field(err error, name string) string {
	if e, ok := errs.As(err); ok {
		return errs.Fields(e.Fields).Map()[name]
	}
	return ""
}

func sari() domain.Employee {
	return domain.Employee{
		ID: "emp-003", Code: "EMP-003", Name: "Ni Luh Putu Sari", Position: "Housekeeping", Department: "housekeeping", Status: "active",
		JoinedOn: "2025-02-09", BasicSalary: 3_600_000, AnnualLeaveDays: 12,
		Allocations: []domain.VillaAllocation{{VillaID: "vil-saka", Percent: 100}},
	}
}

func TestLeaveDaysCountMondayToSaturday(t *testing.T) {
	cases := []struct {
		from, to string
		want     int
	}{
		{"2026-11-02", "2026-11-04", 3},
		{"2026-11-02", "2026-11-14", 12}, // Sunday the 8th is not a leave day
		{"2026-11-08", "2026-11-08", 0},
		{"2026-11-09", "2026-11-15", 6},
	}
	for _, c := range cases {
		if got := domain.LeaveDays(c.from, c.to); got != c.want {
			t.Errorf("LeaveDays(%s, %s) = %d, want %d", c.from, c.to, got, c.want)
		}
	}
}

func TestLeaveBalanceCountsApprovedAnnualLeaveInTheYear(t *testing.T) {
	leaves := []domain.LeaveRequest{
		{EmployeeID: "emp-003", Kind: "annual", Status: "approved", From: "2026-10-02", Days: 4},
		{EmployeeID: "emp-003", Kind: "annual", Status: "pending", From: "2026-11-20", Days: 2},
		{EmployeeID: "emp-003", Kind: "sick", Status: "approved", From: "2026-09-02", Days: 2},
		{EmployeeID: "emp-003", Kind: "annual", Status: "approved", From: "2025-12-29", Days: 3},
		{EmployeeID: "emp-009", Kind: "annual", Status: "approved", From: "2026-10-02", Days: 5},
	}
	if got := domain.LeaveBalance(sari(), leaves, "2026"); got != 8 {
		t.Fatalf("balance: %d", got)
	}
	err := domain.ValidateLeave(domain.LeaveInput{EmployeeID: "emp-003", Kind: "annual", From: "2026-11-02", To: "2026-11-14", Reason: "Long trip"}, ptr(sari()), 8)
	if message(err) != "Only 8 annual leave days are left." {
		t.Fatalf("over the balance: %v", err)
	}
	if err := domain.ValidateLeave(domain.LeaveInput{EmployeeID: "emp-003", Kind: "sick", From: "2026-11-02", To: "2026-11-14", Reason: "Flu"}, ptr(sari()), 0); err != nil {
		t.Fatalf("sick leave ignores the balance: %v", err)
	}
	err = domain.ValidateLeave(domain.LeaveInput{Kind: "annual", From: "2026-11-04", To: "2026-11-02", Reason: "x"}, nil, 0)
	if e, _ := errs.As(err); e == nil || e.Message != "Pick the employee." || field(err, "to") != "The last day is before the first." || field(err, "reason") != "Say why." {
		t.Fatalf("errors in order: %v", err)
	}
	if message(domain.ValidateLeave(domain.LeaveInput{EmployeeID: "emp-003", Kind: "unpaid", From: "2026-11-01", To: "2026-12-05", Reason: "Trip"}, ptr(sari()), 0)) != "A request covers at most 31 days." {
		t.Fatal("31 days")
	}
}

func ptr[T any](v T) *T { return &v }

func TestLateMinutesCountFromTheShiftStart(t *testing.T) {
	morning := &domain.Shift{ID: "sh-morning", Start: "07:00", End: "15:00"}
	if got := domain.LateMinutes(ptr("07:25"), morning); got != 25 {
		t.Fatalf("late: %d", got)
	}
	if got := domain.LateMinutes(ptr("06:50"), morning); got != 0 {
		t.Fatalf("early: %d", got)
	}
	if got := domain.LateMinutes(ptr("09:00"), nil); got != 0 {
		t.Fatalf("no shift: %d", got)
	}
	err := domain.ValidateAttendance(domain.AttendanceInput{EmployeeID: "emp-002", Date: "2026-11-11", Status: "late", ClockIn: ptr("15:00"), ClockOut: ptr("07:00")})
	if message(err) != "Clock-out is before clock-in." {
		t.Fatalf("clock-out: %v", err)
	}
	if message(domain.ValidateAttendance(domain.AttendanceInput{EmployeeID: "emp-002", Date: "2026-11-11", Status: "present"})) != "Enter the clock-in time as HH:MM." {
		t.Fatal("present needs a clock-in")
	}
}

func TestLoanInstalmentRoundsUpToAThousand(t *testing.T) {
	cases := []struct {
		amount int64
		n      int
		want   int64
	}{{6_000_000, 6, 1_000_000}, {4_000_000, 3, 1_334_000}, {1_500_000, 1, 1_500_000}, {1_000, 0, 1_000}}
	for _, c := range cases {
		if got := domain.LoanInstalment(c.amount, c.n); got != c.want {
			t.Errorf("LoanInstalment(%d, %d) = %d, want %d", c.amount, c.n, got, c.want)
		}
	}
}

func TestLoanRules(t *testing.T) {
	e := sari()
	open := []domain.Loan{{EmployeeID: "emp-003", Status: "active"}}
	err := domain.ValidateLoan(domain.LoanInput{EmployeeID: "emp-003", Kind: "loan", Amount: 1_000_000, Installments: 2, Reason: "Second loan", StartMonth: "2026-11"}, &e, open)
	if message(err) != "Ni Luh Putu Sari still has an open loan." {
		t.Fatalf("open loan: %v", err)
	}
	err = domain.ValidateLoan(domain.LoanInput{EmployeeID: "emp-003", Kind: "loan", Amount: 20_000_000, Installments: 2, Reason: "Car", StartMonth: "2026-11"}, &e, nil)
	if message(err) != "A loan is at most three months of basic salary." {
		t.Fatalf("cap: %v", err)
	}
	err = domain.ValidateLoan(domain.LoanInput{EmployeeID: "emp-003", Kind: "advance", Amount: 1_000_000, Installments: 2, Reason: "School", StartMonth: "2026-11"}, &e, nil)
	if message(err) != "A salary advance is repaid from the next payroll." {
		t.Fatalf("advance: %v", err)
	}
}

func TestEmployeeValidation(t *testing.T) {
	e := sari()
	e.Code = "E3"
	e.Allocations = []domain.VillaAllocation{{VillaID: "vil-saka", Percent: 70}, {VillaID: "vil-tirta", Percent: 20}}
	err := domain.ValidateEmployee(e, false)
	if message(err) != "The code is EMP- and three digits, for example EMP-021." || field(err, "allocations") != "The villa shares add up to 90%, not 100%." {
		t.Fatalf("employee: %v", err)
	}
	e = sari()
	e.Allocations = []domain.VillaAllocation{{VillaID: "vil-saka", Percent: 50}, {VillaID: "vil-saka", Percent: 50}}
	if field(domain.ValidateEmployee(e, false), "allocations") != "A villa is listed twice." {
		t.Fatal("duplicate villa")
	}
	e = sari()
	e.Status = "inactive"
	if message(domain.ValidateEmployee(e, true)) != "EMP-003 is already used." || field(domain.ValidateEmployee(e, true), "leftOn") != "Record when the employee left." {
		t.Fatal("taken code and leaving date")
	}
}

func TestOvertimeKpiAndNoticeValidation(t *testing.T) {
	if message(domain.ValidateOvertime(domain.OvertimeInput{EmployeeID: "emp-002", Date: "2026-11-11", Hours: 9, VillaID: "vil-saka", Reason: "Night"})) != "Overtime is 0.5 to 8 hours, in half hours." {
		t.Fatal("9 hours")
	}
	if message(domain.ValidateOvertime(domain.OvertimeInput{EmployeeID: "emp-002", Date: "2026-11-11", Hours: 1.25, VillaID: "vil-saka", Reason: "Night"})) == "" {
		t.Fatal("quarter hours")
	}
	err := domain.ValidateKpi(domain.KpiInput{EmployeeID: "emp-009", Period: "2026-Q4", Items: []domain.KpiItem{{Name: "Rooms", Target: 95, Actual: 90, Weight: 60, Unit: "%"}}, Status: "draft"})
	if message(err) != "The weights add up to 60%, not 100%." {
		t.Fatalf("kpi: %v", err)
	}
	if field(domain.ValidateKpi(domain.KpiInput{EmployeeID: "e", Period: "2026-Q4", Items: []domain.KpiItem{{Name: "R", Target: 0, Weight: 100}}}), "items.0.target") != "A target above zero." {
		t.Fatal("kpi item")
	}
	if message(domain.ValidateAnnouncement(domain.AnnouncementInput{Title: "Fire", Body: "short"})) != "Write the notice." {
		t.Fatal("notice")
	}
	if err := domain.CheckDecision(domain.Rejected, " "); field(err, "note") != "Say why." {
		t.Fatalf("reject without a reason: %v", err)
	}
	var d domain.Decision
	if _, err := domain.Decide("LV-201", "approved", &d, domain.Cancelled, "", "Nia", "2026-11-11"); message(err) != "LV-201 is approved; it can no longer change." {
		t.Fatalf("decided twice: %v", err)
	}
}
