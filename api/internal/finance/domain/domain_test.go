package domain

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func code(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	return ""
}

var rules = []ApprovalRule{
	{ID: "rule-standard", Kind: "all", MinAmount: 0, Levels: []string{"manager"}, Active: true},
	{ID: "rule-5m", Kind: CashOut, MinAmount: 5_000_000, Levels: []string{"manager", "finance"}, Active: true},
	{ID: "rule-25m", Kind: CashOut, MinAmount: 25_000_000, Levels: []string{"manager", "finance", "owner"}, Active: true},
	{ID: "rule-karang", Kind: CashOut, VillaID: Ptr("vil-karang"), MinAmount: 1_000_000, Levels: []string{"manager", "finance"}, Active: true},
	{ID: "rule-off", Kind: "all", MinAmount: 0, Levels: []string{"owner"}, Active: false},
}

// From services.test.ts: keeps approval rules editable and picks the most specific one.
func TestMatchRulePicksTheMostSpecific(t *testing.T) {
	for _, c := range []struct {
		kind, villa string
		amount      int64
		want        string
	}{
		{CashOut, "vil-saka", 400_000, "rule-standard"},
		{CashOut, "vil-saka", 6_000_000, "rule-5m"},
		{CashOut, "vil-saka", 30_000_000, "rule-25m"},
		{CashOut, "vil-karang", 2_000_000, "rule-karang"},
		{CashOut, "vil-karang", 30_000_000, "rule-karang"},
		{CashIn, "vil-saka", 30_000_000, "rule-standard"},
	} {
		if got := MatchRule(rules, c.kind, c.villa, c.amount); got == nil || got.ID != c.want {
			t.Errorf("%s %s %d: got %+v, want %s", c.kind, c.villa, c.amount, got, c.want)
		}
	}
	if got := RequiredLevels(nil, CashOut, "", 1); len(got) != 1 || got[0] != "manager" {
		t.Errorf("without a rule one manager signs: %v", got)
	}
}

func TestApprovalChainSignsInOrder(t *testing.T) {
	status, approvals, history := Submitted, []ApprovalGrant{}, []TransactionEvent{}
	var reason *string
	a := Approvable{Number: "TX-1", Status: &status, Approvals: &approvals, History: &history, RejectionReason: &reason, CreatedByID: "usr-kadek", Noun: "entry"}
	levels := []string{"manager", "finance", "owner"}
	kadek := Signer{ID: "usr-kadek", Name: "Kadek Ariani", Role: "manager"}
	putu := Signer{ID: "usr-putu", Name: "Putu", Role: "manager"}
	ida := Signer{ID: "usr-ida", Name: "Ida Bagus Rai", Role: "finance"}
	rama := Signer{ID: "usr-rama", Name: "Rama Wijaya", Role: "owner"}

	if err := a.Approve(levels, kadek, "2026-11-11", ""); code(err) != "APPROVAL_SELF" {
		t.Fatalf("the author signs: %v", err)
	}
	if err := a.Approve(levels, ida, "2026-11-11", ""); code(err) != "APPROVAL_ROLE" || err.(*errs.Error).Message != "Level 1 of 3 needs Villa manager; you are Finance." {
		t.Fatalf("finance signs level 1: %v", err)
	}
	if err := a.Approve(levels, putu, "2026-11-11", ""); err != nil || status != Submitted || history[0].Note != "Level 1 of 3" {
		t.Fatalf("level 1: %v %s %+v", err, status, history)
	}
	if err := a.Approve(levels, putu, "2026-11-11", ""); code(err) != "APPROVAL_ROLE" {
		t.Fatalf("level 2 by a manager: %v", err)
	}
	if err := a.Approve(levels, ida, "2026-11-11", ""); err != nil || status != Submitted {
		t.Fatalf("level 2: %v", err)
	}
	// The owner signs any level, so a second signature is refused by name.
	a2 := a
	if err := a2.Approve(levels, Signer{ID: "usr-x", Name: "Ida Bagus Rai", Role: "owner"}, "2026-11-11", ""); code(err) != "APPROVAL_SELF" {
		t.Fatalf("a second signature: %v", err)
	}
	if err := a.Approve(levels, rama, "2026-11-11", ""); err != nil || status != Approved || history[len(history)-1].Note != "All levels signed" {
		t.Fatalf("level 3: %v %s", err, status)
	}
	if err := a.Approve(levels, rama, "2026-11-11", ""); code(err) != "TRANSACTION_INVALID_STATE" {
		t.Fatalf("past the last level: %v", err)
	}
}

