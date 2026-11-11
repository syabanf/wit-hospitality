// Package postgres implements the payroll context's write repository, its copies of the people
// records, the read store, projections and seed loader on the payroll schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/payroll/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/domain"
	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the payroll context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "payroll", FS: sub}
}

// Repo is the write repository and the reader of the people copies.
type Repo struct{ DB *db.DB }

var (
	_ command.Repository = Repo{}
	_ command.Inputs     = Repo{}
)

// Settings returns the stored settings, or the defaults at version 0.
func (r Repo) Settings(ctx context.Context) (domain.Settings, int64, error) {
	var raw []byte
	var version int64
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT data, version FROM payroll.settings WHERE id = 1`).Scan(&raw, &version)
	if db.NoRows(err) {
		return domain.DefaultSettings, 0, nil
	}
	if err != nil {
		return domain.Settings{}, 0, err
	}
	var s domain.Settings
	return s, version, json.Unmarshal(raw, &s)
}

// SaveSettings inserts or replaces the settings when the version matches.
func (r Repo) SaveSettings(ctx context.Context, s domain.Settings, version int64) (int64, error) {
	data, err := json.Marshal(s)
	if err != nil {
		return 0, err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO payroll.settings (id, data, version) VALUES (1, $1, 1)
		ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = payroll.settings.version + 1
		WHERE payroll.settings.version = $2`, data, version)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, errs.New(errs.CodeConflict, "Someone else changed the payroll settings. Reload and try again.")
	}
	return version + 1, nil
}

// Period loads and locks a period.
func (r Repo) Period(ctx context.Context, id string) (domain.Period, int64, error) {
	var raw []byte
	var version int64
	var p domain.Period
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT data, version FROM payroll.periods WHERE id = $1 FOR UPDATE`, id).Scan(&raw, &version)
	if db.NoRows(err) {
		return p, 0, errs.NotFound("payroll period", id)
	}
	if err != nil {
		return p, 0, err
	}
	return p, version, json.Unmarshal(raw, &p)
}

// MonthTaken reports a period for the month.
func (r Repo) MonthTaken(ctx context.Context, month string) (bool, error) {
	var taken bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM payroll.periods WHERE month = $1)`, month).Scan(&taken)
	return taken, err
}

// SavePeriod inserts at version 1 when version is 0, else updates when the version matches.
func (r Repo) SavePeriod(ctx context.Context, p domain.Period, version int64) (int64, error) {
	if p.Lines == nil {
		p.Lines = []domain.Line{}
	}
	data, err := json.Marshal(p)
	if err != nil {
		return 0, err
	}
	q := r.DB.Q(ctx)
	if version == 0 {
		_, err := q.Exec(ctx, `INSERT INTO payroll.periods (id, month, data, version) VALUES ($1, $2, $3, 1)`, p.ID, p.Month, data)
		if _, dup := db.UniqueViolation(err); dup {
			return 0, errs.Newf("PAYROLL_EXISTS", "Payroll for %s already exists.", p.Month)
		}
		return 1, err
	}
	tag, err := q.Exec(ctx, `UPDATE payroll.periods SET data = $2, version = version + 1 WHERE id = $1 AND version = $3`, p.ID, data, version)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, errs.New(errs.CodeConflict, "Someone else changed this payroll period. Reload and try again.")
	}
	return version + 1, nil
}

// Next is the mock's seq(key).
func (r Repo) Next(ctx context.Context, key string) (int, error) {
	var n int
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO payroll.counters (key, n) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET n = payroll.counters.n + 1 RETURNING n - 1`, key).Scan(&n)
	return n, err
}

func collect[T any](rows pgx.Rows, err error) ([]T, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (T, error) {
		var raw []byte
		var v T
		if err := r.Scan(&raw); err != nil {
			return v, err
		}
		return v, json.Unmarshal(raw, &v)
	})
}

// Employees lists the employee copies in the order people created them.
func (r Repo) Employees(ctx context.Context) ([]people.Employee, error) {
	return collect[people.Employee](r.DB.Q(ctx).Query(ctx, `SELECT data FROM payroll.rm_employees ORDER BY seq`))
}

// Attendance lists the month's attendance copies.
func (r Repo) Attendance(ctx context.Context, month string) ([]people.Attendance, error) {
	return collect[people.Attendance](r.DB.Q(ctx).Query(ctx, `SELECT data FROM payroll.rm_attendance WHERE day LIKE $1 || '%' ORDER BY day, id`, month))
}

// Overtime lists the month's overtime copies.
func (r Repo) Overtime(ctx context.Context, month string) ([]people.OvertimeRequest, error) {
	return collect[people.OvertimeRequest](r.DB.Q(ctx).Query(ctx, `SELECT data FROM payroll.rm_overtime WHERE day LIKE $1 || '%' ORDER BY day, id`, month))
}

// Loans lists the loan copies in creation order.
func (r Repo) Loans(ctx context.Context) ([]people.Loan, error) {
	return collect[people.Loan](r.DB.Q(ctx).Query(ctx, `SELECT data FROM payroll.rm_loans ORDER BY seq`))
}
