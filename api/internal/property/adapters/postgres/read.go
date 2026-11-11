package postgres

import (
	"context"
	"encoding/json"

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
		SELECT id, location_id, code, name, description, facilities FROM property.rm_villas
		WHERE `+inScopeVilla+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Villa, error) {
		var v domain.Villa
		err := r.Scan(&v.ID, &v.LocationID, &v.Code, &v.Name, &v.Description, &v.Facilities)
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
		SELECT id, villa_id, group_id, code, name, bedrooms, nightly_rate, status, amenities FROM property.rm_units
		WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Unit, error) {
		var u domain.Unit
		err := r.Scan(&u.ID, &u.VillaID, &u.GroupID, &u.Code, &u.Name, &u.Bedrooms, &u.NightlyRate, &u.Status, &u.Amenities)
		return u, err
	})
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
