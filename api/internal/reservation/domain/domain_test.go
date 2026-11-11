package domain

import (
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

func ptr[T any](v T) *T { return &v }

func code(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	return ""
}

func fields(err error) map[string]string {
	if e, ok := errs.As(err); ok {
		return errs.Fields(e.Fields).Map()
	}
	return map[string]string{}
}

func eq[T any](t *testing.T, label string, got, want T) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %#v, want %#v", label, got, want)
	}
}

// Ported from src/domain/booking.test.ts.

func held(id, code, unit string, assigned bool, status, in, out string) Holding {
	return Holding{ID: id, Code: code, UnitID: unit, UnitAssigned: assigned, Status: status, CheckIn: in, CheckOut: out}
}

var block = UnitBlock{ID: "k1", UnitID: "u1", From: "2026-10-10", To: "2026-10-12", Reason: "maintenance"}

func TestSameDayCheckOutAndCheckInAreFree(t *testing.T) {
	eq(t, "touching", Overlaps("2026-10-01", "2026-10-05", "2026-10-05", "2026-10-08"), false)
	eq(t, "overlapping", Overlaps("2026-10-01", "2026-10-06", "2026-10-05", "2026-10-08"), true)
}

func TestFindConflictsIgnoresDraftsAndTheBookingItself(t *testing.T) {
	list := []Holding{held("b1", "BK-1", "u1", true, Confirmed, "2026-10-05", "2026-10-08"), held("b2", "BK-2", "u1", true, Draft, "2026-10-09", "2026-10-11")}
	var labels []string
	for _, c := range FindConflicts("u1", "2026-10-06", "2026-10-11", list, []UnitBlock{block}, "") {
		labels = append(labels, c.Label)
	}
	eq(t, "labels", labels, []string{"BK-1", "Maintenance"})
	eq(t, "excluded", len(FindConflicts("u1", "2026-10-06", "2026-10-07", list, []UnitBlock{block}, "b1")), 0)
}

func TestValidateStay(t *testing.T) {
	if !strings.Contains(ValidateStay("2026-10-05", "2026-10-05"), "after") {
		t.Error("same day")
	}
	if !strings.Contains(ValidateStay("2026-10-05", "2027-02-05"), "90") {
		t.Error("too long")
	}
	eq(t, "fine", ValidateStay("2026-10-05", "2026-10-06"), "")
}

func TestLifecycleOneStepAtATime(t *testing.T) {
	eq(t, "draft", NextStep(Draft), Confirmed)
	eq(t, "in house", NextStep(CheckedIn), CheckedOut)
	eq(t, "out", NextStep(CheckedOut), "")
	eq(t, "cancel in house", CanTransition(CheckedIn, Cancelled), false)
	eq(t, "cancel confirmed", CanTransition(Confirmed, Cancelled), true)
	b := Booking{Status: CheckedOut}
	if err := b.CheckTransition(Cancelled); err == nil || err.Error() != "BOOKING_INVALID_STATE: A checked out booking cannot become cancelled." {
		t.Errorf("refusal: %v", err)
	}
}

func typeCatalog(rooms ...Unit) Catalog {
	return Catalog{
		Villas: []Villa{{ID: "v1", LocationID: "l1", Name: "Saka"}},
		Groups: []UnitGroup{{ID: "g1", VillaID: "v1", Name: "Std", Interchangeable: true, OperatorAssigns: true}, {ID: "single", VillaID: "v1", Name: "Single"}},
		Units:  rooms,
	}
}

func room(id, group string) Unit {
	return Unit{ID: id, VillaID: "v1", GroupID: ptr(group), Code: strings.ToUpper(id), NightlyRate: 1_000_000, Status: "active"}
}

