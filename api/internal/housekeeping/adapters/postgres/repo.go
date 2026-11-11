// Package postgres implements the housekeeping context's store, read store, projections and seed
// loader on the housekeeping schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the housekeeping context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "housekeeping", FS: sub}
}

// Repo is the write store.
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

func scanDoc[T any](row pgx.Row, version *int64) (T, error) {
	var v T
	var raw []byte
	if err := row.Scan(&raw, version); err != nil {
		return v, err
	}
	err := json.Unmarshal(raw, &v)
	return v, err
}

// Next returns the next number of a sequence: roomTask, laundryBatch, linenDiscard.
func (r Repo) Next(ctx context.Context, key string) (int64, error) {
	var n int64
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO housekeeping.counters (key, n) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET n = housekeeping.counters.n + 1
		RETURNING n - 1`, key).Scan(&n)
	return n, err
}

// Settings reads the settings, the defaults until someone saves them.
func (r Repo) Settings(ctx context.Context) (domain.Settings, int64, error) {
	var version int64
	s, err := scanDoc[domain.Settings](r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM housekeeping.settings WHERE id = 'housekeeping'`), &version)
	if db.NoRows(err) {
		return domain.DefaultSettings(), 0, nil
	}
	return s, version, err
}

// SaveSettings writes the settings when the version matches (0 for the first save).
func (r Repo) SaveSettings(ctx context.Context, s domain.Settings, version int64) (int64, error) {
	doc, err := json.Marshal(s)
	if err != nil {
		return 0, err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.settings (id, doc, version) VALUES ('housekeeping', $1, 1)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = housekeeping.settings.version + 1
		WHERE housekeeping.settings.version = $2`, doc, version)
	return version + 1, stale(tag, err, "setting")
}

// Record loads and locks a unit's board record.
func (r Repo) Record(ctx context.Context, unitID string) (domain.Record, bool, error) {
	var version int64
	rec, err := scanDoc[domain.Record](r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM housekeeping.board WHERE unit_id = $1 FOR UPDATE`, unitID), &version)
	if db.NoRows(err) {
		return rec, false, nil
	}
	rec.Version = version
	return rec, err == nil, err
}

// SaveRecord inserts a new record at version 1 or updates one when the version matches.
func (r Repo) SaveRecord(ctx context.Context, rec *domain.Record, villaID string) error {
	doc, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	if rec.Version == 0 {
		_, err = r.DB.Q(ctx).Exec(ctx, `INSERT INTO housekeeping.board (unit_id, villa_id, state, doc, version) VALUES ($1, $2, $3, $4, 1)`, rec.UnitID, villaID, rec.State, doc)
		if err == nil {
			rec.Version = 1
		}
		return err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE housekeeping.board SET villa_id = $2, state = $3, doc = $4, version = version + 1 WHERE unit_id = $1 AND version = $5`,
		rec.UnitID, villaID, rec.State, doc, rec.Version)
	if err := stale(tag, err, "housekeeping record"); err != nil {
		return err
	}
	rec.Version++
	return nil
}

// DirtyUnits lists the units the board shows dirty.
func (r Repo) DirtyUnits(ctx context.Context) (map[string]bool, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT unit_id FROM housekeeping.board WHERE state = 'dirty'`)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	out := map[string]bool{}
	for _, id := range ids {
		out[id] = true
	}
	return out, err
}

// Task loads and locks a task.
func (r Repo) Task(ctx context.Context, id string) (domain.RoomTask, error) {
	var version int64
	t, err := scanDoc[domain.RoomTask](r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM housekeeping.tasks WHERE id = $1 FOR UPDATE`, id), &version)
	t.Version = version
	t.Normalize()
	return t, notFound(err, "housekeeping task", id)
}

// DayTasks loads and locks the day's tasks in creation order.
func (r Repo) DayTasks(ctx context.Context, date string) ([]domain.RoomTask, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc, version FROM housekeeping.tasks WHERE day = $1::date ORDER BY seq FOR UPDATE`, date)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.RoomTask, error) {
		var version int64
		t, err := scanDoc[domain.RoomTask](row, &version)
		t.Version = version
		t.Normalize()
		return t, err
	})
}

