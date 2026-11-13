package command_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
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
	"github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/clients"
	reservationpg "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

var (
	kadek = auth.Principal{UserID: "usr-kadek", Name: "Kadek Ariani", Role: "manager", LocationIDs: []string{}, VillaIDs: []string{}}
	dian  = auth.Principal{UserID: "usr-dian", Name: "Dian Permata", Role: "reservation", LocationIDs: []string{}, VillaIDs: []string{}}
	wayan = auth.Principal{UserID: "usr-wayan", Name: "Wayan Sudiarta", Role: "staff", LocationIDs: []string{}, VillaIDs: []string{"vil-saka"}}
)

const today = "2026-11-11"

type env struct {
	db      *db.DB
	deps    command.Deps
	queries query.Queries
	relay   *outbox.Relay
}

// setup seeds every context on a fresh database, as cmd/seed does, and wires reservation's
// commands with the clients the monolith uses before guest and billing exist.
func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, bootstrap.MigrationSets(bootstrap.All)[1:]...)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	if err := bootstrap.Seed(context.Background(), d, logging.Discard(), clk); err != nil {
		t.Fatal(err)
	}
	proj := projector.New(d, logging.Discard())
	reservationpg.Projections{DB: d}.Register(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		t.Fatal(err)
	}
	return env{
		db: d,
		deps: command.Deps{
			DB: d, Repo: reservationpg.Repo{DB: d}, Catalog: reservationpg.CatalogStore{DB: d}, Clients: clients.Pending(),
			Authz: rbac.Authorizer{Source: rbac.Static(rbac.DefaultPermissions())}, Audit: audit.Recorder{DB: d, Clock: clk}, Clock: clk,
			Settings: clients.DefaultSettings{},
		},
		queries: query.Queries{Store: reservationpg.ReadStore{DB: d}},
		relay:   &outbox.Relay{DB: d, Bus: b, Log: logging.Discard()},
	}
}

func (e env) list(t *testing.T, p auth.Principal, table string) []domain.Booking {
	t.Helper()
	if _, err := e.relay.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, err := e.queries.List(auth.WithPrincipal(context.Background(), p), table)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]domain.Booking, len(rows))
	for i, r := range rows {
		if err := json.Unmarshal(r, &out[i]); err != nil {
			t.Fatal(err)
		}
	}
	return out
}

