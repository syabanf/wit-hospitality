package command_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	maintenancepg "github.com/syabanf/wit-hospitality/api/internal/maintenance/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
)

// The cases follow src/application/villaOps.test.ts (villa-operations-contract.md sections 3 and 4).

func opsEnv(t *testing.T) env {
	e := setup(t)
	e.deps.Ops = maintenancepg.VillaOps{DB: e.d}
	return e
}

// stay puts a stay into maintenance's copy, as reservation's events would.
func (e env) stay(t *testing.T, id, unitID, status, checkIn, checkOut, window string) {
	t.Helper()
	var w any
	if window != "" {
		w = []byte(window)
	}
	if _, err := e.d.Pool.Exec(ctx(), `
		INSERT INTO maintenance.ref_stays (id, code, status, unit_id, check_in, check_out, service_window, version) VALUES ($1, upper($1), $2, $3, $4, $5, $6, 1)
		ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, service_window = EXCLUDED.service_window`, id, status, unitID, checkIn, checkOut, w); err != nil {
		t.Fatal(err)
	}
}

func value(v float64) *float64 { return &v }

func (e env) billed(t *testing.T, readingID string) int {
	t.Helper()
	var n int
	_ = e.d.Pool.QueryRow(ctx(), `SELECT count(*) FROM platform.outbox WHERE event_type = $1 AND payload->>'readingId' = $2`, maintenance.EventUtilityBilled, readingID).Scan(&n)
	return n
}

func TestReadingsGoInOrderAndAboveTheLast(t *testing.T) {
	e := opsEnv(t)
	read := command.RecordReading{Deps: e.deps}
	in := domain.ReadingInput{MeterID: "mtr-5", On: today, Value: value(100), Purpose: "monthly"}
	if _, err := read.Handle(ctx(), kadek, in); code(err) != "READING_BELOW_PREVIOUS" {
		t.Fatalf("below the last: %v", err)
	}
	in.Replacement = true
	r, err := read.Handle(ctx(), kadek, in)
	if err != nil || r.Consumption != 0 || r.Previous == nil || r.BilledTo != nil {
		t.Fatalf("replacement %+v: %v", r, err)
	}
	if _, err := read.Handle(ctx(), kadek, domain.ReadingInput{MeterID: "mtr-5", On: clock.AddDays(today, -1), Value: value(120), Purpose: "monthly"}); code(err) != "READING_OUT_OF_ORDER" {
		t.Fatalf("back-dated: %v", err)
	}
	if _, err := read.Handle(ctx(), wayan, domain.ReadingInput{MeterID: "mtr-5", On: today, Value: value(120), Purpose: "monthly"}); code(err) != "FORBIDDEN" {
		t.Fatalf("out of scope: %v", err)
	}
}

func TestLongStayBillsTheGuestOnceAndTheOwnerMonthly(t *testing.T) {
	e := opsEnv(t)
	e.stay(t, "bk-long", "unit-kr-02", "checked_in", clock.AddDays(today, -6), clock.AddDays(today, 1), "")
	e.stay(t, "bk-short", "unit-kr-02", "confirmed", clock.AddDays(today, 2), clock.AddDays(today, 4), "")
	read := command.RecordReading{Deps: e.deps}
	readings, _ := maintenancepg.VillaOps{DB: e.d}.Readings(ctx(), "mtr-2")
	last := readings[len(readings)-1].Value
	short := "bk-short"
	if _, err := read.Handle(ctx(), kadek, domain.ReadingInput{MeterID: "mtr-2", On: today, Value: value(last + 1), Purpose: "check_in", BookingID: &short}); code(err) != "READING_SHORT_STAY" {
		t.Fatalf("short stay: %v", err)
	}
	long := "bk-long"
	if _, err := read.Handle(ctx(), kadek, domain.ReadingInput{MeterID: "mtr-2", On: today, Value: value(last + 10), Purpose: "check_out", BookingID: &long}); code(err) != "READING_NO_CHECK_IN" {
		t.Fatalf("check-out first: %v", err)
	}
	if _, err := read.Handle(ctx(), kadek, domain.ReadingInput{MeterID: "mtr-2", On: clock.AddDays(today, -3), Value: value(last + 10), Purpose: "check_in", BookingID: &long}); err != nil {
		t.Fatal(err)
	}
	out, err := read.Handle(ctx(), kadek, domain.ReadingInput{MeterID: "mtr-2", On: today, Value: value(last + 30.5), Purpose: "check_out", BookingID: &long})
	if err != nil || out.BilledTo == nil || *out.BilledTo != "guest" || out.Amount != 34_850 || e.billed(t, out.ID) != 1 {
		t.Fatalf("check-out %+v: %v", out, err)
	}
	if _, err := read.Handle(ctx(), kadek, domain.ReadingInput{MeterID: "mtr-2", On: today, Value: value(last + 31), Purpose: "check_out", BookingID: &long}); code(err) != "READING_TWICE" {
		t.Fatalf("second check-out: %v", err)
	}
	water, _ := maintenancepg.VillaOps{DB: e.d}.Readings(ctx(), "mtr-4")
	owner, err := read.Handle(ctx(), kadek, domain.ReadingInput{MeterID: "mtr-4", On: today, Value: value(water[len(water)-1].Value + 10), Purpose: "monthly"})
	if err != nil || owner.BilledTo == nil || *owner.BilledTo != "owner" || owner.Amount != 95_000 || e.billed(t, owner.ID) != 1 {
		t.Fatalf("owner water %+v: %v", owner, err)
	}
}

