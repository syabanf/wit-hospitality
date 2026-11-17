package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// SettingsAttendance is the settings row that holds the clock-in radius.
const SettingsAttendance = "attendance"

func notLinked() error {
	return errs.New("NO_EMPLOYEE_RECORD", "Your login is not linked to an employee record.")
}

// me loads the signed-in employee; the employee area acts in that name only.
func (d Deps) me(ctx context.Context, p auth.Principal) (domain.Employee, error) {
	if p.EmployeeID == nil || *p.EmployeeID == "" {
		return domain.Employee{}, notLinked()
	}
	e, err := d.Repo.FindEmployee(ctx, *p.EmployeeID)
	if err != nil {
		return domain.Employee{}, err
	}
	if e == nil {
		return domain.Employee{}, notLinked()
	}
	return *e, nil
}

// AttendanceSettings reads the clock-in radius, the default until HR saves one.
func (d Deps) AttendanceSettings(ctx context.Context) (domain.AttendanceSettings, int64, error) {
	s := domain.DefaultAttendanceSettings
	version, err := d.Repo.Load(ctx, Settings, SettingsAttendance, &s)
	if errs.HasCode(err, errs.CodeNotFound) {
		return domain.DefaultAttendanceSettings, 0, nil
	}
	return s, version, err
}

// stamp measures a position against the villa the roster names that day, else every villa the
// employee works at.
func (d Deps) stamp(ctx context.Context, e domain.Employee, date string, geo *domain.GeoPoint) (*domain.ClockStamp, error) {
	if geo == nil {
		return nil, nil
	}
	var asg domain.ShiftAssignment
	version, err := d.Repo.FindBy(ctx, Assignments, e.ID, date, &asg)
	if err != nil {
		return nil, err
	}
	villas := e.VillaIDs()
	if version > 0 && asg.ShiftID != nil && *asg.ShiftID != "" {
		villas = []string{asg.VillaID}
	}
	points, err := d.Repo.VillaPoints(ctx, villas)
	if err != nil {
		return nil, err
	}
	settings, _, err := d.AttendanceSettings(ctx)
	if err != nil {
		return nil, err
	}
	return domain.StampGeo(geo, points, settings.RadiusMeters), nil
}

// attendanceOn loads an employee's row of a day; nil and version 0 when there is none.
func (d Deps) attendanceOn(ctx context.Context, employeeID, date string) (*domain.Attendance, int64, error) {
	var a domain.Attendance
	version, err := d.Repo.FindBy(ctx, AttendanceK, employeeID, date, &a)
	if err != nil || version == 0 {
		return nil, 0, err
	}
	return &a, version, nil
}

func (d Deps) now() string { return d.Clock.Now().Format("15:04") }

// ClockIn stamps the signed-in employee's clock-in with the server's time in the business time
// zone: late against the shift start, at the villa or away when the browser shares a position.
type ClockIn struct{ Deps }

// Handle clocks in.
func (h ClockIn) Handle(ctx context.Context, p auth.Principal, in domain.ClockInput) (domain.Attendance, error) {
	var a domain.Attendance
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		e, err := h.me(ctx, p)
		if err != nil {
			return err
		}
		date := h.today()
		row, version, err := h.attendanceOn(ctx, e.ID, date)
		if err != nil {
			return err
		}
		shift, err := h.Repo.ShiftOn(ctx, e.ID, date)
		if err != nil {
			return err
		}
		leaves, err := h.Repo.Leaves(ctx, e.ID)
		if err != nil {
			return err
		}
		onLeave := false
		for _, l := range leaves {
			onLeave = onLeave || (l.Status == domain.Approved && l.From <= date && date <= l.To)
		}
		if err := domain.CheckClockIn(row, shift, onLeave, in.Reason); err != nil {
			return err
		}
		id := ""
		if row != nil {
			id = row.ID
		} else {
			n, err := h.Repo.Next(ctx, "attendance")
			if err != nil {
				return err
			}
			id = fmt.Sprintf("att-%d", n)
		}
		geo, err := h.stamp(ctx, e, date, in.Geo)
		if err != nil {
			return err
		}
		a = domain.ClockedIn(id, e.ID, date, h.now(), shift, in.Reason, geo)
		if err := h.saveAttendance(ctx, a, version); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "attendance", EntityID: a.ID, Summary: fmt.Sprintf("%s clocked in at %s", e.Name, *a.ClockIn)})
	})
	return a, err
}