func code(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

func ptr[T any](v T) *T { return &v }

func direct(unit, group, in, out string) command.NewBooking {
	b := command.NewBooking{GuestID: ptr("g-01"), Source: domain.Direct, CheckIn: in, CheckOut: out, Confirm: true}
	if unit != "" {
		b.UnitID = ptr(unit)
	}
	if group != "" {
		b.GroupID = ptr(group)
	}
	return b
}

var ctx = context.Background()

func TestSeedProjectsTheStays(t *testing.T) {
	e := setup(t)
	all := e.list(t, kadek, query.Bookings)
	if len(all) != 396 || all[0].Code != "BK-1000" {
		t.Fatalf("got %d bookings, first %s", len(all), all[0].Code)
	}
	for _, b := range e.list(t, wayan, query.Bookings) {
		if !strings.HasPrefix(b.UnitID, "unit-sk-") {
			t.Fatalf("staff of Saka sees %s on %s", b.Code, b.UnitID)
		}
	}
}

func TestBookingPricesByUnitKindAndRefusesAnOverlap(t *testing.T) {
	e := setup(t)
	// KR-03 is a villa with no listing: its own nightly rate.
	b, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct("unit-kr-03", "", "2026-12-06", "2026-12-08"))
	if err != nil {
		t.Fatal(err)
	}
	if b.Code != "BK-3001" || b.Status != domain.Confirmed || (*b.ListSources)[0].Kind != "villa" || b.ListRates[0] != 3_200_000 || b.PriceMode != "net" {
		t.Fatalf("booking %+v", b)
	}
	// SK-01 is a hotel room: the Saka rate plan, Friday 2027-02-12 at the weekend rate. The seed's
	// room types carry no kind yet, so the catalog copy learns it here.
	e.exec(t, `UPDATE reservation.cat_unit_groups SET kind = 'room' WHERE id = 'grp-saka-standard'`)
	room, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct("unit-sk-01", "", "2027-02-11", "2027-02-13"))
	if err != nil {
		t.Fatal(err)
	}
	if (*room.ListSources)[0] != (domain.PriceSource{Kind: "plan", Name: "Weekday"}) || room.ListRates[1] != 2_200_000 {
		t.Fatalf("room %+v %+v", room.ListRates, *room.ListSources)
	}
	_, err = command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct("unit-kr-03", "", "2026-12-07", "2026-12-09"))
	if code(err) != "BOOKING_OVERLAP" || !strings.Contains(err.Error(), "KR-03 is held by BK-3001 from 2026-12-06 to 2026-12-08.") {
		t.Fatalf("overlap: %v", err)
	}
	_, err = command.CreateBooking{Deps: e.deps}.Handle(ctx, auth.Principal{Role: "finance"}, direct("unit-kr-03", "", "2026-12-20", "2026-12-23"))
	if code(err) != errs.CodeForbidden {
		t.Fatalf("finance books: %v", err)
	}
	_, err = command.SetPrice{Deps: e.deps}.Handle(ctx, dian, b.ID, domain.PriceChange{Discount: &domain.Discount{Kind: "percent", Value: 20, Per: "stay", Reason: "Friend"}})
	if code(err) != "DISCOUNT_LIMIT" {
		t.Fatalf("discount past the limit: %v", err)
	}
	priced, err := command.SetPrice{Deps: e.deps}.Handle(ctx, kadek, b.ID, domain.PriceChange{Discount: &domain.Discount{Kind: "percent", Value: 20, Per: "stay", Reason: "Friend"}})
	if err != nil || *priced.PriceSetBy.ApprovedBy != "Kadek Ariani" {
		t.Fatalf("manager discount: %v %+v", err, priced.PriceSetBy)
	}
	cancelled, err := command.Transition{Deps: e.deps}.Handle(ctx, dian, b.ID, domain.Cancelled)
	if err != nil || cancelled.Status != domain.Cancelled {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := (command.Transition{Deps: e.deps}).Handle(ctx, dian, b.ID, domain.Confirmed); code(err) != "BOOKING_INVALID_STATE" {
		t.Fatalf("confirm a cancelled booking: %v", err)
	}
}

func TestRoomTypeSellingWaitsForTheOperator(t *testing.T) {
	e := setup(t)
	b, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct("", "grp-lumbung-loft", "2027-03-01", "2027-03-03"))
	if err != nil {
		t.Fatal(err)
	}
	if b.UnitAssigned {
		t.Fatal("a stay booked by type has no room yet")
	}
	waiting, err := reservationpg.Stays{DB: e.db}.WaitingForRoom(ctx, "grp-lumbung-loft")
	if err != nil || !strings.Contains(strings.Join(waiting, ","), b.Code) {
		t.Fatalf("waiting %v %v", waiting, err)
	}
	if _, err := (command.Transition{Deps: e.deps}).Handle(ctx, dian, b.ID, domain.CheckedIn); code(err) != "UNIT_UNASSIGNED" {
		t.Fatalf("check in without a room: %v", err)
	}
	if _, err := (command.AssignUnit{Deps: e.deps}).Handle(ctx, dian, b.ID, command.AssignInput{UnitID: "unit-kr-01"}); code(err) != "UNIT_NOT_INTERCHANGEABLE" {
		t.Fatalf("a room of another type: %v", err)
	}
	cat, _ := reservationpg.CatalogStore{DB: e.db}.Catalog(ctx)
	holdings, _ := reservationpg.Repo{DB: e.db}.Holdings(ctx, "2027-03-01", "2027-03-03")
	free := domain.TypeAvailabilityOf(cat, "grp-lumbung-loft", "2027-03-01", "2027-03-03", holdings, cat.Blocks, b.ID, 0).Units
	if len(free) == 0 {
		t.Fatal("no Lumbung room free")
	}
	placed, err := command.AssignUnit{Deps: e.deps}.Handle(ctx, dian, b.ID, command.AssignInput{UnitID: free[0].ID})
	if err != nil || !placed.UnitAssigned || placed.RequestedUnitID != free[0].ID {
		t.Fatalf("assign: %v %+v", err, placed)
	}
	in, err := command.CheckIn{Deps: e.deps}.Handle(ctx, dian, b.ID, domain.CheckInDetails{IDVerified: true, KeysHanded: true, Adults: 2})
	if err != nil || in.Status != domain.CheckedIn || in.Arrival == nil {
		t.Fatalf("check in: %v", err)
	}
}

