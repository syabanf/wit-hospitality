package bootstrap_test

import (
	"net/http"
	"testing"
)

type groupJSON struct {
	ID              string `json:"id"`
	VillaID         string `json:"villaId"`
	Name            string `json:"name"`
	Kind            string `json:"kind"`
	Interchangeable bool   `json:"interchangeable"`
	OperatorAssigns bool   `json:"operatorAssigns"`
}

type operatingJSON struct {
	ID               string `json:"id"`
	Operation        string `json:"operation"`
	StayoverEvery    int    `json:"stayoverEvery"`
	WholeRental      bool   `json:"wholeRental"`
	WholeNightlyRate int64  `json:"wholeNightlyRate"`
	DepositOnCheckIn bool   `json:"depositOnCheckIn"`
}

func propertyVilla(code, name string, operating map[string]any) map[string]any {
	v := map[string]any{"locationId": "loc-canggu", "code": code, "name": name, "description": "", "facilities": []string{}}
	for k, x := range operating {
		v[k] = x
	}
	return v
}

func wizardRoom(code, name, floor string, bedrooms, rate int, group *int) map[string]any {
	return map[string]any{"code": code, "name": name, "floor": floor, "bedrooms": bedrooms, "nightlyRate": rate, "groupIndex": group, "amenities": []string{}}
}

func villaGroups(t *testing.T, c *client, villaID string) []groupJSON {
	t.Helper()
	var out []groupJSON
	for _, g := range decode[[]groupJSON](t, c.do("GET", "unit-groups", nil)) {
		if g.VillaID == villaID {
			out = append(out, g)
		}
	}
	return out
}

// createProperty runs the wizard and returns the new villa's id.
func createProperty(t *testing.T, c *client, body map[string]any) string {
	t.Helper()
	r := c.do("POST", "properties", body)
	if r.status != http.StatusCreated {
		t.Fatalf("wizard: %d %+v", r.status, r.Error)
	}
	return decode[operatingJSON](t, r).ID
}

