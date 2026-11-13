package domain

import "testing"

// A mixed property: rooms in the "std" room type, villas in "gdn"; both types have a plan.
func mixedCatalog() Catalog {
	return Catalog{
		Villas: []Villa{{ID: "vil-m", Operation: OperationMixed}},
		Groups: []UnitGroup{{ID: "std", VillaID: "vil-m", Name: "Standard rooms", Kind: KindRoom}, {ID: "gdn", VillaID: "vil-m", Name: "Garden villas", Kind: KindVilla}},
		Units: []Unit{
			{ID: "r1", VillaID: "vil-m", GroupID: ptr("std"), Code: "MX-01", NightlyRate: 900_000},
			{ID: "v1", VillaID: "vil-m", GroupID: ptr("gdn"), Code: "MX-10", NightlyRate: 3_000_000},
			{ID: "v2", VillaID: "vil-m", GroupID: ptr("gdn"), Code: "MX-11"},
		},
		RatePlans: []RatePlan{{GroupID: "std", WeekdayRate: 1_000_000, WeekendRate: 1_200_000}, {GroupID: "gdn", WeekdayRate: 2_500_000, WeekendRate: 2_800_000}},
	}
}

func priced(t *testing.T, c Catalog, unitID string, listing *Listing, dates ...string) []NightPrice {
	t.Helper()
	unit, _ := c.Unit(unitID)
	list := PriceListFor(c, unit, listing)
	if list == nil {
		t.Fatalf("%s: no price list", unitID)
	}
	out := make([]NightPrice, len(dates))
	for i, d := range dates {
		out[i] = list.Night(unit.NightlyRate, d)
	}
	return out
}

// 2026-11-19 is a Thursday, 2026-11-20 a Friday.
func TestRoomSellsAtItsRatePlanEvenWithAListing(t *testing.T) {
	c := mixedCatalog()
	listing := &Listing{DateRates: map[string]int64{"2026-11-19": 5_000_000}}
	eq(t, "room", priced(t, c, "r1", listing, "2026-11-19", "2026-11-20"), []NightPrice{
		{Date: "2026-11-19", Rate: 1_000_000, Source: PriceSource{Kind: "plan", Name: "Weekday"}},
		{Date: "2026-11-20", Rate: 1_200_000, Source: PriceSource{Kind: "plan", Name: "Weekend"}},
	})
}

func TestVillaSellsAtListingElseNightlyRateElsePlan(t *testing.T) {
	c := mixedCatalog()
	listing := &Listing{DateRates: map[string]int64{"2026-11-20": 3_500_000}}
	eq(t, "listing", priced(t, c, "v1", listing, "2026-11-19", "2026-11-20"), []NightPrice{
		{Date: "2026-11-19", Rate: 3_000_000, Source: PriceSource{Kind: "listing"}},
		{Date: "2026-11-20", Rate: 3_500_000, Source: PriceSource{Kind: "listing"}},
	})
	eq(t, "nightly rate", priced(t, c, "v1", nil, "2026-11-20"), []NightPrice{{Date: "2026-11-20", Rate: 3_000_000, Source: PriceSource{Kind: "villa"}}})
	eq(t, "plan", priced(t, c, "v2", nil, "2026-11-20"), []NightPrice{{Date: "2026-11-20", Rate: 2_800_000, Source: PriceSource{Kind: "plan", Name: "Weekend"}}})
}

func TestNoPriceNamesWhatIsMissing(t *testing.T) {
	c := mixedCatalog()
	c.RatePlans = nil
	room, _ := c.Unit("r1")
	eq(t, "room list", PriceListFor(c, room, &Listing{}) == nil, true)
	eq(t, "room", ErrNoPrice(c, room).Error(), "NO_PRICE: Standard rooms has no rate plan. Add one on the room type page.")
	villa, _ := c.Unit("v2")
	eq(t, "villa list", PriceListFor(c, villa, nil) == nil, true)
	eq(t, "villa", ErrNoPrice(c, villa).Error(), "NO_PRICE: MX-11 has no live Airbnb listing, no nightly rate and no rate plan. Set its nightly rate on the unit page.")
}

func TestRepricingKeepsSoldNights(t *testing.T) {
	c := mixedCatalog()
	b := Booking{Source: Direct, CheckIn: "2026-11-19"}
	b.SetNights([]NightPrice{{Date: "2026-11-19", Rate: 1_800_000, Source: PriceSource{Kind: "listing"}}})
	unit, _ := c.Unit("v1")
	list := PriceListFor(c, unit, nil)
	next := RepriceNights(b.CheckIn, b.SoldNights(), "2026-11-19", "2026-11-21", func(d string) NightPrice { return list.Night(unit.NightlyRate, d) })
	eq(t, "kept and new", next, []NightPrice{
		{Date: "2026-11-19", Rate: 1_800_000, Source: PriceSource{Kind: "listing"}},
		{Date: "2026-11-20", Rate: 3_000_000, Source: PriceSource{Kind: "villa"}},
	})
}
