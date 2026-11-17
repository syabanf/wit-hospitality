package bootstrap_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"
)

// The hotel desk tests run on Villa Saka, the seed's hotel (rooms SK-01 to SK-08 of Saka
// standard), and make the sections, packages and rooms each needs through the API.

type sectionJSON struct {
	ID      string   `json:"id"`
	VillaID string   `json:"villaId"`
	Name    string   `json:"name"`
	UnitIDs []string `json:"unitIds"`
}

type sectionAssignmentJSON struct {
	SectionID   string `json:"sectionId"`
	Date        string `json:"date"`
	AttendantID string `json:"attendantId"`
}

type deskTask struct {
	ID          string  `json:"id"`
	UnitID      string  `json:"unitId"`
	AttendantID *string `json:"attendantId"`
	History     []struct {
		Kind string `json:"kind"`
		Note string `json:"note"`
	} `json:"history"`
}

type packageJSON struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Rate      string  `json:"rate"`
	Value     int64   `json:"value"`
	Breakfast int64   `json:"breakfast"`
	AccountID *string `json:"accountId"`
}

type soldStay struct {
	ID          string  `json:"id"`
	Code        string  `json:"code"`
	UnitID      string  `json:"unitId"`
	ListRates   []int64 `json:"listRates"`
	ListSources []struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	} `json:"listSources"`
	RatePackage *packageJSON `json:"ratePackage"`
}