// ClockOut closes the open clock-in: today's, or last night's when that shift ran past midnight.
type ClockOut struct{ Deps }

// Handle clocks out.
func (h ClockOut) Handle(ctx context.Context, p auth.Principal, geo *domain.GeoPoint) (domain.Attendance, error) {
	var a domain.Attendance
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		e, err := h.me(ctx, p)
		if err != nil {
			return err
		}
		date := h.today()
		yesterday := domain.AddDays(date, -1)
		today, todayVersion, err := h.attendanceOn(ctx, e.ID, date)
		if err != nil {
			return err
		}
		last, lastVersion, err := h.attendanceOn(ctx, e.ID, yesterday)
		if err != nil {
			return err
		}
		lastShift, err := h.Repo.ShiftOn(ctx, e.ID, yesterday)
		if err != nil {
			return err
		}
		open := domain.OpenClock(today, last, lastShift)
		if err := domain.CheckClockOut(open, today); err != nil {
			return err
		}
		version := todayVersion
		if open != today {
			version = lastVersion
		}
		at := h.now()
		open.ClockOut = &at
		if open.ClockOutGeo, err = h.stamp(ctx, e, open.Date, geo); err != nil {
			return err
		}
		a = *open
		if err := h.saveAttendance(ctx, a, version); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "attendance", EntityID: a.ID, Summary: fmt.Sprintf("%s clocked out at %s", e.Name, at)})
	})
	return a, err
}

// SaveAttendanceSettings changes the clock-in radius; it needs hr/edit.
type SaveAttendanceSettings struct{ Deps }

// Handle saves the settings.
func (h SaveAttendanceSettings) Handle(ctx context.Context, p auth.Principal, in domain.AttendanceSettings) (domain.AttendanceSettings, error) {
	if err := h.Authz.Require(ctx, p.Role, hrEdit...); err != nil {
		return in, err
	}
	if err := domain.ValidateAttendanceSettings(in); err != nil {
		return in, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		before, version, err := h.AttendanceSettings(ctx)
		if err != nil {
			return err
		}
		if _, err := h.Repo.Save(ctx, Settings, Row{ID: SettingsAttendance, Data: in}, version); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "attendance-settings", EntityID: "settings", Summary: "Changed the clock-in radius",
			Before: map[string]any{"radiusMeters": before.RadiusMeters}, After: map[string]any{"radiusMeters": in.RadiusMeters}})
	})
	return in, err
}

func (d Deps) saveSwap(ctx context.Context, s domain.ShiftSwap, version int64) error {
	villa, err := d.Repo.Villa(ctx, s.VillaID)
	if err != nil {
		return err
	}
	v, err := d.Repo.Save(ctx, Swaps, Row{ID: s.ID, EmployeeID: s.RequesterID, Key: s.Date, VillaIDs: []string{s.VillaID}, LocationIDs: []string{villa.LocationID}, Data: s}, version)
	if err != nil {
		return err
	}
	return d.emit(ctx, people.EventShiftSwapSaved, "shift_swap", s.ID, v, people.ShiftSwapSaved{Swap: s})
}

// swapWorld loads what the swap rules read for the two people.
func (d Deps) swapWorld(ctx context.Context, requester, counterpart domain.Employee) (domain.SwapWorld, error) {
	w := domain.SwapWorld{Today: d.today(), Requester: requester, Counterpart: counterpart}
	var err error
	if w.Assignments, err = d.Repo.AssignmentsFrom(ctx, []string{requester.ID, counterpart.ID}, w.Today); err != nil {
		return w, err
	}
	for _, id := range []string{requester.ID, counterpart.ID} {
		leaves, err := d.Repo.Leaves(ctx, id)
		if err != nil {
			return w, err
		}
		w.Leaves = append(w.Leaves, leaves...)
	}
	if w.Shifts, err = d.Repo.AllShifts(ctx); err != nil {
		return w, err
	}
	if w.Swaps, err = d.Repo.OpenSwaps(ctx); err != nil {
		return w, err
	}
	w.VillaName = func(id string) string {
		if v, err := d.Repo.Villa(ctx, id); err == nil {
			return v.Name
		}
		return id
	}
	return w, nil
}

func (d Deps) findEmployee(ctx context.Context, id string) (domain.Employee, error) {
	e, err := d.Repo.FindEmployee(ctx, id)
	if err != nil {
		return domain.Employee{}, err
	}
	if e == nil {
		return domain.Employee{}, notFound("employee", id)
	}
	return *e, nil
}

