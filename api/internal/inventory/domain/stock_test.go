package domain_test

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Ported from src/domain/stock.test.ts.

func item(id string, edit ...func(*domain.Item)) domain.Item {
	i := domain.Item{ID: id, Code: id, Name: id, Kind: "amenity", Unit: "piece", ReorderLevel: 5, AverageCost: 1000, Active: true}
	for _, e := range edit {
		e(&i)
	}
	return i
}

func move(n int, villa, itemID string, quantity int, on string, edit ...func(*domain.Movement)) domain.Movement {
	if on == "" {
		on = "2026-10-01"
	}
	kind := domain.Issue
	if quantity > 0 {
		kind = domain.Receipt
	}
	m := domain.Movement{ID: fmt.Sprintf("m%d", n), Number: fmt.Sprintf("SM-%d", n), VillaID: villa, ItemID: itemID, Kind: kind, Quantity: quantity, UnitCost: 1000, On: on, By: "Kadek"}
	for _, e := range edit {
		e(&m)
	}
	return m
}

func str(s string) *string { return &s }

func receiptOf(unitCost int64, receiptID string) func(*domain.Movement) {
	return func(m *domain.Movement) { m.Kind, m.UnitCost, m.ReceiptID = domain.Receipt, unitCost, str(receiptID) }
}

var movements = []domain.Movement{
	move(1, "v1", "soap", 20, ""), move(2, "v1", "soap", -4, "2026-10-03"), move(3, "v2", "soap", 3, ""), move(4, "v1", "water", 10, "2026-10-02"),
}

func TestOnHandPerStoreUpToADay(t *testing.T) {
	for _, c := range []struct {
		villa, item, upTo string
		want              int
	}{{"v1", "soap", "", 16}, {"v1", "soap", "2026-10-02", 20}, {"v2", "soap", "", 3}, {"v2", "water", "", 0}} {
		if got := domain.OnHand(movements, c.villa, c.item, c.upTo); got != c.want {
			t.Errorf("OnHand(%s, %s, %q) = %d, want %d", c.villa, c.item, c.upTo, got, c.want)
		}
	}
}

func TestStoreLevelsListCarriedItemsAndFlagLow(t *testing.T) {
	items := []domain.Item{item("soap"), item("water", func(i *domain.Item) { i.ReorderLevel = 0 }), item("towel")}
	levels := domain.StoreLevels(items, movements, "v2", func(string) int64 { return 1000 }, "")
	if len(levels) != 1 || levels[0].Item.ID != "soap" || levels[0].OnHand != 3 || levels[0].Value != 3000 || !levels[0].Low {
		t.Fatalf("levels = %+v", levels)
	}
	if domain.IsLow(item("x", func(i *domain.Item) { i.ReorderLevel = 0 }), 0) || domain.IsLow(item("x"), 6) {
		t.Fatal("IsLow flags a store above its level or an item without one")
	}
}

func TestAverageMovesOnAReceipt(t *testing.T) {
	for _, c := range []struct {
		avg             int64
		held, qty       int
		unitCost, wants int64
	}{{10000, 10, 10, 12000, 11000}, {10000, 0, 5, 9000, 9000}, {10000, -2, 4, 8000, 8000}} {
		if got := domain.AverageAfterReceipt(c.avg, c.held, c.qty, c.unitCost); got != c.wants {
			t.Errorf("AverageAfterReceipt(%d, %d, %d, %d) = %d, want %d", c.avg, c.held, c.qty, c.unitCost, got, c.wants)
		}
	}
}

func buy(n, quantity int, unitCost int64, on string, villa ...string) domain.Movement {
	v := "v1"
	if len(villa) > 0 {
		v = villa[0]
	}
	return move(n, v, "soap", quantity, on, receiptOf(unitCost, fmt.Sprintf("r%d", n)))
}

func out(n, quantity int, on, kind string) domain.Movement {
	return move(n, "v1", "soap", -quantity, on, func(m *domain.Movement) { m.Kind, m.UnitCost = kind, 0 })
}

func ids(steps []domain.Step) []string {
	var out []string
	for _, s := range steps {
		out = append(out, s.Movement.ID)
	}
	return out
}

