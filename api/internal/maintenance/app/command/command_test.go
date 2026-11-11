package command_test

import (
	"context"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	maintenancepg "github.com/syabanf/wit-hospitality/api/internal/maintenance/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
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
	propertymodule "github.com/syabanf/wit-hospitality/api/internal/property/module"
	"github.com/syabanf/wit-hospitality/api/seed"
)

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
	d := testdb.New(t, propertypg.Migrations(), maintenancepg.Migrations())
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
	raw, _ := seed.FS.ReadFile("maintenance.json")
	data, err := maintenancepg.ParseSeed(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := maintenancepg.Seed(ctx, d, data, clock.DaysBetween(data.BaseDate, today), clk.Now()); err != nil {
		t.Fatal(err)
	}
	perms := rbac.Static(rbac.DefaultPermissions())
	pm := propertymodule.New(propertymodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: logging.Discard(), Stays: noStays{}})
	proj := projector.New(d, logging.Discard())
	pm.Project(proj)
	maintenancepg.Projections{DB: d}.Register(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		t.Fatal(err)
	}
	rec := audit.Recorder{DB: d, Clock: clk}
	e := env{
		d: d, clk: clk, q: query.Queries{Store: maintenancepg.ReadStore{DB: d}},
		relay: &outbox.Relay{DB: d, Bus: b, Log: logging.Discard()},
		deps: command.Deps{
			DB: d, Repo: maintenancepg.Repo{DB: d}, Blocks: pm.Blocks(), CashOuts: maintenancepg.CashOuts{DB: d, Audit: rec, Clock: clk},
			Authz: rbac.Authorizer{Source: perms}, Audit: rec, Clock: clk,
		},
	}
	e.drain(t)
	return e
}

// noStays stands in for reservation: no unit has a stay. The HTTP tests cover a real overlap.
type noStays struct{}

func (noStays) OverlappingStay(context.Context, string, string, string) (string, bool, error) {
	return "", false, nil
}
func (noStays) HasUpcomingStays(context.Context, string, string) (bool, error) { return false, nil }
func (noStays) WaitingForRoom(context.Context, string) ([]string, error)       { return nil, nil }

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

func str(s string) *string { return &s }

func job(unit string) domain.NewInput {
	return domain.NewInput{Input: domain.Input{VillaID: "vil-saka", UnitID: str(unit), Category: "plumbing", Priority: "high", Title: "Leaking shower mixer", Parts: []domain.Part{{Name: "Cartridge", Qty: 1, UnitCost: 350000}}}}
}

func expense() domain.ExpenseInput {
	return domain.ExpenseInput{Kind: "parts", Description: "Cartridge", Payee: "Toko Bangunan", Amount: 350000, Method: "cash", PaidOn: today}
}

// blockOf reads the unit block property keeps.
func (e env) blockOf(t *testing.T, id string) (from, to string, ok bool) {
	t.Helper()
	err := e.d.Pool.QueryRow(ctx(), `SELECT to_char(from_date, 'YYYY-MM-DD'), to_char(to_date, 'YYYY-MM-DD') FROM property.unit_blocks WHERE id = $1`, id).Scan(&from, &to)
	if db.NoRows(err) {
		return "", "", false
	}
	if err != nil {
		t.Fatal(err)
	}
	return from, to, true
}

func TestSeedServesTheMockRecords(t *testing.T) {
	e := setup(t)
	all, _ := e.q.WorkOrders(auth.WithPrincipal(ctx(), kadek))
	ubud, _ := e.q.WorkOrders(auth.WithPrincipal(ctx(), putu))
	vendors, _ := e.q.Vendors(auth.WithPrincipal(ctx(), putu))
	if len(all) != 18 || len(ubud) == 0 || len(ubud) >= len(all) || len(vendors) != 6 {
		t.Fatalf("work orders %d, Ubud %d, vendors %d", len(all), len(ubud), len(vendors))
	}
	for _, w := range ubud {
		if w.VillaID != "vil-tirta" {
			t.Fatalf("Putu sees %s", w.VillaID)
		}
	}
}

