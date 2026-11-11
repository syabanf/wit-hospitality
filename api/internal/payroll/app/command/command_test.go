package command_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/payroll"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/adapters/billing"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/adapters/finance"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/domain"
	payrollmodule "github.com/syabanf/wit-hospitality/api/internal/payroll/module"
	"github.com/syabanf/wit-hospitality/api/internal/people"
	peoplemodule "github.com/syabanf/wit-hospitality/api/internal/people/module"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/platform/testdb"
)

func str(s string) *string { return &s }

var (
	nia   = auth.Principal{UserID: "usr-nia", Name: "Nia Kusuma", Role: "hr"}
	ida   = auth.Principal{UserID: "usr-ida", Name: "Ida Bagus Rai", Role: "finance", EmployeeID: str("emp-013")}
	wayan = auth.Principal{UserID: "usr-wayan", Name: "Wayan Sudiarta", Role: "staff", VillaIDs: []string{"vil-saka"}, EmployeeID: str("emp-002")}
	putu  = auth.Principal{UserID: "usr-putu", Name: "Putu Eka Wijaya", Role: "hr", LocationIDs: []string{"loc-ubud"}}
)

type env struct {
	db    *db.DB
	deps  command.Deps
	q     query.Queries
	relay *outbox.Relay
}

// setup seeds every context on a fresh database, on 11 November 2026 in Bali, with people and
// payroll handlers on an in-process bus.
func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, bootstrap.MigrationSets(bootstrap.All)[1:]...)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	log := logging.Discard()
	if err := bootstrap.Seed(context.Background(), d, log, clk); err != nil {
		t.Fatal(err)
	}
	perms := rbac.Static(rbac.DefaultPermissions())
	proj := projector.New(d, log)
	peoplemodule.New(peoplemodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log}).Project(proj)
	payrollmodule.New(payrollmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log}).Project(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		t.Fatal(err)
	}
	authz := rbac.Authorizer{Source: perms}
	repo := postgres.Repo{DB: d}
	return env{
		db: d,
		deps: command.Deps{DB: d, Repo: repo, Inputs: repo, Pool: billing.NoPool{}, Posting: finance.Outbox{DB: d, Clock: clk},
			Authz: authz, Audit: audit.Recorder{DB: d, Clock: clk}, Clock: clk},
		q:     query.Queries{Store: postgres.ReadStore{DB: d}, Authz: authz},
		relay: &outbox.Relay{DB: d, Bus: b, Log: log},
	}
}

func wantCode(t *testing.T, err error, code, message string) {
	t.Helper()
	e, ok := errs.As(err)
	if !ok || e.Code != code || (message != "" && e.Message != message) {
		t.Fatalf("want %s %q, got %v", code, message, err)
	}
}

func line(p domain.Period, employeeID string) domain.Line {
	i, _ := domain.LineOf(p, employeeID)
	if i < 0 {
		return domain.Line{}
	}
	return p.Lines[i]
}

