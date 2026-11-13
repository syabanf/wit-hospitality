package command_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

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
	"github.com/syabanf/wit-hospitality/api/internal/property"
	propertypg "github.com/syabanf/wit-hospitality/api/internal/property/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/property/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/property/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
	"github.com/syabanf/wit-hospitality/api/seed"
)

// fakeStays stands in for the booking context.
type fakeStays struct {
	overlap  string
	upcoming bool
	waiting  []string
}

func (f fakeStays) OverlappingStay(context.Context, string, string, string) (string, bool, error) {
	return f.overlap, f.overlap != "", nil
}
func (f fakeStays) HasUpcomingStays(context.Context, string, string) (bool, error) {
	return f.upcoming, nil
}
func (f fakeStays) WaitingForRoom(context.Context, string) ([]string, error) { return f.waiting, nil }

type env struct {
	db      *db.DB
	deps    command.Deps
	queries query.Queries
	relay   *outbox.Relay
}

var (
	rama  = auth.Principal{UserID: "usr-rama", Name: "Rama Wijaya", Role: "owner", LocationIDs: []string{}, VillaIDs: []string{}}
	kadek = auth.Principal{UserID: "usr-kadek", Name: "Kadek Ariani", Role: "manager", LocationIDs: []string{}, VillaIDs: []string{}}
	putu  = auth.Principal{UserID: "usr-putu", Name: "Putu Eka Wijaya", Role: "manager", LocationIDs: []string{"loc-ubud"}, VillaIDs: []string{}}
	wayan = auth.Principal{UserID: "usr-wayan", Name: "Wayan Sudiarta", Role: "staff", LocationIDs: []string{}, VillaIDs: []string{"vil-saka"}}
)

