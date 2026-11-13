package postgres

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// ReadStore reads the projected rm_* tables.
type ReadStore struct{ DB *db.DB }

// inScope is the allowedVilla rule in SQL: $1 villa ids, $2 location ids; empty lists allow all.
const inScope = `((cardinality($1::text[]) > 0 AND villa_id = ANY($1)) OR
	(cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR location_id = ANY($2))))`

func args(s rbac.Scope) []any {
	vil, loc := s.VillaIDs, s.LocationIDs
	if vil == nil {
		vil = []string{}
	}
	if loc == nil {
		loc = []string{}
	}
	return []any{vil, loc}
}

// Locations returns every location, or for a scoped user the locations of the villas they see.
func (s ReadStore) Locations(ctx context.Context, sc rbac.Scope) ([]domain.Location, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT id, name, area FROM property.rm_locations l
		WHERE (cardinality($1::text[]) = 0 AND cardinality($2::text[]) = 0)
		   OR EXISTS (SELECT 1 FROM property.rm_villas v WHERE v.location_id = l.id AND
		        ((cardinality($1::text[]) > 0 AND v.id = ANY($1)) OR (cardinality($1::text[]) = 0 AND v.location_id = ANY($2))))
		ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Location, error) {
		var l domain.Location
		err := r.Scan(&l.ID, &l.Name, &l.Area)
		return l, err
	})
}

// Villas returns the villas in scope.
func (s ReadStore) Villas(ctx context.Context, sc rbac.Scope) ([]domain.Villa, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT `+villaColumns+` FROM property.rm_villas
		WHERE `+inScopeVilla+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Villa, error) {
		var v domain.Villa
		err := r.Scan(villaFields(&v)...)
		return v, err
	})
}

// inScopeVilla is inScope for rm_villas, whose own id is the villa id.
const inScopeVilla = `((cardinality($1::text[]) > 0 AND id = ANY($1)) OR
	(cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR location_id = ANY($2))))`

// Groups returns the room types of villas in scope.
func (s ReadStore) Groups(ctx context.Context, sc rbac.Scope) ([]domain.UnitGroup, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT id, villa_id, name, interchangeable, operator_assigns FROM property.rm_unit_groups
		WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.UnitGroup, error) {
		var g domain.UnitGroup
		err := r.Scan(&g.ID, &g.VillaID, &g.Name, &g.Interchangeable, &g.OperatorAssigns)
		return g, err
	})
}

// Units returns the units of villas in scope.
func (s ReadStore) Units(ctx context.Context, sc rbac.Scope) ([]domain.Unit, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT `+unitColumns+`, status_until FROM property.rm_units
		WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Unit, error) {
		var u domain.Unit
		err := r.Scan(unitFields(&u)...)
		return u, err
	})
}

// StatusHistory returns the status changes of units in scope, newest first, narrowed by unit,
// villa and the business days from and to (inclusive) when given.
func (s ReadStore) StatusHistory(ctx context.Context, sc rbac.Scope, f domain.HistoryFilter) ([]domain.StatusChange, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT id, unit_id, from_status, to_status, reason, to_char(until, 'YYYY-MM-DD'), by_name, at FROM property.unit_status_history
		WHERE `+inScope+` AND ($3 = '' OR unit_id = $3) AND ($4 = '' OR villa_id = $4)
			AND ($5 = '' OR on_date >= $5::date) AND ($6 = '' OR on_date <= $6::date)
		ORDER BY seq DESC`, append(args(sc), f.UnitID, f.VillaID, f.From, f.To)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.StatusChange, error) {
		var c domain.StatusChange
		var at time.Time
		err := r.Scan(&c.ID, &c.UnitID, &c.From, &c.To, &c.Reason, &c.Until, &c.By, &at)
		c.At = at.UTC().Format(time.RFC3339)
		return c, err
	})
}

// PhotoOnActive reports whether the file is a photo on an active unit, or on a villa that still has
// a unit in service (a villa has no status of its own).
func (s ReadStore) PhotoOnActive(ctx context.Context, fileID string) (bool, error) {
	var found bool
	err := s.DB.Q(ctx).QueryRow(ctx, `
		WITH has AS (SELECT jsonb_build_array(jsonb_build_object('fileId', $1::text)) AS photo)
		SELECT EXISTS (SELECT 1 FROM property.rm_units, has WHERE status <> 'inactive' AND photos @> has.photo) OR
			EXISTS (SELECT 1 FROM property.rm_villas v, has WHERE v.photos @> has.photo
				AND EXISTS (SELECT 1 FROM property.rm_units u WHERE u.villa_id = v.id AND u.status <> 'inactive'))`, fileID).Scan(&found)
	return found, err
}

// RatePlans returns the plans of room types in scope.
func (s ReadStore) RatePlans(ctx context.Context, sc rbac.Scope) ([]domain.RatePlan, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT group_id, weekday_rate, weekend_rate, seasons FROM property.rm_rate_plans
		WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.RatePlan, error) {
		var p domain.RatePlan
		var seasons []byte
		if err := r.Scan(&p.GroupID, &p.WeekdayRate, &p.WeekendRate, &seasons); err != nil {
			return p, err
		}
		err := json.Unmarshal(seasons, &p.Seasons)
		return p, err
	})
}

// Blocks returns the blocks on units in scope.
func (s ReadStore) Blocks(ctx context.Context, sc rbac.Scope) ([]domain.UnitBlock, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT id, unit_id, from_date, to_date, reason, note FROM property.rm_unit_blocks
		WHERE NOT removed AND `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.UnitBlock, error) {
		var b domain.UnitBlock
		err := r.Scan(&b.ID, &b.UnitID, &b.From, &b.To, &b.Reason, &b.Note)
		return b, err
	})
}
