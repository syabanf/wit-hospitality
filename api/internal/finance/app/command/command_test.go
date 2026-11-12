package command_test

import (
	"context"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
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
	"github.com/syabanf/wit-hospitality/api/internal/services"
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
		Clock: clk, Files: noFiles{}}
	return env{deps: deps, queries: query.Queries{Deps: deps}}
}

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
	f := billing.PaymentRecorded{Where: billing.Where{BookingID: "bk-1001", VillaID: "vil-saka", LocationID: "loc-canggu", Date: today}, PaymentID: "pay-x", Number: "PAY-9001",
		BookingCode: "BK-1001", Kind: "deposit", Method: "card", CashAccountID: "bank-bca", Amount: 2_000_000, Fee: 58_000, CategoryID: "cat-room", Origin: "payment", RecordedBy: "Dian Permata"}
	if err := e.deps.DB.InTx(ctx, func(ctx context.Context) error { return command.Policies{Deps: e.deps}.PaymentRecorded(ctx, f) }); err != nil {
		t.Fatal(err)
	}
	c := query.Client{Queries: e.queries}
	money, _ := c.Entries(ctx, finance.Source{Type: "payment", ID: "pay-x"})
	fee, _ := c.Entries(ctx, finance.Source{Type: "payment_fee", ID: "pay-x"})
	if len(money) != 1 || money[0].CategoryID != "cat-room" || money[0].AccountID != "bank-bca" || len(fee) != 1 || fee[0].Amount != 58_000 || fee[0].CategoryID != "cat-fees" {
		t.Fatalf("money %+v fee %+v", money, fee)
	}
	if err := e.deps.DB.InTx(ctx, func(ctx context.Context) error { return command.Policies{Deps: e.deps}.PaymentRecorded(ctx, f) }); err != nil {
		t.Fatal(err)
	}
	if again, _ := c.Entries(ctx, finance.Source{Type: "payment", ID: "pay-x"}); len(again) != 1 {
		t.Fatalf("a replay books twice: %d", len(again))
	}
	if status, err := c.ApprovalStatus(ctx, "pay-x"); err != nil || status != domain.Submitted {
		t.Fatalf("status %q %v", status, err)
	}
	if _, err := (command.Transition{Deps: e.deps}).Handle(ctx, rama, money[0].TransactionID, domain.Approved, ""); err != nil {
		t.Fatal(err)
	}
	if status, _ := c.ApprovalStatus(ctx, "pay-x"); status != domain.Approved {
		t.Fatalf("status after approval %q", status)
	}
}

type someFiles map[string]domain.Attachment

func (f someFiles) Attachments(_ context.Context, ids []string) ([]domain.Attachment, error) {
	out := []domain.Attachment{}
	for _, id := range ids {
		a, ok := f[id]
		if !ok {
			return nil, errs.NotFound("file", id)
		}
		out = append(out, a)
	}
	return out, nil
}

