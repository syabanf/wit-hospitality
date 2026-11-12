package domain

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

type fixture struct {
	Contracts  []Contract  `json:"contracts"`
	Statements []Statement `json:"statements"`
}

// seed reads seed/owners.json, which scripts/export-seed.mjs writes from the TypeScript seed: each
// statement there was worked out by statementDraft and settlement in src/domain/owner.ts.
func seed(t *testing.T) fixture {
	t.Helper()
	raw, err := os.ReadFile("../../../seed/owners.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func code(t *testing.T, err error, want string) {
	t.Helper()
	if !errs.HasCode(err, want) {
		t.Fatalf("want %s, got %v", want, err)
	}
}

func message(t *testing.T, err error, want string) {
	t.Helper()
	e, ok := errs.As(err)
	if !ok || e.Message != want {
		t.Fatalf("want %q, got %v", want, err)
	}
}

func contract(f fixture, id string) Contract {
	for _, c := range f.Contracts {
		if c.ID == id {
			return c
		}
	}
	return Contract{}
}

// TestDraftEqualsTheTypeScriptFigures replays every seeded statement's stays and entries through
// the Go draft: the figures and the carried settlement come out as the TypeScript ones.
func TestDraftEqualsTheTypeScriptFigures(t *testing.T) {
	f := seed(t)
	if len(f.Statements) != 6 {
		t.Fatalf("seed has %d statements", len(f.Statements))
	}
	var closed []Statement
	for _, st := range f.Statements {
		c := contract(f, st.ContractID)
		books := Books{Stays: st.Stays, Payroll: st.Figures.Payroll, OwnerNights: st.Figures.OwnerNights, OwnerStays: st.Figures.OwnerStays}
		for _, e := range st.Entries {
			origin := ""
			if e.Charged {
				origin = "maintenance"
			}
			books.Entries = append(books.Entries, BookEntry{StatementEntry: e, Origin: origin})
		}
		d := StatementDraft(c.ContractInput, books)
		if d.Figures != st.Figures {
			t.Errorf("%s figures\n got %+v\nwant %+v", st.Number, d.Figures, st.Figures)
		}
		if err := AssertDrillDown(d.Base, d.Stays, d.Entries); err != nil {
			t.Errorf("%s: %v", st.Number, err)
		}
		s := Settle(d.Figures.NetPayable, PreviousStatement(closed, c.ID, st.Month))
		if s.Payable != st.Payable || s.BroughtForward != st.BroughtForward {
			t.Errorf("%s settlement %+v, want payable %d brought %d", st.Number, s, st.Payable, st.BroughtForward)
		}
		closed = append(closed, st)
	}
}

func TestFiguresByFeeBasisAndCharges(t *testing.T) {
	base := StatementBase{RoomRevenue: 100_000_000, OtherRevenue: 5_000_000, AirbnbFees: 3_000_000, Expenses: 20_000_000, Payroll: 10_000_000, MaintenanceCharged: 4_000_000, OwnerNights: 3, OwnerStays: 1}
	c := ContractInput{FeeBasis: FeeGOP, FeePct: 20, FixedMonthlyFee: 2_500_000, Charged: ChargedOperating, ReservePct: 3, OwnerStayPricing: StayCleaning, OwnerStayPrice: 350_000}
	f := Figures(c, base)
	// GOP 105m - 23m = 82m; fee 16.4m + 2.5m; reserve 3% of 105m; one cleaning.
	if f.GOP != 82_000_000 || f.ManagementFee != 18_900_000 || f.Reserve != 3_150_000 || f.OwnerStayCharge != 350_000 || f.NetPayable != 82_000_000-18_900_000-3_150_000-350_000 {
		t.Fatalf("gop contract %+v", f)
	}
	c.Charged, c.FeeBasis, c.OwnerStayPricing, c.OwnerStayPrice = ChargedAll, FeeGross, StayRate, 750_000
	if f := Figures(c, base); f.Charged != 33_000_000 || f.ManagementFee != 21_000_000+2_500_000 || f.OwnerStayCharge != 2_250_000 {
		t.Fatalf("gross contract %+v", f)
	}
	c.Charged, c.FeeBasis = ChargedMaintenance, FeeRoom
	if f := Figures(c, base); f.Charged != 7_000_000 || f.ManagementFee != 20_000_000+2_500_000 {
		t.Fatalf("room contract %+v", f)
	}
	// A loss pays no GOP fee, only the fixed one.
	c.FeeBasis = FeeGOP
	if f := Figures(c, StatementBase{AirbnbFees: 1_000_000, MaintenanceCharged: 2_000_000}); f.ManagementFee != 2_500_000 || f.GOP != -3_000_000 {
		t.Fatalf("loss %+v", f)
	}
}

func TestCarryForward(t *testing.T) {
	october := &Statement{Month: "2026-10", Payable: -2_143_089, Shortfall: ShortfallCarry}
	s := Settle(30_000_000, october)
	if s.BroughtFrom == nil || *s.BroughtFrom != "2026-10" || s.BroughtForward != 2_143_089 || s.Payable != 30_000_000-2_143_089 {
		t.Fatalf("carried %+v", s)
	}
	october.Shortfall = ShortfallTopUp
	if s := Settle(30_000_000, october); s.BroughtFrom != nil || s.Payable != 30_000_000 {
		t.Fatalf("a topped-up month carries nothing %+v", s)
	}
	_, err := AssertPayable(Statement{Number: "OS-2026-10-PD", Status: StatementApproved, Payable: -2_143_089, Shortfall: ShortfallCarry})
	message(t, err, "OS-2026-10-PD carries 2143089 forward to the next statement; nothing is paid this month.")
	_, err = AssertPayable(Statement{Number: "OS-2026-10-PD", Status: StatementApproved})
	message(t, err, "OS-2026-10-PD leaves nothing to pay the owner.")
	_, err = AssertPayable(Statement{Number: "OS-2026-10-PD", Status: StatementClosed, Payable: 5})
	message(t, err, "OS-2026-10-PD needs the Owner’s approval before it is paid.")
}

func TestTopUpJournal(t *testing.T) {
	st := Statement{ID: "os-9", Number: "OS-2026-10-PD", VillaID: "vil-pandawa", Month: "2026-10", Status: StatementApproved, Shortfall: ShortfallTopUp, Payable: -2_000_000,
		Figures: StatementFigures{GOP: 1_000_000, ManagementFee: 2_500_000, Reserve: 500_000, NetPayable: -2_000_000}}
	topUp, err := AssertPayable(st)
	if err != nil || !topUp {
		t.Fatalf("a top-up pays: %v %v", topUp, err)
	}
	j := CloseJournal(st)
	if j.Date != "2026-10-31" || j.Memo != "OS-2026-10-PD closed: owner share of October 2026" || j.Source != "owner" {
		t.Fatalf("journal %+v", j)
	}
	want := []JournalLine{{GLOwnerShare, 1_000_000, 0}, {GLManagementFee, 0, 2_500_000}, {GLOwnerReserve, 0, 500_000}, {GLOwnerPayable, 2_000_000, 0}, {GLOwnerReceivable, 2_000_000, 0}, {GLOwnerPayable, 0, 2_000_000}}
	if len(j.Lines) != len(want) {
		t.Fatalf("lines %+v", j.Lines)
	}
	for i := range want {
		if j.Lines[i] != want[i] {
			t.Fatalf("line %d: %+v, want %+v", i, j.Lines[i], want[i])
		}
	}
	r := ReopenJournal(st, "Fee to be checked")
	if r.Memo != "OS-2026-10-PD reopened: Fee to be checked" || r.Lines[0] != (JournalLine{GLOwnerShare, 0, 1_000_000}) {
		t.Fatalf("reversal %+v", r)
	}
}

func TestEveryCloseJournalBalances(t *testing.T) {
	for _, st := range seed(t).Statements {
		var dr, cr int64
		for _, l := range CloseJournal(st).Lines {
			dr, cr = dr+l.Debit, cr+l.Credit
		}
		if dr != cr || dr == 0 {
			t.Errorf("%s: debits %d, credits %d", st.Number, dr, cr)
		}
	}
}

func TestStatementsCloseInOrder(t *testing.T) {
	f := seed(t)
	karang := contract(f, "ct-karang")
	today := "2026-11-11"
	code(t, AssertClosable(karang, "2026-11", today, f.Statements, 0), "STATEMENT_MONTH_OPEN")
	message(t, AssertClosable(karang, "2026-10", today, f.Statements, 0), "The 2026-10 statement of MC-2025-01 is already closed.")
	message(t, AssertClosable(karang, "2026-08", today, f.Statements, 0), "OS-2026-09-KR is already closed; reopen it before closing an earlier month.")
	code(t, AssertClosable(karang, "2025-01", today, nil, 0), "CONTRACT_NOT_ACTIVE")
	code(t, AssertClosable(karang, "2026-13", today, nil, 0), errs.CodeValidation)
	message(t, AssertClosable(karang, "2026-08", today, nil, 2), "2 entries of the villa dated in 2026-08 still wait for approval or posting.")
	message(t, AssertClosable(karang, "2026-08", today, nil, 1), "1 entry of the villa dated in 2026-08 still waits for approval or posting.")
	if err := AssertClosable(karang, "2026-08", today, nil, 0); err != nil {
		t.Fatal(err)
	}
}

func TestReopen(t *testing.T) {
	f := seed(t)
	var september, october Statement
	for _, st := range f.Statements {
		if st.ContractID == "ct-karang" && st.Month == "2026-09" {
			september = st
		}
		if st.ContractID == "ct-karang" && st.Month == "2026-10" {
			october = st
		}
	}
	code(t, AssertReopenable(october, f.Statements, ""), errs.CodeValidation)
	message(t, AssertReopenable(september, f.Statements, "Wrong fee"), "OS-2026-10-KR comes after OS-2026-09-KR; reopen it first.")
	october.Payout = &Payout{Ref: "osp-1", Number: "TX-2637", Status: "submitted"}
	message(t, AssertReopenable(october, f.Statements, "Wrong fee"), "OS-2026-10-KR has TX-2637 waiting for approval; reject it before reopening.")
	october.Payout.Status = "rejected"
	if err := AssertReopenable(october, f.Statements, "Fee to be checked"); err != nil {
		t.Fatal(err)
	}
	october.Payout.Status = "posted"
	message(t, AssertReopenable(october, f.Statements, "Too late"), "OS-2026-10-KR is settled by TX-2637; it no longer reopens.")
}

func TestApprovalRoles(t *testing.T) {
	for role, ok := range map[string]bool{"owner": true, "admin": true, "finance": false, "manager": false, "investor": false} {
		if CanSignOwnerLevel(role) != ok {
			t.Errorf("%s signs the owner level: %v", role, !ok)
		}
	}
}

func TestOwnerStayAllowance(t *testing.T) {
	f := seed(t)
	lumbung := contract(f, "ct-lumbung")
	lumbung.Start, lumbung.End = "2026-01-15", "2029-01-14"
	pending := []StayRequest{{StayInput: StayInput{ContractID: "ct-lumbung", CheckIn: "2026-12-21", CheckOut: "2026-12-26"}, ID: "osr-2", Status: StayPending}}
	err := ValidateStay(StayInput{ContractID: "ct-lumbung", CheckIn: "2026-12-01", CheckOut: "2027-01-02", Guests: 2}, lumbung, pending, "2026-11-06")
	message(t, err, "The contract allows 30 owner nights in 2026; 5 are taken or asked for, so 25 remain.")
	if err := ValidateStay(StayInput{ContractID: "ct-lumbung", CheckIn: "2026-12-01", CheckOut: "2026-12-04", Guests: 2}, lumbung, pending, "2026-11-06"); err != nil {
		t.Fatal(err)
	}
	code(t, ValidateStay(StayInput{CheckIn: "2026-11-01", CheckOut: "2026-11-04", Guests: 2}, lumbung, nil, "2026-11-06"), "OWNER_STAY_DATES")
	code(t, ValidateStay(StayInput{CheckIn: "2026-12-04", CheckOut: "2026-12-01", Guests: 2}, lumbung, nil, "2026-11-06"), "OWNER_STAY_DATES")
	code(t, ValidateStay(StayInput{CheckIn: "2026-12-01", CheckOut: "2026-12-04", Guests: 0}, lumbung, nil, "2026-11-06"), errs.CodeValidation)
	if n := OwnerNightsUsed(pending, "ct-lumbung", "2026", ""); n != 5 {
		t.Fatalf("used %d", n)
	}
}

func TestValidateContract(t *testing.T) {
	f := seed(t)
	in := contract(f, "ct-karang").ContractInput
	if err := ValidateContract(in, f.Contracts, "ct-karang"); err != nil {
		t.Fatal(err)
	}
	message(t, ValidateContract(in, f.Contracts, ""), "Another contract covers this villa on some of those dates.")
	bad := in
	bad.FeePct, bad.PayoutDay = 120, 30
	message(t, ValidateContract(bad, f.Contracts, "ct-karang"), "A fee between 0 and 100 percent.")
	bad = in
	bad.FixedMonthlyFee = 10.5
	message(t, ValidateContract(bad, f.Contracts, "ct-karang"), "Whole rupiah, zero or more.")
}

func TestNightCharges(t *testing.T) {
	override := int64(1_000_000)
	s := Stay{CheckIn: "2026-10-30", ListRates: []int64{900_000, 900_000, 1_100_000}, RateOverride: &override, Discount: &Discount{Kind: "percent", Value: 10}}
	if got := s.ChargedBetween("2026-10-01", "2026-11-01"); got != 1_800_000 {
		t.Fatalf("October nights %d", got)
	}
	if got := s.ChargedBetween("2026-11-01", "2026-12-01"); got != 900_000 {
		t.Fatalf("November night %d", got)
	}
}

// segmentOf: Airbnb by source whatever the group, corporate by the group's source, else direct.
func TestStaySegment(t *testing.T) {
	cases := []struct {
		source, group, want string
	}{
		{"airbnb", "corporate", "airbnb"},
		{"direct", "corporate", "corporate"},
		{"direct", "agent", "direct"},
		{"direct", "", "direct"},
	}
	for _, c := range cases {
		if got := (Stay{Source: c.source}).Segment(c.group); got != c.want {
			t.Errorf("%s in a %q group: %s, want %s", c.source, c.group, got, c.want)
		}
	}
}
