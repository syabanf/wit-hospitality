package domain

import (
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func errCode(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	return ""
}

func TestPackageNightPricesThePlanNight(t *testing.T) {
	night := NightPrice{Date: "2026-11-11", Rate: 1_850_000, Source: PriceSource{Kind: "plan", Name: "Weekday"}}
	for _, tc := range []struct {
		pkg  *RatePackage
		rate int64
		name string
	}{
		{nil, 1_850_000, "Weekday"},
		{&RatePackage{Name: "With breakfast", Rate: PackagePlan, Breakfast: 150_000}, 1_850_000, "Weekday, With breakfast"},
		{&RatePackage{Name: "Corporate", Rate: PackageFixed, Value: 1_400_000}, 1_400_000, "Corporate"},
		{&RatePackage{Name: "Long stay", Rate: PackagePercent, Value: 15}, 1_572_500, "Weekday, Long stay"},
		// 1,850,000 less 33% is 1,239,500 exactly; 1,000,001 less 15% rounds half up.
		{&RatePackage{Name: "Agent", Rate: PackagePercent, Value: 33}, 1_239_500, "Weekday, Agent"},
	} {
		got := PackageNight(tc.pkg, night)
		if got.Rate != tc.rate || got.Source.Name != tc.name || got.Source.Kind != "plan" {
			t.Errorf("%+v: got %d %q", tc.pkg, got.Rate, got.Source.Name)
		}
	}
	if got := PackageNight(&RatePackage{Name: "Odd", Rate: PackagePercent, Value: 15}, NightPrice{Rate: 1_000_010, Source: PriceSource{Kind: "plan", Name: "Weekday"}}); got.Rate != 850_009 {
		t.Errorf("half up: got %d", got.Rate)
	}
	// A villa's own rate or a listing price is never a package price.
	villa := NightPrice{Rate: 3_000_000, Source: PriceSource{Kind: KindVilla}}
	if got := PackageNight(&RatePackage{Name: "Corporate", Rate: PackageFixed, Value: 1}, villa); got != villa {
		t.Errorf("villa night changed: %+v", got)
	}
}

func packageCatalog() Catalog {
	c := mixedCatalog()
	c.Groups = append(c.Groups, UnitGroup{ID: "dlx", VillaID: "vil-m", Name: "Deluxe rooms", Kind: KindRoom})
	c.Units = append(c.Units,
		Unit{ID: "r2", VillaID: "vil-m", GroupID: ptr("dlx"), Code: "MX-02", Status: "active"},
		Unit{ID: "r3", VillaID: "vil-m", GroupID: ptr("dlx"), Code: "MX-03", Status: "maintenance"},
		Unit{ID: "x1", VillaID: "vil-x", Code: "XX-01", Status: "active"})
	for i := range c.Units {
		if c.Units[i].Status == "" {
			c.Units[i].Status = "active"
		}
	}
	c.RatePlans[0].Packages = []RatePackage{
		{ID: "pkg-bf", Name: "With breakfast", Rate: PackagePlan, Breakfast: 150_000},
		{ID: "pkg-corp", Name: "Corporate", Rate: PackageFixed, Value: 800_000, AccountID: ptr("cl-1")},
	}
	return c
}

func TestPackageForRefusesInTheContractOrder(t *testing.T) {
	c := packageCatalog()
	room, _ := c.Unit("r1")
	villa, _ := c.Unit("v1")
	if pkg, err := PackageFor(c, room, Direct, "", ""); pkg != nil || err != nil {
		t.Fatalf("no package: %v %v", pkg, err)
	}
	for _, tc := range []struct {
		unit             Unit
		source, id, bill string
		want             string
	}{
		{villa, Direct, "pkg-bf", "", "PACKAGE_NOT_ALLOWED"},
		{room, Airbnb, "pkg-bf", "", "PACKAGE_NOT_ALLOWED"},
		{room, Airbnb, "nope", "", "PACKAGE_NOT_ALLOWED"},
		{room, Direct, "nope", "", "PACKAGE_UNKNOWN"},
		{room, Direct, "pkg-corp", "", "PACKAGE_ACCOUNT"},
		{room, Direct, "pkg-corp", "cl-2", "PACKAGE_ACCOUNT"},
		{room, Direct, "pkg-corp", "cl-1", ""},
		{room, Direct, "pkg-bf", "", ""},
	} {
		pkg, err := PackageFor(c, tc.unit, tc.source, tc.id, tc.bill)
		if errCode(err) != tc.want || (tc.want == "") != (pkg != nil) {
			t.Errorf("%s %s %s billed %q: got %v %v, want %q", tc.unit.Code, tc.source, tc.id, tc.bill, pkg, err, tc.want)
		}
	}
	_, err := PackageFor(c, room, Direct, "nope", "")
	if e, _ := errs.As(err); e.Message != "Standard rooms has no such rate package." {
		t.Errorf("message: %q", e.Message)
	}
	_, err = PackageFor(c, room, Direct, "pkg-corp", "")
	if e, _ := errs.As(err); e.Message != "Corporate is a company rate; bill the stay to its city ledger account." {
		t.Errorf("message: %q", e.Message)
	}
}

func TestARoomMovesAcrossRoomTypesAndAVillaOnlyBetweenInterchangeableUnits(t *testing.T) {
	c := packageCatalog()
	unit := func(id string) Unit { u, _ := c.Unit(id); return u }
	// The room reaches the other active room of the property, whatever its type; never a villa.
	var codes []string
	for _, u := range MoveTargets(c, "r1") {
		codes = append(codes, u.Code)
	}
	if len(codes) != 1 || codes[0] != "MX-02" {
		t.Fatalf("room targets: %v", codes)
	}
	if got := MoveTargets(c, "v1"); len(got) != 0 {
		t.Fatalf("villas that are not interchangeable move nowhere: %v", got)
	}
	for _, tc := range []struct{ from, to, want string }{
		{"r1", "r2", ""},
		{"r1", "r3", "UNIT_UNAVAILABLE"},
		{"r1", "v1", "UNIT_NOT_INTERCHANGEABLE"},
		{"r1", "x1", "UNIT_NOT_INTERCHANGEABLE"},
		{"r1", "r1", "UNIT_NOT_INTERCHANGEABLE"},
		{"v1", "v2", "UNIT_NOT_INTERCHANGEABLE"},
		{"v1", "r1", "UNIT_NOT_INTERCHANGEABLE"},
	} {
		if got := errCode(CheckMoveTarget(c, unit(tc.from), unit(tc.to))); got != tc.want {
			t.Errorf("%s to %s: got %q, want %q", tc.from, tc.to, got, tc.want)
		}
	}
	err := CheckMoveTarget(c, unit("r1"), unit("r3"))
	if e, _ := errs.As(err); e.Message != "MX-03 is maintenance." {
		t.Errorf("message: %q", e.Message)
	}
	// Interchangeable villas still swap.
	for i := range c.Groups {
		if c.Groups[i].ID == "gdn" {
			c.Groups[i].Interchangeable = true
		}
	}
	if err := CheckMoveTarget(c, unit("v1"), unit("v2")); err != nil {
		t.Errorf("interchangeable villas: %v", err)
	}
}

func TestRepriceFromKeepsThePostedAndPastNights(t *testing.T) {
	b := Booking{CheckIn: "2026-11-09", CheckOut: "2026-11-14"}
	if got := RepriceFrom(b, "2026-11-11"); got != 2 {
		t.Errorf("two nights slept: got %d", got)
	}
	posted := []string{"2026-11-09", "2026-11-10", "2026-11-11"}
	b.NightsPosted = &posted
	if got := RepriceFrom(b, "2026-11-11"); got != 3 {
		t.Errorf("three nights posted: got %d", got)
	}
	if got := RepriceFrom(Booking{CheckIn: "2026-11-20"}, "2026-11-11"); got != 0 {
		t.Errorf("before check-in every night reprices: got %d", got)
	}
}
