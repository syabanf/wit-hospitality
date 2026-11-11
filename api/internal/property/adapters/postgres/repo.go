// Package postgres implements the property context's write repository, read store, projections
// and seed loader on the property schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the property context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "property", FS: sub}
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

// duplicate maps a unique violation on a code to the validator's message.
func duplicate(err error, field, code string) error {
	if _, dup := db.UniqueViolation(err); dup {
		return errs.Invalid(field, code+" is already used.")
	}
	return err
}

// Location loads and locks a location.
func (r Repo) Location(ctx context.Context, id string) (domain.Location, error) {
	var l domain.Location
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, name, area, version FROM property.locations WHERE id = $1 FOR UPDATE`, id).Scan(&l.ID, &l.Name, &l.Area, &l.Version)
	return l, notFound(err, "location", id)
}

// InsertLocation adds a location at version 1.
func (r Repo) InsertLocation(ctx context.Context, l *domain.Location) error {
	l.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO property.locations (id, name, area, version) VALUES ($1, $2, $3, $4)`, l.ID, l.Name, l.Area, l.Version)
	return err
}

// UpdateLocation saves when the version matches.
func (r Repo) UpdateLocation(ctx context.Context, l *domain.Location) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE property.locations SET name = $2, area = $3, version = version + 1 WHERE id = $1 AND version = $4`, l.ID, l.Name, l.Area, l.Version)
	if err := stale(tag, err, "location"); err != nil {
		return err
	}
	l.Version++
	return nil
}

// Villa loads and locks a villa.
func (r Repo) Villa(ctx context.Context, id string) (domain.Villa, error) {
	var v domain.Villa
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, location_id, code, name, description, facilities, version FROM property.villas WHERE id = $1 FOR UPDATE`, id).
		Scan(&v.ID, &v.LocationID, &v.Code, &v.Name, &v.Description, &v.Facilities, &v.Version)
	return v, notFound(err, "villa", id)
}

// VillaCodeTaken reports whether another villa uses the code.
func (r Repo) VillaCodeTaken(ctx context.Context, code, excludeID string) (bool, error) {
	var taken bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM property.villas WHERE code = $1 AND id <> $2)`, code, excludeID).Scan(&taken)
	return taken, err
}

// InsertVilla adds a villa at version 1.
func (r Repo) InsertVilla(ctx context.Context, v *domain.Villa) error {
	v.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO property.villas (id, location_id, code, name, description, facilities, version) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		v.ID, v.LocationID, v.Code, v.Name, v.Description, v.Facilities, v.Version)
	return duplicate(err, "code", v.Code)
}

// UpdateVilla saves when the version matches.
func (r Repo) UpdateVilla(ctx context.Context, v *domain.Villa) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE property.villas SET location_id = $2, code = $3, name = $4, description = $5, facilities = $6, version = version + 1 WHERE id = $1 AND version = $7`,
		v.ID, v.LocationID, v.Code, v.Name, v.Description, v.Facilities, v.Version)
	if err := stale(tag, duplicate(err, "code", v.Code), "villa"); err != nil {
		return err
	}
	v.Version++
	return nil
}

const groupColumns = `id, villa_id, name, interchangeable, operator_assigns, version`

func scanGroup(row pgx.Row) (domain.UnitGroup, error) {
	var g domain.UnitGroup
	err := row.Scan(&g.ID, &g.VillaID, &g.Name, &g.Interchangeable, &g.OperatorAssigns, &g.Version)
	return g, err
}

// Group loads and locks a room type.
func (r Repo) Group(ctx context.Context, id string) (domain.UnitGroup, error) {
	g, err := scanGroup(r.DB.Q(ctx).QueryRow(ctx, `SELECT `+groupColumns+` FROM property.unit_groups WHERE id = $1 FOR UPDATE`, id))
	return g, notFound(err, "unit group", id)
}

// FindGroup reads a room type without locking; nil when absent.
func (r Repo) FindGroup(ctx context.Context, id string) (*domain.UnitGroup, error) {
	g, err := scanGroup(r.DB.Q(ctx).QueryRow(ctx, `SELECT `+groupColumns+` FROM property.unit_groups WHERE id = $1`, id))
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// InsertGroup adds a room type at version 1.
func (r Repo) InsertGroup(ctx context.Context, g *domain.UnitGroup) error {
	g.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO property.unit_groups (`+groupColumns+`) VALUES ($1, $2, $3, $4, $5, $6)`,
		g.ID, g.VillaID, g.Name, g.Interchangeable, g.OperatorAssigns, g.Version)
	return err
}

// UpdateGroup saves when the version matches.
func (r Repo) UpdateGroup(ctx context.Context, g *domain.UnitGroup) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE property.unit_groups SET villa_id = $2, name = $3, interchangeable = $4, operator_assigns = $5, version = version + 1 WHERE id = $1 AND version = $6`,
		g.ID, g.VillaID, g.Name, g.Interchangeable, g.OperatorAssigns, g.Version)
	if err := stale(tag, err, "room type"); err != nil {
		return err
	}
	g.Version++
	return nil
}

