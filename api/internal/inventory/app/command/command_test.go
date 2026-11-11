package command_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	inventorypg "github.com/syabanf/wit-hospitality/api/internal/inventory/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
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
	propertypg "github.com/syabanf/wit-hospitality/api/internal/property/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/seed"
)

// The cases follow src/application/stock.test.ts, run against a fresh database each.

const today = "2026-11-11"

var (
	kadek = auth.Principal{UserID: "usr-kadek", Name: "Kadek Ariani", Role: "manager"}
	wayan = auth.Principal{UserID: "usr-wayan", Name: "Wayan Sudiarta", Role: "staff", VillaIDs: []string{"vil-saka"}}
	putu  = auth.Principal{UserID: "usr-putu", Name: "Putu Eka Wijaya", Role: "manager", LocationIDs: []string{"loc-ubud"}}
)

type env struct {
	d     *db.DB
	deps  command.Deps
	q     query.Queries
	relay *outbox.Relay
	clk   clock.Clock
}

func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, propertypg.Migrations(), inventorypg.Migrations())
	ctx := context.Background()
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	rawProperty, _ := seed.FS.ReadFile("property.json")
	props, err := propertypg.ParseSeed(rawProperty)
	if err != nil {
		t.Fatal(err)
	}
	if err := propertypg.Seed(ctx, d, props, clock.DaysBetween(props.BaseDate, today), clk.Now()); err != nil {
		t.Fatal(err)
	}
	rawInventory, _ := seed.FS.ReadFile("inventory.json")
	inv, err := inventorypg.ParseSeed(rawInventory)
	if err != nil {
		t.Fatal(err)
	}
	if err := inventorypg.Seed(ctx, d, inv, clock.DaysBetween(inv.BaseDate, today)); err != nil {
		t.Fatal(err)
	}
	proj := projector.New(d, logging.Discard())
	inventorypg.Projections{DB: d}.Register(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		t.Fatal(err)
	}
	rec := audit.Recorder{DB: d, Clock: clk}
	e := env{
		d: d, clk: clk, q: query.Queries{Store: inventorypg.ReadStore{DB: d}},
		relay: &outbox.Relay{DB: d, Bus: b, Log: logging.Discard()},
		deps: command.Deps{
			DB: d, Repo: inventorypg.Repo{DB: d}, Stays: stays{}, CashOuts: inventorypg.CashOuts{DB: d, Audit: rec, Clock: clk},
			Authz: rbac.Authorizer{Source: rbac.Static(rbac.DefaultPermissions())}, Audit: rec, Clock: clk,
		},
	}
	e.drain(t)
	return e
}

// stays stands in for reservation: bk-in is in house in SK-01, bk-out has left.
type stays struct{}

func (stays) Stay(_ context.Context, id string) (command.Stay, error) {
	switch id {
	case "bk-in":
		return command.Stay{ID: id, Code: "BK-IN", Status: "checked_in", UnitID: "unit-sk-01"}, nil
	case "bk-out":
		return command.Stay{ID: id, Code: "BK-OUT", Status: "checked_out", UnitID: "unit-sk-01"}, nil
	}
	return command.Stay{}, errs.NotFound("booking", id)
}

func (e env) drain(t *testing.T) {
	t.Helper()
	if _, err := e.relay.Drain(context.Background()); err != nil {
		t.Fatalf("drain: %v", err)
	}
}

func ctx() context.Context { return context.Background() }

func code(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

func message(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Message
	}
	return ""
}

func (e env) onHand(t *testing.T, villaID, itemID string) int {
	t.Helper()
	moves, err := e.q.Movements(auth.WithPrincipal(ctx(), kadek))
	if err != nil {
		t.Fatal(err)
	}
	return domain.OnHand(moves, villaID, itemID, "")
}

func (e env) average(t *testing.T, itemID string) int64 {
	t.Helper()
	items, err := e.q.Items(auth.WithPrincipal(ctx(), kadek))
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range items {
		if i.ID == itemID {
			return i.AverageCost
		}
	}
	t.Fatalf("no item %s", itemID)
	return 0
}

