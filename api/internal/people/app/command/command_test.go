package command_test

import (
	"context"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/people/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/people/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/people/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/platform/testdb"
)

func str(s string) *string { return &s }

var (
	nia   = auth.Principal{UserID: "usr-nia", Name: "Nia Kusuma", Role: "hr"}
	ida   = auth.Principal{UserID: "usr-ida", Name: "Ida Bagus Rai", Role: "finance", EmployeeID: str("emp-013")}
	putu  = auth.Principal{UserID: "usr-putu", Name: "Putu Eka Wijaya", Role: "manager", LocationIDs: []string{"loc-ubud"}, EmployeeID: str("emp-008")}
	wayan = auth.Principal{UserID: "usr-wayan", Name: "Wayan Sudiarta", Role: "staff", VillaIDs: []string{"vil-saka"}, EmployeeID: str("emp-002")}
)

type env struct {
	db   *db.DB
	deps command.Deps
	q    query.Queries
}

// setup seeds every context on a fresh database, on 11 November 2026 in Bali.
func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, bootstrap.MigrationSets(bootstrap.All)[1:]...)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	if err := bootstrap.Seed(context.Background(), d, logging.Discard(), clk); err != nil {
		t.Fatal(err)
	}
	authz := rbac.Authorizer{Source: rbac.Static(rbac.DefaultPermissions())}
	return env{
		db:   d,
		deps: command.Deps{DB: d, Repo: postgres.Repo{DB: d}, Authz: authz, Audit: audit.Recorder{DB: d, Clock: clk}, Clock: clk},
		q:    query.Queries{Store: postgres.ReadStore{DB: d}, Authz: authz},
	}
}

func as(p auth.Principal) context.Context { return auth.WithPrincipal(context.Background(), p) }

func wantCode(t *testing.T, err error, code, message string) {
	t.Helper()
	e, ok := errs.As(err)
	if !ok || e.Code != code || (message != "" && e.Message != message) {
		t.Fatalf("want %s %q, got %v", code, message, err)
	}
}

func TestLeaveRequestApprovalMarksTheAttendanceSheet(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	request := command.RequestLeave{Deps: e.deps}
	_, err := request.Handle(ctx, nia, domain.LeaveInput{EmployeeID: "emp-003", Kind: "annual", From: "2026-11-02", To: "2026-11-14", Reason: "Long trip"})
	wantCode(t, err, errs.CodeValidation, "Only 8 annual leave days are left.")
	leave, err := request.Handle(ctx, nia, domain.LeaveInput{EmployeeID: "emp-003", Kind: "annual", From: "2026-11-02", To: "2026-11-04", Reason: "Family ceremony"})
	if err != nil || leave.Days != 3 || leave.Number != "LV-209" || leave.Status != "pending" {
		t.Fatalf("request: %+v %v", leave, err)
	}
	decide := command.DecideLeave{Deps: e.deps}
	_, err = decide.Handle(ctx, nia, leave.ID, domain.Rejected, "")
	wantCode(t, err, errs.CodeValidation, "Say why.")
	_, err = decide.Handle(ctx, wayan, leave.ID, domain.Approved, "")
	wantCode(t, err, errs.CodeForbidden, "Staff cannot approve in HR.")
	approved, err := decide.Handle(ctx, nia, leave.ID, domain.Approved, "Covered")
	if err != nil || approved.Status != "approved" || approved.DecidedBy != "Nia Kusuma" || approved.DecisionNote != "Covered" || *approved.DecidedOn != "2026-11-11" {
		t.Fatalf("approve: %+v %v", approved, err)
	}
	_, err = decide.Handle(ctx, nia, leave.ID, domain.Cancelled, "")
	wantCode(t, err, "REQUEST_INVALID_STATE", "LV-209 is approved; it can no longer change.")

	rows, err := e.q.Attendance(as(nia))
	if err != nil {
		t.Fatal(err)
	}
	marked := 0
	for _, a := range rows {
		if a.EmployeeID == "emp-003" && a.Date >= "2026-11-02" && a.Date <= "2026-11-04" {
			if a.Status != "leave" || a.Note != "LV-209" || a.ClockIn != nil {
				t.Fatalf("leave day: %+v", a)
			}
			marked++
		}
	}
	if marked != 3 {
		t.Fatalf("leave days on the sheet: %d", marked)
	}
	_, err = request.Handle(ctx, nia, domain.LeaveInput{EmployeeID: "emp-003", Kind: "annual", From: "2026-11-16", To: "2026-11-21", Reason: "Another trip"})
	wantCode(t, err, errs.CodeValidation, "Only 5 annual leave days are left.")
}