// Unit loads and locks a unit.
func (r Repo) Unit(ctx context.Context, id string) (domain.Unit, error) {
	var u domain.Unit
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, villa_id, group_id, code, name, bedrooms, nightly_rate, status, amenities, version FROM property.units WHERE id = $1 FOR UPDATE`, id).
		Scan(&u.ID, &u.VillaID, &u.GroupID, &u.Code, &u.Name, &u.Bedrooms, &u.NightlyRate, &u.Status, &u.Amenities, &u.Version)
	return u, notFound(err, "unit", id)
}

// UnitCodeTaken reports whether another unit uses the code.
func (r Repo) UnitCodeTaken(ctx context.Context, code, excludeID string) (bool, error) {
	var taken bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM property.units WHERE code = $1 AND id <> $2)`, code, excludeID).Scan(&taken)
	return taken, err
}

// UnitIDTaken reports whether a unit has the id.
func (r Repo) UnitIDTaken(ctx context.Context, id string) (bool, error) {
	var taken bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM property.units WHERE id = $1)`, id).Scan(&taken)
	return taken, err
}

// InsertUnit adds a unit at version 1.
func (r Repo) InsertUnit(ctx context.Context, u *domain.Unit) error {
	u.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO property.units (id, villa_id, group_id, code, name, bedrooms, nightly_rate, status, amenities, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		u.ID, u.VillaID, u.GroupID, u.Code, u.Name, u.Bedrooms, u.NightlyRate, u.Status, u.Amenities, u.Version)
	return duplicate(err, "code", u.Code)
}

// UpdateUnit saves when the version matches.
func (r Repo) UpdateUnit(ctx context.Context, u *domain.Unit) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE property.units SET villa_id = $2, group_id = $3, code = $4, name = $5, bedrooms = $6, nightly_rate = $7, status = $8, amenities = $9, version = version + 1 WHERE id = $1 AND version = $10`,
		u.ID, u.VillaID, u.GroupID, u.Code, u.Name, u.Bedrooms, u.NightlyRate, u.Status, u.Amenities, u.Version)
	if err := stale(tag, duplicate(err, "code", u.Code), "unit"); err != nil {
		return err
	}
	u.Version++
	return nil
}

// RatePlan loads and locks a room type's plan; nil when it has none.
func (r Repo) RatePlan(ctx context.Context, groupID string) (*domain.RatePlan, error) {
	var p domain.RatePlan
	var seasons []byte
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT group_id, weekday_rate, weekend_rate, seasons, version FROM property.rate_plans WHERE group_id = $1 FOR UPDATE`, groupID).
		Scan(&p.GroupID, &p.WeekdayRate, &p.WeekendRate, &seasons, &p.Version)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(seasons, &p.Seasons); err != nil {
		return nil, err
	}
	return &p, nil
}

// SaveRatePlan inserts or replaces the plan; p.Version is the version it replaces (0 for new).
func (r Repo) SaveRatePlan(ctx context.Context, p *domain.RatePlan) error {
	if p.Seasons == nil {
		p.Seasons = []domain.Season{}
	}
	seasons, err := json.Marshal(p.Seasons)
	if err != nil {
		return err
	}
	var version int64
	err = r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO property.rate_plans (group_id, weekday_rate, weekend_rate, seasons, version) VALUES ($1, $2, $3, $4, 1)
		ON CONFLICT (group_id) DO UPDATE SET weekday_rate = EXCLUDED.weekday_rate, weekend_rate = EXCLUDED.weekend_rate,
			seasons = EXCLUDED.seasons, version = property.rate_plans.version + 1
		RETURNING version`, p.GroupID, p.WeekdayRate, p.WeekendRate, seasons).Scan(&version)
	if err != nil {
		return err
	}
	p.Version = version
	return nil
}

// Block loads and locks a block.
func (r Repo) Block(ctx context.Context, id string) (domain.UnitBlock, error) {
	var b domain.UnitBlock
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, unit_id, to_char(from_date, 'YYYY-MM-DD'), to_char(to_date, 'YYYY-MM-DD'), reason, note FROM property.unit_blocks WHERE id = $1 FOR UPDATE`, id).
		Scan(&b.ID, &b.UnitID, &b.From, &b.To, &b.Reason, &b.Note)
	return b, notFound(err, "block", id)
}

// InsertBlock adds a block.
func (r Repo) InsertBlock(ctx context.Context, b domain.UnitBlock) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO property.unit_blocks (id, unit_id, from_date, to_date, reason, note) VALUES ($1, $2, $3::date, $4::date, $5, $6)`,
		b.ID, b.UnitID, b.From, b.To, b.Reason, b.Note)
	return err
}

// DeleteBlock removes a block.
func (r Repo) DeleteBlock(ctx context.Context, id string) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `DELETE FROM property.unit_blocks WHERE id = $1`, id)
	return err
}
