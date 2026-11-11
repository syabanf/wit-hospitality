// Package postgres implements the maintenance context's write repository, read store,
// projections, cash-out requests and seed loader on the maintenance schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the maintenance context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "maintenance", FS: sub}
}

// Repo is the write repository.
type Repo struct{ DB *db.DB }

func notFound(err error, what, id string) error {
	if db.NoRows(err) {
		return errs.NotFound(what, id)
	}
	return err
}

func stale(tag pgconn.CommandTag, err error, what string) error {
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errs.Newf(errs.CodeConflict, "Someone else changed this %s. Reload and try again.", what)
	}
	return nil
}

// load reads one document and its version.
func load[T any](ctx context.Context, q db.Querier, sql, what, id string) (T, int64, error) {
	var v T
	var raw []byte
	var version int64
	if err := q.QueryRow(ctx, sql, id).Scan(&raw, &version); err != nil {
		return v, 0, notFound(err, what, id)
	}
	return v, version, json.Unmarshal(raw, &v)
}

// docs collects document rows.
func docs[T any](rows pgx.Rows, err error) ([]T, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (T, error) {
		var v T
		var raw []byte
		if err := r.Scan(&raw); err != nil {
			return v, err
		}
		return v, json.Unmarshal(raw, &v)
	})
}

// Next returns the counter's next number and moves it on; a counter starts at 1.
func (r Repo) Next(ctx context.Context, counter string) (int, error) {
	var n int
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO maintenance.counters (key, next) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET next = maintenance.counters.next + 1
		RETURNING next - 1`, counter).Scan(&n)
	return n, err
}

// Villa reads a projected villa.
func (r Repo) Villa(ctx context.Context, id string) (command.Villa, error) {
	var v command.Villa
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, location_id, name FROM maintenance.ref_villas WHERE id = $1`, id).Scan(&v.ID, &v.LocationID, &v.Name)
	return v, notFound(err, "villa", id)
}

// Unit reads a projected unit.
func (r Repo) Unit(ctx context.Context, id string) (command.Unit, error) {
	var u command.Unit
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, villa_id, code FROM maintenance.ref_units WHERE id = $1`, id).Scan(&u.ID, &u.VillaID, &u.Code)
	return u, notFound(err, "unit", id)
}

// WorkOrder loads and locks a work order.
func (r Repo) WorkOrder(ctx context.Context, id string) (domain.WorkOrder, error) {
	w, version, err := load[domain.WorkOrder](ctx, r.DB.Q(ctx), `SELECT doc, version FROM maintenance.work_orders WHERE id = $1 FOR UPDATE`, "work order", id)
	w.Version = version
	return w, err
}

// InsertWorkOrder adds a work order at version 1.
func (r Repo) InsertWorkOrder(ctx context.Context, w *domain.WorkOrder) error {
	w.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO maintenance.work_orders (id, number, villa_id, plan_id, status, doc, version) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
		w.ID, w.Number, w.VillaID, w.PlanID, w.Status, w)
	return err
}

// UpdateWorkOrder saves when the version matches.
func (r Repo) UpdateWorkOrder(ctx context.Context, w *domain.WorkOrder) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `
		UPDATE maintenance.work_orders SET villa_id = $2, plan_id = $3, status = $4, doc = $5, version = version + 1
		WHERE id = $1 AND version = $6`, w.ID, w.VillaID, w.PlanID, w.Status, w, w.Version)
	if err := stale(tag, err, "work order"); err != nil {
		return err
	}
	w.Version++
	return nil
}

// FindAsset loads and locks an asset, or nil when there is none.
func (r Repo) FindAsset(ctx context.Context, id string) (*domain.Asset, error) {
	a, err := r.Asset(ctx, id)
	if errs.HasCode(err, errs.CodeNotFound) {
		return nil, nil
	}
	return &a, err
}

// Asset loads and locks an asset.
func (r Repo) Asset(ctx context.Context, id string) (domain.Asset, error) {
	a, version, err := load[domain.Asset](ctx, r.DB.Q(ctx), `SELECT doc, version FROM maintenance.assets WHERE id = $1 FOR UPDATE`, "asset", id)
	a.Version = version
	return a, err
}

// AssetCodeTaken reports whether another asset uses code.
func (r Repo) AssetCodeTaken(ctx context.Context, code, excludeID string) (bool, error) {
	var taken bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM maintenance.assets WHERE code = $1 AND id <> $2)`, code, excludeID).Scan(&taken)
	return taken, err
}

