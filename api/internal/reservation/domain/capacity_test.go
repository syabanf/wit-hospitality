package domain

import (
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func intPtr(n int) *int { return &n }

func TestCapacityFits(t *testing.T) {
	c := Capacity{Name: "Garden Suite", MaxAdults: 2, MaxChildren: 1, ExtraBeds: 1}
	cases := []struct {
		adults, children int
		fits             bool
	}{
		{2, 1, true}, {3, 1, true}, {3, 0, true}, {1, 3, true},
		{4, 0, false}, {2, 3, false}, {3, 2, false},
	}
	for _, tc := range cases {
		if got := c.Fits(tc.adults, tc.children); got != tc.fits {
			t.Errorf("Fits(%d, %d) = %v, want %v", tc.adults, tc.children, got, tc.fits)
		}
	}
	err := c.Check(4, 0)
	e, ok := errs.As(err)
	if !ok || e.Code != "UNIT_CAPACITY" || e.Message != "Garden Suite sleeps 2 adults and 1 child, plus 1 extra bed." {
		t.Fatalf("Check: %v", err)
	}
}

func TestUnitAndGroupCapacity(t *testing.T) {
	g := "grp-a"
	c := Catalog{
		Groups: []UnitGroup{{ID: g, Name: "Deluxe", Interchangeable: true, OperatorAssigns: true}},
		Units: []Unit{
			{ID: "u1", Name: "Deluxe 1", GroupID: &g, MaxAdults: intPtr(4), MaxChildren: intPtr(1), ExtraBeds: intPtr(2)},
			{ID: "u2", Name: "Deluxe 2", GroupID: &g, MaxAdults: intPtr(2), MaxChildren: intPtr(2), ExtraBeds: intPtr(0)},
			{ID: "u3", Name: "Deluxe 3", GroupID: &g},
			{ID: "u4", Name: "Other", MaxAdults: intPtr(1), MaxChildren: intPtr(0), ExtraBeds: intPtr(0)},
		},
	}
	got, ok := GroupCapacity(c, c.Groups[0])
	if !ok || got != (Capacity{Name: "Deluxe", MaxAdults: 2, MaxChildren: 1, ExtraBeds: 0}) {
		t.Fatalf("GroupCapacity = %+v %v", got, ok)
	}
	if err := CheckGroupFits(c, c.Groups[0], 3, 0); !errs.HasCode(err, "UNIT_CAPACITY") {
		t.Fatalf("group 3 adults: %v", err)
	}
	if err := CheckUnitFits(c, "u1", 6, 0); err != nil {
		t.Fatalf("u1 6 adults: %v", err)
	}
	if err := CheckUnitFits(c, "u3", 20, 0); err != nil {
		t.Fatalf("unknown capacity must pass: %v", err)
	}
	if _, ok := GroupCapacity(c, UnitGroup{ID: "none"}); ok {
		t.Fatal("empty group has no capacity")
	}
}

func TestBookingParty(t *testing.T) {
	b := Booking{}
	if _, _, ok := b.Party(); ok {
		t.Fatal("no party")
	}
	b.PartySize = &PartySize{Adults: 2, Children: 1}
	if a, c, ok := b.Party(); !ok || a != 2 || c != 1 {
		t.Fatal("party size")
	}
	b.Arrival = &CheckInDetails{Adults: 3}
	if a, c, ok := b.Party(); !ok || a != 3 || c != 0 {
		t.Fatal("arrival wins")
	}
}