func TestTypeAvailabilityCountsStaysWaitingForARoom(t *testing.T) {
	c := typeCatalog(room("u1", "g1"), room("u2", "g1"))
	stays := []Holding{held("b1", "BK-1", "u1", true, Confirmed, "2026-10-05", "2026-10-08"), held("b2", "BK-2", "u1", false, Confirmed, "2026-10-07", "2026-10-09")}
	eq(t, "free early", TypeAvailabilityOf(c, "g1", "2026-10-05", "2026-10-07", stays, nil, "", 0).Free, 1)
	tight := TypeAvailabilityOf(c, "g1", "2026-10-06", "2026-10-09", stays, nil, "", 0)
	eq(t, "tight", tight.Free, 0)
	eq(t, "assignable", []string{tight.Units[0].ID}, []string{"u2"})
	eq(t, "waiting holds no room", len(FindConflicts("u1", "2026-10-08", "2026-10-09", stays, nil, "")), 0)
	eq(t, "excluded", TypeAvailabilityOf(c, "g1", "2026-10-06", "2026-10-09", stays, nil, "b2", 0).Free, 1)
}

// Ported from src/domain/overbooking.test.ts.

func TestOverbookingSellsPastTheRoomsUpToThePolicy(t *testing.T) {
	c := typeCatalog(room("a1", "g1"), room("a2", "g1"), room("b1", "single"))
	stays := []Holding{held("x", "x", "a1", true, Confirmed, "2026-11-20", "2026-11-22"), held("y", "y", "a1", false, Confirmed, "2026-11-20", "2026-11-21")}
	a := TypeAvailabilityOf(c, "g1", "2026-11-20", "2026-11-21", stays, nil, "", 0)
	eq(t, "no policy", [2]int{a.Free, a.Sellable}, [2]int{0, 0})
	a = TypeAvailabilityOf(c, "g1", "2026-11-20", "2026-11-21", stays, nil, "", 1)
	eq(t, "one over", [2]int{a.Free, a.Sellable}, [2]int{0, 1})
	over := append(stays, held("z", "z", "a1", false, Confirmed, "2026-11-20", "2026-11-21"))
	eq(t, "used up", TypeAvailabilityOf(c, "g1", "2026-11-20", "2026-11-21", over, nil, "", 1).Sellable, 0)
}

func TestOverbookedNights(t *testing.T) {
	c := typeCatalog(room("a1", "g1"), room("a2", "g1"), room("b1", "single"))
	stays := []Holding{held("x", "x", "a1", true, Confirmed, "2026-11-20", "2026-11-22"), held("y", "y", "a1", false, Confirmed, "2026-11-20", "2026-11-23"), held("z", "z", "a1", false, Confirmed, "2026-11-21", "2026-11-22")}
	eq(t, "nights", OverbookedNights(c, "g1", "2026-11-19", "2026-11-24", stays, nil), []OverbookedNight{{GroupID: "g1", Date: "2026-11-21", Rooms: 2, Held: 3, Over: 1}})
	blocks := []UnitBlock{{ID: "k", UnitID: "a2", From: "2026-11-20", To: "2026-11-21", Reason: "maintenance"}}
	got := OverbookedNights(c, "g1", "2026-11-20", "2026-11-21", stays, blocks)
	eq(t, "blocked", len(got) == 1 && got[0].Over == 1, true)
	eq(t, "room by room", len(OverbookedNights(c, "single", "2026-11-20", "2026-11-22", []Holding{held("s", "s", "b1", true, Confirmed, "2026-11-20", "2026-11-22")}, nil)), 0)
}

func TestOverbookPolicyAndWalkForm(t *testing.T) {
	eq(t, "limit", OverbookLimit([]OverbookPolicy{{GroupID: "type", Limit: 2}}, "type"), 2)
	eq(t, "none", OverbookLimit(nil, "type"), 0)
	eq(t, "zero ok", ValidateOverbook(0), nil)
	if err := ValidateOverbook(6); err == nil || !strings.Contains(err.Error(), "0 to 5") {
		t.Errorf("six: %v", err)
	}
	if ValidateOverbook(1.5) == nil {
		t.Error("fraction")
	}
	eq(t, "walk to a villa", fields(ValidateWalk(WalkInput{Destination: "group_villa", Cost: -1, Method: "cash"})), map[string]string{"unitId": "Pick the unit the guest moves to.", "cost": "Enter the cost in whole rupiah, or zero.", "reason": "Say why the guest is walked."})
	eq(t, "walk outside", fields(ValidateWalk(WalkInput{Destination: "outside", Property: "X", Method: "cash", Reason: "Overbooked"})), map[string]string{"property": "Name the property the guest goes to."})
}

