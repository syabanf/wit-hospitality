package command_test

import (
	"context"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/services/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/services/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

type staffStub map[string]people.StaffMember

func (s staffStub) StaffMember(_ context.Context, id string) (people.StaffMember, bool, error) {
	m, ok := s[id]
	return m, ok, nil
}

// A villa stay orders a villaOnRequest item outside its hours; a room stay keeps the hours.
func TestVillaStaysOrderOnRequestOutsideTheHours(t *testing.T) {
	t.Parallel()
	e := setup(t)
	breakfast := item(t, e, "Balinese breakfast")
	if _, err := e.db.Pool.Exec(ctx, `UPDATE services.menu_items SET doc = doc || '{"villaOnRequest": true}' WHERE id = $1`, breakfast.ID); err != nil {
		t.Fatal(err)
	}
	in := orderFor(saka, domain.OrderLineInput{ItemID: breakfast.ID, Quantity: 1})
	in.RequestedAt = 15 * 60
	if _, err := (command.PlaceOrder{Deps: e.deps}).Handle(ctx, kadek, in); err != nil {
		t.Fatalf("villa stay out of hours: %v", err)
	}
	if _, err := e.db.Pool.Exec(ctx, `UPDATE reservation.cat_unit_groups SET kind = 'room' WHERE id = 'grp-saka-standard'`); err != nil {
		t.Fatal(err)
	}
	if _, err := (command.PlaceOrder{Deps: e.deps}).Handle(ctx, kadek, in); code(err) != domain.CodeItemUnavailable {
		t.Fatalf("room stay out of hours: %v", err)
	}
}

// Each setup a stay asks for becomes one open request assigned to its host, once.
func TestSetupsBecomeRequestsForTheHost(t *testing.T) {
	t.Parallel()
	e := setup(t)
	e.deps.Staff = staffStub{"emp-004": {ID: "emp-004", Name: "Ketut Sari", Status: "active", VillaIDs: []string{"vil-saka"}}}
	before := len(list[domain.ServiceRequest](t, e, kadek, query.Requests))
	host := "emp-004"
	stay := command.StaySetups{ID: saka, UnitID: "unit-sk-04", Status: "checked_in", CheckIn: "2026-11-09", HostID: &host}
	stay.Preferences.Setups = []string{"bbq", "airport_pickup"}
	setups := command.RequestSetups{Deps: e.deps}
	for range 2 {
		if err := setups.Handle(ctx, stay); err != nil {
			t.Fatal(err)
		}
	}
	all := list[domain.ServiceRequest](t, e, kadek, query.Requests)
	if len(all) != before+2 {
		t.Fatalf("requests %d, want %d", len(all), before+2)
	}
	kinds := map[string]domain.ServiceRequest{}
	for _, r := range all[before:] {
		kinds[r.Kind] = r
	}
	if r := kinds["transfer"]; r.Assignee != "Ketut Sari" || r.Status != domain.RequestOpen || r.BookingID == nil || *r.BookingID != saka || r.Charge != 0 {
		t.Fatalf("pickup %+v", r)
	}
	if r := kinds["other"]; r.Note != "BBQ, asked before arrival on 2026-11-09" {
		t.Fatalf("bbq %+v", r)
	}
	stay.Status = "cancelled"
	stay.Preferences.Setups = []string{"private_chef"}
	if err := setups.Handle(ctx, stay); err != nil || len(list[domain.ServiceRequest](t, e, kadek, query.Requests)) != before+2 {
		t.Fatalf("a cancelled stay asks for nothing: %v", err)
	}
}
