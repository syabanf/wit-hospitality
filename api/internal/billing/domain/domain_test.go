package domain

import (
	"reflect"
	"slices"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func eq[T any](t *testing.T, got, want T) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func code(t *testing.T, err error, want string) {
	t.Helper()
	if !errs.HasCode(err, want) {
		t.Fatalf("got %v, want %s", err, want)
	}
}

func field(t *testing.T, err error, names ...string) {
	t.Helper()
	e, ok := errs.As(err)
	if !ok {
		t.Fatalf("got %v, want field errors on %v", err, names)
	}
	for _, n := range names {
		if !errs.Fields(e.Fields).Has(n) {
			t.Fatalf("no field error on %s in %+v", n, e.Fields)
		}
	}
}

// tax.test.ts

func TestNetPriceAddsServiceAndPB1OnTop(t *testing.T) {
	r := DefaultTaxRates()
	s := Split(1_000_000, "ROOM", &r, ModeNet)
	eq(t, s, TaxSplit{1_000_000, 100_000, 110_000})
	eq(t, s.Gross(), int64(1_210_000))
}

func TestInclusivePriceLeavesTheRoundingOnPB1(t *testing.T) {
	r := DefaultTaxRates()
	eq(t, Split(1_210_000, "ROOM", &r, ModeInclusive), TaxSplit{1_000_000, 100_000, 110_000})
	eq(t, Split(1_000_000, "ROOM", &r, ModeInclusive), TaxSplit{826_446, 82_645, 90_909})
}

func TestEachCodeIsTaxedAsTheSettingsSay(t *testing.T) {
	r := DefaultTaxRates()
	eq(t, Split(200_000, "LDRY", &r, ModeNet), TaxSplit{200_000, 0, 20_000})
	eq(t, Split(220_000, "LDRY", &r, ModeInclusive), TaxSplit{200_000, 0, 20_000})
	eq(t, Split(350_000, "TRNS", &r, ModeNet), TaxSplit{350_000, 0, 0})
	eq(t, Split(350_000, "DMG", &r, ModeInclusive), TaxSplit{350_000, 0, 0})
}

func TestRateAndBaseFollowTheSettings(t *testing.T) {
	r := DefaultTaxRates()
	plain := r
	plain.PB1OnService = false
	eq(t, Split(1_000_000, "ROOM", &plain, ModeNet), TaxSplit{1_000_000, 100_000, 100_000})
	eleven := r
	eleven.ServicePct = 11
	eq(t, Split(1_000_000, "FNB", &eleven, ModeNet), TaxSplit{1_000_000, 110_000, 111_000})
	eq(t, Split(1_000_000, "ROOM", nil, ModeNet), TaxSplit{Net: 1_000_000})
}

func TestRoundsHalfUp(t *testing.T) {
	eq(t, []int64{RoundHalfUp(0.5), RoundHalfUp(1.49), RoundHalfUp(2.5), RoundHalfUp(-2.5)}, []int64{1, 1, 3, -3})
	r := DefaultTaxRates()
	eq(t, Split(5, "ROOM", &r, ModeNet), TaxSplit{5, 1, 1})
}

func TestRebateTakesItsShareOfTheTaxBackToTheRupiah(t *testing.T) {
	line := TaxSplit{1_000_000, 100_000, 110_000}
	first := RebateSplit(line, 0, 333_333)
	eq(t, first, TaxSplit{333_333, 33_333, 36_667})
	rest := RebateSplit(line, 333_333, 666_667)
	eq(t, first.Service+rest.Service, int64(100_000))
	eq(t, first.PB1+rest.PB1, int64(110_000))
}

func TestRatesInForceOnThePostingDate(t *testing.T) {
	r := DefaultTaxRates()
	later := r
	later.EffectiveFrom, later.ServicePct = "2026-12-01", 11
	settings := DefaultTaxSettings()
	settings.Rates = WithRates(settings, later)
	if RatesOn(&settings, "2019-12-31") != nil {
		t.Fatal("rates before the first effective date")
	}
	eq(t, RatesOn(&settings, "2026-11-30").ServicePct, 10.0)
	eq(t, RatesOn(&settings, "2026-12-01").ServicePct, 11.0)
	stay := Booking{ListRates: []int64{1_000_000, 1_000_000}, CheckIn: "2026-11-30", Status: Confirmed, PriceMode: ModeNet}
	eq(t, NightSplits(stay, &settings), []TaxSplit{{1_000_000, 100_000, 110_000}, {1_000_000, 110_000, 111_000}})
}

func TestStayWithoutModeReadsInclusive(t *testing.T) {
	out := "2026-10-02"
	settings := DefaultTaxSettings()
	st := StayTaxOf(Booking{ListRates: []int64{1_210_000}, CheckIn: "2026-10-01", Status: CheckedOut, CheckedOutOn: &out}, &settings)
	eq(t, st.Mode, ModeInclusive)
	eq(t, st.TaxSplit, TaxSplit{1_000_000, 100_000, 110_000})
	eq(t, st.Total, int64(1_210_000))
	eq(t, TaxNote(st), "Prices include 10% service and 10% PB1")
	st.Mode = ModeNet
	eq(t, TaxNote(st), "Prices exclude 10% service and 10% PB1")
}

func TestValidatesTaxSettings(t *testing.T) {
	r := DefaultTaxRates()
	r.ServicePct = 30
	field(t, ValidateTaxSettings(TaxSettingsInput{Rates: r, DirectMode: ModeNet, Regencies: map[string]string{"loc-ubud": ""}}, []string{"ROOM"}), "servicePct", "codes", "regencies")
}

func TestNewRatesMayNotStartBeforeToday(t *testing.T) {
	codes := []string{}
	for _, c := range ChargeCodes(DefaultTransactionCodes()) {
		codes = append(codes, c.Code)
	}
	codes = append(codes, "ROOM")
	r := DefaultTaxRates()
	r.EffectiveFrom, r.ServicePct = "2026-11-01", 11
	_, _, err := SaveTaxSettings(DefaultTaxSettings(), TaxSettingsInput{Rates: r, DirectMode: ModeNet}, codes, "2026-11-11")
	code(t, err, "TAX_RATES_BACKDATED")
	// The same rates on a past date only change the mode.
	same := DefaultTaxRates()
	same.EffectiveFrom = "2026-11-01"
	out, added, err := SaveTaxSettings(DefaultTaxSettings(), TaxSettingsInput{Rates: same, DirectMode: ModeInclusive}, codes, "2026-11-11")
	if err != nil || added != nil || out.DirectMode != ModeInclusive || len(out.Rates) != 1 {
		t.Fatalf("got %+v %+v %v", out, added, err)
	}
	r.EffectiveFrom = "2026-12-01"
	out, added, err = SaveTaxSettings(DefaultTaxSettings(), TaxSettingsInput{Rates: r, DirectMode: ModeNet}, codes, "2026-11-11")
	if err != nil || added == nil || len(out.Rates) != 2 {
		t.Fatalf("got %+v %+v %v", out, added, err)
	}
}

// folio.test.ts

func booking(over func(*Booking)) Booking {
	in := "2026-10-05"
	b := Booking{ID: "b1", Code: "BK-1", GuestID: "g1", UnitID: "u1", UnitAssigned: true, Source: Direct, CheckIn: "2026-10-05", CheckOut: "2026-10-08",
		ListRates: []int64{1_000_000, 1_200_000, 1_000_000}, Status: CheckedIn, CheckedInOn: &in, Arrival: &Arrival{Deposit: 500_000}}
	if over != nil {
		over(&b)
	}
	return b
}

func payment(over func(*Payment)) Payment {
	on := "2026-09-20"
	p := Payment{ID: "p1", Number: "PAY-1", BookingID: "b1", Kind: "deposit", Method: "cash", Amount: 1_000_000, Status: "paid", PaidOn: &on, CreatedBy: "Dian", CreatedOn: on}
	if over != nil {
		over(&p)
	}
	return p
}

func order(over func(*Order)) Order {
	on := "2026-10-06"
	minutes := 12*60 + 15
	o := Order{ID: "so-1", Number: "SO-701", BookingID: "b1", Lines: []OrderLine{
		{Name: "Nasi goreng", Category: "food", Price: 100_000, Quantity: 2},
		{Name: "Flowers", Category: "extras", Price: 50_000, Quantity: 1, Comp: true},
	}, RequestedOn: on, RequestedAt: 12 * 60, Status: "delivered", Assignee: "Wayan", DeliveredOn: &on, DeliveredAt: &minutes, DiscountPct: 10,
		DiscountReason: "Returning guest", CompReason: "Anniversary"}
	if over != nil {
		over(&o)
	}
	return o
}

func posting(over func(*Posting)) Posting {
	p := Posting{ID: "fp-1", BookingID: "b1", Kind: KindCharge, Code: "MINI", Description: "2 × Bintang", Amount: 150_000, Date: "2026-10-06", Part: PartCharges,
		PostedBy: "Wayan", PostedByID: "usr-wayan", PostedAt: "2026-10-06T21:00:00"}
	if over != nil {
		over(&p)
	}
	return p
}

func find(lines []FolioLine, keep func(FolioLine) bool) []FolioLine { return filterLines(lines, keep) }

func TestSideComesFromTheKind(t *testing.T) {
	eq(t, []string{Side(KindRoom), Side(KindRefund), Side(KindRebate), Side(KindPayment), Side(KindDeposit)}, []string{"debit", "debit", "credit", "credit", "memo"})
}

func TestAuditedNightsPostAndTheRestForecast(t *testing.T) {
	b := booking(func(b *Booking) {
		b.Discount = &Discount{Kind: "amount", Value: 200_000, Per: "stay"}
		b.NightsPosted = &[]string{"2026-10-05", "2026-10-06"}
	})
	f := Folio(FolioSources{Booking: b,
		Payments: []Payment{payment(nil), payment(func(p *Payment) { p.ID, p.Number, p.Status, p.Amount = "p2", "PAY-2", "pending", 2_000_000 })},
		Orders:   []Order{order(nil)},
		Postings: []Posting{posting(nil), posting(func(p *Posting) {
			p.ID, p.Kind, p.LineID, p.Description, p.Amount, p.PostedAt = "fp-2", KindRebate, str("fp-1"), "Fridge was warm", 50_000, "2026-10-06T22:00:00"
		})},
	})
	nights := find(f.Lines, func(l FolioLine) bool { return l.Kind == KindRoom })
	type night struct {
		debit    int64
		forecast bool
		by       string
	}
	var got []night
	var total int64
	for _, l := range nights {
		got = append(got, night{l.Debit, l.Forecast, l.PostedBy})
		total += l.Debit
		eq(t, l.Code, RoomCode)
	}
	eq(t, got, []night{{937_500, false, "Night audit"}, {1_125_000, false, "Night audit"}, {937_500, true, "Console"}})
	eq(t, total, int64(3_000_000))
	eq(t, f.Forecast, int64(937_500))
	eq(t, len(find(f.Lines, func(l FolioLine) bool { return l.Kind == KindDiscount && l.Part == PartRoom })), 0)
	var rs [][2]any
	for _, l := range find(f.Lines, func(l FolioLine) bool { return l.Kind == KindRoomService }) {
		rs = append(rs, [2]any{l.Code, l.Debit})
	}
	eq(t, rs, [][2]any{{"FNB", int64(200_000)}, {"XTRA", int64(50_000)}})
	comp := find(f.Lines, func(l FolioLine) bool { return l.Kind == KindComp })[0]
	eq(t, [2]any{comp.Code, comp.Credit}, [2]any{"XTRA", int64(50_000)})
	disc := find(f.Lines, func(l FolioLine) bool { return l.Kind == KindDiscount && l.Part == PartOrders })[0]
	eq(t, [2]any{disc.Code, disc.Credit}, [2]any{"FNB", int64(20_000)})
	pays := find(f.Lines, func(l FolioLine) bool { return l.Kind == KindPayment })
	eq(t, len(pays), 1)
	eq(t, pays[0].Code, "CASH")
	dep := find(f.Lines, func(l FolioLine) bool { return l.Kind == KindDeposit })[0]
	eq(t, [3]int64{dep.Debit, dep.Credit, dep.Memo}, [3]int64{0, 0, 500_000})
	eq(t, f.DepositHeld, int64(500_000))
	eq(t, f.Due, FolioDue{Room: 2_000_000, Orders: []OrderDue{{"so-1", 180_000}}, Charges: 100_000})
	eq(t, f.Balance, f.Debits-f.Credits)
	eq(t, f.Estimated, f.Balance+f.Forecast)
	eq(t, f.Estimated, f.Owed())
	eq(t, f.Lines[len(f.Lines)-1].Balance, f.Balance)

	b.Status, b.CheckedOutOn = CheckedOut, str("2026-10-08")
	out := Folio(FolioSources{Booking: b})
	var by []string
	for _, l := range find(out.Lines, func(l FolioLine) bool { return l.Kind == KindRoom }) {
		if l.Forecast {
			t.Fatal("a night is still a forecast after check-out")
		}
		by = append(by, l.PostedBy)
	}
	eq(t, by, []string{"Night audit", "Night audit", "Check-out"})
	eq(t, out.Forecast, int64(0))
}

func TestPaidOrdersRefundsAndChargesTakenAtCheckOut(t *testing.T) {
	b := booking(func(b *Booking) {
		b.Status, b.CheckedOutOn = CheckedOut, str("2026-10-08")
		b.Departure = &Departure{DepositReturned: 500_000, ExtraCharges: 75_000, RoomInspected: true, KeysReturned: true, Notes: "Late check-out"}
	})
	f := Folio(FolioSources{Booking: b,
		Payments: []Payment{payment(func(p *Payment) { p.Amount = 3_200_000 }),
			payment(func(p *Payment) { p.ID, p.Number, p.Kind, p.Amount, p.PaidOn = "p3", "PAY-3", "refund", 100_000, str("2026-10-07") }),
			payment(func(p *Payment) {
				p.ID, p.Number, p.Kind, p.Amount, p.OrderIDs, p.PaidOn = "p4", "PAY-4", "extra", 180_000, []string{"so-1"}, str("2026-10-06")
			})},
		Orders:   []Order{order(nil)},
		Postings: []Posting{posting(func(p *Posting) { p.TransactionID = str("tx-9") })},
	})
	eq(t, f.Due, FolioDue{Room: 100_000, Orders: []OrderDue{}, Charges: 0})
	var credits []int64
	for _, l := range find(f.Lines, func(l FolioLine) bool { return l.Kind == KindPayment && l.Part == PartCharges }) {
		credits = append(credits, l.Credit)
	}
	slices.Sort(credits)
	eq(t, credits, []int64{75_000, 150_000})
	eq(t, find(f.Lines, func(l FolioLine) bool { return l.Memo < 0 })[0].Memo, int64(-500_000))
}

func TestAirbnbStayBillsTheRoomToAirbnb(t *testing.T) {
	f := Folio(FolioSources{Booking: booking(func(b *Booking) { b.Source, b.AirbnbFee = "airbnb", 90_000 }),
		Payments: []Payment{payment(func(p *Payment) { p.Kind, p.Method, p.Amount = "payout", "airbnb_payout", 3_110_000 })},
		Postings: []Posting{posting(nil)}})
	eq(t, find(f.Lines, func(l FolioLine) bool { return l.Kind == KindChannel })[0].Credit, int64(3_200_000))
	eq(t, len(find(f.Lines, func(l FolioLine) bool { return l.Ref.Type == "payment" })), 0)
	eq(t, f.Due, FolioDue{Room: 0, Orders: []OrderDue{}, Charges: 150_000})
}

func TestCancelledStayKeepsWhatWasNotRefunded(t *testing.T) {
	f := Folio(FolioSources{Booking: booking(func(b *Booking) { b.Status = Cancelled }),
		Payments: []Payment{payment(func(p *Payment) { p.Status = "refunded" }), payment(func(p *Payment) { p.ID, p.Kind, p.Amount = "p2", "refund", 700_000 })}})
	eq(t, find(f.Lines, func(l FolioLine) bool { return l.Kind == KindRoom })[0].Debit, int64(300_000))
	eq(t, f.Balance, int64(0))
}

func TestChargesAndRebatesAreChecked(t *testing.T) {
	field(t, ValidateCharge(ChargeInput{Code: "ROOM"}, DefaultTransactionCodes()), "code", "description", "amount")
	f := Folio(FolioSources{Booking: booking(nil), Orders: []Order{order(nil)}, Postings: []Posting{posting(func(p *Posting) { p.Amount = 500_000 })}})
	charge := TargetOf(f.Lines, "fp-1")
	eq(t, [2]int64{charge.Net, charge.Open}, [2]int64{500_000, 500_000})
	field(t, ValidateRebate(RebateInput{LineID: "fp-1", Amount: 600_000, Reason: "Noise"}, charge), "amount")
	field(t, ValidateRebate(RebateInput{LineID: "fp-1", Amount: 50_000}, charge), "reason")
	field(t, ValidateRebate(RebateInput{LineID: "so-1-FNB-comp", Amount: 50_000, Reason: "Noise"}, TargetOf(f.Lines, "so-1-FNB-comp")), "lineId")
	eq(t, RebateBeyondLimit(*charge, 50_000, 10), false)
	eq(t, RebateBeyondLimit(*charge, 60_000, 10), true)
	fnb := TargetOf(f.Lines, "so-1-FNB")
	eq(t, [2]int64{fnb.Net, fnb.Open}, [2]int64{180_000, 180_000})
}

func TestRebateAfterThePaymentOwesARefund(t *testing.T) {
	paid := payment(func(p *Payment) {
		p.ID, p.Number, p.Kind, p.Amount, p.OrderIDs, p.PaidOn = "p4", "PAY-4", "extra", 180_000, []string{"so-1"}, str("2026-10-06")
	})
	rebate := posting(func(p *Posting) {
		p.ID, p.Kind, p.Code, p.Part, p.LineID, p.OrderID, p.Amount, p.Description = "fp-2", KindRebate, "FNB", PartOrders, str("so-1-FNB"), str("so-1"), 60_000, "Cold food"
	})
	f := Folio(FolioSources{Booking: booking(nil), Payments: []Payment{paid}, Orders: []Order{order(nil)}, Postings: []Posting{rebate}})
	l := find(f.Lines, func(l FolioLine) bool { return l.ID == "fp-2" })[0]
	eq(t, [5]any{l.Kind, l.Code, l.Part, *l.OrderID, *l.Of}, [5]any{KindRebate, "FNB", PartOrders, "so-1", "so-1-FNB"})
	eq(t, l.Credit, int64(60_000))
	target := TargetOf(f.Lines, "so-1-FNB")
	eq(t, [2]int64{target.Rebated, target.Open}, [2]int64{60_000, 120_000})
	eq(t, f.RefundDue, int64(60_000))
	eq(t, Refundable(f, paid, 0), int64(60_000))
	back := payment(func(p *Payment) {
		p.ID, p.Number, p.Kind, p.Amount, p.OrderIDs, p.RefundOf = "p5", "PAY-5", "refund", 60_000, []string{"so-1"}, str("p4")
	})
	after := Folio(FolioSources{Booking: booking(nil), Payments: []Payment{paid, back}, Orders: []Order{order(nil)}, Postings: []Posting{rebate}})
	r := find(after.Lines, func(l FolioLine) bool { return l.Kind == KindRefund })[0]
	eq(t, [3]any{r.Part, *r.OrderID, r.Debit}, [3]any{PartOrders, "so-1", int64(60_000)})
	eq(t, after.RefundDue, int64(0))
}

func TestChargeCarriesServiceAndPB1Lines(t *testing.T) {
	settings := DefaultTaxSettings()
	split := Split(150_000, "MINI", RatesOn(&settings, "2026-10-06"), ModeNet)
	f := Folio(FolioSources{Booking: booking(nil), Tax: &settings, Postings: []Posting{posting(func(p *Posting) { p.Service, p.PB1 = &split.Service, &split.PB1 })}})
	svc := find(f.Lines, func(l FolioLine) bool { return l.ID == "fp-1-svc" })[0]
	pb1 := find(f.Lines, func(l FolioLine) bool { return l.ID == "fp-1-pb1" })[0]
	eq(t, [2]int64{svc.Debit, pb1.Debit}, [2]int64{15_000, 16_500})
	eq(t, [2]string{svc.Code, *svc.Of}, [2]string{ServiceCode, "fp-1"})
	target := TargetOf(f.Lines, "fp-1")
	back := RebateTax(f.Lines, *target, 150_000)
	eq(t, back, TaxSplit{150_000, 15_000, 16_500})
}

// nightAudit.ts

func TestAuditRefusesARerunAnotherDateAndADayNotStarted(t *testing.T) {
	code(t, AuditProblem("2026-11-10", "2026-11-11", "2026-11-11", []string{"2026-11-10"}), "AUDIT_ALREADY_RUN")
	code(t, AuditProblem("2026-11-09", "2026-11-11", "2026-11-11", nil), "AUDIT_DATE")
	code(t, AuditProblem("2026-11-12", "2026-11-12", "2026-11-11", nil), "AUDIT_TOO_EARLY")
	if err := AuditProblem("2026-11-11", "2026-11-11", "2026-11-11", nil); err != nil {
		t.Fatal(err)
	}
}

func TestAuditPostsEveryNightNotPostedUpToTheDate(t *testing.T) {
	b := booking(nil)
	eq(t, NightsToPost(b, "2026-10-06"), []int{0, 1})
	b.NightsPosted = &[]string{"2026-10-05"}
	eq(t, NightsToPost(b, "2026-10-06"), []int{1})
	eq(t, NightsAmount(b, []int{1}), int64(1_200_000))
	b.Status = Confirmed
	eq(t, len(NightsToPost(b, "2026-10-06")), 0)
}

// cashier.ts

func TestDrawerCountAndShiftRules(t *testing.T) {
	c := CountFor(1_234_500)
	eq(t, CountTotal(c), int64(1_234_500))
	code(t, ValidateCount(DrawerCount{Notes: map[string]float64{"100000": -1}}), errs.CodeValidation)
	counted := int64(500_000)
	open := Shift{ID: "cs-1", Number: "SH-0001", AccountID: "box", CashierID: "u1", CashierName: "Wayan", Status: ShiftOpen}
	code(t, OpenProblem("box", []Shift{open}, true, false, nil), "SHIFT_ALREADY_OPEN")
	code(t, OpenProblem("other", nil, false, false, nil), "SHIFT_NOT_ROSTERED")
	code(t, CloseProblem(open, 20_000, "", DefaultShiftPolicy), "SHIFT_REASON_REQUIRED")
	if err := CloseProblem(open, 10_000, "", DefaultShiftPolicy); err != nil {
		t.Fatal(err)
	}
	closed := open
	closed.Status, closed.Counted = ShiftAwaiting, &counted
	code(t, SignOffProblem(closed, "u1"), "SHIFT_SELF_SIGNOFF")
	code(t, DropProblem(open, 1), "SHIFT_NOT_CLOSED")
	closed.Status = ShiftClosed
	code(t, DropProblem(closed, 600_000), errs.CodeValidation)
	if err := DropProblem(closed, 400_000); err != nil {
		t.Fatal(err)
	}
	eq(t, Money(1_250_000), "Rp 1.250.000")
}

// cityLedger.ts

func TestCreditLimitAndInvoiceFigures(t *testing.T) {
	a := Account{Name: "Bali Tours", CreditLimit: 10_000_000, Active: true, VillaIDs: []string{"vil-a"}}
	code(t, AssertBookable(a, "vil-b", "Villa B"), "CITY_LEDGER_VILLA")
	if o, err := CreditCheck(a, 6_000_000, 4_000_000, false, "", "Dian"); err != nil || o != nil {
		t.Fatalf("within the limit: %v %v", o, err)
	}
	_, err := CreditCheck(a, 6_000_000, 5_000_000, false, "", "Dian")
	code(t, err, "CREDIT_LIMIT")
	o, err := CreditCheck(a, 6_000_000, 5_000_000, true, "Long-standing partner", "Dian")
	if err != nil || o.Reason != "Long-standing partner" {
		t.Fatalf("override: %v %v", o, err)
	}
	inv := Invoice{Lines: []InvoiceLine{{Gross: 1_210_000, Service: 100_000, PB1: 110_000}}}
	inv.SetFigures(10)
	eq(t, [3]int64{inv.Gross, inv.Commission, inv.Net}, [3]int64{1_210_000, 100_000, 1_110_000})
	eq(t, InvoiceNumber("2026-11-11", []Invoice{{IssuedOn: "2026-11-01"}, {IssuedOn: "2026-10-30"}}), "CL-2026-11-002")
	eq(t, OldestFirst(500, []OpenInvoice{{"a", 300}, {"b", 400}}), []Allocation{{"a", 300}, {"b", 200}})
	code(t, AssertWriteOffLimit(500_001), "WRITE_OFF_LIMIT")
}

func TestTransferMovesTheRoomWithItsTax(t *testing.T) {
	settings := DefaultTaxSettings()
	b := booking(func(b *Booking) { b.PriceMode = ModeNet; b.Arrival = nil })
	f := Folio(FolioSources{Booking: b, Tax: &settings})
	parts := TransferParts(f, nil, "room", nil)
	eq(t, len(parts), 1)
	eq(t, parts[0].Amount, int64(3_200_000*121/100))
	eq(t, [2]int64{parts[0].Service, parts[0].PB1}, [2]int64{320_000, 352_000})
}

func TestMasterFolioMergesTheSharesOfOneBatch(t *testing.T) {
	a := booking(func(b *Booking) { b.ID, b.Code, b.Arrival = "a", "BK-A", nil })
	b := booking(func(b *Booking) { b.ID, b.Code, b.Arrival = "b", "BK-B", nil })
	pays := []Payment{
		payment(func(p *Payment) { p.ID, p.BookingID, p.Batch, p.Amount = "pa", "a", "GP-2001", 500_000 }),
		payment(func(p *Payment) { p.ID, p.BookingID, p.Batch, p.Amount = "pb", "b", "GP-2001", 700_000 }),
	}
	m := Master([]StayFolio{{a, Folio(FolioSources{Booking: a, Payments: pays})}, {b, Folio(FolioSources{Booking: b, Payments: pays})}}, pays)
	merged := filterMaster(m.Lines, func(l MasterLine) bool { return l.Kind == KindPayment })
	eq(t, len(merged), 1)
	eq(t, merged[0].Credit, int64(1_200_000))
	eq(t, merged[0].Description, "Group payment GP-2001 over BK-A, BK-B")
	eq(t, m.Due, int64(6_400_000-1_200_000))
}

func filterMaster(lines []MasterLine, keep func(MasterLine) bool) []MasterLine {
	var out []MasterLine
	for _, l := range lines {
		if keep(l) {
			out = append(out, l)
		}
	}
	return out
}

func TestGatewayArtefacts(t *testing.T) {
	token := LinkToken(7, "bk-3001")
	eq(t, token, "pl7bk300112tz")
	eq(t, VANumberFor(token), "88082453210280")
	eq(t, QRPayloadFor(token, 5)[len(QRPayloadFor(token, 5))-4:], "04A8")
	eq(t, GatewayFee("card", 1_000_000, DefaultPolicy), int64(29_000))
	eq(t, GatewayFee("virtual_account", 1_000_000, DefaultPolicy), int64(4_000))
	eq(t, DepositAmount(3_630_000, DefaultPolicy), int64(1_090_000))
}