func TestOverbookingAndTheWalk(t *testing.T) {
	e := setup(t)
	_, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, kadek, direct("", "grp-saka-standard", today, "2026-11-12"))
	if code(err) != "ROOM_TYPE_FULL" {
		t.Fatalf("Saka standard is sold one past its rooms tonight: %v", err)
	}
	if _, err := (command.SetOverbooking{Deps: e.deps}).Handle(ctx, dian, "grp-saka-standard", 2); code(err) != errs.CodeForbidden {
		t.Fatalf("the desk sets the policy: %v", err)
	}
	if _, err := (command.SetOverbooking{Deps: e.deps}).Handle(ctx, kadek, "grp-karang-cliff", 1); code(err) != "OVERBOOK_ROOM_BY_ROOM" {
		t.Fatalf("room by room: %v", err)
	}
	stays := e.list(t, kadek, query.Bookings)
	find := func(c string) domain.Booking {
		for _, b := range stays {
			if b.Code == c {
				return b
			}
		}
		t.Fatalf("no %s", c)
		return domain.Booking{}
	}
	last, prev := find("BK-2011"), find("BK-2008")
	out, err := command.WalkGuest{Deps: e.deps}.Handle(ctx, kadek, last.ID, domain.WalkInput{Destination: "outside", Property: "Hotel Canggu Beach", Cost: 800_000, Method: "cash", Reason: "Saka standard overbooked tonight"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Booking.Status != domain.Cancelled || out.Walk.Number != "WLK-101" || out.Walk.Cost != 800_000 {
		t.Fatalf("walk %+v", out)
	}
	_, err = command.WalkGuest{Deps: e.deps}.Handle(ctx, kadek, prev.ID, domain.WalkInput{Destination: "outside", Property: "Hotel Canggu", Method: "cash", Reason: "Overbooked"})
	if code(err) != "WALK_NOT_OVERBOOKED" {
		t.Fatalf("the night is no longer overbooked: %v", err)
	}
}

func TestRestrictionsAndTheOverride(t *testing.T) {
	e := setup(t)
	closed := direct("unit-tr-04", "", clock.AddDays(today, 29), clock.AddDays(today, 31))
	_, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, closed)
	if code(err) != "RESTRICTION_VIOLATED" || !strings.Contains(err.Error(), "Closed for sale") {
		t.Fatalf("stop sell: %v", err)
	}
	closed.Override = &domain.Override{Reason: "Guest asked"}
	if _, err := (command.CreateBooking{Deps: e.deps}).Handle(ctx, dian, closed); code(err) != "RESTRICTION_OVERRIDE_FORBIDDEN" {
		t.Fatalf("desk override: %v", err)
	}
	b, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, kadek, closed)
	if err != nil || b.RestrictionNote == nil || b.RestrictionNote.Kind != "override" || b.RestrictionNote.By != "Kadek Ariani" {
		t.Fatalf("manager override: %v %+v", err, b.RestrictionNote)
	}
	rule := domain.RestrictionInput{GroupID: "grp-lumbung-loft", Rule: "closed_to_departure", From: "2026-11-15", To: "2026-11-15", Weekdays: []float64{}}
	if _, err := (command.SaveRestriction{Deps: e.deps}).Handle(ctx, dian, "", rule); code(err) != errs.CodeForbidden {
		t.Fatalf("desk edits rules: %v", err)
	}
	rule.UnitID = ptr("unit-kr-01")
	if _, err := (command.SaveRestriction{Deps: e.deps}).Handle(ctx, kadek, "", rule); code(err) != errs.CodeValidation {
		t.Fatalf("unit of another type: %v", err)
	}
	rule.UnitID = nil
	saved, err := command.SaveRestriction{Deps: e.deps}.Handle(ctx, kadek, "", rule)
	if err != nil || saved.ID != "rst-1" {
		t.Fatalf("save: %v %+v", err, saved)
	}
	bulk, err := command.BulkRestrictions{Deps: e.deps}.Handle(ctx, kadek, domain.BulkRestrictionInput{GroupIDs: []string{"grp-saka-standard", "grp-tirta-pool"},
		RestrictionInput: domain.RestrictionInput{Rule: "max_stay", Nights: ptr(14.0), Yearly: true, From: "01-06", To: "06-30", Weekdays: []float64{}}})
	if err != nil || len(bulk) != 2 {
		t.Fatalf("bulk: %v", err)
	}
	if err := (command.RemoveRestriction{Deps: e.deps}).Handle(ctx, kadek, saved.ID); err != nil {
		t.Fatal(err)
	}
}

