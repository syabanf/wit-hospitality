package command_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	guestpg "github.com/syabanf/wit-hospitality/api/internal/guest/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/guest/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/guest/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
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

type env struct {
	db      *db.DB
	deps    command.Deps
	queries query.Queries
	relay   *outbox.Relay
}

var (
	rama   = auth.Principal{UserID: "usr-rama", Name: "Rama Wijaya", Role: "owner"}
	kadek  = auth.Principal{UserID: "usr-kadek", Name: "Kadek Ariani", Role: "manager"}
	putu   = auth.Principal{UserID: "usr-putu", Name: "Putu Eka Wijaya", Role: "manager", LocationIDs: []string{"loc-ubud"}}
	wayan  = auth.Principal{UserID: "usr-wayan", Name: "Wayan Sudiarta", Role: "staff", VillaIDs: []string{"vil-saka"}}
	hendra = auth.Principal{UserID: "usr-hendra", Name: "Hendra Gunawan", Role: "investor"}
)

func fixture[T any](t *testing.T, name string, parse func([]byte) (T, error)) T {
	t.Helper()
	raw, err := seed.FS.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	v, err := parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// setup seeds property (for the villas and units guest projects) and guest on a fresh database.
func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, propertypg.Migrations(), guestpg.Migrations())
	ctx := context.Background()
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	props := fixture(t, "property.json", propertypg.ParseSeed)
	guests := fixture(t, "guest.json", guestpg.ParseSeed)
	if err := propertypg.Seed(ctx, d, props, clock.DaysBetween(props.BaseDate, clock.Today(clk)), clk.Now()); err != nil {
		t.Fatal(err)
	}
	if err := guestpg.Seed(ctx, d, guests, clock.DaysBetween(guests.BaseDate, clock.Today(clk)), clk.Now()); err != nil {
		t.Fatal(err)
	}
	proj := projector.New(d, logging.Discard())
	guestpg.Projections{DB: d}.Register(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		t.Fatal(err)
	}
	authz := rbac.Authorizer{Source: rbac.Static(rbac.DefaultPermissions())}
	e := env{
		db:      d,
		deps:    command.Deps{DB: d, Repo: guestpg.Repo{DB: d}, Authz: authz, Audit: audit.Recorder{DB: d, Clock: clk}, Clock: clk},
		queries: query.Queries{Store: guestpg.ReadStore{DB: d}, Authz: authz, Clock: clk},
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

func (e env) audited(t *testing.T, summary string) {
	t.Helper()
	var n int
	_ = e.db.Pool.QueryRow(context.Background(), `SELECT count(*) FROM platform.audit_log WHERE summary = $1`, summary).Scan(&n)
	if n != 1 {
		t.Fatalf("audit line %q: %d", summary, n)
	}
}

// stayWhere picks a seeded stay by status.
func (e env) stayWhere(t *testing.T, status, villa string) string {
	t.Helper()
	var id string
	if err := e.db.Pool.QueryRow(context.Background(), `SELECT id FROM guest.rm_stays WHERE status = $1 AND villa_id = $2 ORDER BY seq LIMIT 1`, status, villa).Scan(&id); err != nil {
		t.Fatalf("no %s stay in %s: %v", status, villa, err)
	}
	return id
}

func TestSeedAndScopedReads(t *testing.T) {
	e := setup(t)
	guests, _ := e.queries.Guests(as(wayan))
	companions, _ := e.queries.Companions(as(rama))
	reports, _ := e.queries.Reports(as(rama))
	items, _ := e.queries.LostItems(as(rama))
	if len(guests) != 26 || len(companions) != 4 || len(reports) != 266 || len(items) != 6 {
		t.Fatalf("guests %d companions %d reports %d items %d", len(guests), len(companions), len(reports), len(items))
	}
	ubud, _ := e.queries.LostItems(as(putu))
	if len(ubud) != 2 || ubud[0].VillaID != "vil-tirta" || ubud[1].VillaID != "vil-tirta" {
		t.Fatalf("Putu sees Tirta's items only: %+v", ubud)
	}
	saka, _ := e.queries.Reports(as(wayan))
	if len(saka) == 0 || len(saka) >= len(reports) {
		t.Fatalf("Wayan sees Saka's reports only: %d of %d", len(saka), len(reports))
	}
	if _, err := e.queries.Guests(context.Background()); err == nil {
		t.Fatal("anonymous read")
	}
	s, _ := e.queries.Settings(as(wayan))
	if s.HoldDays != 90 {
		t.Fatalf("settings %+v", s)
	}
}

func TestCreateAndUpdateGuest(t *testing.T) {
	e := setup(t)
	in := domain.GuestInput{Name: " Chris Hall ", Email: "chris.hall@example.com", Phone: "+61 400 111 222", Nationality: "AU", IDType: "passport", IDNumber: "PB1112223"}
	if _, err := (command.CreateGuest{Deps: e.deps}).Handle(as(hendra), hendra, in); err == nil {
		t.Fatal("an investor cannot add guests")
	}
	g, err := command.CreateGuest{Deps: e.deps}.Handle(as(wayan), wayan, in)
	if err != nil || g.ID != "g-27" || g.Name != "Chris Hall" || g.CreatedOn != "2026-11-11" {
		t.Fatalf("got %+v %v", g, err)
	}
	var payload []byte
	if err := e.db.Pool.QueryRow(context.Background(), `SELECT payload FROM platform.outbox WHERE event_type = $1 AND aggregate_id = 'g-27'`, guest.EventGuestCreated).Scan(&payload); err != nil {
		t.Fatalf("guest.created not in the outbox: %v", err)
	}
	e.audited(t, "Added guest Chris Hall")
	in.VipLevel = domain.Optional[int]{Set: true, Value: 1}
	_, err = command.UpdateGuest{Deps: e.deps}.Handle(as(wayan), wayan, g.ID, in)
	refusal(t, err, errs.CodeValidation, "Say why the guest is a VIP.")
	in.VipReason = domain.Optional[string]{Set: true, Value: "Repeat corporate"}
	g, err = command.UpdateGuest{Deps: e.deps}.Handle(as(wayan), wayan, g.ID, in)
	if err != nil || g.VipLevel != 1 {
		t.Fatalf("got %+v %v", g, err)
	}
	_, err = command.UpdateGuest{Deps: e.deps}.Handle(as(wayan), wayan, "g-99", in)
	refusal(t, err, errs.CodeNotFound, `No guest with id "g-99"`)
}

func TestBlacklistNeedsApprove(t *testing.T) {
	e := setup(t)
	reason := "Smoked indoors twice"
	_, err := command.SetBlacklist{Deps: e.deps}.Handle(as(wayan), wayan, "g-02", &reason)
	refusal(t, err, errs.CodeForbidden, "Only someone who may approve in the guest module can change the blacklist.")
	g, err := command.SetBlacklist{Deps: e.deps}.Handle(as(kadek), kadek, "g-02", &reason)
	if err != nil || g.Blacklist == nil || g.Blacklist.SetBy != "Kadek Ariani" || g.Blacklist.SetOn != "2026-11-11" {
		t.Fatalf("got %+v %v", g.Blacklist, err)
	}
	e.audited(t, "Blacklisted Liam O'Connor: Smoked indoors twice")
	status, _ := e.queries.BlacklistStatus(context.Background(), "g-02")
	if !status.Blacklisted || status.Blacklist.Reason != reason {
		t.Fatalf("client sees %+v", status)
	}
	g, err = command.SetBlacklist{Deps: e.deps}.Handle(as(kadek), kadek, "g-02", nil)
	if err != nil || g.Blacklist != nil {
		t.Fatalf("got %+v %v", g.Blacklist, err)
	}
	e.audited(t, "Took Liam O'Connor off the blacklist")
}

func TestMergeMovesReferencesAndPublishesTheEvent(t *testing.T) {
	e := setup(t)
	_, err := command.MergeGuests{Deps: e.deps}.Handle(as(wayan), wayan, "g-16", "g-26")
	refusal(t, err, errs.CodeForbidden, "Only someone who may approve in the guest module can merge guest profiles.")
	_, err = command.MergeGuests{Deps: e.deps}.Handle(as(kadek), kadek, "g-16", "g-16")
	refusal(t, err, errs.CodeValidation, "Pick two different profiles.")
	pairs, _ := e.queries.Duplicates(as(kadek))
	found := false
	for _, p := range pairs {
		found = found || (p.A.ID == "g-16" && p.B.ID == "g-26" && p.Match == "phone")
	}
	if !found {
		t.Fatalf("the seeded duplicate: %+v", pairs)
	}
	ctx := context.Background()
	if _, err := e.db.Pool.Exec(ctx, `UPDATE guest.lost_items SET guest_id = 'g-26', doc = jsonb_set(doc, '{guestId}', '"g-26"') WHERE id = 'lf-4'`); err != nil {
		t.Fatal(err)
	}
	kept, err := command.MergeGuests{Deps: e.deps}.Handle(as(kadek), kadek, "g-16", "g-26")
	if err != nil || kept.ID != "g-16" || kept.Email != "sarah.cohen@example.com" || kept.VipLevel != 2 {
		t.Fatalf("got %+v %v", kept, err)
	}
	var payload []byte
	if err := e.db.Pool.QueryRow(ctx, `SELECT payload FROM platform.outbox WHERE event_type = $1`, guest.EventGuestMerged).Scan(&payload); err != nil {
		t.Fatalf("guest.merged not in the outbox: %v", err)
	}
	var merged guest.GuestMerged
	_ = json.Unmarshal(payload, &merged)
	if merged.KeepID != "g-16" || merged.DropID != "g-26" || len(merged.MovedLostItems) != 1 || merged.MovedLostItems[0] != "lf-4" {
		t.Fatalf("payload %+v", merged)
	}
	guests, _ := e.queries.Guests(as(kadek))
	if len(guests) != 25 {
		t.Fatalf("the dropped profile stays: %d", len(guests))
	}
	items, _ := e.queries.LostItems(as(kadek))
	if *items[3].GuestID != "g-16" {
		t.Fatalf("lost item moved: %+v", items[3])
	}
	e.audited(t, "Merged Sarah Cohen (g-26) into Sarah Cohen: 0 stays, 0 groups, 1 lost items moved")
}

func TestCompanionsFollowTheStay(t *testing.T) {
	e := setup(t)
	alex := domain.CompanionInput{Name: " Alex Hall ", Adult: true, TravelDocument: domain.TravelDocument{Nationality: "AU", IDType: "passport", IDNumber: " PB1112224 "}}
	open := e.stayWhere(t, "confirmed", "vil-saka")
	closed := e.stayWhere(t, "checked_out", "vil-saka")
	c, err := command.AddCompanion{Deps: e.deps}.Handle(as(wayan), wayan, open, alex)
	if err != nil || c.ID != "cmp-5" || c.Name != "Alex Hall" || c.IDNumber != "PB1112224" || c.BookingID != open {
		t.Fatalf("got %+v %v", c, err)
	}
	_, err = command.AddCompanion{Deps: e.deps}.Handle(as(wayan), wayan, closed, alex)
	if e, _ := errs.As(err); e == nil || e.Code != "BOOKING_INVALID_STATE" {
		t.Fatalf("closed stay: %v", err)
	}
	_, err = command.AddCompanion{Deps: e.deps}.Handle(as(putu), putu, open, alex)
	refusal(t, err, errs.CodeForbidden, "Villa Saka is outside the villas you work with.")
	_, err = command.AddCompanion{Deps: e.deps}.Handle(as(wayan), wayan, "bk-none", alex)
	refusal(t, err, errs.CodeNotFound, `No booking with id "bk-none"`)
	alex.Adult = false
	if c, err = (command.UpdateCompanion{Deps: e.deps}).Handle(as(wayan), wayan, c.ID, alex); err != nil || c.Adult {
		t.Fatalf("got %+v %v", c, err)
	}
	if err := (command.RemoveCompanion{Deps: e.deps}).Handle(as(wayan), wayan, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := (guestpg.Repo{DB: e.db}).Companion(context.Background(), c.ID); err == nil {
		t.Fatal("removed companion still there")
	}
}

func TestMarkReportedOnce(t *testing.T) {
	e := setup(t)
	list, err := e.queries.Foreign(as(kadek), "", "")
	if err != nil || len(list.Rows) == 0 || len(list.Apoa[0]) != 15 || len(list.Columns) != 15 {
		t.Fatalf("today's list: %+v %v", list, err)
	}
	var first *query.ForeignRow
	overdue := map[string]bool{}
	for i, r := range list.Rows {
		if r.Overdue {
			overdue[r.Booking.ID] = true
			if first == nil {
				first = &list.Rows[i]
			}
		}
	}
	if len(overdue) != 2 || first.Report != nil {
		t.Fatalf("two stays in house past the 24 hours, got %v", overdue)
	}
	in := domain.ReportInput{BookingID: first.Booking.ID, PersonIDs: []string{first.PersonID}, Reference: " APOA-TEST-1 "}
	if _, err := (command.MarkReported{Deps: e.deps}).Handle(as(hendra), hendra, in); err == nil {
		t.Fatal("an investor cannot report")
	}
	lines, err := command.MarkReported{Deps: e.deps}.Handle(as(kadek), kadek, in)
	if err != nil || len(lines) != 1 || lines[0].ID != "fr-267" || lines[0].Reference != "APOA-TEST-1" || lines[0].ReportedAt != "2026-11-11T10:00:00" {
		t.Fatalf("got %+v %v", lines, err)
	}
	e.audited(t, "Reported 1 foreign guest on "+first.Booking.Code+" to Immigration, APOA-TEST-1")
	_, err = command.MarkReported{Deps: e.deps}.Handle(as(kadek), kadek, in)
	refusal(t, err, "ALREADY_REPORTED", "Everyone picked on "+first.Booking.Code+" is already reported.")
	in.PersonIDs = []string{"g-99"}
	_, err = command.MarkReported{Deps: e.deps}.Handle(as(kadek), kadek, in)
	refusal(t, err, errs.CodeValidation, "g-99 is not registered on "+first.Booking.Code+".")
	confirmed := e.stayWhere(t, "confirmed", "vil-saka")
	_, err = command.MarkReported{Deps: e.deps}.Handle(as(kadek), kadek, domain.ReportInput{BookingID: confirmed, PersonIDs: []string{"g-01"}})
	if e, _ := errs.As(err); e == nil || e.Code != "BOOKING_INVALID_STATE" {
		t.Fatalf("not checked in: %v", err)
	}
	after, _ := e.queries.Foreign(as(kadek), "", "")
	for _, r := range after.Rows {
		if r.Key == first.Key && (r.Report == nil || r.Overdue) {
			t.Fatalf("row stays unreported: %+v", r)
		}
	}
}

func TestRegistrationCheckForTheCheckIn(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	chris, err := command.CreateGuest{Deps: e.deps}.Handle(as(kadek), kadek, domain.GuestInput{Name: "Chris Hall", Nationality: "AU", IDType: "passport", IDNumber: "PB1112223"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Pool.Exec(ctx, `INSERT INTO guest.rm_stays (id, code, guest_id, unit_id, villa_id, status, check_in, check_out, adults) VALUES ('bk-new', 'BK-9001', $1, 'unit-kr-01', 'vil-karang', 'confirmed', '2026-11-11', '2026-11-13', 3)`, chris.ID); err != nil {
		t.Fatal(err)
	}
	stay := guest.StayPeople{BookingID: "bk-new", GuestID: chris.ID, Adults: new(int), On: "2026-11-11"}
	*stay.Adults = 3
	err = e.queries.CheckRegistration(ctx, stay)
	refusal(t, err, "FOREIGN_DATA_MISSING", "Immigration needs more for Chris Hall: document expiry, date of birth, sex, date of entry, port of entry, visa type.")
	doc := domain.TravelDocument{Nationality: "AU", IDType: "passport", IDNumber: "PB1112224", IDExpiry: strPtr("2026-11-10"), BirthDate: strPtr("1990-01-01"), Sex: strPtr("female"), EntryDate: strPtr("2026-11-10"), EntryPort: "Ngurah Rai (DPS)", VisaType: strPtr("voa")}
	if _, err := (command.AddCompanion{Deps: e.deps}).Handle(as(kadek), kadek, "bk-new", domain.CompanionInput{Name: "Alex Hall", Adult: true, TravelDocument: doc}); err != nil {
		t.Fatal(err)
	}
	full := doc
	full.IDNumber, full.IDExpiry, full.Sex = "PB1112223", strPtr("2031-01-01"), strPtr("male")
	in := domain.GuestInput{Name: "Chris Hall", Nationality: "AU", IDType: "passport", IDNumber: full.IDNumber,
		IDExpiry: set(full.IDExpiry), BirthDate: set(full.BirthDate), Sex: set(full.Sex), EntryDate: set(full.EntryDate),
		EntryPort: domain.Optional[string]{Set: true, Value: full.EntryPort}, VisaType: set(full.VisaType)}
	if _, err := (command.UpdateGuest{Deps: e.deps}).Handle(as(kadek), kadek, chris.ID, in); err != nil {
		t.Fatal(err)
	}
	err = e.queries.CheckRegistration(ctx, stay)
	refusal(t, err, "DOCUMENT_EXPIRED", "Alex Hall's passport expired on 2026-11-10. Ask for a valid one before check-in.")
	reg, err := e.queries.Registration(ctx, stay)
	if err != nil || reg.RegisteredAdults != 2 || reg.Unregistered != 1 || len(reg.People) != 2 || !reg.People[1].Expired || reg.People[0].Kind != "guest" {
		t.Fatalf("registration %+v %v", reg, err)
	}
}

func strPtr(s string) *string { return &s }

func set(v *string) domain.Optional[*string] { return domain.Optional[*string]{Set: true, Value: v} }

func TestLostItemLifecycle(t *testing.T) {
	e := setup(t)
	find := domain.LostItemInput{FoundOn: "2026-11-11", VillaID: "vil-saka", UnitID: strPtr("unit-sk-06"), Where: "Under the bed", Description: "Phone charger", Storage: ""}
	if _, err := (command.LogLostItem{Deps: e.deps}).Handle(as(hendra), hendra, find); err == nil {
		t.Fatal("an investor cannot log finds")
	}
	wrong := find
	wrong.UnitID = strPtr("unit-tr-01")
	_, err := command.LogLostItem{Deps: e.deps}.Handle(as(kadek), kadek, wrong)
	refusal(t, err, errs.CodeValidation, "TR-01 is not in that villa.")
	away := find
	away.VillaID, away.UnitID = "vil-tirta", nil
	_, err = command.LogLostItem{Deps: e.deps}.Handle(as(wayan), wayan, away)
	refusal(t, err, errs.CodeForbidden, "Villa Tirta is outside the villas you work with.")
	item, err := command.LogLostItem{Deps: e.deps}.Handle(as(wayan), wayan, find)
	if err != nil || item.ID != "lf-7" || item.Number != "LF-007" || item.FoundBy != "Wayan Sudiarta" || item.Status != "found" || len(item.History) != 1 {
		t.Fatalf("got %+v %v", item, err)
	}
	e.audited(t, "Logged Phone charger found at Villa Saka")
	move := command.MoveLostItem{Deps: e.deps}
	_, err = move.Handle(as(wayan), wayan, item.ID, domain.LostMove{To: "returned", Returned: &domain.LostReturn{Method: "courier", To: "Chris Hall", Courier: "JNE"}})
	refusal(t, err, "LOST_ITEM_INVALID_STATE", "Enter the courier and the tracking number.")
	if item, err = move.Handle(as(wayan), wayan, item.ID, domain.LostMove{To: "stored", Note: "Front office drawer"}); err != nil {
		t.Fatal(err)
	}
	_, err = move.Handle(as(wayan), wayan, item.ID, domain.LostMove{To: "donated"})
	refusal(t, err, "LOST_ITEM_INVALID_STATE", "Hold the item until 2027-02-09; the holding period is 90 days.")
	item, err = move.Handle(as(wayan), wayan, item.ID, domain.LostMove{To: "returned", Returned: &domain.LostReturn{Method: "courier", To: "Chris Hall", Courier: "JNE", Tracking: "JNE123"}})
	if err != nil || item.Status != "returned" || len(item.History) != 3 || item.Returned.Tracking != "JNE123" {
		t.Fatalf("got %+v %v", item, err)
	}
	e.audited(t, "LF-007 stored to returned")
	if _, err := move.Handle(as(wayan), wayan, "lf-5", domain.LostMove{To: "donated", Note: "Community library"}); err != nil {
		t.Fatalf("the straw hat is past the holding period: %v", err)
	}
	_, err = command.SaveLostFoundSettings{Deps: e.deps}.Handle(as(wayan), wayan, domain.LostFoundSettings{HoldDays: 30})
	refusal(t, err, errs.CodeForbidden, "Only someone who may approve in the guest module can change the holding period.")
	_, err = command.SaveLostFoundSettings{Deps: e.deps}.Handle(as(kadek), kadek, domain.LostFoundSettings{HoldDays: 400})
	refusal(t, err, errs.CodeValidation, "Hold items between 7 and 365 days.")
	if _, err := (command.SaveLostFoundSettings{Deps: e.deps}).Handle(as(kadek), kadek, domain.LostFoundSettings{HoldDays: 30}); err != nil {
		t.Fatal(err)
	}
	s, _ := e.queries.Settings(as(wayan))
	if s.HoldDays != 30 {
		t.Fatalf("settings %+v", s)
	}
	edit := find
	edit.Description, edit.BookingID = "USB-C phone charger", strPtr(e.stayWhere(t, "checked_out", "vil-saka"))
	updated, err := command.UpdateLostItem{Deps: e.deps}.Handle(as(wayan), wayan, item.ID, edit)
	if err != nil || updated.GuestID == nil || updated.Status != "returned" || updated.Number != "LF-007" {
		t.Fatalf("edit takes the stay's guest and keeps the status: %+v %v", updated, err)
	}
}
