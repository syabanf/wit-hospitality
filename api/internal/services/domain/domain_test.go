package domain

import (
	"regexp"
	"slices"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Cases ported from src/domain/serviceOrder.test.ts and roomService.test.ts.

func ptr[T any](v T) *T { return &v }

func line(f func(*OrderLine)) OrderLine {
	l := OrderLine{ItemID: "mi-x", Name: "Item", Category: "food", Unit: "item", Price: 100_000, Quantity: 1}
	if f != nil {
		f(&l)
	}
	return l
}

func order(f func(*ServiceOrder)) ServiceOrder {
	o := ServiceOrder{
		ID: "so-1", Number: "SO-701", BookingID: "bk-1", UnitID: "unit-sk-01", VillaID: "vil-saka", RequestedOn: "2026-10-05",
		RequestedAt: 12 * 60, Priority: "normal", Status: OrderDelivered, PlacedBy: "staff", CreatedOn: "2026-10-05",
		DeliveredOn: ptr("2026-10-05"), DeliveredAt: ptr(12*60 + 10), CostTransactionIDs: []string{}, History: []OrderEvent{},
	}
	if f != nil {
		f(&o)
	}
	return o
}

func item(f func(*MenuItem)) MenuItem {
	m := MenuItem{ID: "mi-x", VillaID: "vil-saka", Category: "food", Name: "Nasi goreng", Price: 75_000, Unit: "item",
		AvailableFrom: 10 * 60, AvailableTo: 22 * 60, LeadMinutes: 30, Active: true}
	if f != nil {
		f(&m)
	}
	return m
}

func code(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	return ""
}

func fields(err error) map[string]string {
	if e, ok := errs.As(err); ok {
		return errs.Fields(e.Fields).Map()
	}
	return map[string]string{}
}

func TestTotalsChargeMenuPriceLessCompsAndDiscountAndKeepPartnerCostApart(t *testing.T) {
	o := order(func(o *ServiceOrder) {
		o.Lines = []OrderLine{
			line(func(l *OrderLine) {
				l.Price, l.Quantity, l.CostPrice, l.PartnerID, l.Category = 300_000, 2, 180_000, ptr("ptn-spa"), "spa"
			}),
			line(func(l *OrderLine) { l.Price, l.Comp, l.Category = 450_000, true, "extras" }),
		}
		o.DiscountPct = 10
	})
	if got, want := o.Totals(), (Totals{Gross: 1_050_000, Comp: 450_000, Discount: 60_000, Charge: 540_000, Cost: 360_000, Margin: 180_000}); got != want {
		t.Fatalf("totals %+v, want %+v", got, want)
	}
	bills := PartnerCosts(o)
	if len(bills) != 1 || bills[0].PartnerID != "ptn-spa" || bills[0].Amount != 360_000 {
		t.Fatalf("partner costs %+v", bills)
	}
}

func TestRevenueSplitLosesNoRupiah(t *testing.T) {
	o := order(func(o *ServiceOrder) {
		o.Lines = []OrderLine{
			line(func(l *OrderLine) { l.Price, l.Quantity, l.Category = 120_000, 2, "breakfast" }),
			line(func(l *OrderLine) { l.Price, l.Quantity, l.Category = 45_000, 3.5, "laundry" }),
			line(func(l *OrderLine) { l.Price, l.Category = 35_000, "food" }),
		}
		o.DiscountPct = 15
	})
	split := RevenueSplit(o)
	var sum int64
	var keys []string
	for _, s := range split {
		sum += s.Amount
		keys = append(keys, s.Key)
	}
	slices.Sort(keys)
	if sum != o.Totals().Charge || !slices.Equal(keys, []string{"cat-svc-fnb", "cat-svc-laundry"}) {
		t.Fatalf("split %+v, charge %d", split, o.Totals().Charge)
	}
	codes := CodeSplit(o)
	if len(codes) != 2 || codes[0].Key != "FNB" || codes[1].Key != "LDRY" || codes[0].Amount+codes[1].Amount != o.Totals().Charge {
		t.Fatalf("codes %+v", codes)
	}
}

func TestDeliveredOrdersAreBilledAndSettleWithTheirPayment(t *testing.T) {
	open := order(func(o *ServiceOrder) { o.Status, o.Lines = OrderPreparing, []OrderLine{line(nil)} })
	unpaid := order(func(o *ServiceOrder) {
		o.ID, o.Lines = "so-2", []OrderLine{line(func(l *OrderLine) { l.Price = 90_000 })}
	})
	paid := order(func(o *ServiceOrder) {
		o.ID, o.Lines, o.PaymentID = "so-3", []OrderLine{line(func(l *OrderLine) { l.Price = 50_000 })}, ptr("pay-1")
	})
	free := order(func(o *ServiceOrder) { o.ID, o.Lines = "so-4", []OrderLine{line(func(l *OrderLine) { l.Comp = true })} })
	statusOf := func(id *string) string {
		if id != nil && *id == "pay-1" {
			return "paid"
		}
		return ""
	}
	var states []string
	for _, o := range []ServiceOrder{open, unpaid, paid, free} {
		states = append(states, PayState(o, statusOf(o.PaymentID)))
	}
	if !slices.Equal(states, []string{PayNotDue, PayUnpaid, PayPaid, PayFree}) {
		t.Fatalf("pay states %v", states)
	}
	f := StayFolio([]ServiceOrder{open, unpaid, paid, free}, statusOf)
	if f.Charged != 140_000 || f.Paid != 50_000 || f.Outstanding != 90_000 {
		t.Fatalf("folio %+v", f)
	}
}

func TestItemsServeInsideTheirHoursAndAskForNotice(t *testing.T) {
	if !AvailableAt(22*60, 2*60, 60) || AvailableAt(22*60, 2*60, 12*60) {
		t.Fatal("an overnight window runs past midnight")
	}
	cases := []struct {
		item          MenuItem
		on            string
		at, now       int
		code, message string
	}{
		{item(nil), "2026-10-05", 8 * 60, 7 * 60, CodeItemUnavailable, "Nasi goreng is served 10:00 to 22:00."},
		{item(nil), "2026-10-05", 12 * 60, 11*60 + 50, CodeItemLeadTime, "Nasi goreng needs 30 min notice; pick 12:20 or later."},
		{item(nil), "2026-10-06", 12 * 60, 11*60 + 50, "", ""},
		{item(func(m *MenuItem) { m.Active = false }), "2026-10-06", 12 * 60, 0, CodeItemUnavailable, "Nasi goreng is off the menu."},
		{item(nil), "2026-10-04", 12 * 60, 0, errs.CodeValidation, "Pick a time from now on."},
	}
	for _, c := range cases {
		err := ItemProblem(c.item, c.on, c.at, "2026-10-05", c.now, false)
		if code(err) != c.code || (err != nil && err.(*errs.Error).Message != c.message) {
			t.Errorf("%s at %d: %v, want %s %q", c.on, c.at, err, c.code, c.message)
		}
	}
	if HoursLabel(0, 24*60-1) != "Any time" || LeadLabel(90) != "1 h 30 min notice" || LeadLabel(12*60) != "12 h notice" || LeadLabel(0) != "No notice" {
		t.Fatal("labels")
	}
}

func TestVillaStaysOrderOnRequestItemsAtAnyHour(t *testing.T) {
	onRequest := item(func(m *MenuItem) { m.VillaOnRequest = true })
	if err := ItemProblem(onRequest, "2026-10-06", 23*60, "2026-10-05", 0, true); err != nil {
		t.Fatalf("a villa stay orders outside the hours: %v", err)
	}
	if code(ItemProblem(onRequest, "2026-10-06", 23*60, "2026-10-05", 0, false)) != CodeItemUnavailable {
		t.Fatal("a room stay keeps the hours")
	}
	if code(ItemProblem(item(nil), "2026-10-06", 23*60, "2026-10-05", 0, true)) != CodeItemUnavailable {
		t.Fatal("an item not on request keeps its hours for a villa")
	}
	in := MenuItemInput{VillaID: "v", Category: "food", Name: "Chef", Unit: "item", VillaOnRequest: true}
	var m MenuItem
	m.Apply(in)
	if !m.VillaOnRequest {
		t.Fatal("the form sets villaOnRequest")
	}
}

func TestSetupsBecomeRequestsForTheHost(t *testing.T) {
	pickup := SetupRequest("airport_pickup", "unit-1", "bk-1", "2026-10-07")
	if pickup.Kind != "transfer" || pickup.Charge != 0 || *pickup.BookingID != "bk-1" || ValidateServiceRequest(pickup) != nil {
		t.Fatalf("pickup %+v", pickup)
	}
	bbq := SetupRequest("bbq", "unit-1", "bk-1", "2026-10-07")
	if bbq.Kind != "other" || bbq.Note != "BBQ, asked before arrival on 2026-10-07" || ValidateServiceRequest(bbq) != nil {
		t.Fatalf("bbq %+v", bbq)
	}
}

func TestOrdersTakeStaysInHouseOrArrivingWithinThreeDays(t *testing.T) {
	cases := []struct {
		status, checkIn string
		want            bool
	}{
		{"checked_in", "2026-10-01", true},
		{"confirmed", "2026-10-08", true},
		{"confirmed", "2026-10-12", false},
		{"checked_out", "2026-10-01", false},
	}
	for _, c := range cases {
		if OrderableStay(c.status, c.checkIn, "2026-10-05") != c.want {
			t.Errorf("%s %s", c.status, c.checkIn)
		}
	}
}

func TestAnOpenOrderIsLateHalfAnHourPastItsTime(t *testing.T) {
	o := order(func(o *ServiceOrder) { o.Status = OrderConfirmed })
	if OrderLate(o, "2026-10-05", 12*60+30) || !OrderLate(o, "2026-10-05", 12*60+31) {
		t.Fatal("late after the SLA")
	}
	o.Status = OrderDelivered
	if OrderLate(o, "2026-10-05", 23*60) {
		t.Fatal("a delivered order is never late")
	}
	if d := DeliveryDelay(order(nil)); d == nil || *d != 10 {
		t.Fatalf("delay %v", d)
	}
}

func TestValidatesOrdersAndMenuItems(t *testing.T) {
	base := OrderInput{RequestedOn: "2026-10-05", RequestedAt: 600}
	if fields(ValidateOrder(base))["lines"] != "Add at least one item." {
		t.Fatal("no lines")
	}
	in := base
	in.Lines = []OrderLineInput{{ItemID: "a", Quantity: 2.55}}
	if fields(ValidateOrder(in))["lines"] != "Quantities run from 0.1 to 50, in steps of 0.1." {
		t.Fatal("2.55")
	}
	in.Lines = []OrderLineInput{{ItemID: "a", Quantity: 3.5}}
	if err := ValidateOrder(in); err != nil {
		t.Fatalf("3.5: %v", err)
	}
	in.Lines = []OrderLineInput{{ItemID: "a", Quantity: 1, Comp: true}}
	if fields(ValidateOrder(in))["compReason"] != "Say why it is on the house." {
		t.Fatal("comp reason")
	}
	in.Lines, in.DiscountPct = []OrderLineInput{{ItemID: "a", Quantity: 1}}, 20
	if fields(ValidateOrder(in))["discountReason"] != "Say why the order is discounted." {
		t.Fatal("discount reason")
	}
	m := MenuItemInput{VillaID: "vil-saka", Category: "food", Name: "Nasi goreng", Price: 75_000, Unit: "item", AvailableFrom: 600, AvailableTo: 1320, LeadMinutes: 30, CostPrice: 100_000}
	if fields(ValidateMenuItem(m))["partnerId"] != "Pick the partner who bills that cost." {
		t.Fatal("cost without partner")
	}
	m.Price = 1.5
	if err := ValidateMenuItem(m); err == nil || err.Error() != "VALIDATION_ERROR: Enter the price in whole rupiah, or zero." {
		t.Fatalf("fraction: %v", err)
	}
	if err := ValidatePartner(PartnerInput{Name: "Taksu", Kind: "spa", Phone: "12"}); fields(err)["phone"] != "Enter a phone number with the country code." {
		t.Fatalf("phone: %v", err)
	}
}

func TestOneStableRoomSpecificTokenPerQRCard(t *testing.T) {
	if OrderToken("SK-01") == OrderToken("SK-02") {
		t.Fatal("each room has its own token")
	}
	if !regexp.MustCompile(`^sk-01-[a-z0-9]+$`).MatchString(OrderToken("SK-01")) {
		t.Fatalf("token %s", OrderToken("SK-01"))
	}
	// The tokens orderTokenFor prints, so a QR card printed from the console opens the same room.
	for code, want := range map[string]string{"SK-01": "sk-01-1b43s", "TR-04": "tr-04-cae9t", "KR-03": "kr-03-1wzyt", "LB-02": "lb-02-9smc2"} {
		if got := OrderToken(code); got != want {
			t.Errorf("%s: %s, want %s", code, got, want)
		}
	}
}

func TestOrderStepsAndVoidGuard(t *testing.T) {
	o := order(func(o *ServiceOrder) { o.Status = OrderNew })
	if err := o.CheckStep(OrderDelivered, ""); code(err) != CodeOrderState || err.(*errs.Error).Message != "A new order cannot become delivered." {
		t.Fatalf("new to delivered: %v", err)
	}
	if err := o.CheckStep(OrderCancelled, "no"); err == nil || err.(*errs.Error).Message != "Say why the order is cancelled." {
		t.Fatalf("cancel without reason: %v", err)
	}
	o.Step(OrderConfirmed, "", "Wayan", "2026-10-05T09:00:00", "2026-10-05", 540)
	o.Step(OrderDelivered, "", "Wayan", "2026-10-05T09:30:00", "2026-10-05", 570)
	if o.Status != OrderDelivered || *o.DeliveredAt != 570 || len(o.History) != 2 {
		t.Fatalf("stepped %+v", o)
	}
	if err := o.CheckVoid("2026-10-06", PayUnpaid, false, nil); code(err) != CodeVoidDayClosed {
		t.Fatalf("closed day: %v", err)
	}
	if err := o.CheckVoid("2026-10-05", PayPaid, false, nil); code(err) != CodeOrderVoidPaid {
		t.Fatalf("paid: %v", err)
	}
	if err := o.CheckVoid("2026-10-05", PayUnpaid, false, []CostBill{{TransactionID: "tx-1", Status: "approved"}}); err != nil {
		t.Fatalf("void: %v", err)
	}
	err := o.CheckVoid("2026-10-05", PayUnpaid, false, []CostBill{{TransactionID: "tx-1", Status: "approved"}, {TransactionID: "tx-2", Status: BillPosted}})
	if code(err) != CodeOrderVoidPaid || err.(*errs.Error).Message != "A partner bill of SO-701 is already paid; post a rebate instead." {
		t.Fatalf("partner bill paid: %v", err)
	}
}

// costTransactionIds follows partnerCosts: the first partner's bill first, whatever order finance
// answered in.
func TestCostTransactionIDsFollowThePartners(t *testing.T) {
	spa, driver := "ptn-spa", "ptn-driver"
	o := order(func(o *ServiceOrder) {
		o.Lines = []OrderLine{
			line(func(l *OrderLine) { l.PartnerID, l.CostPrice = &spa, 50_000 }),
			line(func(l *OrderLine) { l.ItemID = "mi-free" }),
			line(func(l *OrderLine) { l.ItemID = "mi-car"; l.PartnerID, l.CostPrice = &driver, 80_000 }),
		}
	})
	got := CostTransactionIDs(o, []CostBill{{TransactionID: "tx-9", PartnerID: driver}, {TransactionID: "tx-8", PartnerID: spa}})
	if !slices.Equal(got, []string{"tx-8", "tx-9"}) {
		t.Fatalf("ids %v", got)
	}
}

func TestSortOrdersPutsLiveUrgentWorkFirst(t *testing.T) {
	list := []ServiceOrder{
		order(func(o *ServiceOrder) { o.ID = "done-early"; o.RequestedAt = 600 }),
		order(func(o *ServiceOrder) { o.ID = "done-late"; o.RequestedAt = 900 }),
		order(func(o *ServiceOrder) { o.ID, o.Status, o.RequestedAt = "late", OrderConfirmed, 900 }),
		order(func(o *ServiceOrder) { o.ID, o.Status, o.RequestedAt = "early", OrderPreparing, 600 }),
		order(func(o *ServiceOrder) { o.ID, o.Status, o.Priority = "urgent", OrderConfirmed, "urgent" }),
		order(func(o *ServiceOrder) { o.ID, o.Status = "new", OrderNew }),
	}
	var ids []string
	for _, o := range SortOrders(list) {
		ids = append(ids, o.ID)
	}
	if !slices.Equal(ids, []string{"new", "urgent", "early", "late", "done-late", "done-early"}) {
		t.Fatalf("order %v", ids)
	}
}

func TestRequestsWalkForwardAndNeverBack(t *testing.T) {
	if NextServiceStep(RequestOpen) != RequestInProgress || NextServiceStep(RequestInProgress) != RequestDone || NextServiceStep(RequestDone) != "" {
		t.Fatal("next step")
	}
	r := ServiceRequest{Number: "RQ-1", Status: RequestDone}
	if err := r.Transition(RequestInProgress, "2026-10-05"); code(err) != CodeRequestState || err.(*errs.Error).Message != "A done request cannot become in progress." {
		t.Fatalf("done to in progress: %v", err)
	}
	if err := r.CanEdit(); err == nil || err.(*errs.Error).Message != "RQ-1 is done; it can no longer change." {
		t.Fatalf("edit done: %v", err)
	}
	r.Status = RequestOpen
	if err := r.Transition(RequestDone, "2026-10-05"); err != nil || *r.DoneOn != "2026-10-05" {
		t.Fatalf("open to done: %v", err)
	}
}

func TestRequestsNeedANoteForOtherAndAWholeCharge(t *testing.T) {
	f := fields(ValidateServiceRequest(ServiceRequestInput{Kind: "other", Charge: -1}))
	if f["unitId"] == "" || f["note"] == "" || f["charge"] == "" {
		t.Fatalf("fields %v", f)
	}
	if err := ValidateServiceRequest(ServiceRequestInput{UnitID: "u1", Kind: "towels"}); err != nil {
		t.Fatal(err)
	}
}

func TestSortRequestsPutsLiveWorkFirst(t *testing.T) {
	req := func(id, status, priority string, at int) ServiceRequest {
		return ServiceRequest{ID: id, Status: status, Priority: priority, RequestedOn: "2026-10-05", RequestedAt: at}
	}
	list := []ServiceRequest{req("done", RequestDone, "normal", 540), req("late-open", RequestOpen, "normal", 600), req("urgent-open", RequestOpen, "urgent", 700), req("doing", RequestInProgress, "normal", 540)}
	var ids []string
	for _, r := range SortRequests(list) {
		ids = append(ids, r.ID)
	}
	if !slices.Equal(ids, []string{"doing", "urgent-open", "late-open", "done"}) {
		t.Fatalf("order %v", ids)
	}
}
