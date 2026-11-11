package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/payroll/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
)

// ReadStore reads the v_* views and the employee copies.
type ReadStore struct{ DB *db.DB }

var _ query.ReadStore = ReadStore{}

// Settings returns the stored settings or the defaults.
func (s ReadStore) Settings(ctx context.Context) (domain.Settings, error) {
	out, err := collect[domain.Settings](s.DB.Q(ctx).Query(ctx, `SELECT data FROM payroll.v_settings`))
	if err != nil || len(out) == 0 {
		return domain.DefaultSettings, err
	}
	return out[0], nil
}

// Periods returns every period, oldest month first.
func (s ReadStore) Periods(ctx context.Context) ([]domain.Period, error) {
	return collect[domain.Period](s.DB.Q(ctx).Query(ctx, `SELECT data FROM payroll.v_periods ORDER BY month`))
}

// Workplaces returns each employee's villas and their locations.
func (s ReadStore) Workplaces(ctx context.Context) (map[string]query.Workplace, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT id, villa_ids, location_ids FROM payroll.rm_employees`)
	if err != nil {
		return nil, err
	}
	out := map[string]query.Workplace{}
	var id string
	var w query.Workplace
	_, err = pgx.ForEachRow(rows, []any{&id, &w.VillaIDs, &w.LocationIDs}, func() error {
		out[id] = w
		return nil
	})
	return out, err
}