func TestRequestsRespectScopeAndSelfService(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	request := command.RequestLeave{Deps: e.deps}
	_, err := request.Handle(ctx, wayan, domain.LeaveInput{EmployeeID: "emp-003", Kind: "permission", From: "2026-11-12", To: "2026-11-12", Reason: "Banjar"})
	wantCode(t, err, errs.CodeForbidden, "Staff cannot view in HR.")
	own, err := request.Handle(ctx, wayan, domain.LeaveInput{EmployeeID: "emp-002", Kind: "permission", From: "2026-11-12", To: "2026-11-12", Reason: "Banjar"})
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := command.DecideLeave{Deps: e.deps}.Handle(ctx, wayan, own.ID, domain.Cancelled, "")
	if err != nil || cancelled.Status != "cancelled" {
		t.Fatalf("cancel own: %+v %v", cancelled, err)
	}
	// Luh Ayu works at Villa Lumbung in Seminyak; Putu manages Ubud.
	_, err = command.DecideLeave{Deps: e.deps}.Handle(ctx, putu, "lv-5", domain.Approved, "")
	wantCode(t, err, errs.CodeForbidden, "Luh Ayu Lestari is outside the villas you work with.")

	mine, err := e.q.Leaves(as(wayan))
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range mine {
		if l.EmployeeID != "emp-002" {
			t.Fatalf("staff see their own requests only: %+v", l)
		}
	}
	staff, _ := e.q.Employees(as(putu))
	if len(staff) != 5 {
		t.Fatalf("Putu sees the four at Villa Tirta and Ida, who works at four villas: %d", len(staff))
	}
}

func TestOvertimeAndLoans(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	ot, err := command.RequestOvertime{Deps: e.deps}.Handle(ctx, wayan, domain.OvertimeInput{EmployeeID: "emp-002", Date: "2026-11-11", Hours: 2.5, VillaID: "vil-saka", Reason: "Late arrivals"})
	if err != nil || ot.Status != "pending" || ot.Number != "OT-311" {
		t.Fatalf("overtime: %+v %v", ot, err)
	}
	_, err = command.RequestOvertime{Deps: e.deps}.Handle(ctx, wayan, domain.OvertimeInput{EmployeeID: "emp-002", Date: "2026-11-11", Hours: 9, VillaID: "vil-saka", Reason: "x"})
	wantCode(t, err, errs.CodeValidation, "Overtime is 0.5 to 8 hours, in half hours.")
	if o, err := (command.DecideOvertime{Deps: e.deps}).Handle(ctx, nia, ot.ID, domain.Approved, ""); err != nil || o.Status != "approved" {
		t.Fatalf("approve overtime: %+v %v", o, err)
	}

	loans := command.RequestLoan{Deps: e.deps}
	_, err = loans.Handle(ctx, ida, domain.LoanInput{EmployeeID: "emp-004", Kind: "loan", Amount: 1_000_000, Installments: 2, Reason: "Second loan", StartMonth: "2026-11"})
	wantCode(t, err, errs.CodeValidation, "Made Wirawan still has an open loan.")
	loan, err := loans.Handle(ctx, ida, domain.LoanInput{EmployeeID: "emp-006", Kind: "advance", Amount: 1_000_000, Installments: 1, Reason: "School", StartMonth: "2026-11"})
	if err != nil || loan.Monthly != 1_000_000 || loan.Number != "LN-404" {
		t.Fatalf("loan: %+v %v", loan, err)
	}
	_, err = command.DecideLoan{Deps: e.deps}.Handle(ctx, nia, loan.ID, domain.Approved, "")
	if err != nil {
		t.Fatalf("HR holds payroll/approve: %v", err)
	}
	_, err = command.DecideLoan{Deps: e.deps}.Handle(ctx, putu, "ln-3", domain.Approved, "")
	wantCode(t, err, errs.CodeForbidden, "Villa manager cannot approve in Payroll.")
	got, _ := e.q.Loans(as(nia))
	for _, l := range got {
		if l.ID == loan.ID && l.Status != "active" {
			t.Fatalf("an approved loan repays: %+v", l)
		}
	}
}