// Ported from src/domain/restriction.test.ts.

func rule(f func(r *Restriction)) Restriction {
	r := Restriction{ID: "r", GroupID: "grp-a", Rule: "min_stay", Nights: ptr(3), Yearly: true, From: "07-01", To: "08-31", Weekdays: []int{}, CreatedBy: "Kadek", CreatedOn: "2026-01-01"}
	if f != nil {
		f(&r)
	}
	return r
}

func oneOff(kind, from, to string) Restriction {
	return rule(func(r *Restriction) { r.Rule, r.Nights, r.Yearly, r.From, r.To = kind, nil, false, from, to })
}

func rules(list []Restriction, in, out, unit string) []string {
	got := []string{}
	for _, v := range EvaluateStay(list, StayShape{GroupID: "grp-a", UnitID: unit, CheckIn: in, CheckOut: out}) {
		got = append(got, v.Rule)
	}
	return got
}

func TestStopSellClosesEveryNight(t *testing.T) {
	closed := oneOff("stop_sell", "2026-11-20", "2026-11-21")
	v := EvaluateStay([]Restriction{closed}, StayShape{GroupID: "grp-a", UnitID: "unit-a1", CheckIn: "2026-11-19", CheckOut: "2026-11-23"})
	eq(t, "dates", v[0].Dates, []string{"2026-11-20", "2026-11-21"})
	eq(t, "message", v[0].Message, "Closed for sale on Nov 20, Nov 21.")
	eq(t, "leaving on the first closed day", rules([]Restriction{closed}, "2026-11-18", "2026-11-20", "unit-a1"), []string{})
}

func TestArrivalAndDepartureDates(t *testing.T) {
	list := []Restriction{oneOff("closed_to_arrival", "2026-11-21", "2026-11-21"), oneOff("closed_to_departure", "2026-11-21", "2026-11-21")}
	eq(t, "arrival", rules(list, "2026-11-21", "2026-11-23", "unit-a1"), []string{"closed_to_arrival"})
	eq(t, "departure", rules(list, "2026-11-19", "2026-11-21", "unit-a1"), []string{"closed_to_departure"})
	eq(t, "through", rules(list, "2026-11-20", "2026-11-22", "unit-a1"), []string{})
}

func TestMinimumAndMaximumStayStrictestWins(t *testing.T) {
	list := []Restriction{rule(nil), rule(func(r *Restriction) { r.ID, r.Nights, r.Weekdays = "r2", ptr(4), []int{5} }), rule(func(r *Restriction) { r.ID, r.Rule, r.Nights = "r3", "max_stay", ptr(10) })}
	v := EvaluateStay(list, StayShape{GroupID: "grp-a", UnitID: "unit-a1", CheckIn: "2026-07-04", CheckOut: "2026-07-07"})
	eq(t, "saturday", v[0].Message, "Arrivals on Jul 4 stay at least 4 nights; this stay has 3.")
	eq(t, "friday", rules(list, "2026-07-03", "2026-07-06", "unit-a1"), []string{})
	eq(t, "too long", rules(list, "2026-07-03", "2026-07-15", "unit-a1"), []string{"max_stay"})
	eq(t, "before the range", rules(list, "2026-06-30", "2026-07-01", "unit-a1"), []string{})
}

