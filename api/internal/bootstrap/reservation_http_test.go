package bootstrap_test

import (
	"net/http"
	"strings"
	"testing"
)

type bookingRow struct {
	ID              string `json:"id"`
	Code            string `json:"code"`
	UnitID          string `json:"unitId"`
	UnitAssigned    bool   `json:"unitAssigned"`
	Status          string `json:"status"`
	RestrictionNote *struct {
		Kind string `json:"kind"`
		By   string `json:"by"`
	} `json:"restrictionNote"`
}

func stay(unit, group, in, out string) map[string]any {
	b := map[string]any{"guestId": "g-01", "newGuest": nil, "unitId": nil, "groupId": nil, "source": "direct", "airbnbAccountId": nil, "airbnbCode": nil,
		"checkIn": in, "checkOut": out, "channelRate": nil, "price": nil, "notes": "", "confirm": true}
	if unit != "" {
		b["unitId"] = unit
	}
	if group != "" {
		b["groupId"] = group
	}
	return b
}

func refused(t *testing.T, r reply, status int, code string) {
	t.Helper()
	if r.status != status || r.Error == nil || r.Error.Code != code {
		t.Fatalf("want %d %s, got %d %+v", status, code, r.status, r.Error)
	}
}

func TestBookingCreateOverlapAndTheStaysGuard(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("dian")
	r := c.do("POST", "bookings", stay("unit-kr-03", "", "2026-12-06", "2026-12-08"))
	if r.status != http.StatusCreated {
		t.Fatalf("create: %d %+v", r.status, r.Error)
	}
	b := decode[bookingRow](t, r)
	if b.Code != "BK-3001" || b.Status != "confirmed" {
		t.Fatalf("booking %+v", b)
	}
	listed := decode[[]bookingRow](t, c.do("GET", "bookings", nil))
	if len(listed) != 397 || listed[396].ID != b.ID {
		t.Fatalf("the new booking reads back at once: %d rows", len(listed))
	}
	r = c.do("POST", "bookings", stay("unit-kr-03", "", "2026-12-07", "2026-12-09"))
	refused(t, r, http.StatusConflict, "BOOKING_OVERLAP")
	if r.Error.Message != "KR-03 is held by BK-3001 from 2026-12-06 to 2026-12-08." {
		t.Fatalf("message %q", r.Error.Message)
	}
	// Property's block now sees the stay through reservation (decision 8).
	refused(t, c.do("POST", "unit-blocks", map[string]any{"unitId": "unit-kr-03", "from": "2026-12-06", "to": "2026-12-07", "reason": "maintenance", "note": ""}), http.StatusConflict, "BLOCK_OVERLAP")
	if r := c.do("POST", "bookings/"+b.ID+"/cancel", nil); r.status != http.StatusOK || decode[bookingRow](t, r).Status != "cancelled" {
		t.Fatalf("cancel: %d %+v", r.status, r.Error)
	}
	refused(t, c.do("POST", "bookings/"+b.ID+"/confirm", nil), http.StatusConflict, "BOOKING_INVALID_STATE")
}

func TestRestrictionRefusalAndOverride(t *testing.T) {
	t.Parallel()
	s := start(t)
	desk := s.client(t)
	desk.login("dian")
	closed := stay("unit-tr-04", "", "2026-12-10", "2026-12-12")
	r := desk.do("POST", "bookings", closed)
	refused(t, r, http.StatusConflict, "RESTRICTION_VIOLATED")
	if !strings.Contains(r.Error.Message, "Closed for sale on Dec 10, Dec 11.") {
		t.Fatalf("message %q", r.Error.Message)
	}
	closed["override"] = map[string]string{"reason": "Guest asked for it"}
	refused(t, desk.do("POST", "bookings", closed), http.StatusForbidden, "RESTRICTION_OVERRIDE_FORBIDDEN")
	manager := s.client(t)
	manager.login("kadek")
	r = manager.do("POST", "bookings", closed)
	if r.status != http.StatusCreated {
		t.Fatalf("override: %d %+v", r.status, r.Error)
	}
	if b := decode[bookingRow](t, r); b.RestrictionNote == nil || b.RestrictionNote.Kind != "override" || b.RestrictionNote.By != "Kadek Ariani" {
		t.Fatalf("note %+v", b.RestrictionNote)
	}
	refused(t, desk.do("POST", "stay-restrictions", map[string]any{"groupId": "grp-lumbung-loft", "unitId": nil, "rule": "stop_sell", "nights": nil, "yearly": false, "from": "2026-12-01", "to": "2026-12-01", "weekdays": []int{}, "note": ""}), http.StatusForbidden, "FORBIDDEN")
}