func TestRosterAttendanceAndEmployees(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	if _, err := (command.AssignShift{Deps: e.deps}).Handle(ctx, nia, domain.AssignmentInput{EmployeeID: "emp-002", Date: "2026-11-11", ShiftID: str("sh-morning"), VillaID: "vil-saka"}); err != nil {
		t.Fatal(err)
	}
	_, err := command.AssignShift{Deps: e.deps}.Handle(ctx, nia, domain.AssignmentInput{EmployeeID: "emp-002", Date: "11/11", VillaID: "vil-saka"})
	wantCode(t, err, errs.CodeValidation, "Pick the day.")
	record := command.RecordAttendance{Deps: e.deps}
	late, err := record.Handle(ctx, nia, domain.AttendanceInput{EmployeeID: "emp-002", Date: "2026-11-11", Status: "late", ClockIn: str("07:25"), ClockOut: str("15:00")})
	if err != nil || late.LateMinutes != 25 {
		t.Fatalf("late: %+v %v", late, err)
	}
	_, err = record.Handle(ctx, nia, domain.AttendanceInput{EmployeeID: "emp-002", Date: "2027-01-01", Status: "present", ClockIn: str("07:00")})
	wantCode(t, err, errs.CodeValidation, "Attendance is recorded on or after the day.")
	_, err = record.Handle(ctx, putu, domain.AttendanceInput{EmployeeID: "emp-002", Date: "2026-11-11", Status: "present", ClockIn: str("07:00")})
	wantCode(t, err, errs.CodeForbidden, "Villa manager cannot edit in HR.")

	in := domain.Employee{Code: "EMP-016", Name: "Made Ayu", Position: "Housekeeping", Department: "housekeeping", Status: "probation", JoinedOn: "2026-11-01",
		BasicSalary: 3_600_000, Allocations: []domain.VillaAllocation{{VillaID: "vil-saka", Percent: 100}}, AnnualLeaveDays: 12}
	created, err := command.CreateEmployee{Deps: e.deps}.Handle(ctx, nia, in)
	if err != nil || created.ID != "emp-016" {
		t.Fatalf("create: %+v %v", created, err)
	}
	_, err = command.CreateEmployee{Deps: e.deps}.Handle(ctx, nia, in)
	wantCode(t, err, errs.CodeValidation, "EMP-016 is already used.")
	in.Code, in.Position = "EMP-016", "Head housekeeper"
	updated, err := command.UpdateEmployee{Deps: e.deps}.Handle(ctx, nia, "emp-016", in)
	if err != nil || updated.Position != "Head housekeeper" {
		t.Fatalf("update: %+v %v", updated, err)
	}
	var count int
	_ = e.db.Pool.QueryRow(ctx, `SELECT count(*) FROM platform.outbox WHERE event_type = 'people.employee.saved.v1' AND aggregate_id = 'emp-016'`).Scan(&count)
	if count != 2 {
		t.Fatalf("employee events in the outbox: %d", count)
	}
}

func TestAnnouncementsAndKpis(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	notice, err := command.CreateAnnouncement{Deps: e.deps}.Handle(ctx, nia, domain.AnnouncementInput{Title: "Fire drill on Friday", Body: "Assemble in the car park at 09:00 sharp.", Pinned: true})
	if err != nil || notice.ID != "ann-5" || notice.By != "Nia Kusuma" {
		t.Fatalf("notice: %+v %v", notice, err)
	}
	list, _ := e.q.Announcements(as(wayan))
	if len(list) != 5 || list[0].ID != notice.ID {
		t.Fatalf("newest first: %d", len(list))
	}
	tirta, _ := e.q.Announcements(as(putu))
	for _, a := range tirta {
		if a.VillaID != nil && *a.VillaID == "vil-saka" {
			t.Fatal("Putu does not see the Villa Saka notice")
		}
	}
	if err := (command.DeleteAnnouncement{Deps: e.deps}).Handle(ctx, nia, notice.ID); err != nil {
		t.Fatal(err)
	}
	items := []domain.KpiItem{{Name: "Rooms", Target: 95, Actual: 90, Weight: 60, Unit: "%"}, {Name: "Attendance", Target: 98, Actual: 100, Weight: 40, Unit: "%"}}
	review, err := command.SaveKpi{Deps: e.deps}.Handle(ctx, nia, "", domain.KpiInput{EmployeeID: "emp-009", Period: "2026-Q4", Items: items, Status: "published", Note: " Solid "})
	if err != nil || review.Reviewer != "Nia Kusuma" || review.Note != "Solid" {
		t.Fatalf("kpi: %+v %v", review, err)
	}
	again, err := command.SaveKpi{Deps: e.deps}.Handle(ctx, nia, "", domain.KpiInput{EmployeeID: "emp-009", Period: "2026-Q4", Items: items, Status: "draft"})
	if err != nil || again.ID != review.ID {
		t.Fatalf("the same quarter replaces the review: %+v %v", again, err)
	}
	_, err = command.SaveKpi{Deps: e.deps}.Handle(ctx, putu, "", domain.KpiInput{EmployeeID: "emp-006", Period: "2026-Q4", Items: items, Status: "draft"})
	wantCode(t, err, errs.CodeForbidden, "Villa manager cannot edit in HR.")
}
