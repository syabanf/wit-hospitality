package command_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/guest"
	guestmodule "github.com/syabanf/wit-hospitality/api/internal/guest/module"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/adapters/clients"
	housekeepingpg "github.com/syabanf/wit-hospitality/api/internal/housekeeping/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	inventorymodule "github.com/syabanf/wit-hospitality/api/internal/inventory/module"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/platform/testdb"
)

var (
	kadek = auth.Principal{UserID: "usr-kadek", Name: "Kadek Ariani", Role: "manager", EmployeeID: ptr("emp-001")}
	sari  = auth.Principal{UserID: "usr-sari", Name: "Ni Luh Putu Sari", Role: "staff", VillaIDs: []string{"vil-saka"}, EmployeeID: ptr("emp-003")}
	ida   = auth.Principal{UserID: "usr-ida", Name: "Ida Ayu", Role: "finance", EmployeeID: ptr("emp-013")}
)

const today = "2026-11-11"

func ptr(s string) *string { return &s }

type env struct {
	db      *db.DB
	deps    command.Deps
	queries query.Queries
	staff   housekeepingpg.Staff
}

// setup seeds every context on a fresh database and wires housekeeping with the seed's roster,
// inventory's stock items, pending work orders and guest's lost and found, as the monolith does.
func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, bootstrap.MigrationSets(bootstrap.All)[1:]...)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	if err := bootstrap.Seed(context.Background(), d, logging.Discard(), clk); err != nil {
		t.Fatal(err)
	}
	perms := rbac.Static(rbac.DefaultPermissions())
	staff := housekeepingpg.Staff{DB: d}
	lostFound := guestmodule.New(guestmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: logging.Discard()}).LostFound()
	stock := inventorymodule.New(inventorymodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: logging.Discard()}).Client()
	return env{db: d, staff: staff, queries: query.Queries{Store: housekeepingpg.ReadStore{DB: d}}, deps: command.Deps{
		DB: d, Store: housekeepingpg.Repo{DB: d}, Authz: rbac.Authorizer{Source: perms}, Audit: audit.Recorder{DB: d, Clock: clk}, Clock: clk,
		Clients: command.Clients{People: staff, Stock: clients.Stock{Client: func() inventory.Items { return stock }}, WorkOrders: clients.WorkOrders{},
			LostFound: clients.LostFound{Client: func() guest.LostFound { return lostFound }}},
	}}
}

func as(p auth.Principal) context.Context { return auth.WithPrincipal(context.Background(), p) }

func code(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	return ""
}

func list[T any](t *testing.T, e env, name string) []T {
	t.Helper()
	rows, err := e.queries.List(as(kadek), name)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]T, len(rows))
	for i, r := range rows {
		if err := json.Unmarshal(r, &out[i]); err != nil {
			t.Fatal(err)
		}
	}
	return out
}

func (e env) board(t *testing.T, unitID string) string {
	for _, r := range list[domain.Record](t, e, query.Board) {
		if r.UnitID == unitID {
			return r.State
		}
	}
	return "ready"
}

func (e env) soiled(t *testing.T, villaID, itemID string) int {
	for _, c := range list[domain.LinenCount](t, e, query.Soiled) {
		if c.VillaID == villaID && c.ItemID == itemID {
			return c.Quantity
		}
	}
	return 0
}

func (e env) events(t *testing.T, eventType string) []json.RawMessage {
	rows, err := e.db.Pool.Query(context.Background(), `SELECT payload FROM platform.outbox WHERE event_type = $1 ORDER BY id`, eventType)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []json.RawMessage
	for rows.Next() {
		var raw []byte
		_ = rows.Scan(&raw)
		out = append(out, raw)
	}
	return out
}

