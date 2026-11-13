package bootstrap_test

import (
	"net/http"
	"testing"
)

// KR-03 has two bedrooms, so the seed gives it four adults and two children and no extra beds.
func TestBookingRefusedOverUnitCapacity(t *testing.T) {
	s := start(t)
	c := s.client(t)
	c.login("dian")
	crowd := stay("unit-kr-03", "", "2027-03-01", "2027-03-04")
	crowd["partySize"] = map[string]int{"adults": 5, "children": 0}
	r := c.do("POST", "bookings", crowd)
	refused(t, r, http.StatusConflict, "UNIT_CAPACITY")
	if r.Error.Message != "Karang cliff villa 3 sleeps 4 adults and 2 children." {
		t.Fatalf("message %q", r.Error.Message)
	}
	family := stay("unit-kr-03", "", "2027-03-01", "2027-03-04")
	family["partySize"] = map[string]int{"adults": 4, "children": 2}
	if r := c.do("POST", "bookings", family); r.status != http.StatusCreated {
		t.Fatalf("a party that fits: %d %+v", r.status, r.Error)
	}
}