func TestMinimumStayThrough(t *testing.T) {
	through := rule(func(r *Restriction) { r.Rule, r.Nights, r.From, r.To = "min_stay_through", ptr(5), "12-28", "01-02" })
	v := EvaluateStay([]Restriction{through}, StayShape{GroupID: "grp-a", UnitID: "unit-a1", CheckIn: "2026-12-26", CheckOut: "2026-12-29"})
	eq(t, "hit", [3]any{v[0].Rule, v[0].Dates, *v[0].Nights}, [3]any{"min_stay_through", []string{"2026-12-28"}, 5})
	eq(t, "long enough", rules([]Restriction{through}, "2026-12-26", "2026-12-31", "unit-a1"), []string{})
	eq(t, "before", rules([]Restriction{through}, "2026-12-20", "2026-12-28", "unit-a1"), []string{})
}

func TestYearlyOverTheNewYear(t *testing.T) {
	season := rule(func(r *Restriction) { r.From, r.To = "12-20", "01-05" })
	for _, d := range []string{"2026-12-20", "2026-12-31", "2027-01-01", "2027-01-05", "2028-01-03"} {
		eq(t, d, season.On(d), true)
	}
	for _, d := range []string{"2026-12-19", "2027-01-06", "2027-07-01"} {
		eq(t, d, season.On(d), false)
	}
	eq(t, "inside", rules([]Restriction{season}, "2027-01-04", "2027-01-06", "unit-a1"), []string{"min_stay"})
	eq(t, "after", rules([]Restriction{season}, "2027-01-06", "2027-01-07", "unit-a1"), []string{})
}

func TestUnitRuleStaysOnItsUnit(t *testing.T) {
	list := []Restriction{
		rule(func(r *Restriction) { r.Rule, r.Nights, r.Yearly, r.From, r.To = "max_stay", ptr(1), false, "2026-11-20", "2026-11-30" }),
		rule(func(r *Restriction) {
			r.ID, r.UnitID, r.Rule, r.Nights, r.Yearly, r.From, r.To = "u", ptr("unit-a2"), "stop_sell", nil, false, "2026-11-20", "2026-11-30"
		}),
		rule(func(r *Restriction) {
			r.ID, r.GroupID, r.Rule, r.Nights, r.Yearly, r.From, r.To = "x", "grp-b", "closed_to_arrival", nil, false, "2026-11-20", "2026-11-20"
		}),
	}
	eq(t, "unit a2", rules(list, "2026-11-20", "2026-11-22", "unit-a2"), []string{"stop_sell", "max_stay"})
	eq(t, "unit a1", rules(list, "2026-11-20", "2026-11-22", "unit-a1"), []string{"max_stay"})
	eq(t, "by type", rules(list, "2026-11-20", "2026-11-22", ""), []string{"max_stay"})
	eq(t, "no type", len(EvaluateStay(list, StayShape{CheckIn: "2026-11-20", CheckOut: "2026-11-22"})), 0)
}

func TestValidateRestriction(t *testing.T) {
	in := func(f func(r *RestrictionInput)) RestrictionInput {
		r := RestrictionInput{GroupID: "grp-a", Rule: "min_stay", Nights: ptr(3.0), Yearly: true, From: "07-01", To: "08-31", Weekdays: []float64{}}
		if f != nil {
			f(&r)
		}
		return r
	}
	eq(t, "fine", RestrictionFields(in(nil)).Map(), map[string]string{})
	eq(t, "bad", RestrictionFields(in(func(r *RestrictionInput) { r.Nights, r.From, r.To, r.Weekdays = ptr(0.0), "02-30", "13-01", []float64{7} })).Map(),
		map[string]string{"nights": "Enter whole nights from 1 to 90.", "from": "Pick the first day as MM-DD.", "to": "Pick the last day as MM-DD.", "weekdays": "Pick each day of the week once."})
	eq(t, "backwards", RestrictionFields(in(func(r *RestrictionInput) { r.Yearly, r.From, r.To = false, "2026-11-20", "2026-11-19" })).Map(), map[string]string{"to": "The last day comes on or after the first."})
	eq(t, "stop sell", RestrictionFields(in(func(r *RestrictionInput) { r.Rule, r.Nights = "stop_sell", nil })).Map(), map[string]string{})
	eq(t, "when", RestrictionWhen(true, "07-01", "08-31", []int{5}), "07-01 to 08-31 every year, Sat")
}

