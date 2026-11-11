package command_test

import (
	"context"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/finance"
	"github.com/syabanf/wit-hospitality/api/internal/finance/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/finance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/finance/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/payroll"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/platform/testdb"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

func person(id, name, role string, employee *string) auth.Principal {
	return auth.Principal{UserID: id, Name: name, Role: rbac.Role(role), LocationIDs: []string{}, VillaIDs: []string{}, EmployeeID: employee}
}

var (
	kadek = person("usr-kadek", "Kadek Ariani", "manager", domain.Ptr("emp-001"))
	putu  = auth.Principal{UserID: "usr-putu", Name: "Putu Ayu", Role: "manager", LocationIDs: []string{"loc-ubud"}, VillaIDs: []string{}}
	ida   = person("usr-ida", "Ida Bagus Rai", "finance", domain.Ptr("emp-013"))
	rama  = person("usr-rama", "Rama Wijaya", "owner", nil)
	dian  = person("usr-dian", "Dian Permata", "reservation", nil)
)

const today = "2026-11-11"

type env struct {
	deps    command.Deps
	queries query.Queries
}

func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, bootstrap.MigrationSets(bootstrap.All)[1:]...)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	if err := bootstrap.Seed(context.Background(), d, logging.Discard(), clk); err != nil {
		t.Fatal(err)
	}
	deps := command.Deps{DB: d, Repo: postgres.Repo{DB: d}, Authz: rbac.Authorizer{Source: rbac.Static(rbac.DefaultPermissions())}, Audit: audit.Recorder{DB: d, Clock: clk},
		Clock: clk, Roster: postgres.Roster{DB: d}, BusinessDate: calendar{}, Files: noFiles{}}
	return env{deps: deps, queries: query.Queries{Deps: deps}}
}

type calendar struct{}

func (calendar) BusinessDate(context.Context) (string, error) { return today, nil }

type noFiles struct{}

func (noFiles) Attachments(context.Context, []string) ([]domain.Attachment, error) {
	return nil, errs.New("NOT_AVAILABLE", "Uploaded files are not available yet.")
}

func ctxOf(p auth.Principal) context.Context { return auth.WithPrincipal(context.Background(), p) }

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if e, ok := errs.As(err); !ok || e.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func (e env) books(t *testing.T) {
	t.Helper()
	ctx := ctxOf(rama)
	accounts, err := e.deps.Repo.Accounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	txs, _ := e.deps.Repo.Transactions(ctx)
	entries, _ := e.deps.Repo.Journals(ctx)
	for _, p := range domain.BooksProblems(domain.ChartOfAccounts(accounts), accounts, txs, entries, today) {
		t.Error(p)
	}
}

