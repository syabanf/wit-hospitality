package domain

import (
	"reflect"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func intp(n int) *int { return &n }

func wholeCatalog() Catalog {
	room, villa := "g-room", "g-villa"
	return Catalog{
		Villas: []Villa{{ID: "v", Name: "Villa Tirta", Operation: OperationMixed, WholeRental: true, DepositOnCheckIn: true}, {ID: "h", Name: "Hotel", Operation: OperationHotel, DepositOnCheckIn: true}},
		Groups: []UnitGroup{{ID: room, VillaID: "v", Kind: KindRoom}, {ID: villa, VillaID: "v", Kind: KindVilla}},
		Units: []Unit{
			{ID: "u1", VillaID: "v", GroupID: &villa, Code: "VT-01", Status: "active", MaxAdults: intp(4), MaxChildren: intp(2), ExtraBeds: intp(0)},
			{ID: "u2", VillaID: "v", GroupID: &villa, Code: "VT-02", Status: "active", MaxAdults: intp(2), MaxChildren: intp(1), ExtraBeds: intp(1)},
			{ID: "u3", VillaID: "v", GroupID: &villa, Code: "VT-03", Status: "inactive"},
			{ID: "u4", VillaID: "v", GroupID: &room, Code: "VT-201", Status: "active"},
			{ID: "u5", VillaID: "h", Code: "HT-101", Status: "active"},
		},
	}
}

func TestUnitKindAndDeposit(t *testing.T) {
	c := wholeCatalog()
	kinds := map[string]string{}
	deposit := map[string]bool{}
	for _, u := range c.Units {
		kinds[u.ID], deposit[u.ID] = c.UnitKind(u), c.DepositAsked(u)
	}
	if kinds["u1"] != KindVilla || kinds["u4"] != KindRoom || kinds["u5"] != KindRoom {
		t.Fatalf("kinds %v", kinds)
	}
	if !deposit["u1"] || deposit["u4"] || !deposit["u5"] {
		t.Fatalf("a mixed property asks the deposit of its villas only; a hotel that sets it asks every room: %v", deposit)
	}
}

func TestWholeVillaRules(t *testing.T) {
	c := wholeCatalog()
	v, _ := c.Villa("v")
	units := WholeVillaUnits(c, "v")
	if len(units) != 2 || units[0].ID != "u1" || units[1].ID != "u2" {
		t.Fatalf("the villa units that are not inactive: %+v", units)
	}
	hotel, _ := c.Villa("h")
	if !errs.HasCode(CheckWholeRental(hotel, WholeVillaUnits(c, "h")), CodeWholeVillaNotAllowed) {
		t.Fatal("a hotel was rented whole")
	}
	if err := CheckWholeRental(v, units); err != nil {
		t.Fatal(err)
	}
	held := []Holding{{ID: "b1", Code: "BK-1", UnitID: "u2", UnitAssigned: true, Status: Confirmed, CheckIn: "2026-12-01", CheckOut: "2026-12-03"}}
	err := CheckWholeVillaFree(v, units, "2026-12-02", "2026-12-05", held, nil)
	if e, _ := errs.As(err); e == nil || e.Code != CodeWholeVillaUnavailable || e.Message != "Villa Tirta has VT-02 taken on those nights." {
		t.Fatalf("got %v", err)
	}
	if err := CheckWholeVillaFree(v, units, "2026-12-03", "2026-12-05", held, nil); err != nil {
		t.Fatal(err)
	}
	blocks := []UnitBlock{{ID: "blk", UnitID: "u1", From: "2026-12-04", To: "2026-12-06"}}
	if !errs.HasCode(CheckWholeVillaFree(v, units, "2026-12-03", "2026-12-05", nil, blocks), CodeWholeVillaUnavailable) {
		t.Fatal("a block over the stay was ignored")
	}
	room, ok := WholeVillaCapacity(v, units)
	if !ok || room.Check(7, 0) != nil || room.Check(8, 0) == nil || room.Check(6, 4) != nil || room.Check(6, 5) == nil {
		t.Fatalf("capacity summed per unit: %+v", room)
	}
	spread := SpreadParty(units, 6, 3)
	if *spread[0] != (PartySize{Adults: 4, Children: 2}) || *spread[1] != (PartySize{Adults: 2, Children: 1}) {
		t.Fatalf("spread %+v %+v", *spread[0], *spread[1])
	}
	if small := SpreadParty(units, 2, 0); small[1] != nil {
		t.Fatal("a unit nobody sleeps in has no party")
	}
	if got := SplitNightly(10_000_001, 3); !reflect.DeepEqual(got, []int64{3_333_335, 3_333_333, 3_333_333}) {
		t.Fatalf("split %v", got)
	}
}