func TestTemplatesApplyOnceAndTasksKeepClearOfTheGuest(t *testing.T) {
	e := opsEnv(t)
	apply := command.ApplyTemplate{Deps: e.deps}
	if _, err := apply.Handle(ctx(), kadek, domain.ApplyTemplateInput{VillaID: "vil-karang", Template: "pool", StartOn: today}); code(err) != "UPKEEP_APPLIED" {
		t.Fatalf("pool twice: %v", err)
	}
	plans, err := apply.Handle(ctx(), kadek, domain.ApplyTemplateInput{VillaID: "vil-lumbung", Template: "fogging", StartOn: clock.AddDays(today, 30)})
	if err != nil || len(plans) != 1 || plans[0].Upkeep == nil || plans[0].Upkeep.Key != "fogging_monthly" {
		t.Fatalf("fogging %+v: %v", plans, err)
	}
	e.stay(t, "bk-dnd", "unit-kr-03", "checked_in", clock.AddDays(today, -2), clock.AddDays(today, 3), `{"mode":"dnd","from":"","to":""}`)
	gen := command.GenerateDue{Deps: e.deps}
	created, err := gen.Handle(ctx(), kadek, command.GenerateInput{HorizonDays: 0})
	if err != nil {
		t.Fatal(err)
	}
	if slices.ContainsFunc(created, func(w domain.WorkOrder) bool { return w.VillaID == "vil-karang" && w.Upkeep != nil }) {
		t.Fatal("generated an upkeep task for a do-not-disturb villa")
	}
	e.stay(t, "bk-dnd", "unit-kr-03", "checked_in", clock.AddDays(today, -2), clock.AddDays(today, 3), `{"mode":"window","from":"13:00","to":"15:00"}`)
	created, err = gen.Handle(ctx(), kadek, command.GenerateInput{HorizonDays: 0})
	if err != nil {
		t.Fatal(err)
	}
	var fog, pool domain.WorkOrder
	for _, w := range created {
		if w.VillaID == "vil-karang" && w.Upkeep != nil {
			switch w.Upkeep.Key {
			case "fogging_monthly":
				fog = w
			case "pool_daily":
				pool = w
			}
		}
	}
	if fog.Upkeep == nil || fog.Upkeep.Notice == nil || fog.Upkeep.Notice.BookingCode != "BK-DND" || !strings.HasSuffix(fog.Description, "Outside the guest's service window 13:00 to 15:00.") {
		t.Fatalf("fogging %+v", fog)
	}
	if pool.Upkeep == nil || !pool.Upkeep.ReadingsRequired || pool.Upkeep.Window == nil {
		t.Fatalf("pool %+v", pool)
	}
	move := command.TransitionWorkOrder{Deps: e.deps}
	if _, err := move.Handle(ctx(), kadek, pool.ID, command.TransitionInput{Status: domain.InProgress}); err != nil {
		t.Fatal(err)
	}
	if _, err := move.Handle(ctx(), kadek, pool.ID, command.TransitionInput{Status: domain.Done}); code(err) != "READINGS_REQUIRED" {
		t.Fatalf("done without readings: %v", err)
	}
	in := domain.UpkeepInput{Checklist: []bool{true, true, true, true}}
	in.Readings = &struct {
		PH       *float64 `json:"ph"`
		Chlorine *float64 `json:"chlorine"`
	}{PH: value(8), Chlorine: value(0.5)}
	w, err := command.RecordUpkeep{Deps: e.deps}.Handle(ctx(), kadek, pool.ID, in)
	if err != nil || w.Upkeep.Readings == nil || !slices.Equal(w.Upkeep.Readings.Flags, []string{"pH high", "Chlorine low"}) {
		t.Fatalf("upkeep %+v: %v", w.Upkeep, err)
	}
	if _, err := move.Handle(ctx(), kadek, pool.ID, command.TransitionInput{Status: domain.Done}); err != nil {
		t.Fatal(err)
	}
}
