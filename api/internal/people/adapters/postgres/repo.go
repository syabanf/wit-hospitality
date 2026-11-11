// Package postgres implements the people context's write repository, read store, projections
// and seed loader on the people schema. Each record kind is a table of JSON documents with the
// columns the rules and scope filters need (see the migration).
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/people/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the people context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "people", FS: sub}
}

// Repo is the write repository.
type Repo struct{ DB *db.DB }

var _ command.Repository = Repo{}

func list(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// Load reads and locks one record into out and returns its version.
func (r Repo) Load(ctx context.Context, k command.Kind, id string, out any) (int64, error) {
	var raw []byte
	var version int64
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT data, version FROM people.`+k.Table+` WHERE id = $1 FOR UPDATE`, id).Scan(&raw, &version)
	if db.NoRows(err) {
		return 0, errs.NotFound(k.What, id)
	}
	if err != nil {
		return 0, err
	}
	return version, json.Unmarshal(raw, out)
}

// FindBy reads and locks the record of an employee under a natural key; version 0 when absent.
func (r Repo) FindBy(ctx context.Context, k command.Kind, employeeID, key string, out any) (int64, error) {
	var raw []byte
	var version int64
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT data, version FROM people.`+k.Table+` WHERE employee_id = $1 AND key = $2 FOR UPDATE`, employeeID, key).Scan(&raw, &version)
	if db.NoRows(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return version, json.Unmarshal(raw, out)
}

// Save inserts the record at version 1 when version is 0, else updates it when the stored version
// matches, and returns the new version.
func (r Repo) Save(ctx context.Context, k command.Kind, row command.Row, version int64) (int64, error) {
	data, err := json.Marshal(row.Data)
	if err != nil {
		return 0, err
	}
	q := r.DB.Q(ctx)
	if version == 0 {
		_, err := q.Exec(ctx, `INSERT INTO people.`+k.Table+` (id, employee_id, key, villa_ids, location_ids, data, version) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
			row.ID, row.EmployeeID, row.Key, list(row.VillaIDs), list(row.LocationIDs), data)
		if _, dup := db.UniqueViolation(err); dup && k.Table == "employees" {
			return 0, errs.Invalid("code", row.Key+" is already used.")
		}
		return 1, err
	}
	tag, err := q.Exec(ctx, `UPDATE people.`+k.Table+` SET employee_id = $2, key = $3, villa_ids = $4, location_ids = $5, data = $6, version = version + 1 WHERE id = $1 AND version = $7`,
		row.ID, row.EmployeeID, row.Key, list(row.VillaIDs), list(row.LocationIDs), data, version)
	if _, dup := db.UniqueViolation(err); dup && k.Table == "employees" {
		return 0, errs.Invalid("code", row.Key+" is already used.")
	}
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, errs.Newf(errs.CodeConflict, "Someone else changed this %s. Reload and try again.", k.What)
	}
	return version + 1, nil
}

// Delete removes a record.
func (r Repo) Delete(ctx context.Context, k command.Kind, id string) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `DELETE FROM people.`+k.Table+` WHERE id = $1`, id)
	return err
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

// CodeTaken reports another employee with the code.
func (r Repo) CodeTaken(ctx context.Context, code, excludeID string) (bool, error) {
	var taken bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM people.employees WHERE key = $1 AND id <> $2)`, code, excludeID).Scan(&taken)
	return taken, err
}

// FindEmployee reads an employee without locking; nil when absent.
func (r Repo) FindEmployee(ctx context.Context, id string) (*domain.Employee, error) {
	out, err := collect[domain.Employee](r.DB.Q(ctx).Query(ctx, `SELECT data FROM people.employees WHERE id = $1`, id))
	if err != nil || len(out) == 0 {
		return nil, err
	}
	return &out[0], nil
}

// Leaves lists an employee's leave requests.
func (r Repo) Leaves(ctx context.Context, employeeID string) ([]domain.LeaveRequest, error) {
	return collect[domain.LeaveRequest](r.DB.Q(ctx).Query(ctx, `SELECT data FROM people.leave_requests WHERE employee_id = $1 ORDER BY seq`, employeeID))
}

// Loans lists an employee's loans in creation order.
func (r Repo) Loans(ctx context.Context, employeeID string) ([]domain.Loan, error) {
	return collect[domain.Loan](r.DB.Q(ctx).Query(ctx, `SELECT data FROM people.loans WHERE employee_id = $1 ORDER BY seq`, employeeID))
}

// LockLoans lists and locks an employee's loans in creation order with their versions.
func (r Repo) LockLoans(ctx context.Context, employeeID string) ([]command.Versioned[domain.Loan], error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT data, version FROM people.loans WHERE employee_id = $1 ORDER BY seq FOR UPDATE`, employeeID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (command.Versioned[domain.Loan], error) {
		var raw []byte
		var v command.Versioned[domain.Loan]
		if err := row.Scan(&raw, &v.Version); err != nil {
			return v, err
		}
		return v, json.Unmarshal(raw, &v.Value)
	})
}

// Shift reads a shift; nil when absent.
func (r Repo) Shift(ctx context.Context, id string) (*domain.Shift, error) {
	out, err := collect[domain.Shift](r.DB.Q(ctx).Query(ctx, `SELECT data FROM people.shifts WHERE id = $1`, id))
	if err != nil || len(out) == 0 {
		return nil, err
	}
	return &out[0], nil
}

// ShiftOn is the shift rostered for an employee on a day; nil on a day off or without a roster.
func (r Repo) ShiftOn(ctx context.Context, employeeID, date string) (*domain.Shift, error) {
	out, err := collect[domain.Shift](r.DB.Q(ctx).Query(ctx, `
		SELECT s.data FROM people.shift_assignments a JOIN people.shifts s ON s.id = a.data->>'shiftId'
		WHERE a.employee_id = $1 AND a.key = $2`, employeeID, date))
	if err != nil || len(out) == 0 {
		return nil, err
	}
	return &out[0], nil
}

// Villa reads a villa from the projected catalog.
func (r Repo) Villa(ctx context.Context, id string) (command.Villa, error) {
	v := command.Villa{ID: id}
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT location_id, name FROM people.rm_villas WHERE id = $1`, id).Scan(&v.LocationID, &v.Name)
	if db.NoRows(err) {
		return v, errs.NotFound("villa", id)
	}
	return v, err
}

// Next is the mock's seq(key): it returns the next number and moves the counter on.
func (r Repo) Next(ctx context.Context, key string) (int, error) {
	var n int
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO people.counters (key, n) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET n = people.counters.n + 1 RETURNING n - 1`, key).Scan(&n)
	return n, err
}
