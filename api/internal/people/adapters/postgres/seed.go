package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/people/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

// SeedData is seed/people.json, written by scripts/export-seed.mjs from the mock's buildState.
type SeedData struct {
	BaseDate      string                   `json:"baseDate"`
	Employees     []domain.Employee        `json:"employees"`
	Shifts        []domain.Shift           `json:"shifts"`
	Assignments   []domain.ShiftAssignment `json:"assignments"`
	Attendance    []domain.Attendance      `json:"attendance"`
	Leaves        []domain.LeaveRequest    `json:"leaves"`
	Overtime      []domain.OvertimeRequest `json:"overtime"`
	Loans         []domain.Loan            `json:"loans"`
	Announcements []domain.Announcement    `json:"announcements"`
	Kpis          []domain.KpiReview       `json:"kpis"`
	Next          map[string]int           `json:"next"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

// Seed replaces the people write model with the fixture, shifted, and appends a saved event per
// record so payroll builds its copies the way it does after a command. villaLocations maps the
// seeded villas to their locations.
func Seed(ctx context.Context, d *db.DB, data SeedData, sh clock.Shift, villaLocations map[string]string, now time.Time) error {
	repo := Repo{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE people.employees, people.shifts, people.shift_assignments, people.attendance, people.leave_requests,
			people.overtime_requests, people.loans, people.announcements, people.kpi_reviews, people.counters, people.rm_villas RESTART IDENTITY`); err != nil {
			return err
		}
		put := func(k command.Kind, row command.Row, eventType, aggregate string, payload any) error {
			if _, err := repo.Save(ctx, k, row, 0); err != nil {
				return fmt.Errorf("seed %s %s: %w", k.What, row.ID, err)
			}
			return outbox.Append(ctx, q, now, outbox.Event{Type: eventType, AggregateType: aggregate, AggregateID: row.ID, AggregateVersion: 1, Payload: payload})
		}
		for _, e := range data.Employees {
			e.JoinedOn, e.LeftOn = sh.Date(e.JoinedOn), sh.DatePtr(e.LeftOn)
			locs := make([]string, 0, len(e.Allocations))
			for _, a := range e.Allocations {
				locs = append(locs, villaLocations[a.VillaID])
			}
			if err := put(command.Employees, command.Row{ID: e.ID, EmployeeID: e.ID, Key: e.Code, VillaIDs: e.VillaIDs(), LocationIDs: locs, Data: e},
				people.EventEmployeeSaved, "employee", people.EmployeeSaved{Employee: e, LocationIDs: locs}); err != nil {
				return err
			}
		}
		for _, s := range data.Shifts {
			if err := put(command.Shifts, command.Row{ID: s.ID, Data: s}, people.EventShiftSaved, "shift", people.ShiftSaved{Shift: s}); err != nil {
				return err
			}
		}
		for _, a := range data.Assignments {
			a.Date = sh.Date(a.Date)
			if err := put(command.Assignments, command.Row{ID: a.ID, EmployeeID: a.EmployeeID, Key: a.Date, Data: a}, people.EventAssignmentSaved, "shift_assignment", people.AssignmentSaved{Assignment: a}); err != nil {
				return err
			}
		}
		for _, a := range data.Attendance {
			a.Date = sh.Date(a.Date)
			if err := put(command.AttendanceK, command.Row{ID: a.ID, EmployeeID: a.EmployeeID, Key: a.Date, Data: a}, people.EventAttendanceRecorded, "attendance", people.AttendanceRecorded{Attendance: a}); err != nil {
				return err
			}
		}
		for _, l := range data.Leaves {
			l.From, l.To, l.RequestedOn, l.DecidedOn = sh.Date(l.From), sh.Date(l.To), sh.Date(l.RequestedOn), sh.DatePtr(l.DecidedOn)
			if err := put(command.Leaves, command.Row{ID: l.ID, EmployeeID: l.EmployeeID, Data: l}, people.EventLeaveSaved, "leave", people.LeaveSaved{Leave: l}); err != nil {
				return err
			}
		}
		for _, o := range data.Overtime {
			o.Date, o.RequestedOn, o.DecidedOn = sh.Date(o.Date), sh.Date(o.RequestedOn), sh.DatePtr(o.DecidedOn)
			if err := put(command.Overtimes, command.Row{ID: o.ID, EmployeeID: o.EmployeeID, Data: o}, people.EventOvertimeSaved, "overtime", people.OvertimeSaved{Overtime: o}); err != nil {
				return err
			}
		}
		for _, l := range data.Loans {
			l.RequestedOn, l.DecidedOn, l.StartMonth = sh.Date(l.RequestedOn), sh.DatePtr(l.DecidedOn), sh.Month(l.StartMonth)
			if err := put(command.Loans, command.Row{ID: l.ID, EmployeeID: l.EmployeeID, Data: l}, people.EventLoanSaved, "loan", people.LoanSaved{Loan: l}); err != nil {
				return err
			}
		}
		// The mock keeps notices newest first; the table orders by creation, so insert oldest first.
		for i := len(data.Announcements) - 1; i >= 0; i-- {
			a := data.Announcements[i]
			a.PublishedOn = sh.Date(a.PublishedOn)
			row, loc := command.Row{ID: a.ID, Data: a}, ""
			if a.VillaID != nil {
				loc = villaLocations[*a.VillaID]
				row.VillaIDs, row.LocationIDs = []string{*a.VillaID}, []string{loc}
			}
			if err := put(command.Notices, row, people.EventAnnouncementSaved, "announcement", people.AnnouncementSaved{Announcement: a, LocationID: loc}); err != nil {
				return err
			}
		}
		for _, k := range data.Kpis {
			k.Period, k.ReviewedOn = sh.Quarter(k.Period), sh.Date(k.ReviewedOn)
			if err := put(command.KpiReviews, command.Row{ID: k.ID, EmployeeID: k.EmployeeID, Key: k.Period, Data: k}, people.EventKpiSaved, "kpi_review", people.KpiSaved{Review: k}); err != nil {
				return err
			}
		}
		for key, n := range data.Next {
			if _, err := q.Exec(ctx, `INSERT INTO people.counters (key, n) VALUES ($1, $2)`, key, n); err != nil {
				return err
			}
		}
		return nil
	})
}