// field fails unless r is a validation error with message on field.
func field(t *testing.T, r reply, name, message string) {
	t.Helper()
	refused(t, r, http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	if got := r.Error.Fields[name]; got != message {
		t.Fatalf("field %s: want %q, got %q (%v)", name, message, got, r.Error.Fields)
	}
}

func pkg(name, rate string, value, breakfast int64, account any) map[string]any {
	return map[string]any{"name": name, "rate": rate, "value": value, "breakfast": breakfast, "accountId": account}
}

func ratePlan(weekday, weekend int64, packages []map[string]any) map[string]any {
	plan := map[string]any{"weekdayRate": weekday, "weekendRate": weekend, "seasons": []any{}}
	if packages != nil {
		plan["packages"] = packages
	}
	return plan
}

// hotelRoom adds a room to Villa Saka in the room type and returns its id.
func hotelRoom(t *testing.T, c *client, groupID, code string) string {
	t.Helper()
	u := created[unit](t, c.do("POST", "units", map[string]any{"villaId": "vil-saka", "groupId": groupID, "code": code, "name": "Saka " + code,
		"bedrooms": 1, "nightlyRate": 1850000, "status": "active", "amenities": []string{}}), "room "+code)
	return u.ID
}

// boardOf reads a unit's housekeeping record; ready when the board has none.
func boardOf(t *testing.T, c *client, unitID string) map[string]any {
	t.Helper()
	for _, r := range decode[[]map[string]any](t, c.do("GET", "housekeeping", nil)) {
		if r["unitId"] == unitID {
			return r
		}
	}
	return map[string]any{"state": "ready"}
}

// A section groups hotel rooms only, follows the section rules, and gives its rooms to one
// attendant on shift a day; a task added later on a room of the section starts with them, and
// removing the section removes its attendants.
func TestSectionsAndSectionAttendants(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	// The seed's floor sections stand aside, with their attendants, for the ones this test builds.
	for _, x := range decode[[]sectionJSON](t, c.do("GET", "sections", nil)) {
		if r := c.do("DELETE", "sections/"+x.ID, nil); r.status != http.StatusNoContent {
			t.Fatalf("remove seeded %s: %d", x.ID, r.status)
		}
	}
	r := c.do("POST", "sections", map[string]any{"villaId": "vil-tirta", "name": "Garden", "unitIds": []string{"unit-tr-01"}})
	refused(t, r, http.StatusConflict, "SECTION_HOTEL_ONLY")
	if r.Error.Message != "Sections group hotel rooms; Villa Tirta has none." {
		t.Fatalf("message %q", r.Error.Message)
	}
	field(t, c.do("POST", "sections", map[string]any{"villaId": "vil-saka", "name": "G", "unitIds": []string{"unit-sk-02"}}), "name", "Name the section.")
	field(t, c.do("POST", "sections", map[string]any{"villaId": "vil-saka", "name": "Ground", "unitIds": []string{}}), "unitIds", "Pick at least one room.")
	field(t, c.do("POST", "sections", map[string]any{"villaId": "vil-saka", "name": "Ground", "unitIds": []string{"unit-tr-01"}}), "unitIds", "Pick rooms of this property.")
	sec := created[sectionJSON](t, c.do("POST", "sections", map[string]any{"villaId": "vil-saka", "name": "Ground floor", "unitIds": []string{"unit-sk-02", "unit-sk-03"}}), "section")
	if !strings.HasPrefix(sec.ID, "sec-ground-floor-") || sec.VillaID != "vil-saka" || len(sec.UnitIDs) != 2 {
		t.Fatalf("section %+v", sec)
	}
	clash := c.do("POST", "sections", map[string]any{"villaId": "vil-saka", "name": "ground floor", "unitIds": []string{"unit-sk-03"}})
	field(t, clash, "name", "ground floor is already a section of Villa Saka.")
	field(t, clash, "unitIds", "SK-03 is already in Ground floor.")
	field(t, c.do("PATCH", "sections/"+sec.ID, map[string]any{"villaId": "vil-tirta", "name": "Ground floor", "unitIds": []string{"unit-sk-02"}}), "villaId", "A section stays with its property.")
	sec = created[sectionJSON](t, c.do("PATCH", "sections/"+sec.ID, map[string]any{"villaId": "vil-saka", "name": "Ground floor", "unitIds": []string{"unit-sk-02", "unit-sk-03", "unit-sk-04"}}), "edit")
	if len(sec.UnitIDs) != 3 {
		t.Fatalf("edited %+v", sec)
	}
	if !slices.ContainsFunc(decode[[]sectionJSON](t, c.do("GET", "sections", nil)), func(x sectionJSON) bool { return x.ID == sec.ID && len(x.UnitIDs) == 3 }) {
		t.Fatal("the list shows the edited section")
	}

	put := func(attendant any) reply {
		return c.do("PUT", "housekeeping/section-assignments", map[string]any{"sectionId": sec.ID, "date": "2026-11-11", "attendantId": attendant})
	}
	field(t, c.do("PUT", "housekeeping/section-assignments", map[string]any{"sectionId": sec.ID, "date": "tomorrow", "attendantId": "emp-009"}), "date", "Pick the day.")
	refused(t, c.do("PUT", "housekeeping/section-assignments", map[string]any{"sectionId": "sec-nope-9", "date": "2026-11-11", "attendantId": "emp-009"}), http.StatusNotFound, "NOT_FOUND")
	off := put("emp-002")
	refused(t, off, http.StatusConflict, "NOT_ON_SHIFT")
	if off.Error.Message != "That attendant is not on shift on 2026-11-11." {
		t.Fatalf("message %q", off.Error.Message)
	}
	given := created[[]deskTask](t, put("emp-009"), "give")
	if len(given) != 2 || given[0].ID != "hkt-75" || given[1].ID != "hkt-76" {
		t.Fatalf("the pending tasks of SK-02 and SK-03 change hands: %+v", given)
	}
	if last := given[0].History[len(given[0].History)-1]; *given[0].AttendantID != "emp-009" || last.Kind != "assigned" || last.Note != "Ground floor: Luh Ayu Lestari" {
		t.Fatalf("given %+v", given[0])
	}
	held := decode[[]sectionAssignmentJSON](t, c.do("GET", "housekeeping/section-assignments", nil))
	if !slices.Contains(held, sectionAssignmentJSON{SectionID: sec.ID, Date: "2026-11-11", AttendantID: "emp-009"}) {
		t.Fatalf("assignments %+v", held)
	}
	added := created[deskTask](t, c.do("POST", "housekeeping/tasks", map[string]any{"unitId": "unit-sk-04", "date": "2026-11-11", "type": "inspection"}), "task")
	if added.AttendantID == nil || *added.AttendantID != "emp-009" {
		t.Fatalf("a task added later starts with the section's attendant: %+v", added)
	}
	trail := decode[[]map[string]any](t, c.do("GET", "audit", nil))
	if trail[1]["summary"] != "Gave Ground floor to Luh Ayu Lestari on 2026-11-11: 2 tasks" || trail[1]["entity"] != "housekeeping-section" {
		t.Fatalf("audit %v", trail[1])
	}

	if r := c.do("DELETE", "sections/"+sec.ID, nil); r.status != http.StatusNoContent {
		t.Fatalf("remove: %d %+v", r.status, r.Error)
	}
	for _, a := range decode[[]sectionAssignmentJSON](t, c.do("GET", "housekeeping/section-assignments", nil)) {
		if a.SectionID == sec.ID {
			t.Fatalf("removing the section removes its attendants: %+v", a)
		}
	}
	refused(t, put(nil), http.StatusNotFound, "NOT_FOUND")
}

// Packages go on hotel room types only, follow the package rules and check a corporate rate's
// account against billing's city ledger; a booking takes a package of its room type, in the
// contract's order of refusals, and prices each night through it.
func TestRatePackagesOnThePlanAndTheBooking(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	breakfast := pkg("With breakfast", "plan", 0, 150000, nil)
	field(t, c.do("PUT", "unit-groups/grp-tirta-pool/rate-plan", ratePlan(3000000, 3500000, []map[string]any{breakfast})),
		"packages", "Packages are for hotel room types; a villa sells at its own price.")
	bad := c.do("PUT", "unit-groups/grp-saka-standard/rate-plan", ratePlan(1850000, 2200000, []map[string]any{
		pkg("Room only", "plan", 0, 100000, nil),
		pkg("Deal", "bogus", 0, 0, nil),
		pkg("Fixed", "fixed", 0, 0, nil),
		pkg("Percent", "percent", 95, 0, nil),
		pkg("Bare", "plan", 0, 0, nil),
		pkg("Agent", "fixed", 1000000, 0, "cl-southern"),
		pkg("Deal", "percent", 10, -1, nil),
	}))
	for name, message := range map[string]string{
		"packages.0.name":      "Room only is always offered; name this one differently.",
		"packages.1.rate":      "Pick how the room is priced.",
		"packages.2.value":     "Enter the nightly price in whole rupiah.",
		"packages.3.value":     "A whole percentage from 1 to 90.",
		"packages.4.breakfast": "Add breakfast or a rate; without either this is Room only.",
		"packages.5.accountId": "Pick a company account from the city ledger.",
		"packages.6.name":      "Deal is listed twice.",
		"packages.6.breakfast": "Enter the breakfast price per person in whole rupiah, or zero.",
	} {
		field(t, bad, name, message)
	}
	field(t, c.do("PUT", "unit-groups/grp-saka-standard/rate-plan", ratePlan(1850000, 2200000, []map[string]any{pkg("Ghost", "fixed", 1000000, 0, "cl-nope")})),
		"packages.0.accountId", "Pick a company account from the city ledger.")
	plan := created[struct {
		Packages []packageJSON `json:"packages"`
	}](t, c.do("PUT", "unit-groups/grp-saka-standard/rate-plan", ratePlan(1850000, 2200000, []map[string]any{
		breakfast, pkg("Nusa corporate", "fixed", 1500000, 120000, "cl-nusa"), pkg("Long stay", "percent", 10, 0, nil),
	})), "plan")
	if len(plan.Packages) != 3 || plan.Packages[0].ID != "pkg-with-breakfast" || plan.Packages[1].ID != "pkg-nusa-corporate" || *plan.Packages[1].AccountID != "cl-nusa" || plan.Packages[2].ID != "pkg-long-stay" {
		t.Fatalf("packages %+v", plan.Packages)
	}
	kept := created[struct {
		Packages []packageJSON `json:"packages"`
	}](t, c.do("PUT", "unit-groups/grp-saka-standard/rate-plan", ratePlan(1850000, 2200000, nil)), "plan without packages")
	if len(kept.Packages) != 3 {
		t.Fatalf("a plan saved without packages keeps them: %+v", kept.Packages)
	}

	book := func(unitID, in, out, packageID string, cityLedger any) reply {
		b := stay(unitID, "", in, out)
		b["packageId"] = packageID
		if cityLedger != nil {
			b["cityLedger"] = cityLedger
		}
		return c.do("POST", "bookings", b)
	}
	refused(t, book("unit-tr-04", "2027-03-01", "2027-03-04", "pkg-with-breakfast", nil), http.StatusConflict, "PACKAGE_NOT_ALLOWED")
	unknown := book("unit-sk-01", "2027-03-01", "2027-03-04", "pkg-nope", nil)
	refused(t, unknown, http.StatusConflict, "PACKAGE_UNKNOWN")
	if unknown.Error.Message != "Saka standard has no such rate package." {
		t.Fatalf("message %q", unknown.Error.Message)
	}
	account := book("unit-sk-01", "2027-03-01", "2027-03-04", "pkg-nusa-corporate", nil)
	refused(t, account, http.StatusConflict, "PACKAGE_ACCOUNT")
	if account.Error.Message != "Nusa corporate is a company rate; bill the stay to its city ledger account." {
		t.Fatalf("message %q", account.Error.Message)
	}
	refused(t, book("unit-sk-01", "2027-03-01", "2027-03-04", "pkg-nusa-corporate", map[string]any{"accountId": "cl-consulate", "instruction": "all"}), http.StatusConflict, "PACKAGE_ACCOUNT")
	corporate := created[soldStay](t, book("unit-sk-01", "2027-03-01", "2027-03-04", "pkg-nusa-corporate", map[string]any{"accountId": "cl-nusa", "instruction": "all"}), "corporate stay")
	if corporate.RatePackage == nil || corporate.RatePackage.ID != "pkg-nusa-corporate" || !slices.Equal(corporate.ListRates, []int64{1500000, 1500000, 1500000}) || corporate.ListSources[0].Name != "Nusa corporate" {
		t.Fatalf("a fixed package sells every night at its price: %+v", corporate)
	}
	plain := created[soldStay](t, book("unit-sk-02", "2027-03-01", "2027-03-04", "", nil), "room only stay")
	long := created[soldStay](t, book("unit-sk-03", "2027-03-01", "2027-03-04", "pkg-long-stay", nil), "long stay")
	if plain.RatePackage != nil || len(long.ListRates) != 3 {
		t.Fatalf("room only %+v, long stay %+v", plain, long)
	}
	for i, rate := range plain.ListRates {
		if long.ListRates[i] != rate*90/100 || long.ListSources[i].Name != plain.ListSources[i].Name+", Long stay" {
			t.Fatalf("night %d: a percent package takes 10%% off the plan: %d from %d, %q", i, long.ListRates[i], rate, long.ListSources[i].Name)
		}
	}
}

// A hotel room stay moves to a room of another type keeping its rate, then to another taking the
// new room's price; each room it leaves while in house goes dirty on the board.
func TestHotelRoomMoveKeepsOrReprices(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	deluxe := created[groupJSON](t, c.do("POST", "unit-groups", map[string]any{"villaId": "vil-saka", "name": "Saka deluxe", "kind": "room", "interchangeable": true, "operatorAssigns": true}), "room type")
	created[map[string]any](t, c.do("PUT", "unit-groups/"+deluxe.ID+"/rate-plan", ratePlan(3000000, 3000000, nil)), "deluxe plan")
	standard := hotelRoom(t, c, "grp-saka-standard", "SK-09")
	first, second := hotelRoom(t, c, deluxe.ID, "SK-21"), hotelRoom(t, c, deluxe.ID, "SK-22")

	b := created[soldStay](t, c.do("POST", "bookings", stay(standard, "", "2026-11-11", "2026-11-13")), "stay")
	signCard(t, c, b.ID)
	if r := c.do("POST", "bookings/"+b.ID+"/check-in", nil); r.status != http.StatusOK {
		t.Fatalf("check in: %d %+v", r.status, r.Error)
	}
	move := func(unitID string, rate any) reply {
		return c.do("POST", "bookings/"+b.ID+"/move-unit", map[string]any{"unitId": unitID, "reason": "Guest asked for a quieter room", "rate": rate})
	}
	field(t, move(first, "half"), "rate", "Pick whether the rate follows the new room.")
	refused(t, move("unit-tr-01", "keep"), http.StatusConflict, "UNIT_NOT_INTERCHANGEABLE")

	kept := created[soldStay](t, move(first, "keep"), "keep")
	if kept.UnitID != first || !slices.Equal(kept.ListRates, b.ListRates) {
		t.Fatalf("a free upgrade keeps the price: %+v, sold %v", kept, b.ListRates)
	}
	left := boardOf(t, c, standard)
	if left["state"] != "dirty" || left["note"] != b.Code+" moved to SK-21" || left["updatedBy"] != "Front desk" {
		t.Fatalf("the room left goes dirty: %v", left)
	}
	repriced := created[soldStay](t, move(second, "reprice"), "reprice")
	if !slices.Equal(repriced.ListRates, []int64{3000000, 3000000}) {
		t.Fatalf("before any audit every night takes the new room's price: %v", repriced.ListRates)
	}
	if left := boardOf(t, c, first); left["state"] != "dirty" || left["note"] != b.Code+" moved to SK-22" {
		t.Fatalf("the second room left goes dirty: %v", left)
	}
}

// The night audit posts breakfast for every night it posts on a stay sold with breakfast, for the
// guests of the party.
func TestNightAuditPostsBreakfast(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	created[map[string]any](t, c.do("PUT", "unit-groups/grp-saka-standard/rate-plan", ratePlan(1850000, 2200000, []map[string]any{pkg("With breakfast", "plan", 0, 150000, nil)})), "plan")
	room := hotelRoom(t, c, "grp-saka-standard", "SK-09")
	body := stay(room, "", "2026-11-11", "2026-11-13")
	body["packageId"] = "pkg-with-breakfast"
	body["partySize"] = map[string]any{"adults": 2, "children": 0}
	b := created[soldStay](t, c.do("POST", "bookings", body), "stay")
	if b.ListSources[0].Name == "" || b.RatePackage == nil || b.RatePackage.Breakfast != 150000 {
		t.Fatalf("stay %+v", b)
	}
	signCard(t, c, b.ID)
	if r := c.do("POST", "bookings/"+b.ID+"/check-in", nil); r.status != http.StatusOK {
		t.Fatalf("check in: %d %+v", r.status, r.Error)
	}
	manager := s.client(t)
	manager.login("kadek")
	if r := manager.do("POST", "night-audits", map[string]any{"date": "2026-11-11", "checks": map[string]int{"arrivals": 0}, "noShows": []string{}}); r.status != http.StatusCreated {
		t.Fatalf("audit: %d %+v", r.status, r.Error)
	}
	var bkf []map[string]any
	for _, p := range decode[[]map[string]any](t, manager.do("GET", "bookings/"+b.ID+"/folio", nil)) {
		if p["code"] == "BKF" {
			bkf = append(bkf, p)
		}
	}
	if len(bkf) != 1 || bkf[0]["kind"] != "charge" || bkf[0]["part"] != "charges" || bkf[0]["amount"] != 300000.0 ||
		bkf[0]["description"] != "Breakfast, night 1 of 2, 2 guests" || bkf[0]["postedBy"] != "Kadek Ariani" {
		t.Fatalf("breakfast postings %v", bkf)
	}
}