func TestPayrollCalculateApproveCloseAndPublish(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	const id = "pay-2026-11"

	calculated, err := command.Calculate{Deps: e.deps}.Handle(ctx, nia, id)
	if err != nil || calculated.Status != domain.Calculated || len(calculated.Lines) != 14 {
		t.Fatalf("calculate: %d lines %v", len(calculated.Lines), err)
	}
	made := line(calculated, "emp-004")
	if made.LoanDeduction != 1_000_000 || len(made.Allocation) != 2 || made.Allocation[0].VillaID != "vil-saka" {
		t.Fatalf("Made's payslip: %+v", made)
	}
	if calculated.RevenueBase != 0 || line(calculated, "emp-002").ServiceCharge != 0 {
		t.Fatal("no service charge pool until billing exists")
	}
	adjusted, err := command.AddAdjustment{Deps: e.deps}.Handle(ctx, nia, id, "emp-002", domain.AdjustmentInput{Kind: "bonus", Amount: 300_000, Reason: "Guest review of the month"})
	if err != nil || line(adjusted, "emp-002").Bonus != 300_000 || line(adjusted, "emp-002").Adjustments[0].ID != "adj-1" {
		t.Fatalf("bonus: %+v %v", line(adjusted, "emp-002"), err)
	}
	_, err = command.AddAdjustment{Deps: e.deps}.Handle(ctx, nia, id, "emp-099", domain.AdjustmentInput{Kind: "bonus", Amount: 1, Reason: "Nobody here"})
	wantCode(t, err, errs.CodeValidation, "That employee is not on this payroll.")

	transition := command.Transition{Deps: e.deps}
	_, err = transition.Handle(ctx, nia, id, domain.Approved, "", "")
	wantCode(t, err, "APPROVAL_SELF", "The person who calculated the payroll cannot approve it.")
	_, err = transition.Handle(ctx, wayan, id, domain.Approved, "", "")
	wantCode(t, err, errs.CodeForbidden, "Staff cannot approve in Payroll.")
	if p, err := transition.Handle(ctx, ida, id, domain.Approved, "", ""); err != nil || p.Status != domain.Approved {
		t.Fatalf("approve: %v", err)
	}
	_, err = command.AddAdjustment{Deps: e.deps}.Handle(ctx, nia, id, "emp-002", domain.AdjustmentInput{Kind: "bonus", Amount: 1, Reason: "Too late now"})
	wantCode(t, err, "PAYROLL_LOCKED", "Payroll 2026-11 is approved; reopen it to adjust a payslip.")
	_, err = transition.Handle(ctx, ida, id, domain.Closed, "", "")
	wantCode(t, err, errs.CodeValidation, "Pick the account the salaries are paid from.")
	_, err = transition.Handle(ctx, nia, id, domain.Closed, "", "bank-bca")
	wantCode(t, err, errs.CodeForbidden, "HR cannot post in Payroll.")

	closed, err := transition.Handle(ctx, ida, id, domain.Closed, "", "bank-bca")
	if err != nil || closed.Status != domain.Closed || *closed.PaidFromAccountID != "bank-bca" || closed.TransactionID != nil {
		t.Fatalf("close: %+v %v", closed, err)
	}
	var raw []byte
	if err := e.db.Pool.QueryRow(ctx, `SELECT payload FROM platform.outbox WHERE event_type = $1 AND aggregate_id = $2`, payroll.EventPeriodClosed, id).Scan(&raw); err != nil {
		t.Fatalf("payroll.period.closed.v1 in the outbox: %v", err)
	}
	var event payroll.PeriodClosed
	_ = json.Unmarshal(raw, &event)
	totals := domain.PeriodTotals(closed.Lines)
	if event.AccountID != "bank-bca" || event.Totals != totals || event.Reference != "PAY-2026-11" || len(event.Lines) != 14 || len(event.Statutory) != 2 || len(event.ByVilla) != 5 {
		t.Fatalf("closed event: %+v", event)
	}

	if _, err := e.relay.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	var loan people.Loan
	if err := e.db.Pool.QueryRow(ctx, `SELECT data FROM people.loans WHERE id = 'ln-1'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(raw, &loan)
	if loan.Repaid != 3_000_000 || loan.Status != "active" {
		t.Fatalf("people booked the repayment: %+v", loan)
	}

	published, err := command.Publish{Deps: e.deps}.Handle(ctx, nia, id)
	if err != nil || !published.Published {
		t.Fatalf("publish: %v", err)
	}
	_, err = transition.Handle(ctx, nia, id, domain.Draft, "Wrong overtime", "")
	wantCode(t, err, "PAYROLL_INVALID_STATE", "Payroll 2026-11 is closed; it cannot become draft.")
}

func TestPeriodsSettingsAndReads(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	next, err := command.CreatePeriod{Deps: e.deps}.Handle(ctx, nia, "2026-12")
	if err != nil || next.Status != domain.Draft || len(next.Lines) != 14 || next.History[0].By != "Nia Kusuma" {
		t.Fatalf("create: %+v %v", next.Status, err)
	}
	_, err = command.CreatePeriod{Deps: e.deps}.Handle(ctx, nia, "2026-12")
	wantCode(t, err, "PAYROLL_EXISTS", "Payroll for 2026-12 already exists.")
	_, err = command.CreatePeriod{Deps: e.deps}.Handle(ctx, ida, "2027-01")
	wantCode(t, err, errs.CodeForbidden, "Finance cannot create in Payroll.")
	reopened, err := command.Transition{Deps: e.deps}.Handle(ctx, nia, "pay-2026-11", domain.Draft, "Wrong overtime", "")
	if err != nil || reopened.Status != domain.Draft || reopened.History[len(reopened.History)-1].Note != "Wrong overtime" {
		t.Fatalf("reopen: %v", err)
	}

	settings, _, _ := e.deps.Repo.Settings(ctx)
	settings.THRMonth = 13
	_, err = command.SaveSettings{Deps: e.deps}.Handle(ctx, nia, settings)
	wantCode(t, err, errs.CodeValidation, "A month from 1 to 12.")
	settings.THRMonth = 4
	if _, err := (command.SaveSettings{Deps: e.deps}).Handle(ctx, nia, settings); err != nil {
		t.Fatal(err)
	}
	if s, _ := e.q.Settings(auth.WithPrincipal(ctx, wayan)); s.THRMonth != 4 {
		t.Fatalf("settings read: %+v", s)
	}

	all, _ := e.q.Periods(auth.WithPrincipal(ctx, nia))
	if len(all) != 4 || all[0].Month != "2026-09" || len(all[1].Lines) != 14 {
		t.Fatalf("HR reads every period: %d", len(all))
	}
	mine, _ := e.q.Periods(auth.WithPrincipal(ctx, wayan))
	for _, p := range mine {
		if p.Published != (len(p.Lines) == 1) || (len(p.Lines) == 1 && p.Lines[0].EmployeeID != "emp-002") {
			t.Fatalf("Wayan reads his published payslips only: %s %d", p.Month, len(p.Lines))
		}
	}
	ubud, _ := e.q.Periods(auth.WithPrincipal(ctx, putu))
	if len(ubud[0].Lines) != 5 {
		t.Fatalf("a scoped payroll reader sees the payslips of the villas in scope: %d", len(ubud[0].Lines))
	}
}