// bookMoney carries the payment's files onto the cash-in, not the fee; a file the files context
// does not have, or a process without files, books the money without it.
func TestPaymentRecordedCarriesItsReceipts(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	slip := domain.Attachment{ID: "file-slip", Name: "slip.jpg", Type: "image/jpeg", Size: 2048, URL: "http://localhost:8080/api/v1/files/file-slip", UploadedBy: "Guest", UploadedAt: "2026-11-11T09:00:00"}
	with := e.deps
	with.Files = someFiles{"file-slip": slip}
	c := query.Client{Queries: e.queries}
	book := func(deps command.Deps, id string, files ...string) []domain.Attachment {
		t.Helper()
		f := billing.PaymentRecorded{Where: billing.Where{BookingID: "bk-1001", VillaID: "vil-saka", LocationID: "loc-canggu", Date: today}, PaymentID: id, Number: "PAY-" + id,
			BookingCode: "BK-1001", Kind: "deposit", Method: "bank_transfer", CashAccountID: "bank-bca", Amount: 1_500_000, Fee: 4_000, CategoryID: "cat-room", Origin: "payment",
			AttachmentIDs: files, RecordedBy: "Dian Permata"}
		if err := deps.DB.InTx(ctx, func(ctx context.Context) error { return command.Policies{Deps: deps}.PaymentRecorded(ctx, f) }); err != nil {
			t.Fatal(err)
		}
		money, _ := c.Entries(ctx, finance.Source{Type: "payment", ID: id})
		fee, _ := c.Entries(ctx, finance.Source{Type: "payment_fee", ID: id})
		if len(money) != 1 || len(fee) != 1 {
			t.Fatalf("money %+v fee %+v", money, fee)
		}
		txs, _ := e.deps.Repo.Transactions(ctx)
		var moneyFiles []domain.Attachment
		for _, tx := range txs {
			if tx.ID == fee[0].TransactionID && len(tx.Attachments) != 0 {
				t.Fatalf("the fee carries %+v", tx.Attachments)
			}
			if tx.ID == money[0].TransactionID {
				moneyFiles = tx.Attachments
			}
		}
		return moneyFiles
	}
	if got := book(with, "pay-r1", "file-slip"); len(got) != 1 || got[0] != slip {
		t.Fatalf("receipts %+v", got)
	}
	if got := book(with, "pay-r2", "file-gone"); len(got) != 0 {
		t.Fatalf("an unknown file: %+v", got)
	}
	if got := book(e.deps, "pay-r3", "file-slip"); len(got) != 0 {
		t.Fatalf("without files: %+v", got)
	}
}

// Billing's shift close and drop: the count with its difference as an adjustment, the drop as a
// transfer kept off every shift, and the cash the shift moved read back for billing.
func TestShiftFactsBookTheCountAndTheDrop(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	pol := command.Policies{Deps: e.deps}
	closed := billing.ShiftClosed{Where: billing.Where{LocationID: "loc-ubud", Date: today}, ShiftID: "cs-90", AccountID: "cb-ubud", Expected: 700_000, Counted: 650_000,
		Difference: -50_000, Note: "Shift SH-0090, Kadek Ariani: Change given twice", Shift: []byte(`{"cashierName":"Kadek Ariani"}`)}
	for range 2 {
		if err := e.deps.DB.InTx(ctx, func(ctx context.Context) error { return pol.ShiftClosed(ctx, closed) }); err != nil {
			t.Fatal(err)
		}
	}
	recs, _ := e.queries.Reconciliations(ctxOf(rama))
	last := recs[len(recs)-1]
	if last.Difference != -50_000 || last.AdjustmentID == nil || *last.ShiftID != "cs-90" || recs[len(recs)-2].ShiftID != nil && *recs[len(recs)-2].ShiftID == "cs-90" {
		t.Fatalf("reconciliation %+v", last)
	}
	drop := billing.ShiftDropped{Where: billing.Where{Date: today}, ShiftID: "cs-90", FromAccountID: "cb-ubud", ToAccountID: "bank-bca", Amount: 600_000, Description: "Cash drop from SH-0090", Reference: "SH-0090"}
	if err := e.deps.DB.InTx(ctx, func(ctx context.Context) error { return pol.ShiftDropped(ctx, drop) }); err != nil {
		t.Fatal(err)
	}
	txs, _ := e.deps.Repo.Transactions(ctx)
	out := txs[len(txs)-2]
	if out.Kind != domain.CashOut || out.Amount != 600_000 || out.TransferID == nil || string(out.ShiftID) != "null" {
		t.Fatalf("drop %+v", out)
	}
	cash, err := query.Client{Queries: e.queries}.ShiftCash(ctx, "cs-8", "cb-canggu")
	if err != nil || cash.In == 0 {
		t.Fatalf("seeded shift cash %v %+v", err, cash)
	}
}

