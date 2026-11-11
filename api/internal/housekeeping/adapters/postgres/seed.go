package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
)

// SeedData is seed/housekeeping.json, written by scripts/export-seed.mjs from the mock's buildState.
// Staff and Items are what the people and inventory stubs answer until those contexts run.
type SeedData struct {
	BaseDate    string                `json:"baseDate"`
	Settings    domain.Settings       `json:"settings"`
	Board       []domain.Record       `json:"board"`
	Tasks       []domain.RoomTask     `json:"tasks"`
	LinenPars   []domain.LinenPar     `json:"linenPars"`
	LinenSoiled []domain.LinenCount   `json:"linenSoiled"`
	Batches     []domain.LaundryBatch `json:"laundryBatches"`
	UnitVillas  map[string]string     `json:"unitVillas"`
	GroupVillas map[string]string     `json:"groupVillas"`
	Next        map[string]int64      `json:"next"`
	Staff       domain.StaffDay       `json:"staff"`
	Items       []domain.Item         `json:"items"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

func shift(d string, n int) string {
	if d == "" {
		return d
	}
	return clock.AddDays(d, n)
}

func shiftPtr(d *string, n int) *string {
	if d == nil {
		return nil
	}
	s := shiftStamp(*d, n)
	return &s
}

// shiftStamp moves the date part of a date or a local date-time.
func shiftStamp(s string, n int) string {
	if len(s) < 10 {
		return s
	}
	return shift(s[:10], n) + s[10:]
}

// ShiftStaff moves the roster and leave dates by n days.
func ShiftStaff(s domain.StaffDay, n int) domain.StaffDay {
	out := domain.StaffDay{Employees: s.Employees, Roster: make([]domain.RosterDay, len(s.Roster)), Leaves: make([]domain.Leave, len(s.Leaves))}
	for i, r := range s.Roster {
		r.Date = shift(r.Date, n)
		out.Roster[i] = r
	}
	for i, l := range s.Leaves {
		l.From, l.To = shift(l.From, n), shift(l.To, n)
		out.Leaves[i] = l
	}
	return out
}

// Seed replaces the housekeeping write model with the fixture, shifted by shiftDays. The catalog
// and stay copies come from the property and reservation seed events.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int) error {
	repo := Repo{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE housekeeping.counters, housekeeping.settings, housekeeping.board, housekeeping.tasks, housekeeping.linen_pars,
			housekeeping.linen_soiled, housekeeping.laundry_batches, housekeeping.cat_villas, housekeeping.cat_unit_groups, housekeeping.cat_units,
			housekeeping.stays RESTART IDENTITY`); err != nil {
			return err
		}
		if _, err := repo.SaveSettings(ctx, data.Settings, 0); err != nil {
			return fmt.Errorf("seed housekeeping settings: %w", err)
		}
		for _, r := range data.Board {
			r.UpdatedOn = shift(r.UpdatedOn, shiftDays)
			if r.LastInspection != nil {
				r.LastInspection.On = shift(r.LastInspection.On, shiftDays)
			}
			r.Version = 0
			if err := repo.SaveRecord(ctx, &r, data.UnitVillas[r.UnitID]); err != nil {
				return fmt.Errorf("seed board %s: %w", r.UnitID, err)
			}
		}
		for _, t := range data.Tasks {
			t.Date = shift(t.Date, shiftDays)
			t.StartedAt, t.FinishedAt, t.RunningSince = shiftPtr(t.StartedAt, shiftDays), shiftPtr(t.FinishedAt, shiftDays), shiftPtr(t.RunningSince, shiftDays)
			for i := range t.History {
				t.History[i].At = shiftStamp(t.History[i].At, shiftDays)
			}
			for i := range t.LostFound {
				t.LostFound[i].At = shiftStamp(t.LostFound[i].At, shiftDays)
			}
			t.Normalize()
			if err := repo.InsertTask(ctx, &t); err != nil {
				return fmt.Errorf("seed task %s: %w", t.ID, err)
			}
		}
		for _, p := range data.LinenPars {
			p.Version = 0
			if err := repo.SavePar(ctx, &p, data.GroupVillas[p.GroupID]); err != nil {
				return fmt.Errorf("seed linen par %s: %w", p.GroupID, err)
			}
		}
		for _, c := range data.LinenSoiled {
			if err := repo.AddSoiled(ctx, c.VillaID, []domain.Line{{ItemID: c.ItemID, Quantity: c.Quantity}}, 1); err != nil {
				return err
			}
		}
		for _, b := range data.Batches {
			b.SentOn, b.ReturnedOn = shift(b.SentOn, shiftDays), shiftPtr(b.ReturnedOn, shiftDays)
			b.Normalize()
			if err := repo.InsertBatch(ctx, &b); err != nil {
				return fmt.Errorf("seed laundry batch %s: %w", b.ID, err)
			}
		}
		for key, n := range data.Next {
			if _, err := q.Exec(ctx, `INSERT INTO housekeeping.counters (key, n) VALUES ($1, $2)`, key, n); err != nil {
				return err
			}
		}
		return nil
	})
}