func TestSeededDayIsGivenOutToTheAttendantsOnShift(t *testing.T) {
	t.Parallel()
	e := setup(t)
	var day []domain.RoomTask
	for _, task := range list[domain.RoomTask](t, e, query.Tasks) {
		if task.Date == today {
			day = append(day, task)
		}
	}
	staff, _ := e.staff.Day(context.Background(), today)
	on := domain.AttendantsOnShift(staff, today)
	if len(on) < 3 {
		t.Fatalf("attendants on shift: %d", len(on))
	}
	villas := map[string]bool{}
	unassignedDeep := false
	for _, task := range day {
		villas[task.VillaID] = true
		if task.AttendantID != nil && !slices.ContainsFunc(on, func(a domain.Attendant) bool { return a.ID == *task.AttendantID }) {
			t.Fatalf("%s is given to someone off shift", task.Number)
		}
		unassignedDeep = unassignedDeep || (task.Type == domain.Deep && task.AttendantID == nil)
	}
	if len(villas) != 4 || !unassignedDeep {
		t.Fatalf("villas %v, deep clean left for the supervisor %v", villas, unassignedDeep)
	}
	for id, credits := range domain.CreditsByAttendant(day) {
		if credits > domain.DefaultSettings().DailyQuota {
			t.Fatalf("%s over the quota: %v", id, credits)
		}
	}
	all := list[domain.RoomTask](t, e, query.Tasks)
	if domain.DNDStreak(all, "bk-1294", today) < domain.DNDAlertDays {
		t.Fatal("the seed keeps a stay behind a closed door for three days")
	}
}

func TestAnAttendantWorksOnlyTheirOwnRoomsAndADepartureBagsTheLinen(t *testing.T) {
	t.Parallel()
	e := setup(t)
	work := command.WorkTask{Deps: e.deps}
	// The guest in SK-02 has not checked out yet.
	if _, err := work.Handle(as(sari), sari, "hkt-97", "start", command.WorkInput{}); code(err) != "TASK_INVALID_STATE" || err.(*errs.Error).Message != "BK-1301 has not checked out of SK-02 yet." {
		t.Fatalf("start before the check-out: %v", err)
	}
	if _, err := (command.SetState{Deps: e.deps}).Handle(as(kadek), kadek, "unit-sk-05", "dirty", ""); err != nil {
		t.Fatal(err)
	}
	added, err := command.AddTask{Deps: e.deps}.Handle(as(kadek), kadek, domain.TaskInput{UnitID: "unit-sk-05", Date: today, Type: domain.Departure, AttendantID: ptr("emp-003")})
	if err != nil || added.Number != "HK-4115" {
		t.Fatalf("add: %v %+v", err, added)
	}
	towels := e.soiled(t, "vil-saka", "stk-ln-towel")
	if _, err := work.Handle(as(sari), sari, added.ID, "start", command.WorkInput{}); err != nil {
		t.Fatal(err)
	}
	if e.board(t, "unit-sk-05") != domain.Cleaning {
		t.Fatal("starting a departure takes the room to cleaning")
	}
	for _, step := range []string{"pause", "resume"} {
		if _, err := work.Handle(as(sari), sari, added.ID, step, command.WorkInput{}); err != nil {
			t.Fatalf("%s: %v", step, err)
		}
	}
	ticks := func(n int) []domain.Tick {
		var out []domain.Tick
		for _, item := range domain.Checklist[domain.Departure][n:] {
			out = append(out, domain.Tick{Item: item, OK: true})
		}
		return out
	}
	if _, err := work.Handle(as(sari), sari, added.ID, "done", command.WorkInput{Checklist: ticks(1)}); code(err) != errs.CodeValidation {
		t.Fatalf("a missing tick: %v", err)
	}
	done, err := work.Handle(as(sari), sari, added.ID, "done", command.WorkInput{Checklist: ticks(0)})
	if err != nil || done.Status != domain.Done || len(done.History) != 5 || done.FinishedAt == nil {
		t.Fatalf("done: %v %+v", err, done)
	}
	if e.board(t, "unit-sk-05") != domain.Cleaning {
		t.Fatal("the board waits for the inspection")
	}
	if got := e.soiled(t, "vil-saka", "stk-ln-towel"); got != towels+2 {
		t.Fatalf("soiled towels %d, before %d", got, towels)
	}
	if _, err := work.Handle(as(sari), sari, "hkt-105", "start", command.WorkInput{}); code(err) != "TASK_NOT_YOURS" {
		t.Fatalf("someone else's room: %v", err)
	}
	if _, err := work.Handle(as(ida), ida, "hkt-105", "start", command.WorkInput{}); code(err) != errs.CodeForbidden {
		t.Fatalf("finance works no rooms: %v", err)
	}
}