func TestRejectNeedsAReasonAndAnotherPerson(t *testing.T) {
	status, approvals, history := Submitted, []ApprovalGrant{}, []TransactionEvent{}
	var reason *string
	a := Approvable{Number: "TX-1", Status: &status, Approvals: &approvals, History: &history, RejectionReason: &reason, CreatedByID: "usr-kadek", Noun: "entry"}
	if err := a.Reject(Signer{ID: "usr-ida"}, "2026-11-11", "no"); code(err) != errs.CodeValidation {
		t.Fatalf("short reason: %v", err)
	}
	if err := a.Reject(Signer{ID: "usr-kadek"}, "2026-11-11", "Wrong account"); code(err) != "APPROVAL_SELF" {
		t.Fatalf("the author rejects: %v", err)
	}
	if err := a.Reject(Signer{ID: "usr-ida"}, "2026-11-11", "Wrong account"); err != nil || status != Rejected || *reason != "Wrong account" {
		t.Fatalf("reject: %v", err)
	}
	a.Submit(Signer{ID: "usr-kadek"}, "2026-11-12", "")
	if status != Submitted || reason != nil || history[len(history)-1].Kind != "resubmitted" {
		t.Fatalf("resubmit: %s %+v", status, history)
	}
}

func TestProofRule(t *testing.T) {
	p := DefaultProofPolicy
	if !NeedsProof(CashOut, 1_000_000, "manual", 0, p, false) || NeedsProof(CashOut, 999_999, "manual", 0, p, false) {
		t.Fatal("the threshold")
	}
	if !NeedsProof(CashOut, 10, "maintenance", 0, p, true) || NeedsProof(CashOut, 5_000_000, "payment", 0, p, false) || NeedsProof(CashOut, 5_000_000, "manual", 1, p, false) {
		t.Fatal("petty cash, origins and attachments")
	}
	if NeedsProof(CashOut, 5_000_000, "manual", 0, ProofPolicy{}, true) {
		t.Fatal("0 switches the rule off")
	}
	if ProofRequired(p, false).Message != "Attach a receipt or invoice: cash-outs from Rp 1.000.000 need proof before approval." {
		t.Fatal(ProofRequired(p, false).Message)
	}
}

// From cashier.test.ts: the cashier shift domain.
func TestCashierShiftDomain(t *testing.T) {
	c := DrawerCount{Notes: map[string]float64{"100000": 3, "50000": 1, "2000": 2}, Coins: 500}
	if c.Total() != 354_500 {
		t.Fatalf("count %d", c.Total())
	}
	if CountFor(354_500).Total() != 354_500 {
		t.Fatal("countFor")
	}
	if ValidateCount(DrawerCount{Notes: map[string]float64{"1000": -1}}) == nil || ValidateCount(DrawerCount{Coins: 0.5}) == nil {
		t.Fatal("bad counts pass")
	}
	shift := CashierShift{ID: "cs-1", Number: "SH-0001", AccountID: "cb-canggu", Float: 1_000_000, Status: ShiftOpen, CashierID: "usr-dian"}
	tx := func(kind, status, shift, account string, amount int64) Transaction {
		t := Transaction{Kind: kind, Status: status, AccountID: account, Amount: amount}
		t.SetShift(shift)
		return t
	}
	txs := []Transaction{
		tx(CashIn, Submitted, "cs-1", "cb-canggu", 500_000),
		tx(CashOut, Posted, "cs-1", "cb-canggu", 200_000),
		tx(CashIn, Draft, "cs-1", "cb-canggu", 9_000_000),
		tx(CashIn, Rejected, "cs-1", "cb-canggu", 9_000_000),
		tx(CashIn, Posted, "cs-2", "cb-canggu", 9_000_000),
		tx(CashIn, Posted, "cs-1", "cb-ubud", 9_000_000),
	}
	if e := ShiftExpected(shift, txs); e != 1_300_000 {
		t.Fatalf("expected %d", e)
	}
	p := DefaultShiftPolicy
	if NeedsSignOff(10_000, p) || !NeedsSignOff(-10_001, p) {
		t.Fatal("tolerance")
	}
	if err := CloseProblem(shift, -20_000, "", p); code(err) != "SHIFT_REASON_REQUIRED" {
		t.Fatalf("close without a reason: %v", err)
	}
	shift.Status = ShiftAwaiting
	if err := SignOffProblem(shift, "usr-dian"); code(err) != "SHIFT_SELF_SIGNOFF" {
		t.Fatalf("self sign-off: %v", err)
	}
	if err := OpenProblem("cb-canggu", []CashierShift{{AccountID: "cb-canggu", Status: ShiftOpen, Number: "SH-0002", CashierName: "Wayan"}}, true, true, nil); code(err) != "SHIFT_ALREADY_OPEN" {
		t.Fatalf("second open shift: %v", err)
	}
	if err := OpenProblem("cb-ubud", nil, false, false, nil); code(err) != "SHIFT_NOT_ROSTERED" {
		t.Fatalf("off the roster: %v", err)
	}
	counted := int64(500_000)
	closed := CashierShift{Number: "SH-0003", Status: ShiftClosed, Counted: &counted}
	if err := DropProblem(closed, 600_000); code(err) != errs.CodeValidation {
		t.Fatalf("drop past the count: %v", err)
	}
}