func TestReplayDriftWhenAnEarlierReceiptIsCancelled(t *testing.T) {
	// 10 @ 10,000, issue 5, 10 @ 20,000, then the first receipt is cancelled by its reversal.
	history := []domain.Movement{buy(1, 10, 10000, "2026-10-01"), out(2, 5, "2026-10-02", domain.Issue), buy(3, 10, 20000, "2026-10-03")}
	if got := domain.ReplayCost(history).Average("soap", ""); got != 16667 {
		t.Fatalf("average before the cancellation = %d, want 16667", got)
	}
	cancelled := append(append([]domain.Movement{}, history...), move(4, "v1", "soap", -10, "2026-10-04", receiptOf(10000, "r1")))
	r := domain.ReplayCost(cancelled)
	if got := r.Average("soap", ""); got != 20000 {
		t.Fatalf("average after the cancellation = %d, want 20000: it must stay inside the remaining prices", got)
	}
	if got := ids(r.Steps); !reflect.DeepEqual(got, []string{"m2", "m3"}) {
		t.Fatalf("steps = %v, want [m2 m3]", got)
	}
	if got := domain.FirstShortfall(cancelled, "v1", "soap", "2026-10-01"); got == nil || *got != (domain.Shortfall{On: "2026-10-02", Held: -5}) {
		t.Fatalf("shortfall = %+v, want 2026-10-02 at -5", got)
	}
}

func TestReplayCorrectedReceiptAverage(t *testing.T) {
	// 10 @ 10,000 plus 10 @ 20,000 corrected to 5 @ 16,000: (100,000 + 80,000) / 15.
	if got := domain.ReplayCost([]domain.Movement{buy(1, 10, 10000, "2026-10-01"), buy(2, 5, 16000, "2026-10-01")}).Average("soap", ""); got != 12000 {
		t.Fatalf("average = %d, want 12000", got)
	}
}

func TestReplayValuesAtTheDayAverage(t *testing.T) {
	history := []domain.Movement{buy(1, 10, 10000, "2026-10-01"), out(2, 4, "2026-10-02", domain.Issue), out(3, 2, "2026-10-02", domain.WriteOff)}
	before := domain.ReplayCost(history)
	after := domain.ReplayCost(append(append([]domain.Movement{}, history...), buy(4, 10, 30000, "2026-10-05")))
	for _, m := range history[1:] {
		if after.Value(m) != before.Value(m) {
			t.Errorf("a later receipt changed the value of %s: %d vs %d", m.ID, after.Value(m), before.Value(m))
		}
	}
	if got := after.Value(history[1]); got != -40000 {
		t.Errorf("issue value = %d, want -40000", got)
	}
	if got := after.Average("soap", "2026-10-02"); got != 10000 {
		t.Errorf("average on 2026-10-02 = %d, want 10000", got)
	}
	if got, want := after.Average("soap", ""), domain.Round(float64(4*10000+10*30000)/14); got != want {
		t.Errorf("current average = %d, want %d", got, want)
	}
}

func TestReplayPricesOutflowsAfterReceiptsAndKeepsOneAverageAcrossVillas(t *testing.T) {
	history := []domain.Movement{
		buy(5, 10, 10000, "2026-10-01"), out(4, 3, "2026-10-01", domain.Issue),
		move(6, "v1", "soap", -4, "2026-10-02", func(m *domain.Movement) { m.Kind = domain.Transfer }),
		move(7, "v2", "soap", 4, "2026-10-02", func(m *domain.Movement) { m.Kind = domain.Transfer }),
		move(8, "v2", "soap", 3, "2026-10-03", receiptOf(17000, "r8")),
	}
	r := domain.ReplayCost(history)
	if got := ids(r.Steps); !reflect.DeepEqual(got, []string{"m5", "m4", "m6", "m7", "m8"}) {
		t.Fatalf("steps = %v", got)
	}
	if got := r.Value(history[2]); got != -40000 {
		t.Errorf("transfer value = %d, want -40000", got)
	}
	if got, want := r.Average("soap", ""), domain.Round(float64(7*10000+3*17000)/10); got != want {
		t.Errorf("average = %d, want %d", got, want)
	}
	if got := domain.FirstShortfall(history, "v1", "soap", "2026-10-01"); got != nil {
		t.Errorf("shortfall = %+v, want none", got)
	}
}

func TestCanTakeRefusesMoreThanTheStoreHolds(t *testing.T) {
	err := domain.CanTake(item("soap"), 3, 4, "Villa Saka")
	if !errs.HasCode(err, "STOCK_SHORT") || err.(*errs.Error).Message != "Villa Saka holds 3 soap; 4 cannot leave the store." {
		t.Fatalf("err = %v", err)
	}
	if err := domain.CanTake(item("soap"), 3, 3, "Villa Saka"); err != nil {
		t.Fatal(err)
	}
}

func TestKitIssueTakesWhatIsThereAndReportsTheRest(t *testing.T) {
	held := map[string]int{"soap": 1, "water": 6}
	issue, short := domain.KitIssue(domain.Kit{Lines: []domain.Line{{ItemID: "soap", Quantity: 2}, {ItemID: "water", Quantity: 2}, {ItemID: "slippers", Quantity: 2}}}, func(id string) int { return held[id] })
	if !reflect.DeepEqual(issue, []domain.Line{{ItemID: "soap", Quantity: 1}, {ItemID: "water", Quantity: 2}}) {
		t.Errorf("issue = %v", issue)
	}
	if !reflect.DeepEqual(short, []domain.Line{{ItemID: "soap", Quantity: 1}, {ItemID: "slippers", Quantity: 2}}) {
		t.Errorf("short = %v", short)
	}
}