func TestGroupIsAllOrNothing(t *testing.T) {
	e := setup(t)
	stay := func(unit string) domain.GroupStayInput {
		return domain.GroupStayInput{UnitID: ptr(unit), CheckIn: "2027-02-10", CheckOut: "2027-02-13", Adults: 2}
	}
	in := command.NewGroup{Name: "Retreat", GuestID: ptr("g-11"), Source: "direct", Billing: "per_stay", Stays: []domain.GroupStayInput{stay("unit-kr-01"), stay("unit-kr-01")}, Confirm: true}
	before := len(e.list(t, kadek, query.Bookings))
	_, err := command.CreateGroup{Deps: e.deps}.Handle(ctx, dian, in)
	if code(err) != "GROUP_UNAVAILABLE" || !strings.Contains(err.Error(), "KR-01 is held by stay 1 of this group") {
		t.Fatalf("clash: %v", err)
	}
	if after := len(e.list(t, kadek, query.Bookings)); after != before {
		t.Fatalf("a refused group wrote %d stays", after-before)
	}
	in.Stays[1] = stay("unit-kr-03")
	made, err := command.CreateGroup{Deps: e.deps}.Handle(ctx, dian, in)
	if err != nil || made.Group.Code != "GRP-1003" || len(made.Group.VillaIDs) != 1 {
		t.Fatalf("group: %v %+v", err, made.Group)
	}
	added, err := command.AddGroupStay{Deps: e.deps}.Handle(ctx, dian, made.Group.ID, command.StayInput{GroupStayInput: stay("unit-kr-02")})
	if err != nil || added.BookingGroupID != made.Group.ID {
		t.Fatalf("add stay: %v", err)
	}
	if _, err := (command.RemoveGroupStay{Deps: e.deps}).Handle(ctx, dian, made.Group.ID, added.ID); err != nil {
		t.Fatal(err)
	}
	in.Deposit = json.RawMessage(`{"kind":"deposit","method":"cash","amount":1000000,"reference":"","note":""}`)
	in.Stays = []domain.GroupStayInput{stay("unit-lb-01"), stay("unit-lb-02")}
	if _, err := (command.CreateGroup{Deps: e.deps}).Handle(ctx, kadek, in); code(err) != command.CodeNotAvailable {
		t.Fatalf("a deposit needs billing: %v", err)
	}
}

func TestOnlineCheckIn(t *testing.T) {
	e := setup(t)
	link := command.CheckinLink{Deps: e.deps}
	view, err := link.View(ctx, domain.CheckinToken("bk-1308"))
	if err != nil || view.BookingCode != "BK-1308" || view.Status != "submitted" || !view.Editable {
		t.Fatalf("view: %v %+v", err, view)
	}
	if _, err := link.View(ctx, "cinothing"); code(err) != errs.CodeNotFound {
		t.Fatalf("unknown token: %v", err)
	}
	pre, err := command.VerifyPreCheckIn{Deps: e.deps}.Handle(ctx, dian, "bk-1308")
	if err != nil || pre.Status != "verified" || *pre.VerifiedBy != "Dian Permata" {
		t.Fatalf("verify: %v %+v", err, pre)
	}
	if _, err := (command.VerifyPreCheckIn{Deps: e.deps}).Handle(ctx, dian, "bk-1308"); code(err) != "PRECHECKIN_VERIFIED" {
		t.Fatalf("twice: %v", err)
	}
	if _, err := link.Submit(ctx, domain.CheckinToken("bk-1308"), domain.PreCheckInInput{}); code(err) != "PRECHECKIN_LOCKED" {
		t.Fatalf("locked after verify: %v", err)
	}
}