func TestWhoMayOverride(t *testing.T) {
	p := rbac.DefaultPermissions()
	eq(t, "manager", MayOverrideRestrictions(p, "manager"), true)
	eq(t, "owner", MayOverrideRestrictions(p, "owner"), true)
	eq(t, "reservation", MayOverrideRestrictions(p, "reservation"), false)
	eq(t, "staff", MayOverrideRestrictions(p, "staff"), false)
}

func TestCheckStay(t *testing.T) {
	list := []Restriction{rule(func(r *Restriction) { r.From, r.To = "12-20", "01-05" })}
	stay := StayShape{GroupID: "grp-a", UnitID: "unit-a1", CheckIn: "2026-12-21", CheckOut: "2026-12-23"}
	desk := StayCheck{By: "Dian Permata", Today: "2026-10-30", RoleLabel: "Reservation"}
	_, err := CheckStay(list, stay, Direct, nil, "KR-01, 2026-12-21 to 2026-12-23,", desk)
	eq(t, "refused", err.Error(), "RESTRICTION_VIOLATED: KR-01, 2026-12-21 to 2026-12-23, breaks the stay restrictions: Arrivals on Dec 21 stay at least 3 nights; this stay has 2. A villa manager can sell past them with a reason.")
	_, err = CheckStay(list, stay, Direct, &Override{Reason: "Regular guest"}, "x", desk)
	eq(t, "desk override", code(err), "RESTRICTION_OVERRIDE_FORBIDDEN")
	manager := StayCheck{By: "Kadek Ariani", Today: "2026-10-30", MayOverride: true}
	_, err = CheckStay(list, stay, Direct, &Override{Reason: " "}, "x", manager)
	eq(t, "no reason", code(err), errs.CodeValidation)
	note, _ := CheckStay(list, stay, Direct, &Override{Reason: "Regular guest"}, "x", manager)
	eq(t, "override", [3]any{note.Kind, note.Rules, note.Reason}, [3]any{"override", []string{"min_stay"}, "Regular guest"})
	note, _ = CheckStay(list, stay, Airbnb, nil, "x", desk)
	eq(t, "channel", note.Kind, "channel")
	merged := MergeNotes(note, RestrictionNote{Kind: "override", Rules: []string{"stop_sell", "min_stay"}, Messages: []string{"m"}, Reason: "Pump fixed"})
	eq(t, "merged", [3]any{merged.Kind, merged.Rules, merged.Reason}, [3]any{"override", []string{"min_stay", "stop_sell"}, "Pump fixed"})
}

// Ported from src/domain/pricing.test.ts.

func TestDiscountSpreadsOverTheNights(t *testing.T) {
	percent := Priced{ListRates: []int64{1_000_000, 1_150_000, 1_150_000}, Discount: &Discount{Kind: "percent", Value: 7, Per: "stay"}}
	eq(t, "adds up", sum(NightCharges(percent)), PriceOf(percent).Total)
	p := PriceOf(percent)
	eq(t, "percent", [4]int64{p.List, p.Subtotal, p.Discount, p.Total}, [4]int64{3_300_000, 3_300_000, 231_000, 3_069_000})
	eq(t, "per night", PriceOf(Priced{ListRates: []int64{500_000, 500_000}, Discount: &Discount{Kind: "amount", Value: 100_000, Per: "night"}}).Total, int64(800_000))
	eq(t, "per stay", PriceOf(Priced{ListRates: []int64{500_000, 500_000}, Discount: &Discount{Kind: "amount", Value: 100_000, Per: "stay"}}).Total, int64(900_000))
	eq(t, "capped", PriceOf(Priced{ListRates: []int64{500_000}, Discount: &Discount{Kind: "amount", Value: 900_000, Per: "stay"}}).Total, int64(0))
}