// InsertAsset adds an asset at version 1.
func (r Repo) InsertAsset(ctx context.Context, a *domain.Asset) error {
	a.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO maintenance.assets (id, code, villa_id, doc, version) VALUES ($1, $2, $3, $4, 1)`, a.ID, a.Code, a.VillaID, a)
	return duplicateCode(err, a.Code)
}

// UpdateAsset saves when the version matches.
func (r Repo) UpdateAsset(ctx context.Context, a *domain.Asset) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE maintenance.assets SET code = $2, villa_id = $3, doc = $4, version = version + 1 WHERE id = $1 AND version = $5`,
		a.ID, a.Code, a.VillaID, a, a.Version)
	if err := stale(tag, duplicateCode(err, a.Code), "asset"); err != nil {
		return err
	}
	a.Version++
	return nil
}

func duplicateCode(err error, code string) error {
	if _, dup := db.UniqueViolation(err); dup {
		return errs.Invalid("code", code+" is already used.")
	}
	return err
}

// Vendor loads and locks a vendor.
func (r Repo) Vendor(ctx context.Context, id string) (domain.Vendor, error) {
	v, version, err := load[domain.Vendor](ctx, r.DB.Q(ctx), `SELECT doc, version FROM maintenance.vendors WHERE id = $1 FOR UPDATE`, "vendor", id)
	v.Version = version
	return v, err
}

// VendorNameTaken reports whether another vendor has the name, ignoring case.
func (r Repo) VendorNameTaken(ctx context.Context, name, excludeID string) (bool, error) {
	var taken bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM maintenance.vendors WHERE lower(name) = lower($1) AND id <> $2)`, strings.TrimSpace(name), excludeID).Scan(&taken)
	return taken, err
}

// InsertVendor adds a vendor at version 1.
func (r Repo) InsertVendor(ctx context.Context, v *domain.Vendor) error {
	v.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO maintenance.vendors (id, name, doc, version) VALUES ($1, $2, $3, 1)`, v.ID, v.Name, v)
	return duplicateName(err, v.Name)
}

// UpdateVendor saves when the version matches.
func (r Repo) UpdateVendor(ctx context.Context, v *domain.Vendor) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE maintenance.vendors SET name = $2, doc = $3, version = version + 1 WHERE id = $1 AND version = $4`, v.ID, v.Name, v, v.Version)
	if err := stale(tag, duplicateName(err, v.Name), "vendor"); err != nil {
		return err
	}
	v.Version++
	return nil
}

func duplicateName(err error, name string) error {
	if _, dup := db.UniqueViolation(err); dup {
		return errs.Invalid("name", name+" already exists.")
	}
	return err
}

// FindPlan loads and locks a plan, or nil when there is none.
func (r Repo) FindPlan(ctx context.Context, id string) (*domain.Plan, error) {
	p, err := r.Plan(ctx, id)
	if errs.HasCode(err, errs.CodeNotFound) {
		return nil, nil
	}
	return &p, err
}

// Plan loads and locks a plan.
func (r Repo) Plan(ctx context.Context, id string) (domain.Plan, error) {
	p, version, err := load[domain.Plan](ctx, r.DB.Q(ctx), `SELECT doc, version FROM maintenance.plans WHERE id = $1 FOR UPDATE`, "plan", id)
	p.Version = version
	return p, err
}

// DuePlans lists active plans due by until with no open work order, in plan order, locked.
func (r Repo) DuePlans(ctx context.Context, until string) ([]domain.Plan, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `
		SELECT p.doc, p.version FROM maintenance.plans p
		WHERE p.active AND p.next_due <= $1
		  AND NOT EXISTS (SELECT 1 FROM maintenance.work_orders w WHERE w.plan_id = p.id AND w.status NOT IN ('done', 'verified', 'cancelled'))
		ORDER BY p.seq FOR UPDATE OF p`, until)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Plan, error) {
		var p domain.Plan
		var raw []byte
		if err := row.Scan(&raw, &p.Version); err != nil {
			return p, err
		}
		version := p.Version
		err := json.Unmarshal(raw, &p)
		p.Version = version
		return p, err
	})
}

// InsertPlan adds a plan at version 1.
func (r Repo) InsertPlan(ctx context.Context, p *domain.Plan) error {
	p.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO maintenance.plans (id, villa_id, active, next_due, doc, version) VALUES ($1, $2, $3, $4, $5, 1)`,
		p.ID, p.VillaID, p.Active, p.NextDue, p)
	return err
}

// UpdatePlan saves when the version matches.
func (r Repo) UpdatePlan(ctx context.Context, p *domain.Plan) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE maintenance.plans SET villa_id = $2, active = $3, next_due = $4, doc = $5, version = version + 1 WHERE id = $1 AND version = $6`,
		p.ID, p.VillaID, p.Active, p.NextDue, p, p.Version)
	if err := stale(tag, err, "plan"); err != nil {
		return err
	}
	p.Version++
	return nil
}
