package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/payroll"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

// SeedData is seed/payroll.json, written by scripts/export-seed.mjs from the mock's buildState.
type SeedData struct {
	BaseDate string          `json:"baseDate"`
	Settings domain.Settings `json:"settings"`
	Periods  []domain.Period `json:"periods"`
	Next     map[string]int  `json:"next"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

// Seed replaces the payroll write model with the fixture, months and dates shifted, and appends
// the saved events. It clears the people copies too: the people seed's events rebuild them.
func Seed(ctx context.Context, d *db.DB, data SeedData, sh clock.Shift, now time.Time) error {
	repo := Repo{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE payroll.settings, payroll.periods, payroll.counters,
			payroll.rm_employees, payroll.rm_attendance, payroll.rm_overtime, payroll.rm_loans RESTART IDENTITY`); err != nil {
			return err
		}
		emit := func(eventType, aggregate, id string, payload any) error {
			return outbox.Append(ctx, q, now, outbox.Event{Type: eventType, AggregateType: aggregate, AggregateID: id, AggregateVersion: 1, Payload: payload})
		}
		if _, err := repo.SaveSettings(ctx, data.Settings, 0); err != nil {
			return fmt.Errorf("seed payroll settings: %w", err)
		}
		if err := emit(payroll.EventSettingsSaved, "payroll_settings", "settings", payroll.SettingsSaved{Settings: data.Settings}); err != nil {
			return err
		}
		for _, p := range data.Periods {
			p.Month = sh.Month(p.Month)
			p.ID = "pay-" + p.Month
			for i := range p.History {
				p.History[i].On = sh.Date(p.History[i].On)
			}
			for i := range p.Lines {
				for j := range p.Lines[i].Adjustments {
					p.Lines[i].Adjustments[j].On = sh.Date(p.Lines[i].Adjustments[j].On)
				}
			}
			if _, err := repo.SavePeriod(ctx, p, 0); err != nil {
				return fmt.Errorf("seed payroll %s: %w", p.Month, err)
			}
			if err := emit(payroll.EventPeriodSaved, "payroll_period", p.ID, payroll.PeriodSaved{Period: p}); err != nil {
				return err
			}
		}
		for key, n := range data.Next {
			if _, err := q.Exec(ctx, `INSERT INTO payroll.counters (key, n) VALUES ($1, $2)`, key, n); err != nil {
				return err
			}
		}
		return nil
	})
}
