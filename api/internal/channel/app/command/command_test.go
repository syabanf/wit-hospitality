package command_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	channelpg "github.com/syabanf/wit-hospitality/api/internal/channel/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/channel/adapters/sources"
	"github.com/syabanf/wit-hospitality/api/internal/channel/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/channel/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
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

// fakeBookings stands in for reservation.
type fakeBookings map[string]string

func (f fakeBookings) BookingCode(_ context.Context, id string) (string, bool, error) {
	code, ok := f[id]
	return code, ok, nil
}

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
	hr    = auth.Principal{UserID: "usr-hr", Name: "Sari", Role: "hr", LocationIDs: []string{}, VillaIDs: []string{}}
)

func readSeed(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := seed.FS.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// setup loads the property and channel fixtures on a fresh database and projects property's
// catalog into the channel schema, as the monolith's seed does.
func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, propertypg.Migrations(), channelpg.Migrations())
	ctx := context.Background()
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	today := clock.Today(clk)
	props, err := propertypg.ParseSeed(readSeed(t, "property.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := propertypg.Seed(ctx, d, props, clock.DaysBetween(props.BaseDate, today), clk.Now()); err != nil {
		t.Fatal(err)
	}
	chans, err := channelpg.ParseSeed(readSeed(t, "channel.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := channelpg.Seed(ctx, d, chans, clock.DaysBetween(chans.BaseDate, today), clk.Now()); err != nil {
		t.Fatal(err)
	}
	proj := projector.New(d, logging.Discard())
	channelpg.Projections{DB: d}.Register(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		t.Fatal(err)
	}
	perms := rbac.Static(rbac.DefaultPermissions())
	repo := channelpg.Repo{DB: d}
	e := env{
		db: d,
		deps: command.Deps{
			DB: d, Repo: repo, Catalog: repo, Bookings: fakeBookings{"bk-2101": "BK-2101"},
			Authz: rbac.Authorizer{Source: perms}, Audit: audit.Recorder{DB: d, Clock: clk}, Clock: clk,
		},
		queries: query.Queries{Store: channelpg.ReadStore{DB: d}, Sources: sources.None{}, Permissions: perms},
		relay:   &outbox.Relay{DB: d, Bus: b, Log: logging.Discard()},
	}
	if _, err := e.relay.Drain(ctx); err != nil {
		t.Fatalf("drain outbox: %v", err)
	}
	return e
}

func as(p auth.Principal) context.Context { return auth.WithPrincipal(context.Background(), p) }

func refusal(t *testing.T, err error, code, message string) {
	t.Helper()
	e, ok := errs.As(err)
	if !ok || e.Code != code || (message != "" && e.Message != message) {
		t.Fatalf("want %s %q, got %v", code, message, err)
	}
}

func fieldError(t *testing.T, err error, field string) {
	t.Helper()
	e, ok := errs.As(err)
	if !ok || e.Code != errs.CodeValidation || !errs.Fields(e.Fields).Has(field) {
		t.Fatalf("want a %s error, got %v", field, err)
	}
}

func lastEvent[T any](t *testing.T, e env, eventType string) T {
	t.Helper()
	var raw []byte
	if err := e.db.Pool.QueryRow(context.Background(), `SELECT payload FROM platform.outbox WHERE event_type = $1 ORDER BY id DESC LIMIT 1`, eventType).Scan(&raw); err != nil {
		t.Fatalf("no %s event: %v", eventType, err)
	}
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestSeedLoadsAccountsListingsAndEnquiries(t *testing.T) {
	e := setup(t)
	accounts, err := e.queries.Accounts(as(wayan))
	if err != nil || len(accounts) != 3 || accounts[0].ID != "acc-saka-stays" || accounts[2].Slot != 4 {
		t.Fatalf("accounts %+v %v", accounts, err)
	}
	listings, err := e.queries.Listings(as(rama))
	if err != nil || len(listings) != 18 || listings[0].ID != "lst-sk-01" || listings[7].Status != "paused" || len(listings[0].DateRates) == 0 {
		t.Fatalf("listings %d %v", len(listings), err)
	}
	enquiries, err := e.queries.Enquiries(as(rama))
	if err != nil || len(enquiries) != 4 || enquiries[0].Number != "ENQ-0001" || enquiries[3].Status != "closed" {
		t.Fatalf("enquiries %+v %v", enquiries, err)
	}
}

func TestListingsFollowTheUserScope(t *testing.T) {
	e := setup(t)
	listings, _ := e.queries.Listings(as(putu))
	if len(listings) != 4 {
		t.Fatalf("Putu sees the four Tirta listings, got %d", len(listings))
	}
	for _, l := range listings {
		if l.UnitID[:8] != "unit-tr-" {
			t.Fatalf("Putu works in Ubud only, got %s", l.UnitID)
		}
	}
	listings, _ = e.queries.Listings(as(wayan))
	if len(listings) != 8 {
		t.Fatalf("Wayan sees the eight Saka listings, got %d", len(listings))
	}
}

// From services.test.ts: an account and a listing, refusing a second listing on the same unit.
func TestAccountAndListing(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	account, err := command.CreateAccount{Deps: e.deps}.Handle(ctx, kadek, domain.AccountInput{Name: " Nusa Hosts ", Email: "host@nusa.id", Status: "active"})
	if err != nil || account.Name != "Nusa Hosts" || account.Slot != 5 {
		t.Fatalf("account %+v %v", account, err)
	}
	_, err = command.CreateAccount{Deps: e.deps}.Handle(ctx, kadek, domain.AccountInput{Name: "saka stays", Email: "x@y.id", Status: "active"})
	refusal(t, err, errs.CodeValidation, "saka stays already exists.")
	_, err = command.CreateAccount{Deps: e.deps}.Handle(ctx, wayan, domain.AccountInput{Name: "Wayan Hosts", Email: "x@y.id", Status: "active"})
	refusal(t, err, errs.CodeForbidden, "Staff cannot create in Airbnb.")

	_, err = command.CreateListing{Deps: e.deps}.Handle(ctx, kadek, domain.ListingInput{AccountID: account.ID, UnitID: "unit-sk-01", Title: "Duplicate", AirbnbID: "123456789", Status: "active"})
	fieldError(t, err, "unitId")
	_, err = command.CreateListing{Deps: e.deps}.Handle(ctx, kadek, domain.ListingInput{AccountID: "acc-none", UnitID: "unit-kr-03", Title: "Karang 3", AirbnbID: "471100990", Status: "active"})
	refusal(t, err, errs.CodeNotFound, `No Airbnb account with id "acc-none"`)
	_, err = command.CreateListing{Deps: e.deps}.Handle(ctx, putu, domain.ListingInput{AccountID: account.ID, UnitID: "unit-kr-03", Title: "Karang 3", AirbnbID: "471100990", Status: "active"})
	refusal(t, err, errs.CodeForbidden, "KR-03 is outside the villas you work with.")

	listing, err := command.CreateListing{Deps: e.deps}.Handle(ctx, kadek, domain.ListingInput{AccountID: account.ID, UnitID: "unit-kr-03", Title: "Karang cliff villa 3", AirbnbID: "471100990", Status: "active"})
	if err != nil || listing.ID != "lst-kr-03" || len(listing.DateRates) != 0 {
		t.Fatalf("listing %+v %v", listing, err)
	}
	updated, err := command.UpdateListing{Deps: e.deps}.Handle(ctx, kadek, listing.ID, domain.ListingInput{AccountID: account.ID, UnitID: "unit-kr-03", Title: "Karang 3, sunset", AirbnbID: "471100990", Status: "paused"})
	if err != nil || updated.Status != "paused" || updated.Title != "Karang 3, sunset" {
		t.Fatalf("update %+v %v", updated, err)
	}
	live, err := command.SetListingStatus{Deps: e.deps}.Handle(ctx, kadek, listing.ID, "active")
	if err != nil || live.Status != "active" {
		t.Fatalf("status %+v %v", live, err)
	}
	ev := lastEvent[channel.ListingEvent](t, e, channel.EventListingUpdated)
	if ev.Listing.Status != "active" || ev.VillaID != "vil-karang" || ev.LocationID != "loc-uluwatu" {
		t.Fatalf("event %+v", ev)
	}
}

// From services.test.ts: one price edit moves the base rate and the nights; a zero base is refused.
func TestSetListingPrices(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	in := domain.PriceInput{BaseRate: 1_700_000, DateRates: map[string]*float64{"2026-11-26": new(2_500_000.0)}}
	_, err := command.SetListingPrices{Deps: e.deps}.Handle(ctx, wayan, "lst-tr-04", in)
	refusal(t, err, errs.CodeForbidden, "Staff cannot edit in Airbnb.")
	_, err = command.SetListingPrices{Deps: e.deps}.Handle(ctx, putu, "lst-sk-01", in)
	refusal(t, err, errs.CodeForbidden, "SK-01 is outside the villas you work with.")
	_, err = command.SetListingPrices{Deps: e.deps}.Handle(ctx, putu, "lst-tr-04", domain.PriceInput{BaseRate: 0})
	fieldError(t, err, "baseRate")

	l, err := command.SetListingPrices{Deps: e.deps}.Handle(ctx, putu, "lst-tr-04", in)
	if err != nil || l.DateRates["2026-11-26"] != 2_500_000 {
		t.Fatalf("prices %+v %v", l.DateRates["2026-11-26"], err)
	}
	ev := lastEvent[channel.ListingPriced](t, e, channel.EventListingPriced)
	if ev.BaseRate != 1_700_000 || ev.Listing.UnitID != "unit-tr-04" || ev.VillaID != "vil-tirta" {
		t.Fatalf("priced event %+v", ev)
	}
	var summary string
	if err := e.db.Pool.QueryRow(ctx, `SELECT summary FROM platform.audit_log ORDER BY at DESC, id DESC LIMIT 1`).Scan(&summary); err != nil || summary != "Priced TR-04: base 1700000, 1 nights changed" {
		t.Fatalf("audit %q %v", summary, err)
	}
	// Clearing the night falls back to the base rate.
	l, err = command.SetListingPrices{Deps: e.deps}.Handle(ctx, putu, "lst-tr-04", domain.PriceInput{BaseRate: 1_700_000, DateRates: map[string]*float64{"2026-11-26": nil}})
	if _, still := l.DateRates["2026-11-26"]; err != nil || still {
		t.Fatalf("cleared %v", err)
	}
}

// The client reservation calls: live listing prices, nothing for a paused listing or no listing.
func TestPricesClient(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	price := command.SetListingPrices{Deps: e.deps}
	if _, err := price.Handle(ctx, kadek, "lst-tr-04", domain.PriceInput{BaseRate: 1_650_000, DateRates: map[string]*float64{"2026-11-19": new(1_900_000.0)}}); err != nil {
		t.Fatal(err)
	}
	var p channel.Prices = e.queries
	nights, listed, err := p.NightlyPrices(ctx, "unit-tr-04", "2026-11-18", "2026-11-20")
	want := []channel.NightPrice{{Date: "2026-11-18", Rate: 1_650_000}, {Date: "2026-11-19", Rate: 1_900_000, Custom: true}}
	if err != nil || !listed || len(nights) != 2 || nights[0] != want[0] || nights[1] != want[1] {
		t.Fatalf("nights %+v listed %v err %v", nights, listed, err)
	}
	active, err := p.ActiveListing(ctx, "unit-tr-04")
	if err != nil || active == nil || active.ListingID != "lst-tr-04" || active.BaseRate != 1_650_000 || active.AccountID != "acc-ubud-retreats" {
		t.Fatalf("active %+v %v", active, err)
	}
	if paused, err := p.ActiveListing(ctx, "unit-sk-08"); err != nil || paused != nil {
		t.Fatalf("a paused listing prices nothing: %+v %v", paused, err)
	}
	if _, listed, err := p.NightlyPrices(ctx, "unit-kr-03", "2026-11-18", "2026-11-20"); err != nil || listed {
		t.Fatalf("KR-03 sells direct only: listed %v %v", listed, err)
	}
}

func enquiryInput() domain.EnquiryInput {
	group := "grp-saka-standard"
	return domain.EnquiryInput{
		Name: "Mia Hartono", Email: "mia@example.com", WhatsApp: "+62 812 0000 1111", Country: "ID",
		CheckIn: "2026-11-20", CheckOut: "2026-11-23", Guests: 2, VillaID: "vil-saka", GroupID: &group,
	}
}

// From site.test.ts: refusals, a new enquiry the team converts, the guest in the audit.
func TestEnquiries(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	submit := command.SubmitEnquiry{Deps: e.deps}
	in := enquiryInput()
	other := "grp-tirta-pool"
	in.GroupID = &other
	_, err := submit.Handle(ctx, in)
	fieldError(t, err, "groupId")
	closed := enquiryInput()
	closed.VillaID, closed.GroupID = "vil-pandawa", nil
	_, err = submit.Handle(ctx, closed)
	refusal(t, err, "SITE_VILLA_CLOSED", "Villa Pandawa is not taking stays at the moment.")

	receipt, err := submit.Handle(ctx, enquiryInput())
	if err != nil || receipt.Number != "ENQ-0005" || receipt.VillaName == "" || receipt.CheckIn != "2026-11-20" {
		t.Fatalf("receipt %+v %v", receipt, err)
	}
	var who string
	if err := e.db.Pool.QueryRow(ctx, `SELECT user_name FROM platform.audit_log WHERE entity = 'enquiry' ORDER BY id DESC LIMIT 1`).Scan(&who); err != nil || who != "Guest" {
		t.Fatalf("audit names %q %v", who, err)
	}
	owner := domain.EnquiryInput{Name: "Ketut", Email: "ketut@example.com", WhatsApp: "+62 811 222 333", Country: "ID", Topic: domain.TopicOwner, Note: "Three-bedroom villa in Sanur, self-run today."}
	if _, err := submit.Handle(ctx, owner); err != nil {
		t.Fatal(err)
	}

	_, err = e.queries.Enquiries(as(hr))
	refusal(t, err, errs.CodeForbidden, "HR cannot view web enquiries.")
	mine, err := e.queries.Enquiries(as(wayan))
	if err != nil || len(mine) != 3 || mine[0].Topic != "owner" || mine[1].Number != "ENQ-0005" || mine[2].VillaID != "vil-saka" {
		t.Fatalf("Wayan sees the owner note and Saka's enquiries: %+v %v", mine, err)
	}

	set := command.SetEnquiryStatus{Deps: e.deps}
	_, err = set.Handle(ctx, kadek, "enq-1", "closed", "")
	refusal(t, err, errs.CodeValidation, "Say why it is closed.")
	_, err = set.Handle(ctx, wayan, "enq-1", "contacted", "Called")
	refusal(t, err, errs.CodeForbidden, "ENQ-0001 is about a villa outside the ones you work with.")
	got, err := set.Handle(ctx, kadek, "enq-1", "contacted", "Called on WhatsApp")
	if err != nil || got.Status != "contacted" || got.StatusNote != "Called on WhatsApp" || *got.HandledBy != "Kadek Ariani" {
		t.Fatalf("contacted %+v %v", got, err)
	}

	convert := command.ConvertEnquiry{Deps: e.deps}
	_, err = convert.Handle(ctx, kadek, "enq-5", "bk-none")
	refusal(t, err, errs.CodeNotFound, `No booking with id "bk-none"`)
	got, err = convert.Handle(ctx, kadek, "enq-5", "bk-2101")
	if err != nil || got.Status != "converted" || *got.BookingID != "bk-2101" || got.StatusNote != "Booked as BK-2101" {
		t.Fatalf("converted %+v %v", got, err)
	}
	_, err = convert.Handle(ctx, kadek, "enq-5", "bk-2101")
	refusal(t, err, "ENQUIRY_INVALID_STATE", "ENQ-0005 is Converted and cannot move to Converted.")
}

func TestSiteInventoryAndHolds(t *testing.T) {
	e := setup(t)
	inv, err := e.queries.Inventory(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(inv.Units) != 20 || len(inv.Villas) != 5 || len(inv.Listings) != 18 || len(inv.RatePlans) != 6 || inv.Contact.Email != nil {
		t.Fatalf("inventory units %d villas %d listings %d plans %d", len(inv.Units), len(inv.Villas), len(inv.Listings), len(inv.RatePlans))
	}
	holds, err := e.queries.Holds(context.Background(), "2026-11-01", "2027-01-31")
	if err != nil || len(holds) == 0 || !holds[0].UnitAssigned {
		t.Fatalf("holds %+v %v", holds, err)
	}
	_, err = e.queries.Holds(context.Background(), "", "")
	fieldError(t, err, "from")
}
