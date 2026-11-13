package command_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/clients"
	reservationpg "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

type staffStub map[string]people.StaffMember

func (s staffStub) StaffMember(_ context.Context, id string) (people.StaffMember, bool, error) {
	m, ok := s[id]
	return m, ok, nil
}

// folioStub records the charges reservation posts through billing.
type folioStub struct {
	clients.PendingBilling
	charges *[]command.Charge
}

func (f folioStub) Charge(_ context.Context, _ auth.Principal, _ domain.Booking, c command.Charge) error {
	*f.charges = append(*f.charges, c)
	return nil
}

func (e env) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := e.db.Pool.Exec(ctx, sql, args...); err != nil {
		t.Fatal(err)
	}
}

func (e env) checkedIn(t *testing.T, in command.NewBooking) domain.Booking {
	t.Helper()
	b, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, in)
	if err != nil {
		t.Fatal(err)
	}
	if b, err = (command.Transition{Deps: e.deps}).Handle(ctx, dian, b.ID, domain.CheckedIn); err != nil {
		t.Fatal(err)
	}
	return b
}

// A villa stay takes its unit's host and the villa service window; a manager changes the host to
// another employee allocated to the villa, and the host lists the stay as their own.
func TestVillaStayTakesTheUnitHost(t *testing.T) {
	e := setup(t)
	e.exec(t, `UPDATE reservation.cat_units SET host_id = 'emp-002' WHERE id = 'unit-kr-03'`)
	e.deps.Clients.Staff = staffStub{
		"emp-002": {ID: "emp-002", Name: "Made Wirawan", Status: "active", VillaIDs: []string{"vil-karang"}},
		"emp-004": {ID: "emp-004", Name: "Ketut Sari", Status: "active", VillaIDs: []string{"vil-saka"}},
		"emp-005": {ID: "emp-005", Name: "Nyoman Putra", Status: "active", VillaIDs: []string{"vil-karang", "vil-saka"}},
	}
	b, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct("unit-kr-03", "", "2027-03-01", "2027-03-04"))
	if err != nil {
		t.Fatal(err)
	}
	if b.HostID == nil || *b.HostID != "emp-002" || b.ServiceWindow != domain.DefaultServiceWindow(domain.KindVilla) || len(b.Preferences.Setups) != 0 {
		t.Fatalf("villa stay %+v %+v", b.HostID, b.ServiceWindow)
	}
	set := command.SetHost{Deps: e.deps}
	if _, err := set.Handle(ctx, dian, b.ID, command.HostInput{HostID: ptr("emp-005")}); code(err) != "FORBIDDEN" {
		t.Fatalf("reservation staff changing the host: %v", err)
	}
	if _, err := set.Handle(ctx, kadek, b.ID, command.HostInput{HostID: ptr("emp-004")}); code(err) != domain.CodeHostNotAllocated {
		t.Fatalf("host from another villa: %v", err)
	}
	if b, err = set.Handle(ctx, kadek, b.ID, command.HostInput{HostID: ptr("emp-005")}); err != nil || *b.HostID != "emp-005" {
		t.Fatalf("change host: %v %v", err, b.HostID)
	}
	if _, err := e.relay.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	q := query.Queries{Store: reservationpg.ReadStore{DB: e.db}, Permissions: e.deps.Authz.Source, Clock: e.deps.Clock}
	host := auth.Principal{UserID: "usr-nyoman", Name: "Nyoman Putra", Role: "staff", EmployeeID: ptr("emp-005")}
	rows, err := q.HostStays(auth.WithPrincipal(ctx, host), "")
	if err != nil || len(rows) != 1 {
		t.Fatalf("host stays: %d %v", len(rows), err)
	}
	var stay domain.Booking
	if err := json.Unmarshal(rows[0], &stay); err != nil || stay.ID != b.ID || stay.ServiceWindow.Mode != domain.WindowWindow {
		t.Fatalf("host stay %+v %v", stay, err)
	}
	if _, err := q.HostStays(auth.WithPrincipal(ctx, kadek), ""); code(err) != "VALIDATION_ERROR" {
		t.Fatalf("a login without an employee names the host: %v", err)
	}
	if rows, err := q.HostStays(auth.WithPrincipal(ctx, kadek), "emp-005"); err != nil || len(rows) != 1 {
		t.Fatalf("a manager reads a host's stays: %d %v", len(rows), err)
	}
}