func TestStaffRateAgainstTheLimit(t *testing.T) {
	override := PriceOf(Priced{ListRates: []int64{1_000_000, 1_000_000}, RateOverride: ptr(int64(850_000))})
	eq(t, "override", [3]int64{override.Subtotal, override.Discount, override.Total}, [3]int64{1_700_000, 0, 1_700_000})
	if math.Abs(override.Reduction-0.15) > 1e-9 {
		t.Errorf("reduction %v", override.Reduction)
	}
	eq(t, "past 10", BeyondDiscountLimit(override, 10), true)
	eq(t, "within 15", BeyondDiscountLimit(override, 15), false)
	eq(t, "above list", BeyondDiscountLimit(PriceOf(Priced{ListRates: []int64{1_000_000}, RateOverride: ptr(int64(1_200_000))}), 0), false)
}

func TestRepriceKeepsSoldNights(t *testing.T) {
	got := RepriceNights("2026-11-19", []int64{900_000, 950_000}, "2026-11-20", "2026-11-23", func(string) int64 { return 1_000_000 })
	eq(t, "nights", got, []int64{950_000, 1_000_000, 1_000_000})
}

func TestValidatePriceChange(t *testing.T) {
	if _, ok := fields(ValidatePriceChange(PriceChange{RateOverride: ptr(900_000.0)}))["reason"]; !ok {
		t.Error("override without reason")
	}
	f := fields(ValidatePriceChange(PriceChange{Discount: &Discount{Kind: "percent", Value: 120, Per: "stay", Reason: "x"}}))
	eq(t, "bad discount", len(f) == 2 && f["discount.value"] != "" && f["discount.reason"] != "", true)
	eq(t, "fine", ValidatePriceChange(PriceChange{Discount: &Discount{Kind: "amount", Value: 50_000, Per: "night", Reason: "Long stay"}}), nil)
}

func TestApplyPriceNeedsApprovalPastTheLimit(t *testing.T) {
	b := Booking{Code: "BK-1", Source: Direct, ListRates: []int64{1_000_000, 1_000_000}}
	_, err := b.ApplyPrice(PriceChange{RateOverride: ptr(850_000.0), Reason: "Regular"}, Actor{ID: "usr-dian", Name: "Dian"}, false, 10, "2026-11-11")
	eq(t, "limit", err.Error(), "DISCOUNT_LIMIT: 15% under the list is past the 10% limit. Ask a villa manager to give it.")
	if _, err := b.ApplyPrice(PriceChange{RateOverride: ptr(850_000.0), Reason: "Regular"}, Actor{ID: "usr-kadek", Name: "Kadek"}, true, 10, "2026-11-11"); err != nil {
		t.Fatal(err)
	}
	eq(t, "stamp", [2]any{*b.RateOverride, *b.PriceSetBy.ApprovedBy}, [2]any{int64(850_000), "Kadek"})
	ch := Booking{Code: "BK-2", Source: Airbnb}
	_, err = ch.ApplyPrice(PriceChange{RateOverride: ptr(1.0)}, Actor{}, true, 10, "")
	eq(t, "channel", err.Error(), "CHANNEL_PRICE_LOCKED: BK-2 keeps the price Airbnb sold it for.")
}

func TestPlanNightWeekendAndSeason(t *testing.T) {
	plan := RatePlan{WeekdayRate: 1_000_000, WeekendRate: 1_200_000, Seasons: []Season{{Name: "High season", From: "07-01", To: "08-31", Kind: "surcharge", Value: 35}, {Name: "Galungan", From: "08-10", To: "08-12", Kind: "fixed", Value: 2_000_000}}}
	rate, name := PlanNight(plan, "2026-11-13")
	eq(t, "friday", [2]any{rate, name}, [2]any{int64(1_200_000), "Weekend"})
	rate, name = PlanNight(plan, "2026-07-07")
	eq(t, "season", [2]any{rate, name}, [2]any{int64(1_350_000), "High season"})
	rate, name = PlanNight(plan, "2026-08-11")
	eq(t, "narrower season", [2]any{rate, name}, [2]any{int64(2_000_000), "Galungan"})
}

