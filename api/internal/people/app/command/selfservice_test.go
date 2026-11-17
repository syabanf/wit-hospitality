package command_test

import (
	"context"
	"slices"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/people/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/people/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

var sari = auth.Principal{UserID: "usr-sari", Name: "Ni Luh Putu Sari", Role: "staff", VillaIDs: []string{"vil-saka"}, EmployeeID: str("emp-003")}

func TestStaffClockInAndOutWithTheServerTime(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	in, out := command.ClockIn{Deps: e.deps}, command.ClockOut{Deps: e.deps}

	// Wayan has the day off on the roster: a clock-in needs a reason.
	_, err := in.Handle(ctx, wayan, domain.ClockInput{})
	wantCode(t, err, "CLOCK_NOT_ROSTERED", "You are not on the roster today. Say why you are clocking in.")
	_, err = out.Handle(ctx, wayan, nil)
	wantCode(t, err, "CLOCK_NOT_IN", "Clock in first.")
	row, err := in.Handle(ctx, wayan, domain.ClockInput{Reason: "Covering a late arrival", Geo: &domain.GeoPoint{Lat: -8.6560, Lng: 115.1307}})
	if err != nil || *row.ClockIn != "10:00" || row.Source != "self" || row.Status != "present" || row.Note != "Covering a late arrival" {
		t.Fatalf("clock in: %+v %v", row, err)
	}
	if g := row.ClockInGeo; g == nil || g.Place != "villa" || *g.VillaID != "vil-saka" || *g.DistanceMeters > 20 {
		t.Fatalf("at the villa: %+v", row.ClockInGeo)
	}
	_, err = in.Handle(ctx, wayan, domain.ClockInput{Reason: "Again"})
	wantCode(t, err, "CLOCK_ALREADY_IN", "You already clocked in at 10:00.")
	closed, err := out.Handle(ctx, wayan, &domain.GeoPoint{Lat: -8.70, Lng: 115.1306})
	if err != nil || *closed.ClockOut != "10:00" || closed.ClockOutGeo == nil || closed.ClockOutGeo.Place != "away" {
		t.Fatalf("clock out: %+v %v", closed, err)
	}
	_, err = out.Handle(ctx, wayan, nil)
	wantCode(t, err, "CLOCK_ALREADY_OUT", "You already clocked out at 10:00.")

	// HR's edit wins and marks the clocked row corrected.
	fixed, err := command.RecordAttendance{Deps: e.deps}.Handle(ctx, nia, domain.AttendanceInput{EmployeeID: "emp-002", Date: "2026-11-11", Status: "present", ClockIn: str("09:30"), ClockOut: str("17:00"), Note: "Fixed"})
	if err != nil || !fixed.Corrected || fixed.Source != "self" || fixed.ClockInGeo == nil {
		t.Fatalf("correct: %+v %v", fixed, err)
	}

	// A login without an employee record cannot clock.
	_, err = in.Handle(ctx, nia, domain.ClockInput{Reason: "Test"})
	wantCode(t, err, "NO_EMPLOYEE_RECORD", "")

	settings := command.SaveAttendanceSettings{Deps: e.deps}
	_, err = settings.Handle(ctx, wayan, domain.AttendanceSettings{RadiusMeters: 300})
	wantCode(t, err, errs.CodeForbidden, "Staff cannot edit in HR.")
	_, err = settings.Handle(ctx, nia, domain.AttendanceSettings{RadiusMeters: 5})
	wantCode(t, err, errs.CodeValidation, "The radius is 20 to 5000 whole metres.")
	if s, err := settings.Handle(ctx, nia, domain.AttendanceSettings{RadiusMeters: 300}); err != nil || s.RadiusMeters != 300 {
		t.Fatalf("radius: %+v %v", s, err)
	}
	if s, err := e.q.AttendanceSettings(as(wayan)); err != nil || s.RadiusMeters != 300 {
		t.Fatalf("read radius: %+v %v", s, err)
	}
}

func TestShiftSwapFromOfferToApproval(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	move := command.MoveSwap{Deps: e.deps}

	mine, err := e.q.Swaps(as(wayan))
	if err != nil || len(mine) != 1 || mine[0].Number != "SW-501" || mine[0].Status != "offered" {
		t.Fatalf("wayan's swaps: %+v %v", mine, err)
	}
	if all, err := e.q.Swaps(as(nia)); err != nil || len(all) != 2 {
		t.Fatalf("hr sees every swap: %d %v", len(all), err)
	}
	_, err = move.Handle(ctx, sari, "sw-1", "accept", "")
	wantCode(t, err, errs.CodeForbidden, "Only Wayan Sudiarta can answer SW-501.")
	_, err = move.Handle(ctx, wayan, "sw-1", "approve", "")
	wantCode(t, err, errs.CodeForbidden, "Staff cannot edit in HR.")
	_, err = move.Handle(ctx, nia, "sw-1", "approve", "")
	wantCode(t, err, "SWAP_NOT_ACCEPTED", "SW-501 waits for Wayan Sudiarta to accept.")
	accepted, err := move.Handle(ctx, wayan, "sw-1", "accept", "")
	if err != nil || accepted.Status != "accepted" || *accepted.RespondedOn != "2026-11-11" {
		t.Fatalf("accept: %+v %v", accepted, err)
	}
	_, err = move.Handle(ctx, nia, "sw-1", "reject", "")
	wantCode(t, err, errs.CodeValidation, "Say why.")
	approved, err := move.Handle(ctx, nia, "sw-1", "approve", "")
	if err != nil || approved.Status != "approved" || approved.DecidedBy != "Nia Kusuma" {
		t.Fatalf("approve: %+v %v", approved, err)
	}
	repo := postgres.Repo{DB: e.db}
	wayanShift, _ := repo.ShiftOn(ctx, "emp-002", "2026-11-13")
	sariShift, _ := repo.ShiftOn(ctx, "emp-003", "2026-11-13")
	if wayanShift == nil || wayanShift.ID != "sh-morning" || sariShift == nil || sariShift.ID != "sh-afternoon" {
		t.Fatalf("roster after the swap: wayan %+v sari %+v", wayanShift, sariShift)
	}
	_, err = move.Handle(ctx, wayan, "sw-1", "cancel", "")
	wantCode(t, err, errs.CodeForbidden, "Only Ni Luh Putu Sari can cancel SW-501.")

	request := command.RequestSwap{Deps: e.deps}
	_, err = request.Handle(ctx, wayan, domain.SwapInput{Date: "2026-11-11", CounterpartID: "emp-003"})
	wantCode(t, err, "SWAP_PAST_SHIFT", "The shift on 2026-11-11 has started or passed. Swap an upcoming shift.")
	_, err = request.Handle(ctx, wayan, domain.SwapInput{Date: "2026-11-14", CounterpartID: "emp-003"})
	wantCode(t, err, "SWAP_DOUBLE_SHIFT", "Ni Luh Putu Sari already works Morning on 2026-11-14.")
	offered, err := request.Handle(ctx, wayan, domain.SwapInput{Date: "2026-11-14", CounterpartID: "emp-003", CounterDate: str("2026-11-14"), Note: " Temple day "})
	if err != nil || offered.Number != "SW-503" || offered.Note != "Temple day" || *offered.CounterShiftID != "sh-morning" {
		t.Fatalf("offer: %+v %v", offered, err)
	}
	_, err = request.Handle(ctx, wayan, domain.SwapInput{Date: "2026-11-14", CounterpartID: "emp-003", CounterDate: str("2026-11-14")})
	wantCode(t, err, "SWAP_OPEN_EXISTS", "SW-503 is already open on that shift.")
}

func TestLeavePastTheBalanceOfALimitedKind(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	request := command.RequestLeave{Deps: e.deps}
	_, err := request.Handle(ctx, wayan, domain.LeaveInput{EmployeeID: "emp-002", Kind: "permission", From: "2026-12-01", To: "2026-12-09", Reason: "Ceremonies"})
	wantCode(t, err, "LEAVE_BALANCE_EXCEEDED", "Only 6 permission days are left.")
	if _, err := request.Handle(ctx, wayan, domain.LeaveInput{EmployeeID: "emp-002", Kind: "unpaid", From: "2026-12-01", To: "2026-12-20", Reason: "Long trip home"}); err != nil {
		t.Fatalf("unpaid has no limit: %v", err)
	}
}

func TestTeamShowsVillaCoworkersNamesAndShiftsOnly(t *testing.T) {
	t.Parallel()
	e := setup(t)
	team, err := e.q.Team(as(wayan))
	if err != nil || len(team) < 2 {
		t.Fatalf("team: %+v %v", team, err)
	}
	for _, m := range team {
		if !slices.Contains(m.VillaIDs, "vil-saka") {
			t.Fatalf("%s does not share a villa: %v", m.Name, m.VillaIDs)
		}
		for _, a := range m.Assignments {
			if a.Date < "2026-11-11" || a.Date >= "2026-11-25" {
				t.Fatalf("%s roster out of range: %s", m.Name, a.Date)
			}
		}
	}
	if none, err := e.q.Team(as(nia)); err != nil || len(none) != 0 {
		t.Fatalf("no employee record, no team: %+v %v", none, err)
	}
}