// A work order expense: finance keeps the asking context's id, numbers the entry itself, rejects it
// without its receipt, takes the corrected request back for approval and answers every step with
// finance.cash_out.decided.v1.
func TestExpenseCashOutRoundTrip(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	pol := command.Policies{Deps: e.deps}
	req := command.CashOutRequest{TransactionID: "tx-m50", Number: "TX-M2450", Origin: "maintenance", SourceID: "wo-test", Kind: "cash_out", CategoryID: "cat-maint", Method: "cash",
		Amount: 1_500_000, Date: today, LocationID: "loc-ubud", VillaID: "vil-tirta", Description: "WO-0001 parts: pump seal, Bali Pool", Reference: "WO-0001-1",
		CreatedByID: "usr-kadek", CreatedBy: "Kadek Ariani"}
	run := func(f func(context.Context) error) {
		t.Helper()
		if err := e.deps.DB.InTx(ctx, f); err != nil {
			t.Fatal(err)
		}
	}
	run(func(ctx context.Context) error { return pol.CashOutSubmitted(command.SourceExpense)(ctx, req) })
	tx, err := e.deps.Repo.Transaction(ctx, "tx-m50")
	if err != nil || tx.Number != "TX-2641" || tx.Status != domain.Rejected || tx.AccountID != "cb-ubud" || tx.Reference != "WO-0001-1" {
		t.Fatalf("submitted without a receipt: %v %+v", err, tx)
	}
	req.Attachments = []domain.Attachment{{ID: "file-9", Name: "seal.jpg", Type: "image/jpeg", Size: 900, URL: "https://x/seal.jpg"}}
	run(func(ctx context.Context) error { return pol.CashOutResubmitted(ctx, req) })
	if tx, err = (command.Transition{Deps: e.deps}).Handle(ctx, rama, "tx-m50", domain.Approved, ""); err != nil || tx.Status != domain.Approved {
		t.Fatalf("approve: %v %+v", err, tx)
	}
	var statuses []string
	rows, _ := e.deps.DB.Pool.Query(ctx, `SELECT payload->>'status' FROM platform.outbox WHERE event_type = $1 AND payload->>'transactionId' = 'tx-m50' ORDER BY id`, finance.EventCashOutDecided)
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		statuses = append(statuses, s)
	}
	rows.Close()
	if len(statuses) != 3 || statuses[0] != "rejected" || statuses[1] != "submitted" || statuses[2] != "approved" {
		t.Fatalf("decided %v", statuses)
	}
	entries, _ := query.Client{Queries: e.queries}.Entries(ctx, finance.Source{Type: command.SourceExpense, ID: "wo-test"})
	if len(entries) != 1 || entries[0].TransactionID != "tx-m50" {
		t.Fatalf("by source %+v", entries)
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

// From journal.ts orderJournal and voidJournal and the mock's delivery: a delivery books the
// revenue on the receivable and the partners' share against each partner's payable in one entry,
// and one bill per partner from the bank for approval, once however often the event arrives. A
// void withdraws the bills and turns the partner lines around, and billing's folio void takes the
// revenue back off, so the stay owes nothing and the partners are owed nothing.
func TestOrderDeliveredBooksRevenueAndPartnerBillsAndVoidTurnsThemAround(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	pol := command.Policies{Deps: e.deps}
	run := func(h func(context.Context, services.OrderBilled) error, b services.OrderBilled) {
		t.Helper()
		if err := e.deps.DB.InTx(ctx, func(ctx context.Context) error { return h(ctx, b) }); err != nil {
			t.Fatal(err)
		}
	}
	spa, driver := "ptn-taksu-spa", "ptn-dewata-driver"
	b := services.OrderBilled{OrderID: "so-x", Number: "RS-9001", BookingID: "bk-1001", UnitID: "unit-sk-04", VillaID: "vil-saka", LocationID: "loc-canggu", On: today,
		Lines: []services.BilledLine{
			{ItemID: "mi-massage", Name: "Balinese massage, 60 minutes", PartnerID: &spa, UnitCost: 180_000, Cost: 360_000},
			{ItemID: "mi-transfer", Name: "Airport transfer", PartnerID: &driver, UnitCost: 150_000, Cost: 150_000},
		},
		Codes:        []services.CodeAmount{{Code: "SPA", Amount: 600_000}, {Code: "TRNS", Amount: 200_000}},
		PartnerCosts: []services.PartnerCost{{PartnerID: spa, PartnerName: "Taksu Mobile Spa", Amount: 360_000}, {PartnerID: driver, PartnerName: "Dewata Driver", Amount: 150_000}}}
	run(pol.OrderDelivered, b)
	run(pol.OrderDelivered, b)
	got := e.journalsOf(t, "so-x")
	if len(got) != 1 || got[0].Source != domain.SourceOrder || got[0].SourceNumber != "RS-9001" || *got[0].VillaID != "vil-saka" ||
		got[0].Memo != "RS-9001 delivered: revenue on the receivable, partner costs owed" {
		t.Fatalf("delivery entries %+v", got)
	}
	want := []domain.JournalLine{
		{AccountID: domain.GLReceivable, Debit: 600_000, BookingID: "bk-1001"},
		{AccountID: "gl-4250", Credit: 495_868, Code: "SPA"},
		{AccountID: domain.GLServicePayable, Credit: 49_587, Code: domain.ServiceCode, BookingID: "bk-1001"},
		{AccountID: domain.GLPb1Payable, Credit: 54_545, Code: domain.PB1Code, BookingID: "bk-1001"},
		{AccountID: domain.GLReceivable, Debit: 200_000, BookingID: "bk-1001"},
		{AccountID: "gl-4240", Credit: 200_000, Code: "TRNS"},
		{AccountID: domain.GLPartnerCost, Debit: 510_000},
		{AccountID: domain.GLPartnerPayable, Credit: 360_000, PartnerID: spa},
		{AccountID: domain.GLPartnerPayable, Credit: 150_000, PartnerID: driver},
	}
	if len(got[0].Lines) != len(want) {
		t.Fatalf("delivery lines %+v", got[0].Lines)
	}
	for i, l := range want {
		if got[0].Lines[i] != l {
			t.Fatalf("line %d: %+v, want %+v", i, got[0].Lines[i], l)
		}
	}
	bills, err := e.deps.Repo.BySource(ctx, finance.Source{Type: command.SourcePartnerBill, ID: "so-x"})
	if err != nil || len(bills) != 2 {
		t.Fatalf("bills %v %+v", err, bills)
	}
	first := bills[0]
	if first.Status != domain.Submitted || first.Kind != domain.CashOut || first.CategoryID != services.PartnerCostCategory || first.AccountID != "bank-bca" || first.Amount != 360_000 ||
		first.Description != "RS-9001 Taksu Mobile Spa: Balinese massage, 60 minutes" || first.Reference != "RS-9001" || first.Origin != "room_service" || first.LocationID != "loc-canggu" {
		t.Fatalf("first bill %+v", first)
	}
	var decided []string
	rows, _ := e.deps.DB.Pool.Query(ctx, `SELECT (payload->>'transactionId') || ' ' || (payload->>'status') || ' ' || (payload->>'partnerId') FROM platform.outbox
		WHERE event_type = $1 AND payload->>'sourceId' = 'so-x' ORDER BY id`, finance.EventCashOutDecided)
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		decided = append(decided, s)
	}
	rows.Close()
	if len(decided) != 2 || decided[0] != first.ID+" submitted "+spa || decided[1] != bills[1].ID+" submitted "+driver {
		t.Fatalf("decided %v", decided)
	}

	b.Reason = "Wrong room"
	run(pol.OrderVoided, b)
	run(pol.OrderVoided, b)
	for _, id := range []string{first.ID, bills[1].ID} {
		tx, _ := e.deps.Repo.Transaction(ctx, id)
		if tx.Status != domain.Rejected || tx.RejectionReason == nil || *tx.RejectionReason != "RS-9001 voided" {
			t.Fatalf("bill after the void %+v", tx)
		}
	}
	f := billing.FolioLineVoided{Where: billing.Where{BookingID: "bk-1001", VillaID: "vil-saka", LocationID: "loc-canggu", Date: today}, OrderID: "so-x", OrderNumber: "RS-9001",
		BookingCode: "BK-1001", Lines: []billing.VoidedLine{
			{Code: "SPA", Account: "gl-4250", Amount: 495_868, TaxLines: []billing.TaxLine{{Code: "SVC", Account: domain.GLServicePayable, Amount: 49_587}, {Code: "PB1", Account: domain.GLPb1Payable, Amount: 54_545}}},
			{Code: "TRNS", Account: "gl-4240", Amount: 200_000}}}
	for range 2 {
		if err := e.deps.DB.InTx(ctx, func(ctx context.Context) error { return pol.FolioLineVoided(ctx, f) }); err != nil {
			t.Fatal(err)
		}
	}
	got = e.journalsOf(t, "so-x")
	if len(got) != 3 {
		t.Fatalf("want delivery, partner void and revenue void, got %+v", got)
	}
	turned := got[1]
	if turned.Memo != "RS-9001 voided: partner costs reversed" || len(turned.Lines) != 3 || turned.Lines[0] != (domain.JournalLine{AccountID: domain.GLPartnerCost, Credit: 510_000}) ||
		turned.Lines[1] != (domain.JournalLine{AccountID: domain.GLPartnerPayable, Debit: 360_000, PartnerID: spa}) {
		t.Fatalf("partner void %+v", turned)
	}
	if owed := domain.PartyBalances(got, domain.GLPartnerPayable, false); owed[spa].Credit != owed[spa].Debit || owed[driver].Credit != owed[driver].Debit {
		t.Fatalf("the void leaves a partner owed %+v", owed)
	}
	for _, account := range []string{domain.GLReceivable, domain.GLServicePayable, domain.GLPb1Payable} {
		if left := domain.PartyBalances(got, account, true)["bk-1001"]; left.Debit != left.Credit {
			t.Fatalf("the void leaves %s at %+v", account, left)
		}
	}
	if got[2].Memo != "RS-9001 voided: delivery reversed" {
		t.Fatalf("revenue void %+v", got[2])
	}
	e.books(t)
}

