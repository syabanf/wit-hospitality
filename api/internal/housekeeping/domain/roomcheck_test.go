package domain_test

import (
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func fieldOf(err error, field string) string {
	e, ok := errs.As(err)
	if !ok {
		return ""
	}
	return errs.Fields(e.Fields).Map()[field]
}

func TestADiscrepancyComparesTheRoundWithTheFrontOffice(t *testing.T) {
	two, three := 2, 3
	cases := []struct {
		found    string
		persons  *int
		occupied bool
		front    *int
		want     string
		name     string
	}{
		{domain.FoundVacant, nil, true, &two, domain.DiscrepancySleep, "a guest in house, an empty room"},
		{domain.FoundOutOfOrder, nil, true, nil, domain.DiscrepancySleep, "out of order with a guest in house"},
		{domain.FoundOccupied, nil, false, nil, domain.DiscrepancySkip, "someone in a vacant room"},
		{domain.FoundOccupied, &three, true, &two, domain.DiscrepancyPersons, "three seen, two registered"},
		{domain.FoundOccupied, nil, true, &two, "", "not counted"},
		{domain.FoundOccupied, &two, true, nil, "", "the front office has no count"},
		{domain.FoundOutOfOrder, nil, false, nil, "", "out of order and vacant"},
		{domain.FoundVacant, nil, false, nil, "", "both vacant"},
	}
	for _, c := range cases {
		if got := domain.DiscrepancyOf(c.found, c.persons, c.occupied, c.front); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestTheFrontOfficeHasARoomOccupiedByAStayCheckedInOnIt(t *testing.T) {
	stays := []domain.Stay{
		{ID: "b1", UnitID: "u1", UnitAssigned: true, Status: "checked_out", CheckIn: "2026-11-05", CheckOut: "2026-11-08"},
		{ID: "b2", UnitID: "u1", UnitAssigned: true, Status: "checked_in", CheckIn: "2026-11-09", CheckOut: "2026-11-11"},
		{ID: "b3", UnitID: "u2", UnitAssigned: false, Status: "checked_in", CheckIn: "2026-11-09", CheckOut: "2026-11-13"},
	}
	if s := domain.FrontOfficeStay(stays, "u1", "2026-11-11"); s == nil || s.ID != "b2" {
		t.Fatalf("a guest due out who has not left is in house: %+v", s)
	}
	if s := domain.FrontOfficeStay(stays, "u1", "2026-11-08"); s != nil {
		t.Fatalf("a stay that arrived after the date: %+v", s)
	}
	if s := domain.FrontOfficeStay(stays, "u2", "2026-11-11"); s != nil {
		t.Fatalf("a stay without its room: %+v", s)
	}
}

func TestARoomCheckNeedsADayAndWhatWasFound(t *testing.T) {
	zero, five := 0, 5
	in := domain.RoomCheckInput{UnitID: "u1", Date: "2026-11-12", Found: "empty", Persons: &zero}
	err := domain.ValidateRoomCheck(&in, "2026-11-11")
	if fieldOf(err, "date") != "2026-11-12 has not come yet." || fieldOf(err, "found") != "Pick what housekeeping found." {
		t.Fatalf("future day and unknown status: %v", err)
	}
	in = domain.RoomCheckInput{UnitID: "u1", Date: "2026-11-11", Found: domain.FoundOccupied, Persons: &zero}
	if fieldOf(domain.ValidateRoomCheck(&in, "2026-11-11"), "persons") != "Enter the guests seen as a whole number from 1, or leave it empty." {
		t.Fatal("zero guests seen")
	}
	in = domain.RoomCheckInput{UnitID: "u1", Date: "2026-11-11", Found: domain.FoundVacant, Persons: &five}
	if err := domain.ValidateRoomCheck(&in, "2026-11-11"); err != nil || in.Persons != nil {
		t.Fatalf("a vacant room keeps no count: %v %v", err, in.Persons)
	}
}

func TestADiscrepancyResolvesWithAnActionThatFitsIt(t *testing.T) {
	sleep := domain.DiscrepancySleep
	c := domain.RoomCheck{Date: "2026-11-11", Discrepancy: &sleep}
	err := domain.ValidateResolve(c, "SK-03", domain.ResolveInput{Action: "checked_in", Note: "ok"})
	if fieldOf(err, "action") != "Checked in the walk-in does not settle a sleep discrepancy." || fieldOf(err, "note") != "Say what the desk found." {
		t.Fatalf("wrong action and short note: %v", err)
	}
	if err := domain.ValidateResolve(c, "SK-03", domain.ResolveInput{Action: "guest_out", Note: "Guest stayed with friends"}); err != nil {
		t.Fatal(err)
	}
	c.Resolution = &domain.Resolution{By: "Dian Permata"}
	if err := domain.ValidateResolve(c, "SK-03", domain.ResolveInput{Action: "guest_out", Note: "again"}); !errs.HasCode(err, "DISCREPANCY_RESOLVED") || err.(*errs.Error).Message != "SK-03 on 2026-11-11 was resolved by Dian Permata." {
		t.Fatalf("resolved twice: %v", err)
	}
	if err := domain.ValidateResolve(domain.RoomCheck{Date: "2026-11-11"}, "SK-03", domain.ResolveInput{}); !errs.HasCode(err, "DISCREPANCY_NONE") {
		t.Fatalf("nothing to resolve: %v", err)
	}
}

func TestTheCheckSummaryNamesTheCountAndTheDiscrepancy(t *testing.T) {
	one, persons := 1, domain.DiscrepancyPersons
	got := domain.CheckSummary(domain.RoomCheck{Date: "2026-11-11", Found: domain.FoundOccupied, Persons: &one, Discrepancy: &persons}, "SK-02")
	if got != "Recorded SK-02 on 2026-11-11: Occupied, 1 guest, Person count discrepancy" {
		t.Fatal(got)
	}
}