func TestStayTotalAddsServiceAndPB1OnANetPrice(t *testing.T) {
	net := Booking{ListRates: []int64{1_000_000}, PriceMode: "net"}
	eq(t, "net", DefaultPolicy.StayTotal(net), int64(1_210_000))
	eq(t, "inclusive", DefaultPolicy.StayTotal(Booking{ListRates: []int64{1_000_000}}), int64(1_000_000))
}

func TestCancellationTerms(t *testing.T) {
	p := DefaultPolicy
	eq(t, "nothing paid", p.Cancellation(0, 10_000_000, "2026-12-01", "2026-11-11", Cancelled), CancellationTerms{})
	eq(t, "no-show", p.Cancellation(3_000_000, 10_000_000, "2026-12-01", "2026-11-11", NoShow), CancellationTerms{Retained: 3_000_000})
	eq(t, "early", p.Cancellation(3_000_000, 10_000_000, "2026-12-01", "2026-11-11", Cancelled), CancellationTerms{Refund: 3_000_000})
	eq(t, "late", p.Cancellation(5_000_000, 10_000_000, "2026-11-20", "2026-11-11", Cancelled), CancellationTerms{Refund: 2_000_000, Retained: 3_000_000})
}

// Ported from src/domain/group.test.ts.

func groupCatalog() Catalog {
	return Catalog{
		Villas: []Villa{{ID: "vil-a", LocationID: "loc-a", Name: "Villa A"}},
		Groups: []UnitGroup{{ID: "grp-type", VillaID: "vil-a", Name: "Garden rooms", Interchangeable: true, OperatorAssigns: true}},
		Units: []Unit{
			{ID: "unit-A-01", VillaID: "vil-a", GroupID: ptr("grp-type"), Code: "A-01", Status: "active"},
			{ID: "unit-A-02", VillaID: "vil-a", GroupID: ptr("grp-type"), Code: "A-02", Status: "active"},
			{ID: "unit-B-01", VillaID: "vil-a", Code: "B-01", Status: "active"},
		},
	}
}

func gstay(unit, roomType string) GroupStayInput {
	s := GroupStayInput{CheckIn: "2026-11-10", CheckOut: "2026-11-13", Adults: 2}
	if unit != "" {
		s.UnitID = ptr(unit)
	}
	if roomType != "" {
		s.RoomTypeID = ptr(roomType)
	}
	return s
}

func noOverbook(string) int { return 0 }

func TestValidateGroup(t *testing.T) {
	eq(t, "fine", GroupFields("Wedding", true, []GroupStayInput{gstay("unit-A-01", ""), gstay("unit-B-01", "")}, nil).Map(), map[string]string{})
	bad := gstay("", "")
	bad.Adults = 0
	got := GroupFields("W", false, []GroupStayInput{bad}, &GroupDiscount{}).Map()
	var keys []string
	for k := range got {
		keys = append(keys, k)
	}
	for _, k := range []string{"discount.pct", "discount.reason", "guestId", "name", "stays", "stays.0.adults", "stays.0.unitId"} {
		if got[k] == "" {
			t.Errorf("missing %s in %v", k, keys)
		}
	}
	eq(t, "count", len(got), 7)
}

func TestGroupDiscountOnStaysWithoutTheirOwn(t *testing.T) {
	d := &GroupDiscount{Pct: 10, Reason: "Wedding party"}
	eq(t, "plain", *StayPriceChange(nil, d).Discount, Discount{Kind: "percent", Value: 10, Per: "stay", Reason: "Group discount: Wedding party"})
	staff := StayPriceChange(&PriceChange{RateOverride: ptr(900_000.0), Reason: "Long stay"}, d)
	eq(t, "keeps the staff rate", [2]any{*staff.RateOverride, staff.Reason}, [2]any{900_000.0, "Long stay"})
	own := &PriceChange{Discount: &Discount{Kind: "amount", Value: 100_000, Per: "night", Reason: "Honeymoon"}}
	eq(t, "own discount", StayPriceChange(own, d), own)
	eq(t, "none", StayPriceChange(nil, nil), (*PriceChange)(nil))
}