func (e env) journalsOf(t *testing.T, sourceID string) []domain.JournalEntry {
	t.Helper()
	var out []domain.JournalEntry
	all, err := e.deps.Repo.Journals(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, j := range all {
		if j.SourceID == sourceID {
			out = append(out, j)
		}
	}
	return out
}

func cashOut(amount int64) command.NewTransaction {
	return command.NewTransaction{Submit: true, TransactionInput: domain.TransactionInput{AccountID: "cb-ubud", Kind: domain.CashOut, CategoryID: "cat-util", Amount: float64(amount), Date: today,
		LocationID: "loc-ubud", VillaID: domain.Ptr("vil-tirta"), Description: "Gas refill", Attachments: []domain.Attachment{}}}
}

// From accounting.test.ts: a journal entry when an entry posts and the reversing entry on reversal.
func TestApproveAndPostWritesTheJournalAndReversalTurnsItAround(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	tx, err := command.CreateTransaction{Deps: e.deps}.Handle(ctx, kadek, cashOut(400_000))
	if err != nil || tx.Status != domain.Submitted || tx.Number != "TX-2641" {
		t.Fatalf("create: %v %+v", err, tx)
	}
	move := command.Transition{Deps: e.deps}
	_, err = move.Handle(ctx, kadek, tx.ID, domain.Approved, "")
	wantCode(t, err, "APPROVAL_SELF")
	_, err = move.Handle(ctx, dian, tx.ID, domain.Approved, "")
	wantCode(t, err, errs.CodeForbidden)
	if tx, err = move.Handle(ctx, rama, tx.ID, domain.Approved, ""); err != nil || tx.Status != domain.Approved {
		t.Fatalf("approve: %v %s", err, tx.Status)
	}
	if tx, err = move.Handle(ctx, rama, tx.ID, domain.Posted, ""); err != nil || tx.Status != domain.Posted {
		t.Fatalf("post: %v", err)
	}
	posted := e.journalsOf(t, tx.ID)
	if len(posted) != 1 || posted[0].Lines[0] != (domain.JournalLine{AccountID: "gl-6200", Debit: 400_000}) || posted[0].Lines[1] != (domain.JournalLine{AccountID: "gl-cash-cb-ubud", Credit: 400_000}) {
		t.Fatalf("journal %+v", posted)
	}
	_, err = command.Reverse{Deps: e.deps}.Handle(ctx, rama, tx.ID, "no")
	wantCode(t, err, errs.CodeValidation)
	r, err := command.Reverse{Deps: e.deps}.Handle(ctx, rama, tx.ID, "Charged twice")
	if err != nil || r.Status != domain.Posted || r.Kind != domain.CashIn || *r.ReversalOf != tx.ID {
		t.Fatalf("reverse: %v %+v", err, r)
	}
	turned := e.journalsOf(t, r.ID)
	if len(turned) != 1 || turned[0].Lines[0] != (domain.JournalLine{AccountID: "gl-cash-cb-ubud", Debit: 400_000}) || turned[0].Lines[1] != (domain.JournalLine{AccountID: "gl-6200", Credit: 400_000}) {
		t.Fatalf("reversal journal %+v", turned)
	}
	_, err = command.Reverse{Deps: e.deps}.Handle(ctx, rama, tx.ID, "Again")
	wantCode(t, err, "TRANSACTION_INVALID_STATE")
	e.books(t)
}

func TestMultiLevelChainAndProof(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	_, err := command.CreateTransaction{Deps: e.deps}.Handle(ctx, kadek, cashOut(6_000_000))
	wantCode(t, err, "PROOF_REQUIRED")
	in := cashOut(6_000_000)
	in.Attachments = []domain.Attachment{{ID: "file-1", Name: "invoice.pdf", Type: "application/pdf", Size: 1000, URL: "https://x/invoice.pdf"}}
	tx, err := command.CreateTransaction{Deps: e.deps}.Handle(ctx, kadek, in)
	if err != nil {
		t.Fatal(err)
	}
	move := command.Transition{Deps: e.deps}
	_, err = move.Handle(ctx, ida, tx.ID, domain.Approved, "")
	wantCode(t, err, "APPROVAL_ROLE")
	if tx, err = move.Handle(ctx, putu, tx.ID, domain.Approved, ""); err != nil || tx.Status != domain.Submitted {
		t.Fatalf("level 1: %v %s", err, tx.Status)
	}
	if tx, err = move.Handle(ctx, ida, tx.ID, domain.Approved, ""); err != nil || tx.Status != domain.Approved || len(tx.Approvals) != 2 {
		t.Fatalf("level 2: %v %+v", err, tx)
	}
	_, err = move.Handle(ctx, kadek, tx.ID, domain.Posted, "")
	wantCode(t, err, errs.CodeForbidden)
	_, err = command.Attach{Deps: e.deps}.Handle(ctx, kadek, tx.ID, []string{"file-2"})
	wantCode(t, err, "NOT_AVAILABLE")
}

func TestPeriodCloseRefusesPostingUntilReopened(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	closePeriod := command.ClosePeriod{Deps: e.deps}
	_, err := closePeriod.Handle(ctx, ida, "2026-11", "")
	wantCode(t, err, "PERIOD_NOT_ENDED")
	if _, err := closePeriod.Handle(ctx, ida, "2026-08", "August books final"); err != nil {
		t.Fatal(err)
	}
	_, err = closePeriod.Handle(ctx, ida, "2026-08", "")
	wantCode(t, err, "PERIOD_CLOSED")
	in := command.NewManualJournal{Submit: true, ManualJournalInput: domain.ManualJournalInput{Date: "2026-08-31", Memo: "Late accrual",
		Lines: []domain.JournalLine{{AccountID: domain.GLReceivable, Debit: 100_000}, {AccountID: domain.GLOtherIncome, Credit: 100_000}}}}
	m, err := command.CreateManualJournal{Deps: e.deps}.Handle(ctx, ida, in)
	if err != nil {
		t.Fatal(err)
	}
	move := command.TransitionManualJournal{Deps: e.deps}
	if _, err := move.Handle(ctx, rama, m.ID, domain.Approved, ""); err != nil {
		t.Fatal(err)
	}
	_, err = move.Handle(ctx, ida, m.ID, domain.Posted, "")
	wantCode(t, err, "PERIOD_CLOSED")
	if err := (command.ReopenPeriod{Deps: e.deps}).Handle(ctx, ida, "2026-08", "Late accrual found"); err != nil {
		t.Fatal(err)
	}
	if m, err = move.Handle(ctx, ida, m.ID, domain.Posted, ""); err != nil || m.JournalID == nil {
		t.Fatalf("post: %v %+v", err, m)
	}
	e.books(t)
}

// The payroll close: the salary cash-out posted with the payroll journal, once.
func TestPayrollClosedPostsTheSalariesAndThePayrollJournal(t *testing.T) {
	t.Parallel()
	e := setup(t)
	pol := command.Policies{Deps: e.deps}
	ev := payroll.PeriodClosed{PeriodID: "pay-2026-11", Month: "2026-11", AccountID: "bank-bca", CategoryID: "cat-payroll", Reference: "PAY-2026-11", ClosedBy: "Ida Bagus Rai",
		Totals: payroll.Totals{Employees: 2, Net: 9_000_000},
		Lines:  []payroll.Line{{BPJSHealth: 100_000, BPJSEmployment: 200_000, PPh21: 150_000, LoanDeduction: 250_000, CompanyBPJS: 400_000, ServiceCharge: 300_000}, {CompanyBPJS: 100_000}}}
	ctx := context.Background()
	for range 2 {
		if err := e.deps.DB.InTx(ctx, func(ctx context.Context) error { return pol.PayrollClosed(ctx, ev) }); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := query.Client{Queries: e.queries}.Entries(ctx, finance.Source{Type: "payroll", ID: "pay-2026-11"})
	if err != nil || len(entries) != 1 || entries[0].Status != domain.Posted || entries[0].Amount != 9_000_000 || entries[0].Reference != "PAY-2026-11" {
		t.Fatalf("entries %v %+v", err, entries)
	}
	j := e.journalsOf(t, "pay-2026-11")
	if len(j) != 1 || j[0].Source != domain.SourcePayroll || j[0].Lines[0] != (domain.JournalLine{AccountID: domain.GLWages, Debit: 9_000_000 + 300_000 + 150_000 + 250_000 - 300_000}) {
		t.Fatalf("payroll journal %+v", j)
	}
	e.books(t)
}

// A walk's relocation cost waits for approval as a cash-out read back by its source.
func TestWalkRecordedAsksForTheRelocationCashOut(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	rec := reservation.Record{ID: "wlk-1", VillaIDs: []string{"vil-saka"}, LocationIDs: []string{"loc-canggu"},
		Data: []byte(`{"id":"wlk-1","number":"WLK-101","cost":1500000,"method":"cash","destination":"outside","property":"Alila Seminyak","bookingId":"bk-1001","bookingCode":"BK-1001","fromUnitId":"unit-sk-01","by":"Kadek Ariani","byId":"usr-kadek"}`)}
	if err := e.deps.DB.InTx(ctx, func(ctx context.Context) error { return command.Policies{Deps: e.deps}.WalkRecorded(ctx, rec) }); err != nil {
		t.Fatal(err)
	}
	entries, _ := query.Client{Queries: e.queries}.Entries(ctx, finance.Source{Type: "walk", ID: "wlk-1"})
	if len(entries) != 1 || entries[0].Status != domain.Submitted || entries[0].AccountID != "cb-canggu" || entries[0].CategoryID != "cat-relocation" {
		t.Fatalf("%+v", entries)
	}
}

// A desk payment with a gateway fee: the cash-in and the fee, both for approval.
func TestPaymentRecordedBooksMoneyAndFee(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	f := command.PaymentFact{PaymentID: "pay-x", Number: "PAY-9001", Kind: "deposit", Method: "card", Amount: 2_000_000, GatewayFee: 58_000, BookingID: "bk-1001", BookingCode: "BK-1001",
		LocationID: "loc-canggu", VillaID: domain.Ptr("vil-saka"), RecordedBy: &command.Actor{ID: "usr-dian", Name: "Dian Permata", Role: "reservation"}}
	if err := e.deps.DB.InTx(ctx, func(ctx context.Context) error { return command.Policies{Deps: e.deps}.PaymentRecorded(ctx, f) }); err != nil {
		t.Fatal(err)
	}
	c := query.Client{Queries: e.queries}
	money, _ := c.Entries(ctx, finance.Source{Type: "payment", ID: "pay-x"})
	fee, _ := c.Entries(ctx, finance.Source{Type: "payment_fee", ID: "pay-x"})
	if len(money) != 1 || money[0].CategoryID != "cat-room" || money[0].AccountID != "bank-bca" || len(fee) != 1 || fee[0].Amount != 58_000 || fee[0].CategoryID != "cat-fees" {
		t.Fatalf("money %+v fee %+v", money, fee)
	}
}

// From cashier.test.ts: a difference past the tolerance waits for a reason and another manager.
func TestShiftCloseWithSignOff(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	open, err := command.OpenShift{Deps: e.deps}.Handle(ctx, kadek, domain.OpenShiftInput{AccountID: "cb-ubud", Count: domain.CountFor(1_000_000)})
	if err != nil || open.Float != 1_000_000 || open.Status != domain.ShiftOpen {
		t.Fatalf("open: %v %+v", err, open)
	}
	_, err = command.OpenShift{Deps: e.deps}.Handle(ctx, kadek, domain.OpenShiftInput{AccountID: "cb-ubud", Count: domain.CountFor(1)})
	wantCode(t, err, "SHIFT_ALREADY_OPEN")
	_, err = command.OpenShift{Deps: e.deps}.Handle(ctx, dian, domain.OpenShiftInput{AccountID: "cb-uluwatu", Count: domain.CountFor(1)})
	wantCode(t, err, "SHIFT_NOT_ROSTERED")
	// Desk cash on the cashbox carries the open shift.
	in := cashOut(300_000)
	tx, err := command.CreateTransaction{Deps: e.deps}.Handle(ctx, kadek, in)
	if err != nil || tx.Shift() != open.ID {
		t.Fatalf("stamp: %v %q", err, tx.Shift())
	}
	close := command.CloseShift{Deps: e.deps}
	_, err = close.Handle(ctx, kadek, open.ID, domain.CloseShiftInput{Count: domain.CountFor(650_000)})
	wantCode(t, err, "SHIFT_REASON_REQUIRED")
	_, err = close.Handle(ctx, dian, open.ID, domain.CloseShiftInput{Count: domain.CountFor(650_000), Reason: "Change given twice"})
	wantCode(t, err, "SHIFT_NOT_YOURS")
	s, err := close.Handle(ctx, kadek, open.ID, domain.CloseShiftInput{Count: domain.CountFor(650_000), Reason: "Change given twice"})
	if err != nil || s.Status != domain.ShiftAwaiting || *s.Expected != 700_000 || *s.Difference != -50_000 || s.ReconciliationID != nil {
		t.Fatalf("close: %v %+v", err, s)
	}
	_, err = command.SignOffShift{Deps: e.deps}.Handle(ctx, kadek, open.ID, "")
	wantCode(t, err, "SHIFT_SELF_SIGNOFF")
	s, err = command.SignOffShift{Deps: e.deps}.Handle(ctx, putu, open.ID, "Checked the receipts")
	if err != nil || s.Status != domain.ShiftClosed || s.ReconciliationID == nil || s.SignOff.By != "Putu Ayu" {
		t.Fatalf("sign-off: %v %+v", err, s)
	}
	recs, _ := e.queries.Reconciliations(ctxOf(rama))
	last := recs[len(recs)-1]
	if last.Difference != -50_000 || last.AdjustmentID == nil || *last.ShiftID != open.ID {
		t.Fatalf("reconciliation %+v", last)
	}
	d, err := command.DropShift{Deps: e.deps}.Handle(ctx, kadek, open.ID, domain.DropInput{ToAccountID: "bank-bca", Amount: 600_000, Note: "Bank run"})
	if err != nil || d.Dropped != 600_000 || d.DropTransactionID == nil {
		t.Fatalf("drop: %v %+v", err, d)
	}
	next, err := command.OpenShift{Deps: e.deps}.Handle(ctx, kadek, domain.OpenShiftInput{AccountID: "cb-ubud", HandOverFrom: &open.ID})
	if err != nil || next.Float != 50_000 || next.HandOverID == nil {
		t.Fatalf("hand-over: %v %+v", err, next)
	}
}

func TestScopedReads(t *testing.T) {
	t.Parallel()
	e := setup(t)
	all, _ := e.queries.Transactions(ctxOf(rama))
	ubud, _ := e.queries.Transactions(ctxOf(putu))
	if len(ubud) == 0 || len(ubud) >= len(all) {
		t.Fatalf("ubud %d of %d", len(ubud), len(all))
	}
	for _, x := range ubud {
		if x.LocationID != "loc-ubud" {
			t.Fatalf("outside scope: %+v", x)
		}
	}
	j, _ := e.queries.Journals(ctxOf(dian))
	if len(j) != 0 {
		t.Fatalf("no finance/view reads %d journals", len(j))
	}
	_, err := command.Transition{Deps: e.deps}.Handle(context.Background(), putu, all[0].ID, domain.Approved, "")
	if all[0].LocationID != "loc-ubud" {
		wantCode(t, err, errs.CodeForbidden)
	}
}