// A hotel made through the wizard sells rooms by type, cleans every stayover day and asks no
// deposit; a villa room type in a hotel is refused with GROUP_KIND.
func TestWizardHotel(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	zero := 0
	body := map[string]any{
		"villa":  propertyVilla("HT", "Hotel Tirta", map[string]any{"operation": "hotel"}),
		"groups": []map[string]any{{"name": "Deluxe"}},
		"rooms":  []map[string]any{wizardRoom("HT-201", "Room 201", "2", 1, 900_000, &zero), wizardRoom("HT-202", "Room 202", "2", 1, 900_000, &zero)},
	}
	id := createProperty(t, c, body)
	for _, v := range decode[[]operatingJSON](t, c.do("GET", "villas", nil)) {
		if v.ID == id && (v.Operation != "hotel" || v.StayoverEvery != 1 || v.DepositOnCheckIn || v.WholeRental) {
			t.Fatalf("hotel %+v", v)
		}
	}
	groups := villaGroups(t, c, id)
	if len(groups) != 1 || groups[0].Kind != "room" || !groups[0].Interchangeable || !groups[0].OperatorAssigns {
		t.Fatalf("hotel room types %+v", groups)
	}
	for _, u := range decode[[]map[string]any](t, c.do("GET", "units", nil)) {
		if u["villaId"] == id && u["floor"] != "2" {
			t.Fatalf("unit %v", u)
		}
	}
	for _, r := range decode[[]map[string]any](t, c.do("GET", "stay-restrictions", nil)) {
		if r["groupId"] == groups[0].ID {
			t.Fatalf("a one night minimum needs no restriction: %v", r)
		}
	}
	body["villa"] = propertyVilla("HV", "Hotel Villa", map[string]any{"operation": "hotel"})
	body["groups"] = []map[string]any{{"name": "Pool villas", "kind": "villa"}}
	body["rooms"] = []map[string]any{wizardRoom("HV-01", "Villa 1", "", 2, 3_000_000, &zero)}
	refused(t, c.do("POST", "properties", body), http.StatusConflict, "GROUP_KIND")
	body["villa"] = propertyVilla("HW", "Hotel Whole", map[string]any{"operation": "hotel", "wholeRental": true})
	body["groups"] = []map[string]any{{"name": "Deluxe"}}
	refused(t, c.do("POST", "properties", body), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
}

// A mixed property made through the wizard keeps rooms and villas apart: the villas start with a
// two night minimum stay and can be booked whole as one group on a master folio.
func TestWizardMixedPropertyAndWholeVilla(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	rooms, villas := 0, 1
	id := createProperty(t, c, map[string]any{
		"villa": propertyVilla("TA", "Tirta", map[string]any{"operation": "mixed", "wholeRental": true, "wholeNightlyRate": 5_000_001}),
		"groups": []map[string]any{
			{"name": "Deluxe", "kind": "room"},
			{"name": "Pool villas", "kind": "villa", "interchangeable": false, "operatorAssigns": false},
		},
		"rooms": []map[string]any{
			wizardRoom("TA-201", "Room 201", "2", 1, 900_000, &rooms),
			wizardRoom("TA-01", "Villa Satu", "", 2, 3_000_000, &villas),
			wizardRoom("TA-02", "Villa Dua", "", 2, 3_000_000, &villas),
		},
	})
	groups := villaGroups(t, c, id)
	if len(groups) != 2 || groups[0].Kind != "room" || groups[1].Kind != "villa" || groups[1].OperatorAssigns {
		t.Fatalf("room types %+v", groups)
	}
	minStay := 0
	for _, r := range decode[[]map[string]any](t, c.do("GET", "stay-restrictions", nil)) {
		if r["groupId"] == groups[1].ID && r["rule"] == "min_stay" && r["nights"] == 2.0 && r["yearly"] == true {
			minStay++
		}
	}
	if minStay != 1 {
		t.Fatalf("villa minimum stay restrictions: %d", minStay)
	}

	whole := map[string]any{"villaId": id, "guestId": "g-01", "checkIn": "2026-12-01", "checkOut": "2026-12-04", "adults": 6, "children": 2, "source": "direct", "note": "Family reunion"}
	r := c.do("POST", "whole-villa-bookings", whole)
	if r.status != http.StatusCreated {
		t.Fatalf("whole villa: %d %+v", r.status, r.Error)
	}
	g := decode[struct {
		ID         string   `json:"id"`
		Name       string   `json:"name"`
		Billing    string   `json:"billing"`
		WholeVilla bool     `json:"wholeVilla"`
		VillaIDs   []string `json:"villaIds"`
	}](t, r)
	if g.Name != "Whole Tirta" || g.Billing != "master" || !g.WholeVilla || len(g.VillaIDs) != 1 {
		t.Fatalf("group %+v", g)
	}
	listed := false
	for _, x := range decode[[]map[string]any](t, c.do("GET", "booking-groups", nil)) {
		listed = listed || (x["id"] == g.ID && x["wholeVilla"] == true)
	}
	if !listed {
		t.Fatal("the group list does not show the whole villa group")
	}
	var rates []float64
	for _, b := range decode[[]map[string]any](t, c.do("GET", "bookings", nil)) {
		if b["bookingGroupId"] == g.ID {
			if b["status"] != "confirmed" || b["unitId"] == "unit-ta-201" {
				t.Fatalf("stay %v", b)
			}
			rates = append(rates, b["listRates"].([]any)[0].(float64))
		}
	}
	if len(rates) != 2 || rates[0] != 2_500_001 || rates[1] != 2_500_000 {
		t.Fatalf("whole nightly rate shared over the villas: %v", rates)
	}
	r = c.do("POST", "whole-villa-bookings", whole)
	refused(t, r, http.StatusConflict, "WHOLE_VILLA_UNAVAILABLE")
	if r.Error.Message != "Tirta has TA-01, TA-02 taken on those nights." {
		t.Fatalf("message %q", r.Error.Message)
	}
	crowd := map[string]any{"villaId": id, "guestId": "g-01", "checkIn": "2026-12-10", "checkOut": "2026-12-13", "adults": 9, "children": 0, "source": "direct"}
	refused(t, c.do("POST", "whole-villa-bookings", crowd), http.StatusConflict, "UNIT_CAPACITY")
	crowd["villaId"] = "vil-saka"
	refused(t, c.do("POST", "whole-villa-bookings", crowd), http.StatusConflict, "WHOLE_VILLA_NOT_ALLOWED")
}

// The day plan gives a hotel guest in house a stayover clean every stayoverEvery days after
// arrival, once per room per day however often the day is planned.
func TestStayoverTasksOncePerDay(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	zero := 0
	createProperty(t, c, map[string]any{
		"villa":  propertyVilla("HS", "Hotel Sari", map[string]any{"operation": "hotel", "stayoverEvery": 2}),
		"groups": []map[string]any{{"name": "Standard"}},
		"rooms":  []map[string]any{wizardRoom("HS-101", "Room 101", "1", 1, 800_000, &zero)},
	})
	if r := c.do("POST", "bookings", stay("unit-hs-101", "", "2026-11-20", "2026-11-25")); r.status != http.StatusCreated {
		t.Fatalf("booking: %d %+v", r.status, r.Error)
	}
	stayovers := func(day string) int {
		n := 0
		for _, task := range decode[[]map[string]any](t, c.do("POST", "housekeeping/tasks/plan", map[string]string{"date": day})) {
			if task["unitId"] == "unit-hs-101" && task["type"] == "stayover" {
				n++
			}
		}
		return n
	}
	if n := stayovers("2026-11-21"); n != 0 {
		t.Fatalf("the first day after arrival is not a stayover day with a gap of 2: %d", n)
	}
	if n := stayovers("2026-11-22"); n != 1 {
		t.Fatalf("stayover on the second day: %d", n)
	}
	if n := stayovers("2026-11-22"); n != 0 {
		t.Fatalf("planning the day again adds no second stayover: %d", n)
	}
	if n := stayovers("2026-11-25"); n != 0 {
		t.Fatalf("no stayover on the day out: %d", n)
	}
}