// RequestSwap offers one of the signed-in employee's coming shifts to a coworker at the same
// villa, alone or against one of the coworker's shifts.
type RequestSwap struct{ Deps }

// Handle files the offer.
func (h RequestSwap) Handle(ctx context.Context, p auth.Principal, in domain.SwapInput) (domain.ShiftSwap, error) {
	if p.EmployeeID == nil || *p.EmployeeID == "" {
		return domain.ShiftSwap{}, errs.Invalid("form", "Your login is not linked to an employee record.")
	}
	if err := domain.ValidateSwap(in, *p.EmployeeID); err != nil {
		return domain.ShiftSwap{}, err
	}
	if in.CounterDate != nil && *in.CounterDate == "" {
		in.CounterDate = nil
	}
	var s domain.ShiftSwap
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		e, err := h.me(ctx, p)
		if err != nil {
			return err
		}
		other, err := h.findEmployee(ctx, in.CounterpartID)
		if err != nil {
			return err
		}
		w, err := h.swapWorld(ctx, e, other)
		if err != nil {
			return err
		}
		mine, theirs, err := domain.CheckSwap(in.Date, in.CounterDate, w, "")
		if err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "swap")
		if err != nil {
			return err
		}
		s = domain.ShiftSwap{ID: fmt.Sprintf("sw-%d", n), Number: fmt.Sprintf("SW-%d", 500+n), VillaID: mine.VillaID, RequesterID: e.ID, RequesterName: e.Name,
			Date: mine.Date, ShiftID: *mine.ShiftID, CounterpartID: other.ID, CounterpartName: other.Name, Note: strings.TrimSpace(in.Note), Status: "offered", RequestedOn: w.Today}
		if theirs != nil {
			s.CounterDate, s.CounterShiftID = &theirs.Date, theirs.ShiftID
		}
		if err := h.saveSwap(ctx, s, 0); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "shift-swap", EntityID: s.Number, Summary: fmt.Sprintf("%s offered the shift on %s to %s", e.Name, s.Date, other.Name)})
	})
	return s, err
}

// MoveSwap moves a swap one step: the coworker accepts or declines, the requester cancels, and the
// roster editor (hr/edit) approves or rejects an accepted swap. Accepting and approving check the
// roster again; approval swaps the two assignments.
type MoveSwap struct{ Deps }

// Handle moves the swap.
func (h MoveSwap) Handle(ctx context.Context, p auth.Principal, id, action, note string) (domain.ShiftSwap, error) {
	if action == "approve" || action == "reject" {
		if err := h.Authz.Require(ctx, p.Role, hrEdit...); err != nil {
			return domain.ShiftSwap{}, err
		}
	}
	if action == "reject" {
		if err := domain.CheckDecision(domain.Rejected, note); err != nil {
			return domain.ShiftSwap{}, err
		}
	}
	var s domain.ShiftSwap
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		version, err := h.Repo.Load(ctx, Swaps, id, &s)
		if err != nil {
			return err
		}
		if action == "approve" || action == "reject" {
			if _, err := h.villaInScope(ctx, p, s.VillaID); err != nil {
				return err
			}
		}
		employeeID := ""
		if p.EmployeeID != nil {
			employeeID = *p.EmployeeID
		}
		to, err := domain.MoveSwap(s, action, employeeID, note)
		if err != nil {
			return err
		}
		if action == "accept" || action == "approve" {
			requester, err := h.findEmployee(ctx, s.RequesterID)
			if err != nil {
				return err
			}
			counterpart, err := h.findEmployee(ctx, s.CounterpartID)
			if err != nil {
				return err
			}
			w, err := h.swapWorld(ctx, requester, counterpart)
			if err != nil {
				return err
			}
			mine, theirs, err := domain.CheckSwap(s.Date, s.CounterDate, w, s.ID)
			if err != nil {
				return err
			}
			if action == "approve" {
				for _, cell := range domain.SwapAssignments(s, mine, theirs) {
					if _, err := h.setAssignment(ctx, cell); err != nil {
						return err
					}
				}
			}
		}
		before, today := s.Status, h.today()
		s.Status = to
		if action == "accept" || action == "decline" {
			s.RespondedOn = &today
		} else {
			s.DecidedOn, s.DecidedBy, s.DecisionNote = &today, p.Name, strings.TrimSpace(note)
		}
		if err := h.saveSwap(ctx, s, version); err != nil {
			return err
		}
		return h.decided(ctx, p, "shift-swap", s.Number, before, to)
	})
	return s, err
}