func TestPeriodRules(t *testing.T) {
	if err := AssertOpenPeriod([]string{"2026-08"}, "2026-08-31"); code(err) != "PERIOD_CLOSED" || err.(*errs.Error).Message != "August 2026 is closed; reopen it before posting into it." {
		t.Fatalf("%v", err)
	}
	if err := AssertClosable("2026-11", "2026-11-11", nil, 0); code(err) != "PERIOD_NOT_ENDED" {
		t.Fatalf("%v", err)
	}
	if err := AssertClosable("2026-10", "2026-11-11", nil, 2); code(err) != "PERIOD_PENDING" || err.(*errs.Error).Message != "2 entries dated in October 2026 still wait for approval or posting." {
		t.Fatalf("%v", err)
	}
	if err := AssertClosable("2026-13", "2026-11-11", nil, 0); code(err) != errs.CodeValidation {
		t.Fatalf("%v", err)
	}
}

func TestJournalForPostingRules(t *testing.T) {
	codes := []TransactionCode{{Code: "ROOM", Kind: "charge", AccountID: Ptr(GLRoomRevenue)}}
	b := Books{Map: map[string]string{"cat-util": "gl-6200", "cat-deposit": GLDeposits}, Codes: codes, Stays: map[string]Stay{
		"bk-1": {ID: "bk-1", Status: "confirmed"},
		"bk-2": {ID: "bk-2", Status: "checked_in", BilledOn: Ptr("2026-11-01")},
	}}
	posted := []TransactionEvent{{Kind: "posted", On: "2026-11-05"}}
	util := Transaction{ID: "tx-1", Number: "TX-2401", AccountID: "cb-ubud", Kind: CashOut, CategoryID: "cat-util", Amount: 400_000, Date: "2026-11-05", Origin: "manual", History: posted}
	e, err := JournalFor(util, b)
	if err != nil || e.Lines[0] != (JournalLine{AccountID: "gl-6200", Debit: 400_000}) || e.Lines[1] != (JournalLine{AccountID: "gl-cash-cb-ubud", Credit: 400_000}) {
		t.Fatalf("by category: %v %+v", err, e)
	}
	deposit := Transaction{ID: "tx-2", AccountID: "cb-canggu", Kind: CashIn, CategoryID: "cat-room", Amount: 1_000_000, BookingID: Ptr("bk-1"), Origin: "front_desk", History: posted}
	if e, _ := JournalFor(deposit, b); e.Lines[1].AccountID != GLDeposits || e.Lines[1].BookingID != "bk-1" {
		t.Fatalf("before billing the room money waits on deposits: %+v", e.Lines)
	}
	deposit.BookingID = Ptr("bk-2")
	if e, _ := JournalFor(deposit, b); e.Lines[1].AccountID != GLReceivable {
		t.Fatalf("after billing it settles the receivable: %+v", e.Lines)
	}
	payroll := Transaction{ID: "tx-3", Number: "TX-2403", AccountID: "bank-bca", Kind: CashOut, CategoryID: "cat-payroll", Amount: 20_000_000, Origin: "payroll"}
	b.Payroll = &PayrollTotals{PeriodID: "pay-2026-10", Month: "2026-10", EmployeeBpjs: 600_000, CompanyBpjs: 900_000, Pph21: 400_000, Loans: 500_000, ServiceCharge: 1_000_000}
	e, err = JournalFor(payroll, b)
	if err != nil || e.Source != SourcePayroll || e.SourceID != "pay-2026-10" || e.Lines[0].Debit != 20_000_000+600_000+400_000+500_000-1_000_000 || TotalDebits(e.Lines) != TotalCredits(e.Lines) {
		t.Fatalf("payroll: %v %+v", err, e)
	}
	if e.Memo != "Payroll October 2026: salaries paid with TX-2403" {
		t.Fatal(e.Memo)
	}
}

// The books invariants of accounting.test.ts, on the seeded journal exported from the TS seed.
func TestSeededBooksBalance(t *testing.T) {
	raw, err := os.ReadFile("../../../seed/finance.json")
	if err != nil {
		t.Fatal(err)
	}
	var s struct {
		BaseDate     string         `json:"baseDate"`
		CashAccounts []CashAccount  `json:"cashAccounts"`
		Transactions []Transaction  `json:"transactions"`
		Journals     []JournalEntry `json:"journals"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	if len(s.Journals) < 200 {
		t.Fatalf("%d journal entries", len(s.Journals))
	}
	for _, p := range BooksProblems(ChartOfAccounts(s.CashAccounts), s.CashAccounts, s.Transactions, s.Journals, s.BaseDate) {
		t.Error(p)
	}
}