// InsertTask adds a task at version 1.
func (r Repo) InsertTask(ctx context.Context, t *domain.RoomTask) error {
	t.Version = 1
	doc, err := json.Marshal(t)
	if err != nil {
		return err
	}
	_, err = r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.tasks (id, day, villa_id, unit_id, status, attendant_id, doc, version) VALUES ($1, $2::date, $3, $4, $5, $6, $7, 1)`,
		t.ID, t.Date, t.VillaID, t.UnitID, t.Status, t.AttendantID, doc)
	return err
}

// UpdateTask saves when the version matches.
func (r Repo) UpdateTask(ctx context.Context, t *domain.RoomTask) error {
	doc, err := json.Marshal(t)
	if err != nil {
		return err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `
		UPDATE housekeeping.tasks SET status = $2, attendant_id = $3, doc = $4, version = version + 1 WHERE id = $1 AND version = $5`,
		t.ID, t.Status, t.AttendantID, doc, t.Version)
	if err := stale(tag, err, "housekeeping task"); err != nil {
		return err
	}
	t.Version++
	return nil
}

// Par reads a room type's linen par, nil when it has none.
func (r Repo) Par(ctx context.Context, groupID string) (*domain.LinenPar, error) {
	var version int64
	p, err := scanDoc[domain.LinenPar](r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM housekeeping.linen_pars WHERE group_id = $1 FOR UPDATE`, groupID), &version)
	if db.NoRows(err) {
		return nil, nil
	}
	p.Version = version
	return &p, err
}

// SavePar inserts or replaces a par; Version 0 is a new one.
func (r Repo) SavePar(ctx context.Context, p *domain.LinenPar, villaID string) error {
	doc, err := json.Marshal(p)
	if err != nil {
		return err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.linen_pars (group_id, villa_id, doc, version) VALUES ($1, $2, $3, 1)
		ON CONFLICT (group_id) DO UPDATE SET villa_id = EXCLUDED.villa_id, doc = EXCLUDED.doc, version = housekeeping.linen_pars.version + 1
		WHERE housekeeping.linen_pars.version = $4`, p.GroupID, villaID, doc, p.Version)
	if err := stale(tag, err, "linen par"); err != nil {
		return err
	}
	p.Version++
	return nil
}

// Soiled is the count of one item in a villa's soiled bags.
func (r Repo) Soiled(ctx context.Context, villaID, itemID string) (int, error) {
	var n int
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT quantity FROM housekeeping.linen_soiled WHERE villa_id = $1 AND item_id = $2 FOR UPDATE`, villaID, itemID).Scan(&n)
	if db.NoRows(err) {
		return 0, nil
	}
	return n, err
}

// AddSoiled adds (sign 1) or takes (sign -1) pieces from a villa's soiled bags.
func (r Repo) AddSoiled(ctx context.Context, villaID string, lines []domain.Line, sign int) error {
	for _, l := range lines {
		if _, err := r.DB.Q(ctx).Exec(ctx, `
			INSERT INTO housekeeping.linen_soiled (villa_id, item_id, quantity) VALUES ($1, $2, $3)
			ON CONFLICT (villa_id, item_id) DO UPDATE SET quantity = housekeeping.linen_soiled.quantity + EXCLUDED.quantity`,
			villaID, l.ItemID, sign*l.Quantity); err != nil {
			return err
		}
	}
	return nil
}

