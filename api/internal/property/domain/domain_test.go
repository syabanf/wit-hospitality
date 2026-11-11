package domain

import (
	"reflect"
	"strings"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// The cases mirror src/domain/ratePlan.test.ts and src/domain/property.test.ts.

var plan = RatePlan{
	GroupID: "grp-a", WeekdayRate: 1_000_000, WeekendRate: 1_200_000,
	Seasons: []Season{
		{Name: "High season", From: "12-20", To: "01-05", Kind: SeasonSurcharge, Value: 40},
		{Name: "New Year week", From: "12-28", To: "01-02", Kind: SeasonFixed, Value: 3_000_000},
	},
}

func TestPlanNightWeekdayAndWeekend(t *testing.T) {
	// 2026-11-19 is a Thursday.
	want := []NightPrice{{1_000_000, "Weekday"}, {1_200_000, "Weekend"}, {1_200_000, "Weekend"}, {1_000_000, "Weekday"}}
	for i, d := range []string{"2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"} {
		if got := PlanNight(plan, d); got != want[i] {
			t.Errorf("%s: %+v, want %+v", d, got, want[i])
		}
	}
}

func TestPlanNightSurchargeAcrossTheNewYear(t *testing.T) {
	cases := map[string]NightPrice{
		"2026-12-21": {1_400_000, "High season"},
		"2027-01-08": {1_200_000, "Weekend"},
		"2027-01-04": {1_400_000, "High season"},
		"2026-12-31": {3_000_000, "New Year week"},
	}
	for d, want := range cases {
		if got := PlanNight(plan, d); got != want {
			t.Errorf("%s: %+v, want %+v", d, got, want)
		}
	}
}

func TestNarrowerSeasonWinsWhateverTheOrder(t *testing.T) {
	reversed := []Season{plan.Seasons[1], plan.Seasons[0]}
	if s := SeasonOn(reversed, "2026-12-31"); s == nil || s.Name != "New Year week" {
		t.Fatalf("got %v", s)
	}
	if s := SeasonOn(reversed, "2026-12-27"); s == nil || s.Name != "High season" {
		t.Fatalf("got %v", s)
	}
	a, b := plan.Seasons[1], plan.Seasons[1]
	a.Name, b.Name = "A", "B"
	if s := SeasonOn([]Season{a, b}, "2026-12-30"); s == nil || s.Name != "B" {
		t.Fatalf("equal length: the season listed last wins, got %v", s)
	}
}

func TestValidateRatePlan(t *testing.T) {
	ok := RatePlanInput{WeekdayRate: 1_000_000, WeekendRate: 1_200_000, Seasons: []SeasonInput{{Name: "High season", From: "12-20", To: "01-05", Kind: SeasonSurcharge, Value: 40}}}
	if got := RatePlanErrors(ok); len(got) != 0 {
		t.Fatalf("valid plan refused: %v", got)
	}
	bad := RatePlanInput{WeekdayRate: 0, WeekendRate: 1.5, Seasons: []SeasonInput{{Name: "x", From: "02-30", To: "13-01", Kind: SeasonSurcharge, Value: 500}}}
	want := map[string]string{
		"weekdayRate":     "Enter the weekday rate in whole rupiah.",
		"weekendRate":     "Enter the weekend rate in whole rupiah.",
		"seasons.0.name":  "Name the season.",
		"seasons.0.from":  "Pick the first night.",
		"seasons.0.to":    "Pick the last night.",
		"seasons.0.value": "A whole percentage above 0, up to 300.",
	}
	if got := RatePlanErrors(bad); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	leap := RatePlanInput{WeekdayRate: 1, WeekendRate: 1, Seasons: []SeasonInput{{Name: "Leap", From: "02-29", To: "02-29", Kind: SeasonFixed, Value: 0}}}
	if got := RatePlanErrors(leap); !reflect.DeepEqual(got, map[string]string{"seasons.0.value": "Enter the nightly price in whole rupiah."}) {
		t.Fatalf("got %v", got)
	}
	err := ValidateRatePlan(bad)
	if e, _ := errs.As(err); e == nil || e.Code != errs.CodeValidation || e.Message != "Enter the weekday rate in whole rupiah." {
		t.Fatalf("first error becomes the message, got %v", err)
	}
}

func TestDefaultRatePlan(t *testing.T) {
	p := DefaultRatePlan(1_850_000)
	if p.WeekdayRate != 1_850_000 || p.WeekendRate != 2_220_000 || len(p.Seasons) != 0 {
		t.Fatalf("got %+v", p)
	}
	if p := DefaultRatePlan(1_000); p.WeekendRate != 1_000 {
		t.Fatalf("weekend never goes below the base, got %v", p.WeekendRate)
	}
}

func fieldOf(err error, field string) string {
	e, ok := errs.As(err)
	if !ok {
		return ""
	}
	return errs.Fields(e.Fields).Map()[field]
}

func TestValidateUnit(t *testing.T) {
	g1 := &UnitGroup{ID: "g1", VillaID: "v1"}
	g2 := &UnitGroup{ID: "g2", VillaID: "v2"}
	grp := "g1"
	base := UnitInput{VillaID: "v1", GroupID: &grp, Code: "SK-01", Name: "Saka 9", Bedrooms: 1, NightlyRate: 1_000_000, Status: UnitActive}
	if !strings.Contains(fieldOf(ValidateUnit(base, true, g1), "code"), "already used") {
		t.Fatal("duplicate code accepted")
	}
	bad := base
	bad.Code = "sk9"
	if !strings.Contains(fieldOf(ValidateUnit(bad, false, g1), "code"), "two digits") {
		t.Fatal("malformed code accepted")
	}
	other := base
	other.Code, other.GroupID = "SK-09", ptr("g2")
	if !strings.Contains(fieldOf(ValidateUnit(other, false, g2), "groupId"), "another villa") {
		t.Fatal("group of another villa accepted")
	}
	if err := ValidateUnit(base, false, g1); err != nil {
		t.Fatalf("valid unit refused: %v", err)
	}
	frac := base
	frac.NightlyRate = 1.5
	if fieldOf(ValidateUnit(frac, false, g1), "nightlyRate") != "Enter the nightly rate in whole rupiah." {
		t.Fatal("fractional rate accepted")
	}
}

func ptr(s string) *string { return &s }

func TestValidateVillaAndGroup(t *testing.T) {
	in := VillaInput{LocationID: "l1", Code: "SK", Name: "Dup"}
	if !strings.Contains(fieldOf(ValidateVilla(in, true), "code"), "already used") {
		t.Fatal("duplicate villa code accepted")
	}
	if fieldOf(ValidateGroup(GroupInput{VillaID: "v1", Name: "Std", OperatorAssigns: true}), "operatorAssigns") == "" {
		t.Fatal("room type selling without interchangeable rooms accepted")
	}
}

func TestUnitAndGroupRules(t *testing.T) {
	u := Unit{Code: "SK-01", Status: UnitActive}
	if err := u.CheckDeactivate(UnitInactive, true); !errs.HasCode(err, "UNIT_IN_USE") {
		t.Fatalf("got %v", err)
	}
	if err := u.CheckDeactivate(UnitInactive, false); err != nil {
		t.Fatalf("got %v", err)
	}
	g := UnitGroup{OperatorAssigns: true, Interchangeable: true}
	err := g.CheckRoomTypeSelling(GroupInput{Interchangeable: true}, []string{"BK-1", "BK-2"})
	if e, _ := errs.As(err); e == nil || e.Code != "ROOMS_TO_ASSIGN" || e.Message != "BK-1, BK-2 still wait for a room. Assign them first." {
		t.Fatalf("got %v", err)
	}
}

func TestWizard(t *testing.T) {
	zero := 0
	in := PropertyInput{
		Villa:  VillaInput{LocationID: "loc", Code: "NW", Name: "New villa"},
		Groups: []WizardGroup{{Name: "Pool suites", Interchangeable: true, OperatorAssigns: true}},
		Rooms: []WizardRoom{
			{Code: "NW-01", Name: "Suite 1", Bedrooms: 1, NightlyRate: 2_000_000, GroupIndex: &zero},
			{Code: "NW-02", Name: "Suite 2", Bedrooms: 1, NightlyRate: 2_000_000, GroupIndex: &zero},
			{Code: "NW-03", Name: "Garden", Bedrooms: 2, NightlyRate: 1_500_000},
		},
	}
	types := WizardTypes(in)
	if len(types) != 2 || types[0].Key != "g0" || types[1].Key != "r2" || !reflect.DeepEqual(types[0].Rooms, []int{0, 1}) {
		t.Fatalf("got %+v", types)
	}
	if types[0].Plan.WeekendRate != 2_400_000 || types[1].Plan.WeekdayRate != 1_500_000 || !types[0].OperatorAssigns {
		t.Fatalf("plans start from the first room's base: %+v", types)
	}
	if err := ValidateProperty(in, false, func(string) bool { return false }); err != nil {
		t.Fatalf("valid wizard refused: %v", err)
	}
	dup := in
	dup.Rooms = append([]WizardRoom{}, in.Rooms...)
	dup.Rooms[1].Code = "NW-01"
	dup.Rooms[2].Code = "XX-03"
	err := ValidateProperty(dup, false, func(c string) bool { return c == "NW-01" })
	m := map[string]string{}
	if e, ok := errs.As(err); ok {
		m = errs.Fields(e.Fields).Map()
	}
	if m["rooms.0.code"] != "NW-01 is already used." || m["rooms.1.code"] != "NW-01 is listed twice." || m["rooms.2.code"] != "Code must start with NW-." {
		t.Fatalf("got %v", m)
	}
	if err := ValidateProperty(PropertyInput{Villa: in.Villa}, false, func(string) bool { return false }); fieldOf(err, "rooms") != "Add at least one room." {
		t.Fatalf("empty wizard accepted: %v", err)
	}
}

func TestValidateBlock(t *testing.T) {
	ok := BlockInput{UnitID: "u", From: "2026-11-12", To: "2026-11-15", Reason: "maintenance"}
	if err := ValidateBlock(ok); err != nil {
		t.Fatal(err)
	}
	back := ok
	back.To = "2026-11-12"
	if fieldOf(ValidateBlock(back), "to") != "The end must be after the start." {
		t.Fatal("empty block accepted")
	}
	long := ok
	long.To = "2027-03-01"
	if fieldOf(ValidateBlock(long), "to") != "A stay is at most 90 nights." {
		t.Fatal("long block accepted")
	}
}