func (e env) newItem(t *testing.T, code string) string {
	t.Helper()
	i, err := command.CreateItem{Deps: e.deps}.Handle(ctx(), kadek, domain.ItemInput{Code: code, Name: "Test " + code, Kind: "amenity", Unit: "piece", Active: true})
	if err != nil {
		t.Fatal(err)
	}
	return i.ID
}

func (e env) buy(t *testing.T, p auth.Principal, itemID string, quantity int, unitCost int64) domain.StockReceipt {
	t.Helper()
	r, err := command.Receive{Deps: e.deps}.Handle(ctx(), p, domain.ReceiptInput{
		VillaID: "vil-saka", Supplier: "Pepito Market", Lines: []domain.ReceiptLineInput{{ItemID: itemID, Quantity: float64(quantity), UnitCost: float64(unitCost)}},
		Method: "cash", ReceivedOn: today,
	})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// reject publishes finance's answer, the way finance will once it runs.
func (e env) reject(t *testing.T, r domain.StockReceipt) {
	t.Helper()
	err := e.d.InTx(ctx(), func(c context.Context) error {
		return outbox.Append(c, e.d.Q(c), e.clk.Now(), outbox.Event{Type: inventory.EventCashOutDecided, AggregateType: "cash_out", AggregateID: *r.TransactionID, AggregateVersion: 1,
			Payload: inventory.CashOutDecided{TransactionID: *r.TransactionID, Status: "rejected", RejectionReason: "Fix the receipt", Version: 1}})
	})
	if err != nil {
		t.Fatal(err)
	}
	e.drain(t)
}

func (e env) issue(t *testing.T, itemID string, quantity int) {
	t.Helper()
	unit := "unit-sk-01"
	if _, err := (command.Move{Deps: e.deps}).Handle(ctx(), kadek, domain.MoveInput{Kind: domain.Issue, VillaID: "vil-saka", UnitID: &unit, Lines: []domain.LineInput{{ItemID: itemID, Quantity: float64(quantity)}}}); err != nil {
		t.Fatal(err)
	}
}

func correction(itemID string, quantity int, unitCost int64) command.ReceiptCorrection {
	return command.ReceiptCorrection{Supplier: "Pepito Market", Lines: []domain.ReceiptLineInput{{ItemID: itemID, Quantity: float64(quantity), UnitCost: float64(unitCost)}}, Method: "cash", Reference: "PPT/5", ReceivedOn: today}
}

func TestSeedReplaysToNonNegativeStoresAndPricedItems(t *testing.T) {
	e := setup(t)
	moves, _ := e.q.Movements(auth.WithPrincipal(ctx(), kadek))
	items, _ := e.q.Items(auth.WithPrincipal(ctx(), kadek))
	villas := map[string]bool{}
	for _, m := range moves {
		villas[m.VillaID] = true
	}
	for _, i := range items {
		for v := range villas {
			if short := domain.FirstShortfall(moves, v, i.ID, "2000-01-01"); short != nil {
				t.Errorf("%s %s short on %s", v, i.ID, short.On)
			}
		}
	}
	if avg := e.average(t, "stk-mb-bintang-l"); avg <= 32000 {
		t.Errorf("MB-BINTANG-L average = %d, want above 32,000", avg)
	}
}

func TestReceiveSubmitsTheCashOut(t *testing.T) {
	e := setup(t)
	before := e.onHand(t, "vil-saka", "stk-mb-water")
	r := e.buy(t, kadek, "stk-mb-water", 4, 6000)
	if e.onHand(t, "vil-saka", "stk-mb-water") != before+4 || r.Number != "SR-310" || r.TransactionID == nil {
		t.Fatalf("receipt %+v", r)
	}
	var status, payload string
	if err := e.d.Pool.QueryRow(ctx(), `SELECT status, request->>'categoryId' FROM inventory.cash_outs WHERE id = $1`, *r.TransactionID).Scan(&status, &payload); err != nil {
		t.Fatal(err)
	}
	if status != "submitted" || payload != "cat-minibar" {
		t.Fatalf("cash-out %s %s", status, payload)
	}
	var events int
	_ = e.d.Pool.QueryRow(ctx(), `SELECT count(*) FROM platform.outbox WHERE event_type = $1 AND payload->>'amount' = '24000'`, inventory.EventPurchaseSubmitted).Scan(&events)
	if events != 1 {
		t.Fatalf("purchase.submitted events = %d", events)
	}
}

func TestMovesNeverTakeMoreThanTheStoreHolds(t *testing.T) {
	e := setup(t)
	held := e.onHand(t, "vil-karang", "stk-ln-towel")
	unit, to := "unit-kr-01", "vil-tirta"
	base := domain.MoveInput{VillaID: "vil-karang", Reason: "Torn", Lines: []domain.LineInput{{ItemID: "stk-ln-towel", Quantity: float64(held + 1)}}}
	for _, kind := range []string{domain.WriteOff, domain.Issue} {
		in := base
		in.Kind = kind
		if kind == domain.Issue {
			in.UnitID = &unit
		}
		_, err := command.Move{Deps: e.deps}.Handle(ctx(), kadek, in)
		if code(err) != "STOCK_SHORT" || !strings.HasPrefix(message(err), "Villa Karang holds ") {
			t.Fatalf("%s: %v", kind, err)
		}
	}
	in := base
	in.Kind, in.ToVillaID, in.Lines = domain.Transfer, &to, []domain.LineInput{{ItemID: "stk-ln-towel", Quantity: 2}}
	moved, err := command.Move{Deps: e.deps}.Handle(ctx(), kadek, in)
	if err != nil || len(moved) != 2 || moved[0].Quantity != -2 || moved[1].Quantity != 2 || *moved[0].TransferID != *moved[1].TransferID {
		t.Fatalf("transfer: %v %+v", err, moved)
	}
	if e.onHand(t, "vil-karang", "stk-ln-towel") != held-2 {
		t.Fatal("the transfer did not leave the store")
	}
	in.ToVillaID = &to
	if _, err := (command.Move{Deps: e.deps}).Handle(ctx(), wayan, in); code(err) != errs.CodeForbidden {
		t.Fatalf("a store outside the scope: %v", err)
	}
}

func TestCountPostsVarianceInTheCountersName(t *testing.T) {
	e := setup(t)
	held := e.onHand(t, "vil-tirta", "stk-am-soap")
	c, err := command.TakeCount{Deps: e.deps}.Handle(ctx(), putu, domain.CountInput{VillaID: "vil-tirta", CountedBy: "Made Sutama", Lines: []domain.CountLineInput{{ItemID: "stk-am-soap", Counted: float64(held - 3)}, {ItemID: "stk-am-shampoo", Counted: float64(e.onHand(t, "vil-tirta", "stk-am-shampoo"))}}})
	if err != nil {
		t.Fatal(err)
	}
	if c.Number != "SC-102" || c.VarianceValue() != -3*e.average(t, "stk-am-soap") {
		t.Fatalf("count %+v", c)
	}
	moves, _ := e.q.Movements(auth.WithPrincipal(ctx(), kadek))
	var adjustments []domain.Movement
	for _, m := range moves {
		if m.CountID != nil && *m.CountID == c.ID {
			adjustments = append(adjustments, m)
		}
	}
	if len(adjustments) != 1 || adjustments[0].Kind != domain.Adjustment || adjustments[0].Quantity != -3 || adjustments[0].By != "Made Sutama" {
		t.Fatalf("adjustments %+v", adjustments)
	}
	if _, err := (command.TakeCount{Deps: e.deps}).Handle(ctx(), putu, domain.CountInput{VillaID: "vil-saka", CountedBy: "Putu", Lines: []domain.CountLineInput{{ItemID: "stk-am-soap", Counted: 1}}}); code(err) != errs.CodeForbidden {
		t.Fatalf("Putu counts Canggu: %v", err)
	}
}

func TestCorrectionRedoesTheAverage(t *testing.T) {
	e := setup(t)
	soap := e.newItem(t, "AM-TEST-SOAP")
	e.buy(t, kadek, soap, 10, 10000)
	second := e.buy(t, kadek, soap, 10, 20000)
	if e.average(t, soap) != 15000 {
		t.Fatalf("average = %d, want 15,000", e.average(t, soap))
	}
	if _, err := (command.CorrectReceipt{Deps: e.deps}).Handle(ctx(), kadek, second.ID, correction(soap, 5, 16000)); code(err) != "TRANSACTION_INVALID_STATE" {
		t.Fatalf("correcting a submitted purchase: %v", err)
	}
	e.reject(t, second)
	if e.onHand(t, "vil-saka", soap) != 20 {
		t.Fatal("a rejected purchase keeps its goods on hand")
	}
	_, err := command.CorrectReceipt{Deps: e.deps}.Handle(ctx(), wayan, second.ID, correction(soap, 5, 16000))
	if code(err) != errs.CodeForbidden || message(err) != "Only Kadek Ariani or a manager can fix "+second.Number+"." {
		t.Fatalf("Wayan fixes Kadek's purchase: %v", err)
	}
	fixed, err := command.CorrectReceipt{Deps: e.deps}.Handle(ctx(), kadek, second.ID, correction(soap, 5, 16000))
	if err != nil {
		t.Fatal(err)
	}
	if len(fixed.Lines) != 1 || fixed.Lines[0].Quantity != 5 || *fixed.TransactionID != *second.TransactionID {
		t.Fatalf("fixed %+v", fixed)
	}
	if e.onHand(t, "vil-saka", soap) != 15 {
		t.Fatalf("on hand = %d, want 15", e.onHand(t, "vil-saka", soap))
	}
	// (10 × 10,000 + 5 × 16,000) / 15
	if e.average(t, soap) != 12000 {
		t.Fatalf("average = %d, want 12,000", e.average(t, soap))
	}
	var status string
	_ = e.d.Pool.QueryRow(ctx(), `SELECT status FROM inventory.cash_outs WHERE id = $1`, *second.TransactionID).Scan(&status)
	if status != "submitted" {
		t.Fatalf("cash-out status = %s", status)
	}
	if _, err := (command.CorrectReceipt{Deps: e.deps}).Handle(ctx(), kadek, second.ID, correction(soap, 1, 1)); code(err) != "TRANSACTION_INVALID_STATE" {
		t.Fatalf("a resubmitted purchase is fixed again: %v", err)
	}
}

func TestCancelAfterStockLeftKeepsTheAverageInsideTheRemainingPrices(t *testing.T) {
	e := setup(t)
	gel := e.newItem(t, "AM-TEST-GEL")
	first := e.buy(t, kadek, gel, 10, 10000)
	e.issue(t, gel, 5)
	e.buy(t, kadek, gel, 10, 20000)
	if e.average(t, gel) != 15000 {
		t.Fatalf("average = %d, want 15,000", e.average(t, gel))
	}
	e.reject(t, first)
	if _, err := (command.CancelReceipt{Deps: e.deps}).Handle(ctx(), kadek, first.ID, command.CancelInput{Reason: "Returned to the shop"}); err != nil {
		t.Fatal(err)
	}
	if e.onHand(t, "vil-saka", gel) != 5 || e.average(t, gel) != 20000 {
		t.Fatalf("on hand %d, average %d; want 5 and 20,000", e.onHand(t, "vil-saka", gel), e.average(t, gel))
	}
}

func TestCancelOnlyWhileTheGoodsAreStillThere(t *testing.T) {
	e := setup(t)
	towel := e.newItem(t, "LN-TEST-TOWEL")
	purchase := e.buy(t, kadek, towel, 10, 20000)
	e.reject(t, purchase)
	e.issue(t, towel, 4)
	_, err := command.CancelReceipt{Deps: e.deps}.Handle(ctx(), kadek, purchase.ID, command.CancelInput{Reason: "Returned to the shop"})
	want := "Cancelling " + purchase.Number + " would leave Villa Saka at -4 Test LN-TEST-TOWEL on " + today + "; that stock is already used. Correct the receipt down to what is left, or count the store first."
	if code(err) != "STOCK_SHORT" || message(err) != want {
		t.Fatalf("cancel after use: %v", err)
	}
	if _, err := (command.CorrectReceipt{Deps: e.deps}).Handle(ctx(), kadek, purchase.ID, correction(towel, 3, 20000)); code(err) != "STOCK_SHORT" {
		t.Fatalf("correct below what was used: %v", err)
	}
	if _, err := (command.CancelReceipt{Deps: e.deps}).Handle(ctx(), kadek, purchase.ID, command.CancelInput{}); code(err) != errs.CodeValidation || message(err) != "Say why the purchase is cancelled." {
		t.Fatalf("cancel without a reason: %v", err)
	}
	e.buy(t, kadek, towel, 10, 20000)
	cancelled, err := command.CancelReceipt{Deps: e.deps}.Handle(ctx(), kadek, purchase.ID, command.CancelInput{Reason: "Returned to the shop"})
	if err != nil || cancelled.CancelledOn == nil || *cancelled.CancelledOn != today {
		t.Fatalf("cancel: %v %+v", err, cancelled)
	}
	if e.onHand(t, "vil-saka", towel) != 6 {
		t.Fatalf("on hand = %d, want 6", e.onHand(t, "vil-saka", towel))
	}
	if _, err := (command.CorrectReceipt{Deps: e.deps}).Handle(ctx(), kadek, purchase.ID, correction(towel, 10, 20000)); code(err) != "TRANSACTION_INVALID_STATE" || !strings.Contains(message(err), "was cancelled on") {
		t.Fatalf("correct a cancelled purchase: %v", err)
	}
}

func TestMinibarCheckBillsAndRestocks(t *testing.T) {
	e := setup(t)
	links, _ := e.deps.Repo.Links(ctx())
	var menu, stock string
	for _, l := range links {
		if strings.HasPrefix(l.MenuItemID, "mi-sk-") {
			menu, stock = l.MenuItemID, l.StockItemID
			break
		}
	}
	before := e.onHand(t, "vil-saka", stock)
	in := domain.MinibarCheckInput{BookingID: "bk-in", Lines: []domain.MinibarLineInput{{MenuItemID: menu, Quantity: 2}}, Restock: true}
	o, err := command.MinibarCheck{Deps: e.deps}.Handle(ctx(), kadek, "bk-in", in)
	if err != nil {
		t.Fatal(err)
	}
	if o.Status != "delivered" || len(o.Lines) != 1 || o.Lines[0].Quantity != 2 || e.onHand(t, "vil-saka", stock) != before-2 {
		t.Fatalf("order %+v, on hand %d", o, e.onHand(t, "vil-saka", stock))
	}
	if _, err := (command.MinibarCheck{Deps: e.deps}).Handle(ctx(), kadek, "bk-out", in); code(err) != "ORDER_NO_STAY" || message(err) != "BK-OUT is not in house; check the minibar while the guest stays." {
		t.Fatalf("checked out: %v", err)
	}
}

func TestDeliveredAndVoidedOrdersMoveMinibarStock(t *testing.T) {
	e := setup(t)
	links, _ := e.deps.Repo.Links(ctx())
	var link domain.MinibarLink
	for _, l := range links {
		if strings.HasPrefix(l.MenuItemID, "mi-sk-") {
			link = l
			break
		}
	}
	before := e.onHand(t, "vil-saka", link.StockItemID)
	order := inventory.OrderEvent{By: "Kadek Ariani", Order: inventory.Order{ID: "so-x", Number: "SO-X", BookingID: "bk-in", UnitID: "unit-sk-01", VillaID: "vil-saka", Lines: []inventory.OrderLine{{ItemID: link.MenuItemID, Category: "minibar", Quantity: 3}}}}
	sales := command.Sales{Deps: e.deps}
	if err := sales.Delivered(ctx(), order); err != nil {
		t.Fatal(err)
	}
	if e.onHand(t, "vil-saka", link.StockItemID) != before-3 {
		t.Fatal("the sale did not leave the store")
	}
	if err := sales.Voided(ctx(), order); err != nil {
		t.Fatal(err)
	}
	if e.onHand(t, "vil-saka", link.StockItemID) != before {
		t.Fatal("the void did not come back")
	}
}

func TestQueriesFollowTheScope(t *testing.T) {
	e := setup(t)
	moves, _ := e.q.Movements(auth.WithPrincipal(ctx(), putu))
	for _, m := range moves {
		if m.VillaID != "vil-tirta" {
			t.Fatalf("Putu sees %s", m.VillaID)
		}
	}
	if len(moves) == 0 {
		t.Fatal("Putu sees no Ubud movements")
	}
}