func TestGroupClashes(t *testing.T) {
	c := groupCatalog()
	seeded := []Holding{held("bk-1", "BK-1", "unit-B-01", true, Confirmed, "2026-11-11", "2026-11-14")}
	eq(t, "free", len(GroupClashes(c, []GroupStayInput{gstay("unit-A-01", ""), gstay("unit-A-02", "")}, seeded, nil, noOverbook)), 0)
	clashes := GroupClashes(c, []GroupStayInput{gstay("unit-B-01", ""), gstay("unit-A-01", ""), gstay("unit-A-01", "")}, seeded, nil, noOverbook)
	eq(t, "which", [][2]any{{clashes[0].Index, clashes[0].Label}, {clashes[1].Index, clashes[1].Label}}, [][2]any{{0, "B-01"}, {2, "A-01"}})
	if !strings.Contains(clashes[1].Detail, "stay 2 of this group") {
		t.Errorf("detail %q", clashes[1].Detail)
	}
	eq(t, "by type", len(GroupClashes(c, []GroupStayInput{gstay("", "grp-type"), gstay("", "grp-type")}, nil, nil, noOverbook)), 0)
	full := GroupClashes(c, []GroupStayInput{gstay("unit-A-01", ""), gstay("", "grp-type"), gstay("", "grp-type")}, nil, nil, noOverbook)
	eq(t, "type full", [2]any{full[0].Index, full[0].Label}, [2]any{2, "Garden rooms"})
	eq(t, "message", ErrGroupUnavailable(full).Error(), "GROUP_UNAVAILABLE: The group cannot be booked: Garden rooms has every room taken on at least one of those nights.")
}

func TestAllocateAndGroupStatus(t *testing.T) {
	eq(t, "allocate", Allocate(5_000_000, []Share{{"a", 2_000_000}, {"b", 0}, {"c", 4_000_000}}), []Share{{"a", 2_000_000}, {"c", 3_000_000}})
	eq(t, "in house", GroupStatus([]string{CheckedOut, CheckedIn, Cancelled}), "in_house")
	eq(t, "cancelled", GroupStatus([]string{Cancelled}), "cancelled")
	eq(t, "out", GroupStatus([]string{CheckedOut, NoShow}), "checked_out")
}

// Ported from src/domain/precheckin.ts and src/domain/messaging.ts.

func TestCheckinTokenMatchesTheMock(t *testing.T) {
	eq(t, "token", CheckinToken("bk-1308"), "cibk13080oz47wu")
}

func TestValidatePreCheckIn(t *testing.T) {
	in := PreCheckInInput{Phone: "+62 812 3456 789", ArrivalTime: "15:30", Adults: 1, Travellers: []TravellerDocument{{Name: "Jonas Becker", Nationality: "DE", DocumentType: "passport", DocumentNumber: "PA930117", DocumentExpiry: "2026-11-12", DateOfBirth: "1984-03-10", EntryDate: "2026-11-10", PortOfEntry: "DPS", VisaType: "voa"}}, IDPhotos: []map[string]any{{"id": "f"}}, RulesName: "Jonas Becker", RulesAccepted: true}
	eq(t, "passport", fields(ValidatePreCheckIn(in, "2026-11-11", "2026-11-14")), map[string]string{"travellers.0.documentExpiry": "The passport expires before the stay ends."})
	in.Travellers[0].DocumentExpiry = "2029-01-01"
	eq(t, "fine", ValidatePreCheckIn(in, "2026-11-11", "2026-11-14"), nil)
}
