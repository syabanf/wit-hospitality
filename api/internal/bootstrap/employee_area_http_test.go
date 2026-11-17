package bootstrap_test

import (
	"net/http"
	"testing"
	"time"
)

type clockRow struct {
	ID         string  `json:"id"`
	EmployeeID string  `json:"employeeId"`
	ClockIn    *string `json:"clockIn"`
	ClockOut   *string `json:"clockOut"`
	Source     string  `json:"source"`
	Corrected  bool    `json:"corrected"`
	ClockInGeo *struct {
		Place string `json:"place"`
	} `json:"clockInGeo"`
}

type swap struct {
	ID     string `json:"id"`
	Number string `json:"number"`
	Status string `json:"status"`
}

func TestStaffClocksInAndOutOverHTTP(t *testing.T) {
	t.Parallel()
	s := start(t)
	wayan := s.client(t)
	wayan.login("wayan")
	if r := wayan.do("POST", "attendance/clock-in", map[string]any{"reason": "", "geo": nil}); r.status != http.StatusConflict || r.Error.Code != "CLOCK_NOT_ROSTERED" {
		t.Fatalf("off the roster without a reason: %d %+v", r.status, r.Error)
	}
	r := wayan.do("POST", "attendance/clock-in", map[string]any{"reason": "Covering the morning shift", "geo": map[string]float64{"lat": -8.6560, "lng": 115.1307}})
	in := decode[clockRow](t, r)
	if r.status != http.StatusOK || *in.ClockIn != "10:00" || in.Source != "self" || in.ClockInGeo == nil || in.ClockInGeo.Place != "villa" {
		t.Fatalf("clock in: %d %+v %+v", r.status, in, r.Error)
	}
	if again := wayan.do("POST", "attendance/clock-in", map[string]any{"reason": "x"}); again.Error == nil || again.Error.Code != "CLOCK_ALREADY_IN" {
		t.Fatalf("twice: %d %+v", again.status, again.Error)
	}
	*s.now = s.now.Add(7 * time.Hour)
	r = wayan.do("POST", "attendance/clock-out", map[string]any{"geo": nil})
	if out := decode[clockRow](t, r); r.status != http.StatusOK || *out.ClockOut != "17:00" || out.ID != in.ID {
		t.Fatalf("clock out: %d %+v %+v", r.status, out, r.Error)
	}
	s.published(t, "people.attendance.recorded.v1", in.ID)
	nia := s.client(t)
	nia.login("nia")
	r = nia.do("PUT", "attendance", map[string]any{"employeeId": "emp-002", "date": "2026-11-11", "status": "present", "clockIn": "09:45", "clockOut": "17:00", "note": "Gate log"})
	if fixed := decode[clockRow](t, r); r.status != http.StatusOK || !fixed.Corrected || fixed.Source != "self" {
		t.Fatalf("HR correction: %d %+v %+v", r.status, fixed, r.Error)
	}
}

func TestShiftSwapFromOfferToApprovalOverHTTP(t *testing.T) {
	t.Parallel()
	s := start(t)
	wayan := s.client(t)
	wayan.login("wayan")
	mine := decode[[]swap](t, wayan.do("GET", "shift-swaps", nil))
	if len(mine) != 1 || mine[0].Number != "SW-501" {
		t.Fatalf("wayan's swaps: %+v", mine)
	}
	if r := wayan.do("POST", "shift-swaps/sw-1/accept", map[string]string{"note": ""}); r.status != http.StatusOK || decode[swap](t, r).Status != "accepted" {
		t.Fatalf("accept: %d %+v", r.status, r.Error)
	}
	if r := wayan.do("POST", "shift-swaps/sw-1/approve", map[string]string{"note": ""}); r.status != http.StatusForbidden {
		t.Fatalf("staff approving: %d %+v", r.status, r.Error)
	}
	nia := s.client(t)
	nia.login("nia")
	if r := nia.do("POST", "shift-swaps/sw-1/approve", map[string]string{"note": ""}); r.status != http.StatusOK || decode[swap](t, r).Status != "approved" {
		t.Fatalf("approve: %d %+v", r.status, r.Error)
	}
	type cell struct {
		EmployeeID string  `json:"employeeId"`
		Date       string  `json:"date"`
		ShiftID    *string `json:"shiftId"`
	}
	for _, c := range decode[[]cell](t, nia.do("GET", "shift-assignments", nil)) {
		if c.Date == "2026-11-13" && c.EmployeeID == "emp-002" && (c.ShiftID == nil || *c.ShiftID != "sh-morning") {
			t.Fatalf("wayan takes the morning: %+v", c)
		}
	}
	r := wayan.do("POST", "shift-swaps", map[string]any{"date": "2026-11-11", "counterpartId": "emp-003", "counterDate": nil, "note": ""})
	if r.Error == nil || r.Error.Code != "SWAP_PAST_SHIFT" {
		t.Fatalf("past shift: %d %+v", r.status, r.Error)
	}
}

func TestLeaveRequestPastTheBalanceIsRefusedOverHTTP(t *testing.T) {
	t.Parallel()
	s := start(t)
	wayan := s.client(t)
	wayan.login("wayan")
	r := wayan.do("POST", "leave-requests", map[string]any{"employeeId": "emp-002", "kind": "annual", "from": "2026-12-01", "to": "2026-12-31", "reason": "Long trip"})
	if r.Error == nil || r.Error.Code != "LEAVE_BALANCE_EXCEEDED" {
		t.Fatalf("past the balance: %d %+v", r.status, r.Error)
	}
}

// The employee pages read people.home(): every call it makes answers a staff login, scoped to the
// signed-in employee, and the team carries names and shifts only.
func TestHomeDataForAStaffRole(t *testing.T) {
	t.Parallel()
	s := start(t)
	wayan := s.client(t)
	wayan.login("wayan")
	for _, path := range []string{"locations", "villas", "units", "employees", "shifts", "shift-assignments", "attendance", "leave-requests", "overtime-requests", "loans",
		"kpi-reviews", "announcements", "payroll/periods", "bookings", "guests", "team-shifts", "shift-swaps", "attendance/settings"} {
		if r := wayan.do("GET", path, nil); r.status != http.StatusOK {
			t.Fatalf("GET %s: %d %+v", path, r.status, r.Error)
		}
	}
	for _, a := range decode[[]attendance](t, wayan.do("GET", "attendance", nil)) {
		if a.EmployeeID != "emp-002" {
			t.Fatalf("own attendance only: %+v", a)
		}
	}
	team := decode[[]map[string]any](t, wayan.do("GET", "team-shifts", nil))
	if len(team) < 2 {
		t.Fatalf("team: %+v", team)
	}
	for _, m := range team {
		for key := range m {
			if key != "id" && key != "name" && key != "position" && key != "villaIds" && key != "assignments" {
				t.Fatalf("team member carries %s", key)
			}
		}
	}
}