func TestWorkOrderBlocksTheUnitAndReleasesItWhenDone(t *testing.T) {
	e := setup(t)
	in := job("unit-sk-02")
	in.BlockFrom, in.BlockTo = str(today), str(clock.AddDays(today, 3))
	w, err := command.CreateWorkOrder{Deps: e.deps}.Handle(ctx(), kadek, in)
	if err != nil {
		t.Fatal(err)
	}
	if w.Number != "WO-519" || w.Status != domain.Open || w.BlockID == nil || w.History[1].Kind != "blocked" {
		t.Fatalf("work order %+v", w)
	}
	if from, _, ok := e.blockOf(t, *w.BlockID); !ok || from != today {
		t.Fatal("property holds no block for the job")
	}
	e.drain(t)
	if _, err := (command.TransitionWorkOrder{Deps: e.deps}).Handle(ctx(), kadek, w.ID, command.TransitionInput{Status: domain.InProgress}); err != nil {
		t.Fatal(err)
	}
	done, err := command.TransitionWorkOrder{Deps: e.deps}.Handle(ctx(), kadek, w.ID, command.TransitionInput{Status: domain.Done})
	if err != nil || done.BlockID != nil || *done.FinishedOn != today {
		t.Fatalf("done: %v %+v", err, done)
	}
	if _, _, ok := e.blockOf(t, *w.BlockID); ok {
		t.Fatal("a block that starts today is not released")
	}
	if _, err := (command.TransitionWorkOrder{Deps: e.deps}).Handle(ctx(), wayan, w.ID, command.TransitionInput{Status: domain.Verified}); code(err) != errs.CodeForbidden || message(err) != "Staff cannot approve in Maintenance." {
		t.Fatalf("staff verifies: %v", err)
	}
}

func TestReleasingAStartedBlockKeepsTheLostNights(t *testing.T) {
	e := setup(t)
	w, err := command.CreateWorkOrder{Deps: e.deps}.Handle(ctx(), kadek, job("unit-sk-02"))
	if err != nil {
		t.Fatal(err)
	}
	// A block placed two days ago, as one placed then would be.
	id, err := e.deps.Blocks.Hold(ctx(), "unit-sk-02", clock.AddDays(today, -2), clock.AddDays(today, 4), w.Number)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Pool.Exec(ctx(), `UPDATE maintenance.work_orders SET doc = jsonb_set(doc, '{blockId}', to_jsonb($2::text)) WHERE id = $1`, w.ID, id); err != nil {
		t.Fatal(err)
	}
	if _, err := (command.SetBlock{Deps: e.deps}).Handle(ctx(), kadek, w.ID, command.BlockInput{}); err != nil {
		t.Fatal(err)
	}
	if _, to, ok := e.blockOf(t, id); !ok || to != today {
		t.Fatalf("the block should end today, got %s %v", to, ok)
	}
	e.drain(t)
	var rmTo string
	_ = e.d.Pool.QueryRow(ctx(), `SELECT to_date FROM property.rm_unit_blocks WHERE id = $1`, id).Scan(&rmTo)
	if rmTo != today {
		t.Fatalf("the read model kept %s", rmTo)
	}
}