// A partner bill approved and posted pays its partner's payable down from the bank.
func TestPostingAPartnerBillPaysThePartner(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	spa := "ptn-taksu-spa"
	b := services.OrderBilled{OrderID: "so-p", Number: "RS-9003", BookingID: "bk-1001", VillaID: "vil-saka", LocationID: "loc-canggu", On: today,
		Lines:        []services.BilledLine{{ItemID: "mi-massage", Name: "Balinese massage, 60 minutes", PartnerID: &spa, UnitCost: 180_000, Cost: 180_000}},
		Codes:        []services.CodeAmount{{Code: "SPA", Amount: 300_000}},
		PartnerCosts: []services.PartnerCost{{PartnerID: spa, PartnerName: "Taksu Mobile Spa", Amount: 180_000}},
		By:           "Kadek Ariani", ByID: "usr-kadek", ByRole: "manager"}
	if err := e.deps.DB.InTx(ctx, func(ctx context.Context) error { return command.Policies{Deps: e.deps}.OrderDelivered(ctx, b) }); err != nil {
		t.Fatal(err)
	}
	bills, _ := e.deps.Repo.BySource(ctx, finance.Source{Type: command.SourcePartnerBill, ID: "so-p"})
	if len(bills) != 1 {
		t.Fatalf("bills %+v", bills)
	}
	move := command.Transition{Deps: e.deps}
	// The deliverer wrote the bill, so another manager signs it.
	_, err := move.Handle(ctx, kadek, bills[0].ID, domain.Approved, "")
	wantCode(t, err, "APPROVAL_SELF")
	if _, err := move.Handle(ctx, rama, bills[0].ID, domain.Approved, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := move.Handle(ctx, ida, bills[0].ID, domain.Posted, ""); err != nil {
		t.Fatal(err)
	}
	paid := e.journalsOf(t, bills[0].ID)
	if len(paid) != 1 {
		t.Fatalf("bill journal %+v", paid)
	}
	all := append(e.journalsOf(t, "so-p"), paid...)
	if owed := domain.PartyBalances(all, domain.GLPartnerPayable, false)[spa]; owed.Credit != 180_000 || owed.Debit != 180_000 {
		t.Fatalf("partner after the bill posts %+v (lines %+v)", owed, paid[0].Lines)
	}
	var posted int
	_ = e.deps.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM platform.outbox WHERE event_type = $1 AND payload->>'transactionId' = $2 AND payload->>'status' = 'posted'`,
		finance.EventCashOutDecided, bills[0].ID).Scan(&posted)
	if posted != 1 {
		t.Fatalf("decided posted %d", posted)
	}
	e.books(t)
}