// Preferences follow the unit kind; the service window takes the guest's choice.
func TestPreferencesAndServiceWindow(t *testing.T) {
	e := setup(t)
	b, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct("unit-kr-03", "", "2027-03-01", "2027-03-04"))
	if err != nil {
		t.Fatal(err)
	}
	prefs := domain.Preferences{BreakfastTime: "08:30", Setups: []string{"floating_breakfast", "bbq"}, ArrivalTime: "16:00"}
	if b, err = (command.SetPreferences{Deps: e.deps}).Handle(ctx, dian, b.ID, prefs); err != nil || len(b.Preferences.Setups) != 2 || b.Preferences.Setups[0] != "bbq" {
		t.Fatalf("villa preferences: %v %+v", err, b.Preferences)
	}
	window := command.SetServiceWindow{Deps: e.deps}
	if _, err := window.Handle(ctx, dian, b.ID, domain.ServiceWindow{Mode: "window", From: "14:00", To: "13:00"}); code(err) != "VALIDATION_ERROR" {
		t.Fatalf("backwards window: %v", err)
	}
	if b, err = window.Handle(ctx, dian, b.ID, domain.ServiceWindow{Mode: "dnd", From: "10:00"}); err != nil || b.ServiceWindow != (domain.ServiceWindow{Mode: "dnd"}) {
		t.Fatalf("dnd: %v %+v", err, b.ServiceWindow)
	}
	e.exec(t, `UPDATE reservation.cat_unit_groups SET kind = 'room' WHERE id = 'grp-saka-standard'`)
	room, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct("unit-sk-01", "", "2027-04-01", "2027-04-03"))
	if err != nil {
		t.Fatal(err)
	}
	if room.ServiceWindow.Mode != domain.WindowScheduled || room.HostID != nil {
		t.Fatalf("room stay %+v", room)
	}
	if _, err := (command.SetPreferences{Deps: e.deps}).Handle(ctx, dian, room.ID, prefs); code(err) != "VALIDATION_ERROR" {
		t.Fatalf("a room with setups: %v", err)
	}
}

// A villa leaves late for free when nobody arrives; an arrival before the time refuses it; a room
// pays the property's fee on the folio.
func TestLateCheckout(t *testing.T) {
	e := setup(t)
	var charges []command.Charge
	e.deps.Clients.Billing = folioStub{charges: &charges}
	late := command.LateCheckOut{Deps: e.deps}
	draft, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct("unit-kr-03", "", "2027-03-01", "2027-03-04"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := late.Handle(ctx, dian, draft.ID, command.LateCheckoutInput{Until: "15:00"}); code(err) != "BOOKING_INVALID_STATE" {
		t.Fatalf("before check-in: %v", err)
	}
	if _, err := (command.Transition{Deps: e.deps}).Handle(ctx, dian, draft.ID, domain.CheckedIn); err != nil {
		t.Fatal(err)
	}
	next := direct("unit-kr-03", "", "2027-03-04", "2027-03-06")
	arriving, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, next)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (command.SetPreferences{Deps: e.deps}).Handle(ctx, dian, arriving.ID, domain.Preferences{ArrivalTime: "13:00"}); err != nil {
		t.Fatal(err)
	}
	if _, err := late.Handle(ctx, dian, draft.ID, command.LateCheckoutInput{Until: "15:00"}); code(err) != domain.CodeLateCheckoutTaken {
		t.Fatalf("arrival before until: %v", err)
	}
	if _, err := (command.Transition{Deps: e.deps}).Handle(ctx, dian, arriving.ID, domain.Cancelled); err != nil {
		t.Fatal(err)
	}
	given, err := late.Handle(ctx, dian, draft.ID, command.LateCheckoutInput{Until: "15:00"})
	if err != nil || given.Charge != 0 || given.Booking.LateCheckout == nil || given.Booking.LateCheckout.Until != "15:00" || len(charges) != 0 {
		t.Fatalf("free villa late check-out: %v %+v %v", err, given, charges)
	}
	if _, err := late.Handle(ctx, dian, draft.ID, command.LateCheckoutInput{Until: "16:00"}); code(err) != "BOOKING_INVALID_STATE" {
		t.Fatalf("given twice: %v", err)
	}
	e.exec(t, `UPDATE reservation.cat_unit_groups SET kind = 'room' WHERE id = 'grp-saka-standard'`)
	e.exec(t, `UPDATE reservation.cat_villas SET late_checkout_fee = 300000 WHERE id = 'vil-saka'`)
	room := e.checkedIn(t, direct("unit-sk-01", "", "2027-04-01", "2027-04-03"))
	given, err = late.Handle(ctx, dian, room.ID, command.LateCheckoutInput{Until: "14:00"})
	if err != nil || given.Charge != 300_000 || len(charges) != 1 || charges[0] != (command.Charge{Code: "LATE", Description: "Late check-out until 14:00", Amount: 300_000}) {
		t.Fatalf("room late check-out: %v %+v %v", err, given, charges)
	}
}