func TestExpenseSubmitsACashOutAndIsCorrectedAfterRejection(t *testing.T) {
	e := setup(t)
	w, err := command.CreateWorkOrder{Deps: e.deps}.Handle(ctx(), kadek, job("unit-sk-02"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (command.AddExpense{Deps: e.deps}).Handle(ctx(), kadek, w.ID, expense()); code(err) != "WORK_ORDER_INVALID_STATE" {
		t.Fatalf("expense on an open job: %v", err)
	}
	if _, err := (command.TransitionWorkOrder{Deps: e.deps}).Handle(ctx(), kadek, w.ID, command.TransitionInput{Status: domain.InProgress}); err != nil {
		t.Fatal(err)
	}
	paid, err := command.AddExpense{Deps: e.deps}.Handle(ctx(), wayan, w.ID, expense())
	if err != nil {
		t.Fatal(err)
	}
	line := paid.Expenses[0]
	if line.Line != 1 || line.ID != "exp-wo-19-1" || line.TransactionID == "" || paid.History[len(paid.History)-1].Kind != "cost" {
		t.Fatalf("expense %+v", line)
	}
	var amount, reference string
	if err := e.d.Pool.QueryRow(ctx(), `SELECT payload->>'amount', payload->>'reference' FROM platform.outbox WHERE event_type = $1`, maintenance.EventExpenseSubmitted).Scan(&amount, &reference); err != nil {
		t.Fatal(err)
	}
	if amount != "350000" || reference != "WO-519 / 1" {
		t.Fatalf("expense.submitted carries %s %s", amount, reference)
	}
	fixed := expense()
	fixed.Amount = 300000
	if _, err := (command.CorrectExpense{Deps: e.deps}).Handle(ctx(), kadek, w.ID, line.ID, fixed); code(err) != "TRANSACTION_INVALID_STATE" {
		t.Fatalf("correcting a submitted expense: %v", err)
	}
	err = e.d.InTx(ctx(), func(c context.Context) error {
		return outbox.Append(c, e.d.Q(c), e.clk.Now(), outbox.Event{Type: maintenance.EventCashOutDecided, AggregateType: "cash_out", AggregateID: line.TransactionID, AggregateVersion: 1,
			Payload: maintenance.CashOutDecided{TransactionID: line.TransactionID, Status: "rejected", Version: 1}})
	})
	if err != nil {
		t.Fatal(err)
	}
	e.drain(t)
	corrected, err := command.CorrectExpense{Deps: e.deps}.Handle(ctx(), kadek, w.ID, line.ID, fixed)
	if err != nil {
		t.Fatal(err)
	}
	if corrected.Expenses[0].Amount != 300000 || corrected.Expenses[0].TransactionID != line.TransactionID {
		t.Fatalf("corrected %+v", corrected.Expenses[0])
	}
	var status string
	_ = e.d.Pool.QueryRow(ctx(), `SELECT status FROM maintenance.cash_outs WHERE id = $1`, line.TransactionID).Scan(&status)
	if status != "submitted" {
		t.Fatalf("cash-out status %s", status)
	}
}

func TestScopeAndUnitChecks(t *testing.T) {
	e := setup(t)
	if _, err := (command.CreateWorkOrder{Deps: e.deps}).Handle(ctx(), putu, job("unit-sk-02")); code(err) != errs.CodeForbidden {
		t.Fatalf("Putu opens a Canggu job: %v", err)
	}
	if _, err := (command.CreateWorkOrder{Deps: e.deps}).Handle(ctx(), kadek, job("unit-kr-01")); code(err) != errs.CodeValidation || message(err) != "The unit belongs to another villa." {
		t.Fatalf("unit of another villa: %v", err)
	}
}

func TestGenerateDueOpensOneJobPerDuePlan(t *testing.T) {
	e := setup(t)
	created, err := command.GenerateDue{Deps: e.deps}.Handle(ctx(), kadek, command.GenerateInput{HorizonDays: 7})
	if err != nil {
		t.Fatal(err)
	}
	if len(created) == 0 {
		t.Fatal("no plan was due")
	}
	for _, w := range created {
		if w.Source != "preventive" || w.ReportedBy != "Preventive plan" || w.PlanID == nil || w.Status != domain.Scheduled {
			t.Fatalf("job %+v", w)
		}
	}
	again, err := command.GenerateDue{Deps: e.deps}.Handle(ctx(), kadek, command.GenerateInput{HorizonDays: 7})
	if err != nil || len(again) != 0 {
		t.Fatalf("a plan with an open job got another: %d %v", len(again), err)
	}
	w := created[0]
	for _, to := range []string{domain.InProgress, domain.Done} {
		if _, err := (command.TransitionWorkOrder{Deps: e.deps}).Handle(ctx(), kadek, w.ID, command.TransitionInput{Status: to}); err != nil {
			t.Fatal(err)
		}
	}
	plan, err := e.deps.Repo.Plan(ctx(), *w.PlanID)
	if err != nil || plan.LastDoneOn == nil || *plan.LastDoneOn != today || plan.NextDue <= today {
		t.Fatalf("plan after the job: %v %+v", err, plan)
	}
}