func TestAGuestAnswerLeavesTheBoardAndAFindReachesLostAndFound(t *testing.T) {
	t.Parallel()
	e := setup(t)
	work := command.WorkTask{Deps: e.deps}
	if _, err := work.Handle(as(sari), sari, "hkt-97", "dnd", command.WorkInput{}); code(err) != "TASK_INVALID_STATE" {
		t.Fatalf("dnd on a departure: %v", err)
	}
	before := e.board(t, "unit-sk-08")
	if task, err := work.Handle(as(sari), sari, "hkt-103", "dnd", command.WorkInput{}); err != nil || task.Status != domain.DND {
		t.Fatalf("dnd: %v", err)
	}
	if e.board(t, "unit-sk-08") != before {
		t.Fatal("a guest answer leaves the board")
	}
	if _, err := (command.ReportIssue{Deps: e.deps}).Handle(as(sari), sari, "hkt-103", command.IssueInput{Category: "plumbing", Title: "Shower drain blocked", Urgent: true}); code(err) != command.CodeNotAvailable {
		t.Fatalf("a work order waits for maintenance: %v", err)
	}
	found, err := command.NoteLostFound{Deps: e.deps}.Handle(as(sari), sari, "hkt-103", command.LostFoundInput{Note: "Phone charger by the bed"})
	if err != nil || len(found.LostFound) != 1 || found.LostFound[0].Ref == nil {
		t.Fatalf("find: %v %+v", err, found.LostFound)
	}
	var unitID, bookingID, desc, by string
	if err := e.db.Pool.QueryRow(context.Background(), `SELECT doc->>'unitId', doc->>'bookingId', doc->>'description', doc->>'foundBy' FROM guest.lost_items WHERE id = $1`, *found.LostFound[0].Ref).
		Scan(&unitID, &bookingID, &desc, &by); err != nil {
		t.Fatal(err)
	}
	if unitID != "unit-sk-08" || bookingID != "bk-1307" || desc != "Phone charger by the bed" || by != "Ni Luh Putu Sari" {
		t.Fatalf("lost item %s %s %s %s", unitID, bookingID, desc, by)
	}
}

func TestAssignOnlyToAttendantsOnShiftAndAutoAssignStopsAtTheQuota(t *testing.T) {
	t.Parallel()
	e := setup(t)
	if _, err := (command.Assign{Deps: e.deps}).Handle(as(kadek), kadek, []string{"hkt-114"}, ptr("emp-002")); code(err) != "NOT_ON_SHIFT" {
		t.Fatalf("assign off shift: %v", err)
	}
	if _, err := (command.Assign{Deps: e.deps}).Handle(as(sari), sari, []string{"hkt-114"}, ptr("emp-003")); code(err) != errs.CodeForbidden {
		t.Fatalf("staff assigning: %v", err)
	}
	s := domain.DefaultSettings()
	s.DailyQuota = 1
	if _, err := (command.SaveSettings{Deps: e.deps}).Handle(as(kadek), kadek, s); err != nil {
		t.Fatal(err)
	}
	added, err := command.AddTask{Deps: e.deps}.Handle(as(kadek), kadek, domain.TaskInput{UnitID: "unit-kr-02", Date: today, Type: domain.Inspection})
	if err != nil {
		t.Fatal(err)
	}
	given, err := command.AutoAssign{Deps: e.deps}.Handle(as(kadek), kadek, today)
	if err != nil || len(given) != 0 {
		t.Fatalf("everyone is full: %v %d", err, len(given))
	}
	s.DailyQuota = 8
	if _, err := (command.SaveSettings{Deps: e.deps}).Handle(as(kadek), kadek, s); err != nil {
		t.Fatal(err)
	}
	given, err = command.AutoAssign{Deps: e.deps}.Handle(as(kadek), kadek, today)
	if err != nil || len(given) != 2 {
		t.Fatalf("the deep clean and the inspection go out: %v %+v", err, given)
	}
	for _, task := range given {
		if *task.AttendantID != "emp-012" || task.History[len(task.History)-1].Note != "Auto-assigned to Kadek Yuliani" {
			t.Fatalf("Karang's attendant takes Karang's rooms: %s %v", task.ID, *task.AttendantID)
		}
	}
	_ = added
}