func setup(t *testing.T, stays command.Stays) env {
	t.Helper()
	d := testdb.New(t, propertypg.Migrations())
	ctx := context.Background()
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	raw, err := seed.FS.ReadFile("property.json")
	if err != nil {
		t.Fatal(err)
	}
	data, err := propertypg.ParseSeed(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := propertypg.Seed(ctx, d, data, clock.DaysBetween(data.BaseDate, clock.Today(clk)), clk.Now()); err != nil {
		t.Fatal(err)
	}
	proj := projector.New(d, logging.Discard())
	propertypg.Projections{DB: d}.Register(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		t.Fatal(err)
	}
	e := env{
		db: d,
		deps: command.Deps{
			DB: d, Repo: propertypg.Repo{DB: d}, Stays: stays, Authz: rbac.Authorizer{Source: rbac.Static(rbac.DefaultPermissions())},
			Audit: audit.Recorder{DB: d, Clock: clk}, Clock: clk,
		},
		queries: query.Queries{Store: propertypg.ReadStore{DB: d}},
		relay:   &outbox.Relay{DB: d, Bus: b, Log: logging.Discard()},
	}
	e.drain(t)
	return e
}

func (e env) drain(t *testing.T) {
	t.Helper()
	if _, err := e.relay.Drain(context.Background()); err != nil {
		t.Fatalf("drain outbox: %v", err)
	}
}

func as(p auth.Principal) context.Context { return auth.WithPrincipal(context.Background(), p) }

func code(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

func TestSeedProjectsTheCatalog(t *testing.T) {
	e := setup(t, fakeStays{})
	units, err := e.queries.Units(as(rama))
	if err != nil {
		t.Fatal(err)
	}
	if len(units) != 20 || units[0].ID != "unit-sk-01" || units[19].Code != "PD-01" || units[19].Status != "inactive" {
		t.Fatalf("got %d units, first %+v", len(units), units[0])
	}
	plans, _ := e.queries.RatePlans(as(rama))
	blocks, _ := e.queries.Blocks(as(rama))
	locations, _ := e.queries.Locations(as(rama))
	if len(plans) != 6 || len(blocks) != 4 || len(locations) != 4 {
		t.Fatalf("plans %d blocks %d locations %d", len(plans), len(blocks), len(locations))
	}
}

func TestQueriesFollowTheUserScope(t *testing.T) {
	e := setup(t, fakeStays{})
	units, _ := e.queries.Units(as(putu))
	for _, u := range units {
		if u.VillaID != "vil-tirta" {
			t.Fatalf("Putu works in Ubud only, got %s", u.Code)
		}
	}
	if len(units) != 4 {
		t.Fatalf("got %d Ubud units", len(units))
	}
	locations, _ := e.queries.Locations(as(putu))
	if len(locations) != 1 || locations[0].ID != "loc-ubud" {
		t.Fatalf("got %+v", locations)
	}
	villas, _ := e.queries.Villas(as(wayan))
	if len(villas) != 1 || villas[0].ID != "vil-saka" {
		t.Fatalf("got %+v", villas)
	}
	plans, _ := e.queries.RatePlans(as(wayan))
	if len(plans) != 1 || plans[0].GroupID != "grp-saka-standard" {
		t.Fatalf("got %+v", plans)
	}
	if _, err := e.queries.Units(context.Background()); code(err) != errs.CodeUnauthenticated {
		t.Fatalf("anonymous read: %v", err)
	}
}

func TestCreateUnitAppendsItsEventAndStartsAPlan(t *testing.T) {
	e := setup(t, fakeStays{})
	g, err := command.CreateGroup{Deps: e.deps}.Handle(as(rama), rama, domain.GroupInput{VillaID: "vil-saka", Name: "Saka family", Interchangeable: true})
	if err != nil {
		t.Fatal(err)
	}
	u, err := command.CreateUnit{Deps: e.deps}.Handle(as(rama), rama, domain.UnitInput{VillaID: "vil-saka", GroupID: &g.ID, Code: "SK-09", Name: "Saka 9", Bedrooms: 2, NightlyRate: 2_500_000, Status: "active", Amenities: []string{"ac"}})
	if err != nil {
		t.Fatal(err)
	}
	if u.ID != "unit-sk-09" {
		t.Fatalf("id = %s", u.ID)
	}
	var payload []byte
	if err := e.db.Pool.QueryRow(context.Background(), `SELECT payload FROM platform.outbox WHERE event_type = $1 AND aggregate_id = $2 AND published_at IS NULL`, property.EventUnitCreated, u.ID).Scan(&payload); err != nil {
		t.Fatalf("unit.created not in the outbox: %v", err)
	}
	var ev property.UnitEvent
	_ = json.Unmarshal(payload, &ev)
	if ev.LocationID != "loc-canggu" || ev.Unit.Code != "SK-09" {
		t.Fatalf("payload %+v", ev)
	}
	e.drain(t)
	plans, _ := e.queries.RatePlans(as(rama))
	var started *domain.RatePlan
	for i := range plans {
		if plans[i].GroupID == g.ID {
			started = &plans[i]
		}
	}
	if started == nil || started.WeekdayRate != 2_500_000 || started.WeekendRate != 3_000_000 {
		t.Fatalf("plan from the base price: %+v", started)
	}
	units, _ := e.queries.Units(as(wayan))
	if len(units) != 9 {
		t.Fatalf("read model: %d Saka units", len(units))
	}
	var lines int
	_ = e.db.Pool.QueryRow(context.Background(), `SELECT count(*) FROM platform.audit_log WHERE summary IN ('Added unit SK-09', 'Started the Saka family rate plan from SK-09''s base price')`).Scan(&lines)
	if lines != 2 {
		t.Fatalf("audit lines = %d", lines)
	}
	_, err = command.CreateUnit{Deps: e.deps}.Handle(as(rama), rama, domain.UnitInput{VillaID: "vil-saka", Code: "SK-09", Name: "Twin", Bedrooms: 1, NightlyRate: 1, Status: "active"})
	if e, _ := errs.As(err); e == nil || e.Code != errs.CodeValidation || e.Message != "SK-09 is already used." {
		t.Fatalf("duplicate code: %v", err)
	}
}

func TestPermissionsAndScopeOnWrites(t *testing.T) {
	e := setup(t, fakeStays{})
	_, err := command.CreateLocation{Deps: e.deps}.Handle(as(wayan), wayan, domain.LocationInput{Name: "Sanur", Area: "Denpasar, Bali"})
	if e, _ := errs.As(err); e == nil || e.Code != errs.CodeForbidden || e.Message != "Staff cannot create in Master data." {
		t.Fatalf("staff creating a location: %v", err)
	}
	in := domain.RatePlanInput{WeekdayRate: 1_700_000, WeekendRate: 2_000_000}
	if _, err := (command.SaveRatePlan{Deps: e.deps}).Handle(as(putu), putu, "grp-saka-standard", in); code(err) != errs.CodeForbidden {
		t.Fatalf("Putu pricing a Canggu room type: %v", err)
	}
	plan, err := command.SaveRatePlan{Deps: e.deps}.Handle(as(putu), putu, "grp-tirta-garden", in)
	if err != nil || plan.WeekdayRate != 1_700_000 || len(plan.Seasons) != 0 {
		t.Fatalf("got %+v, %v", plan, err)
	}
	if _, err := (command.SaveRatePlan{Deps: e.deps}).Handle(as(wayan), wayan, "grp-saka-standard", in); code(err) != errs.CodeForbidden {
		t.Fatalf("staff pricing: %v", err)
	}
}

func TestRulesThatAskTheBookingContext(t *testing.T) {
	e := setup(t, fakeStays{overlap: "BK-2001", upcoming: true, waiting: []string{"BK-3001"}})
	sk, _ := propertypg.Repo{DB: e.db}.Unit(context.Background(), "unit-sk-01")
	in := domain.UnitInput{VillaID: sk.VillaID, GroupID: sk.GroupID, Code: sk.Code, Name: sk.Name, Bedrooms: 1, NightlyRate: float64(sk.NightlyRate), Status: "inactive", StatusReason: "Renovation", Amenities: sk.Amenities}
	if _, err := (command.UpdateUnit{Deps: e.deps}).Handle(as(kadek), kadek, sk.ID, in); code(err) != "UNIT_IN_USE" {
		t.Fatalf("got %v", err)
	}
	g := domain.GroupInput{VillaID: "vil-saka", Name: "Saka standard", Interchangeable: true, OperatorAssigns: false}
	if _, err := (command.UpdateGroup{Deps: e.deps}).Handle(as(kadek), kadek, "grp-saka-standard", g); code(err) != "ROOMS_TO_ASSIGN" {
		t.Fatalf("got %v", err)
	}
	_, err := command.AddBlock{Deps: e.deps}.Handle(as(kadek), kadek, domain.BlockInput{UnitID: "unit-sk-01", From: "2026-11-20", To: "2026-11-22", Reason: "maintenance"})
	if e, _ := errs.As(err); e == nil || e.Code != "BLOCK_OVERLAP" || e.Message != "SK-01 has BK-2001 on those nights. Move it before blocking." {
		t.Fatalf("got %v", err)
	}
}

func TestBlocksAndTheWizard(t *testing.T) {
	e := setup(t, fakeStays{})
	b, err := command.AddBlock{Deps: e.deps}.Handle(as(kadek), kadek, domain.BlockInput{UnitID: "unit-kr-02", From: "2026-11-20", To: "2026-11-22", Reason: "owner", Note: " Owner visit "})
	if err != nil || b.Note != "Owner visit" {
		t.Fatalf("got %+v, %v", b, err)
	}
	if err := (command.RemoveBlock{Deps: e.deps}).Handle(as(kadek), kadek, "blk-1"); err != nil {
		t.Fatal(err)
	}
	e.drain(t)
	blocks, _ := e.queries.Blocks(as(rama))
	if len(blocks) != 4 {
		t.Fatalf("4 seeded + 1 added - 1 removed, got %d", len(blocks))
	}
	zero, yes := 0, true
	villa, err := command.CreateProperty{Deps: e.deps}.Handle(as(rama), rama, domain.PropertyInput{
		Villa:  domain.VillaInput{LocationID: "loc-canggu", Code: "NW", Name: "Villa Nawa", Facilities: []string{"pool"}},
		Groups: []domain.WizardGroup{{Name: "Nawa suites", Interchangeable: &yes, OperatorAssigns: &yes}},
		Rooms: []domain.WizardRoom{
			{Code: "NW-01", Name: "Nawa 1", Bedrooms: 1, NightlyRate: 2_000_000, GroupIndex: &zero},
			{Code: "NW-02", Name: "Nawa 2", Bedrooms: 1, NightlyRate: 2_000_000, GroupIndex: &zero},
			{Code: "NW-03", Name: "Nawa garden", Bedrooms: 2, NightlyRate: 1_500_000},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	e.drain(t)
	groups, _ := e.queries.Groups(as(rama))
	units, _ := e.queries.Units(as(rama))
	plans, _ := e.queries.RatePlans(as(rama))
	if len(groups) != 8 || len(units) != 23 || len(plans) != 8 {
		t.Fatalf("groups %d units %d plans %d", len(groups), len(units), len(plans))
	}
	for _, u := range units[20:] {
		if u.VillaID != villa.ID || u.GroupID == nil {
			t.Fatalf("wizard unit %+v", u)
		}
	}
	_, err = command.CreateProperty{Deps: e.deps}.Handle(as(rama), rama, domain.PropertyInput{
		Villa: domain.VillaInput{LocationID: "loc-canggu", Code: "SK", Name: "Another Saka"},
		Rooms: []domain.WizardRoom{{Code: "SK-01", Name: "Clash", Bedrooms: 1, NightlyRate: 1}},
	})
	ee, _ := errs.As(err)
	if ee == nil || ee.Code != errs.CodeValidation || errs.Fields(ee.Fields).Map()["rooms.0.code"] != "SK-01 is already used." || ee.Message != "SK is already used." {
		t.Fatalf("got %v", err)
	}
}