func TestRoomTypeAssignment(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("dian")
	r := c.do("POST", "bookings", stay("", "grp-lumbung-loft", "2027-03-01", "2027-03-03"))
	if r.status != http.StatusCreated {
		t.Fatalf("by type: %d %+v", r.status, r.Error)
	}
	b := decode[bookingRow](t, r)
	if b.UnitAssigned {
		t.Fatal("a stay booked by type waits for a room")
	}
	refused(t, c.do("POST", "bookings/"+b.ID+"/check-in", nil), http.StatusConflict, "UNIT_UNASSIGNED")
	// Property refuses to stop selling the type while the stay waits.
	manager := s.client(t)
	manager.login("kadek")
	refused(t, manager.do("PATCH", "unit-groups/grp-lumbung-loft", map[string]any{"villaId": "vil-lumbung", "name": "Lumbung loft", "interchangeable": true, "operatorAssigns": false}), http.StatusConflict, "ROOMS_TO_ASSIGN")
	refused(t, c.do("POST", "bookings/"+b.ID+"/assign-unit", map[string]any{"unitId": "unit-kr-01", "override": nil}), http.StatusConflict, "UNIT_NOT_INTERCHANGEABLE")
	r = c.do("POST", "bookings/"+b.ID+"/assign-unit", map[string]any{"unitId": "unit-lb-02", "override": nil})
	if r.status != http.StatusOK || !decode[bookingRow](t, r).UnitAssigned {
		t.Fatalf("assign: %d %+v", r.status, r.Error)
	}
}

func TestOverbookingWalk(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	refused(t, c.do("POST", "bookings", stay("", "grp-saka-standard", "2026-11-11", "2026-11-12")), http.StatusConflict, "ROOM_TYPE_FULL")
	var last bookingRow
	for _, b := range decode[[]bookingRow](t, c.do("GET", "bookings", nil)) {
		if b.Code == "BK-2011" {
			last = b
		}
	}
	r := c.do("POST", "bookings/"+last.ID+"/walk", map[string]any{"destination": "outside", "unitId": nil, "property": "Hotel Canggu Beach", "cost": 800000, "method": "cash", "compensation": "Free transfer", "reason": "Saka standard overbooked tonight"})
	if r.status != http.StatusOK {
		t.Fatalf("walk: %d %+v", r.status, r.Error)
	}
	walked := decode[struct {
		Booking bookingRow `json:"booking"`
		Walk    struct {
			Number string `json:"number"`
		} `json:"walk"`
	}](t, r)
	if walked.Booking.Status != "cancelled" || walked.Walk.Number != "WLK-101" {
		t.Fatalf("walked %+v", walked)
	}
	if walks := decode[[]map[string]any](t, c.do("GET", "walks", nil)); len(walks) != 1 {
		t.Fatalf("walks: %d", len(walks))
	}
	refused(t, c.do("PUT", "unit-groups/grp-karang-cliff/overbooking", map[string]int{"limit": 1}), http.StatusConflict, "OVERBOOK_ROOM_BY_ROOM")
}

func TestBlacklistedGuestNeedsAnApprover(t *testing.T) {
	t.Parallel()
	s := start(t)
	desk := s.client(t)
	desk.login("dian")
	b := stay("unit-kr-03", "", "2027-02-10", "2027-02-12")
	b["guestId"] = "g-25"
	refused(t, desk.do("POST", "bookings", b), http.StatusConflict, "GUEST_BLACKLISTED")
	b["blacklistOverride"] = "Paid the damage"
	refused(t, desk.do("POST", "bookings", b), http.StatusForbidden, "FORBIDDEN")
	manager := s.client(t)
	manager.login("kadek")
	if r := manager.do("POST", "bookings", b); r.status != http.StatusCreated {
		t.Fatalf("manager books the blacklisted guest: %d %+v", r.status, r.Error)
	}
}