// Batch loads and locks a laundry batch.
func (r Repo) Batch(ctx context.Context, id string) (domain.LaundryBatch, error) {
	var version int64
	b, err := scanDoc[domain.LaundryBatch](r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM housekeeping.laundry_batches WHERE id = $1 FOR UPDATE`, id), &version)
	b.Version = version
	b.Normalize()
	return b, notFound(err, "laundry batch", id)
}

// InsertBatch adds a batch at version 1.
func (r Repo) InsertBatch(ctx context.Context, b *domain.LaundryBatch) error {
	b.Version = 1
	doc, err := json.Marshal(b)
	if err != nil {
		return err
	}
	_, err = r.DB.Q(ctx).Exec(ctx, `INSERT INTO housekeeping.laundry_batches (id, villa_id, status, doc, version) VALUES ($1, $2, $3, $4, 1)`, b.ID, b.VillaID, b.Status, doc)
	return err
}

// UpdateBatch saves when the version matches.
func (r Repo) UpdateBatch(ctx context.Context, b *domain.LaundryBatch) error {
	doc, err := json.Marshal(b)
	if err != nil {
		return err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE housekeeping.laundry_batches SET status = $2, doc = $3, version = version + 1 WHERE id = $1 AND version = $4`, b.ID, b.Status, doc, b.Version)
	if err := stale(tag, err, "laundry batch"); err != nil {
		return err
	}
	b.Version++
	return nil
}

const unitColumns = `SELECT id, villa_id, group_id, code, status FROM housekeeping.cat_units`

func scanUnit(row pgx.Row) (domain.Unit, error) {
	var u domain.Unit
	err := row.Scan(&u.ID, &u.VillaID, &u.GroupID, &u.Code, &u.Status)
	return u, err
}

// Unit reads a unit from the catalog copy.
func (r Repo) Unit(ctx context.Context, id string) (domain.Unit, error) {
	u, err := scanUnit(r.DB.Q(ctx).QueryRow(ctx, unitColumns+` WHERE id = $1`, id))
	return u, notFound(err, "unit", id)
}

// Units lists the catalog's units in creation order.
func (r Repo) Units(ctx context.Context) ([]domain.Unit, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, unitColumns+` ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Unit, error) { return scanUnit(row) })
}

// Villa reads a villa from the catalog copy.
func (r Repo) Villa(ctx context.Context, id string) (domain.Villa, error) {
	var v domain.Villa
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, location_id, name FROM housekeeping.cat_villas WHERE id = $1`, id).Scan(&v.ID, &v.LocationID, &v.Name)
	return v, notFound(err, "villa", id)
}

// Group reads a room type from the catalog copy.
func (r Repo) Group(ctx context.Context, id string) (domain.Group, error) {
	var g domain.Group
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, villa_id, name FROM housekeeping.cat_unit_groups WHERE id = $1`, id).Scan(&g.ID, &g.VillaID, &g.Name)
	return g, notFound(err, "unit group", id)
}

const stayColumns = `SELECT id, code, unit_id, unit_assigned, status, to_char(check_in, 'YYYY-MM-DD'), to_char(check_out, 'YYYY-MM-DD') FROM housekeeping.stays`

func scanStay(row pgx.Row) (domain.Stay, error) {
	var s domain.Stay
	err := row.Scan(&s.ID, &s.Code, &s.UnitID, &s.UnitAssigned, &s.Status, &s.CheckIn, &s.CheckOut)
	return s, err
}

// Stay reads a stay, nil when housekeeping has no copy of it.
func (r Repo) Stay(ctx context.Context, id string) (*domain.Stay, error) {
	s, err := scanStay(r.DB.Q(ctx).QueryRow(ctx, stayColumns+` WHERE id = $1`, id))
	if db.NoRows(err) {
		return nil, nil
	}
	return &s, err
}

// PlanStays lists the assigned stays that occupy a room, in booking order.
func (r Repo) PlanStays(ctx context.Context) ([]domain.PlanStay, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, stayColumns+` WHERE unit_assigned AND status IN ('checked_in', 'checked_out', 'confirmed') ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.PlanStay, error) {
		s, err := scanStay(row)
		return domain.PlanStay{ID: s.ID, UnitID: s.UnitID, CheckIn: s.CheckIn, CheckOut: s.CheckOut}, err
	})
}

// InHouse is the stay checked in on the unit over date.
func (r Repo) InHouse(ctx context.Context, unitID, date string) (*domain.Stay, error) {
	s, err := scanStay(r.DB.Q(ctx).QueryRow(ctx, stayColumns+` WHERE unit_id = $1 AND status = 'checked_in' AND check_in <= $2::date AND $2::date < check_out ORDER BY seq LIMIT 1`, unitID, date))
	if db.NoRows(err) {
		return nil, nil
	}
	return &s, err
}