func TestCountVarianceAtTheCountedCost(t *testing.T) {
	c := domain.Count{Lines: []domain.CountLine{{ItemID: "soap", Expected: 10, Counted: 8, UnitCost: 1500}, {ItemID: "water", Expected: 4, Counted: 5, UnitCost: 3000}}}
	if c.Lines[0].Variance() != -2 || c.Lines[1].Variance() != 1 {
		t.Fatal("variance")
	}
	if c.VarianceValue() != 0 {
		t.Fatalf("variance value = %d, want -3000 + 3000", c.VarianceValue())
	}
}

func fields(err error) map[string]string {
	if e, ok := errs.As(err); ok {
		return errs.Fields(e.Fields).Map()
	}
	return map[string]string{}
}

func TestValidators(t *testing.T) {
	soap := domain.ItemInput{Code: "AM-SOAP", Name: "Soap", Kind: "amenity", Unit: "piece", ReorderLevel: 10, Active: true}
	if f := fields(domain.ValidateItem(soap, true)); f["code"] != "AM-SOAP is already used." {
		t.Errorf("code: %v", f)
	}
	withPar := soap
	withPar.Par = 2
	if f := fields(domain.ValidateItem(withPar, false)); f["par"] == "" {
		t.Errorf("par: %v", f)
	}
	receipt := domain.ReceiptInput{VillaID: "v1", Supplier: "Toko Bali", Lines: []domain.ReceiptLineInput{{ItemID: "soap", Quantity: 10, UnitCost: 1500}}, Method: "cash", ReceivedOn: "2026-10-01"}
	if err := domain.ValidateReceipt(receipt); err != nil {
		t.Errorf("receipt: %v", err)
	}
	free := receipt
	free.Lines = []domain.ReceiptLineInput{{ItemID: "soap", Quantity: 1, UnitCost: 0}}
	if fields(domain.ValidateReceipt(free))["lines"] == "" {
		t.Error("a free line passes")
	}
	twice := receipt
	twice.Lines = append(append([]domain.ReceiptLineInput{}, receipt.Lines...), receipt.Lines...)
	if fields(domain.ValidateReceipt(twice))["lines"] == "" {
		t.Error("an item twice passes")
	}
	base := domain.MoveInput{VillaID: "v1", Lines: []domain.LineInput{{ItemID: "soap", Quantity: 2}}}
	issue := base
	issue.Kind = domain.Issue
	if fields(domain.ValidateMove(issue))["unitId"] == "" {
		t.Error("an issue without a unit passes")
	}
	transfer := base
	transfer.Kind, transfer.ToVillaID = domain.Transfer, str("v1")
	if fields(domain.ValidateMove(transfer))["toVillaId"] == "" {
		t.Error("a transfer to the same villa passes")
	}
	writeOff := base
	writeOff.Kind = domain.WriteOff
	if fields(domain.ValidateMove(writeOff))["reason"] == "" {
		t.Error("a write-off without a reason passes")
	}
	writeOff.Reason = "Damaged in the rain"
	if err := domain.ValidateMove(writeOff); err != nil {
		t.Error(err)
	}
	count := domain.CountInput{VillaID: "v1", Lines: []domain.CountLineInput{{ItemID: "soap", Counted: 3}}}
	if fields(domain.ValidateCount(count))["countedBy"] == "" {
		t.Error("a count without a counter passes")
	}
	check := domain.MinibarCheckInput{BookingID: "b1", Lines: []domain.MinibarLineInput{{MenuItemID: "mi", Quantity: 0}}}
	if fields(domain.ValidateMinibarCheck(check))["lines"] == "" {
		t.Error("an empty minibar check passes")
	}
	check.Lines[0].Quantity = 2
	if err := domain.ValidateMinibarCheck(check); err != nil {
		t.Error(err)
	}
}

func TestSortMovementsNewestFirst(t *testing.T) {
	var got []string
	for _, m := range domain.SortMovements(movements) {
		got = append(got, m.ID)
	}
	if !reflect.DeepEqual(got, []string{"m2", "m4", "m3", "m1"}) {
		t.Fatalf("order = %v", got)
	}
}

func TestCompareNumbersIsNumeric(t *testing.T) {
	if domain.CompareNumbers("SM-999", "SM-1012") >= 0 || domain.CompareNumbers("SR-301-10", "SR-301-9") <= 0 || domain.CompareNumbers("SM-5", "SM-5") != 0 {
		t.Fatal("numeric compare")
	}
}