func TestLaundryOutAndBackWritesOffTheLossesAndBillsFinance(t *testing.T) {
	t.Parallel()
	e := setup(t)
	send := command.SendLaundry{Deps: e.deps}
	_, err := send.Handle(as(kadek), kadek, domain.SendInput{VillaID: "vil-saka", Vendor: "Bersih Laundry", SentOn: today, Lines: []domain.Line{{ItemID: "stk-ln-towel", Quantity: 3}}})
	if code(err) != "LINEN_SHORT" || err.(*errs.Error).Message != "Villa Saka holds 2 soiled Bath towel; 3 cannot leave." {
		t.Fatalf("short: %v", err)
	}
	batch, err := send.Handle(as(kadek), kadek, domain.SendInput{VillaID: "vil-saka", Vendor: "Bersih Laundry", SentOn: today, Lines: []domain.Line{{ItemID: "stk-ln-towel", Quantity: 2}, {ItemID: "stk-ln-mat", Quantity: 0}}})
	if err != nil || batch.Number != "LDY-203" || len(batch.Lines) != 1 || e.soiled(t, "vil-saka", "stk-ln-towel") != 0 {
		t.Fatalf("send: %v %+v", err, batch)
	}
	back, err := command.ReturnLaundry{Deps: e.deps}.Handle(as(kadek), kadek, batch.ID, domain.ReturnInput{ReturnedOn: today, Lines: []domain.ReturnLine{{ItemID: "stk-ln-towel", Returned: 1}}, Cost: 120_000, Method: "cash", Reference: "BL-1"})
	if err != nil || back.Status != domain.Returned || len(back.WriteOffs) != 1 {
		t.Fatalf("return: %v %+v", err, back)
	}
	var discarded housekeeping.LinenDiscarded
	_ = json.Unmarshal(e.events(t, housekeeping.EventLinenDiscarded)[0], &discarded)
	if discarded.DiscardID != back.WriteOffs[0] || discarded.From != "laundry" || discarded.Lines[0].Quantity != 1 || discarded.LocationID != "loc-canggu" {
		t.Fatalf("write-off %+v", discarded)
	}
	var billed housekeeping.LaundryBilled
	_ = json.Unmarshal(e.events(t, housekeeping.EventLaundryBilled)[0], &billed)
	if billed.Amount != 120_000 || billed.CategoryID != "cat-house" || billed.Description != "LDY-203 laundry, Bersih Laundry" || billed.Reference != "BL-1" {
		t.Fatalf("bill %+v", billed)
	}
	if _, err := (command.ReturnLaundry{Deps: e.deps}).Handle(as(kadek), kadek, batch.ID, domain.ReturnInput{ReturnedOn: today, Method: "cash"}); code(err) != "LAUNDRY_INVALID_STATE" {
		t.Fatalf("again: %v", err)
	}
	moved, err := command.DiscardLinen{Deps: e.deps}.Handle(as(kadek), kadek, domain.Discard{VillaID: "vil-lumbung", From: "soiled", Reason: "Torn seams", Lines: []domain.Line{{ItemID: "stk-ln-pillow", Quantity: 2}}})
	if err != nil || len(moved) != 1 || moved[0].Quantity != -2 || e.soiled(t, "vil-lumbung", "stk-ln-pillow") != 2 {
		t.Fatalf("discard: %v %+v", err, moved)
	}
}

func TestTheBoardReleasesARoomAndACheckOutMakesItDirty(t *testing.T) {
	t.Parallel()
	e := setup(t)
	inspect := command.Inspect{Deps: e.deps}
	if _, err := inspect.Handle(as(kadek), kadek, "unit-sk-01", command.InspectInput{Results: []domain.InspectionResult{{Item: "bed", OK: true}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := (command.SetState{Deps: e.deps}).Handle(as(kadek), kadek, "unit-sk-01", "ready", ""); err != nil {
		t.Fatal(err)
	}
	released := e.events(t, housekeeping.EventRoomReleased)
	var r housekeeping.RoomReleased
	if len(released) != 1 || json.Unmarshal(released[0], &r) != nil || r.UnitCode != "SK-01" || *r.GroupID != "grp-saka-standard" {
		t.Fatalf("released %s", released)
	}
	if _, err := inspect.Handle(as(kadek), kadek, "unit-tr-01", command.InspectInput{Results: []domain.InspectionResult{{Item: "minibar", OK: false}}, RaiseWorkOrder: true}); code(err) != command.CodeNotAvailable {
		t.Fatalf("a work order waits for maintenance: %v", err)
	}
	if err := (command.CheckedOut{Deps: e.deps}).Handle(context.Background(), "unit-sk-01", "BK-1310", "Front desk"); err != nil {
		t.Fatal(err)
	}
	if e.board(t, "unit-sk-01") != domain.Dirty {
		t.Fatal("a check-out leaves the room dirty")
	}
}
