package command_test

import (
	"context"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	inventorypg "github.com/syabanf/wit-hospitality/api/internal/inventory/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// The cases follow src/application/villaOps.test.ts (villa-operations-contract.md sections 1 and 2).

type workOrders struct{ opened *[]maintenance.Report }

func (w workOrders) Open(_ context.Context, _ maintenance.Reporter, r maintenance.Report) (maintenance.WorkOrderRef, error) {
	*w.opened = append(*w.opened, r)
	return maintenance.WorkOrderRef{ID: "wo-99", Number: "WO-599"}, nil
}

func unitEnv(t *testing.T) (env, *[]maintenance.Report) {
	e := setup(t)
	opened := &[]maintenance.Report{}
	e.deps.Units = inventorypg.UnitInventory{DB: e.d}
	e.deps.WorkOrders = workOrders{opened: opened}
	return e, opened
}

func listOf(t *testing.T, e env, unitID string) []domain.UnitItem {
	t.Helper()
	items, err := inventorypg.UnitInventory{DB: e.d}.Items(ctx(), unitID)
	if err != nil {
		t.Fatal(err)
	}
	return items
}

func counts(list []domain.UnitItem) []domain.ItemCount {
	out := make([]domain.ItemCount, 0, len(list))
	for _, i := range list {
		out = append(out, domain.ItemCount{ItemID: i.ID, Counted: float64(i.Expected), Condition: "ok"})
	}
	return out
}

func TestSeedServesTheListsAndChecks(t *testing.T) {
	e, _ := unitEnv(t)
	q := e.q
	q.Units = inventorypg.ReadStore{DB: e.d}
	items, err := q.UnitItems(auth.WithPrincipal(ctx(), wayan))
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range items {
		if i.VillaID != "vil-saka" {
			t.Fatalf("Wayan sees %s", i.VillaID)
		}
	}
	checks, _ := q.UnitChecks(auth.WithPrincipal(ctx(), kadek))
	if len(items) != 56 || len(checks) != 2 || checks[1].Lines[0].Charge == nil {
		t.Fatalf("items %d, checks %d", len(items), len(checks))
	}
}

func TestCopyAddsTheMissingItemsOnce(t *testing.T) {
	e, _ := unitEnv(t)
	list, err := command.CopyUnitItems{Deps: e.deps}.Handle(ctx(), kadek, command.CopyInput{FromUnitID: "unit-sk-01", ToUnitID: "unit-tr-03"})
	if err != nil || len(list) != 7 {
		t.Fatalf("copied %d: %v", len(list), err)
	}
	if _, err := (command.CopyUnitItems{Deps: e.deps}).Handle(ctx(), kadek, command.CopyInput{FromUnitID: "unit-sk-01", ToUnitID: "unit-tr-03"}); code(err) != "INVENTORY_COPY_NOTHING" {
		t.Fatalf("second copy: %v", err)
	}
	if _, err := (command.SaveUnitItem{Deps: e.deps}).Handle(ctx(), kadek, "", domain.UnitItemInput{UnitID: "unit-tr-03", Name: "kettle", Category: "kitchen", Expected: 1}); code(err) != "VALIDATION_ERROR" || message(err) != "kettle is already on this list." {
		t.Fatalf("duplicate name: %v", err)
	}
	if _, err := (command.CopyUnitItems{Deps: e.deps}).Handle(ctx(), wayan, command.CopyInput{FromUnitID: "unit-sk-01", ToUnitID: "unit-tr-03"}); code(err) != "FORBIDDEN" {
		t.Fatalf("out of scope: %v", err)
	}
}

func TestPostDepartureCheckChargesOnceRaisesAndAdjusts(t *testing.T) {
	e, opened := unitEnv(t)
	list := listOf(t, e, "unit-sk-01")
	if _, err := (command.RecordCheck{Deps: e.deps}).Handle(ctx(), kadek, domain.CheckInput{UnitID: "unit-sk-01", BookingID: "bk-out", Kind: domain.PreArrival, Lines: counts(list)}); code(err) != "CHECK_STAY_STATE" {
		t.Fatalf("pre-arrival on a stay that left: %v", err)
	}
	lines := counts(list)
	lines[0].Counted, lines[0].Condition = lines[0].Counted-1, "ok"
	if _, err := (command.RecordCheck{Deps: e.deps}).Handle(ctx(), kadek, domain.CheckInput{UnitID: "unit-sk-01", BookingID: "bk-in", Kind: domain.PostDeparture, Lines: lines}); code(err) != "VALIDATION_ERROR" {
		t.Fatalf("ok with fewer: %v", err)
	}
	lines[0].Condition = "missing"
	c, err := command.RecordCheck{Deps: e.deps}.Handle(ctx(), kadek, domain.CheckInput{UnitID: "unit-sk-01", BookingID: "bk-in", Kind: domain.PostDeparture, Lines: lines})
	if err != nil || c.Number != "IC-1003" || domain.LinesOff(c) != 1 {
		t.Fatalf("check %+v: %v", c, err)
	}
	if _, err := (command.RecordCheck{Deps: e.deps}).Handle(ctx(), kadek, domain.CheckInput{UnitID: "unit-sk-01", BookingID: "bk-in", Kind: domain.PostDeparture, Lines: lines}); code(err) != "CHECK_TWICE" {
		t.Fatalf("second check: %v", err)
	}
	item := lines[0].ItemID
	charged, err := command.ChargeLine{Deps: e.deps}.Handle(ctx(), kadek, c.ID, item, domain.ChargeInput{Quantity: 1, Reason: "Not returned"})
	if err != nil || charged.Lines[0].Charge == nil || charged.Lines[0].Charge.Amount != list[0].ReplacementCost {
		t.Fatalf("charge: %+v %v", charged.Lines[0], err)
	}
	if _, err := (command.ChargeLine{Deps: e.deps}).Handle(ctx(), kadek, c.ID, item, domain.ChargeInput{Quantity: 1, Reason: "Not returned"}); code(err) != "CHECK_CHARGED" {
		t.Fatalf("second charge: %v", err)
	}
	var events int
	_ = e.d.Pool.QueryRow(ctx(), `SELECT count(*) FROM platform.outbox WHERE event_type = $1 AND payload->>'sourceRef' = $2`, inventory.EventDamageCharged, c.ID+":"+item).Scan(&events)
	if events != 1 {
		t.Fatalf("%d damage events", events)
	}
	raised, err := command.RaiseWorkOrder{Deps: e.deps}.Handle(ctx(), kadek, c.ID, item)
	if err != nil || raised.Lines[0].WorkOrder == nil || len(*opened) != 1 || (*opened)[0].Source != "inspection" || (*opened)[0].Title != "Missing "+list[0].Name+" in SK-01" {
		t.Fatalf("work order: %+v %v", *opened, err)
	}
	if _, err := (command.AdjustLine{Deps: e.deps}).Handle(ctx(), kadek, c.ID, item); err != nil {
		t.Fatal(err)
	}
	if got := listOf(t, e, "unit-sk-01")[0].Expected; got != list[0].Expected-1 {
		t.Fatalf("expected %d after the adjustment", got)
	}
	if _, err := (command.AdjustLine{Deps: e.deps}).Handle(ctx(), kadek, c.ID, lines[1].ItemID); code(err) != "CHECK_LINE_OK" {
		t.Fatalf("adjust a line in order: %v", err)
	}
}
