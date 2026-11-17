package command_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

type cleanStub struct{ asked []string }

func (c *cleanStub) GuestClean(_ context.Context, bookingID, _ string) error {
	c.asked = append(c.asked, bookingID)
	return nil
}

type servicesStub struct{ requests int }

func (servicesStub) GuestStay(context.Context, string) (command.GuestServices, error) {
	return command.GuestServices{Menu: json.RawMessage(`[]`), Orders: json.RawMessage(`[]`), Requests: json.RawMessage(`[]`)}, nil
}

func (servicesStub) GuestOrder(context.Context, string, json.RawMessage) (string, error) {
	return "1 × Nasi goreng (SO-801)", nil
}

func (s *servicesStub) GuestRequest(context.Context, string, string, string) (string, error) {
	s.requests++
	return "RQ-900", nil
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if !errs.HasCode(err, code) {
		t.Fatalf("want %s, got %v", code, err)
	}
}

// Check-in gives the stay its link; the page runs each guest action in the guest's name, keeps it
// on the stay, refuses a second clean today and a window the unit kind does not take, and turns
// read only at check-out.
func TestStayPageGuestActions(t *testing.T) {
	e := setup(t)
	hk, sv := &cleanStub{}, &servicesStub{}
	e.deps.Clients.Housekeeping, e.deps.Clients.Services = hk, sv
	b := e.checkedIn(t, direct("unit-sk-02", "", "2027-03-01", "2027-03-04"))
	if b.StayToken == nil || !domain.IsStayToken(*b.StayToken) {
		t.Fatalf("stay token at check-in %v", b.StayToken)
	}
	token := *b.StayToken
	page := command.StayPage{Deps: e.deps}

	view, err := page.View(ctx, token)
	if err != nil || view.State != domain.StayLinkOpen || view.HostName != nil || view.UnitKind != domain.KindRoom {
		t.Fatalf("view %+v %v", view, err)
	}
	if view, err = page.AskClean(ctx, token, "Fresh towels"); err != nil || view.CleanAskedAt == nil || len(hk.asked) != 1 {
		t.Fatalf("clean %+v %v", view.CleanAskedAt, err)
	}
	_, err = page.AskClean(ctx, token, "")
	wantCode(t, err, domain.CodeCleanAlreadyAsked)
	_, err = page.SetServiceWindow(ctx, token, domain.ServiceWindow{Mode: domain.WindowWindow, From: "10:00", To: "12:00"})
	wantCode(t, err, errs.CodeValidation)
	if view, err = page.SetServiceWindow(ctx, token, domain.ServiceWindow{Mode: domain.WindowDND}); err != nil || view.ServiceWindow.Mode != domain.WindowDND {
		t.Fatalf("dnd %+v %v", view.ServiceWindow, err)
	}
	if _, err = page.Order(ctx, token, json.RawMessage(`{"lines":[]}`)); err != nil {
		t.Fatal(err)
	}
	if _, err = page.Request(ctx, token, domain.GuestRequestInput{Kind: "towels"}); err != nil || sv.requests != 1 {
		t.Fatalf("request %v", err)
	}
	_, err = page.Request(ctx, token, domain.GuestRequestInput{Kind: "cleaning"})
	wantCode(t, err, errs.CodeValidation)
	if _, err = page.SetPreferences(ctx, token, domain.Preferences{Notes: "Extra pillows", ArrivalTime: "23:00"}); err != nil {
		t.Fatal(err)
	}

	saved, err := e.deps.Repo.Booking(ctx, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{}
	for _, a := range saved.GuestActions {
		kinds = append(kinds, a.Kind)
	}
	if len(kinds) != 5 || kinds[0] != domain.GuestClean || saved.Preferences.ArrivalTime != "" || saved.Preferences.Notes != "Extra pillows" {
		t.Fatalf("guest actions %v preferences %+v", kinds, saved.Preferences)
	}

	if _, err := (command.Transition{Deps: e.deps}).Handle(ctx, dian, b.ID, domain.CheckedOut); err != nil {
		t.Fatal(err)
	}
	if view, err = page.View(ctx, token); err != nil || view.State != domain.StayLinkReadOnly {
		t.Fatalf("after check-out %+v %v", view.State, err)
	}
	_, err = page.AskClean(ctx, token, "")
	wantCode(t, err, domain.CodeStayReadOnly)
	_, err = page.View(ctx, "st"+"00000000000000000000000000000000")
	wantCode(t, err, errs.CodeNotFound)
}
