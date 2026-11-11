package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/services/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// ReadStore reads the write tables in scope.
type ReadStore struct{ DB *db.DB }

var scoped = map[string]bool{query.MenuItems: true, query.Orders: true, query.Requests: true}

// inScope is the allowedVilla rule on a row's villa: $1 villa ids, $2 location ids; empty lists
// allow all.
const inScope = `((cardinality($1::text[]) > 0 AND t.villa_id = ANY($1)) OR
	(cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR v.location_id = ANY($2))))`

// Docs returns one table's rows in scope, oldest first.
func (s ReadStore) Docs(ctx context.Context, table string, sc rbac.Scope) ([]json.RawMessage, error) {
	var rows pgx.Rows
	var err error
	switch {
	case table == query.Partners:
		rows, err = s.DB.Q(ctx).Query(ctx, `SELECT doc FROM services.partners ORDER BY seq`)
	case scoped[table]:
		vil, loc := sc.VillaIDs, sc.LocationIDs
		if vil == nil {
			vil = []string{}
		}
		if loc == nil {
			loc = []string{}
		}
		rows, err = s.DB.Q(ctx).Query(ctx, `SELECT t.doc FROM services.`+table+` t LEFT JOIN services.cat_villas v ON v.id = t.villa_id
			WHERE `+inScope+` ORDER BY t.seq`, vil, loc)
	default:
		return nil, fmt.Errorf("unknown table %q", table)
	}
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (json.RawMessage, error) {
		var raw []byte
		err := r.Scan(&raw)
		return raw, err
	})
}

// SiteMenu lists the active items as the public site prints them (SiteMenuItem): no partner,
// cost, photo or opening hours.
func (s ReadStore) SiteMenu(ctx context.Context) ([]json.RawMessage, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT jsonb_build_object('id', doc->'id', 'villaId', doc->'villaId', 'category', doc->'category', 'name', doc->'name',
			'description', doc->'description', 'price', doc->'price', 'unit', doc->'unit')
		FROM services.menu_items WHERE (doc->>'active')::boolean ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (json.RawMessage, error) {
		var raw []byte
		err := r.Scan(&raw)
		return raw, err
	})
}

// CatalogStore reads services' copy of the property catalog.
type CatalogStore struct{ DB *db.DB }

// Villa returns one villa.
func (s CatalogStore) Villa(ctx context.Context, id string) (domain.Villa, bool, error) {
	var v domain.Villa
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT id, location_id, name FROM services.cat_villas WHERE id = $1`, id).Scan(&v.ID, &v.LocationID, &v.Name)
	if db.NoRows(err) {
		return v, false, nil
	}
	return v, err == nil, err
}

// Place returns where a unit sits.
func (s CatalogStore) Place(ctx context.Context, unitID string) (domain.Place, bool, error) {
	var p domain.Place
	err := s.DB.Q(ctx).QueryRow(ctx, `
		SELECT u.id, u.villa_id, u.code, u.name, u.status, COALESCE(v.location_id, ''), COALESCE(v.name, ''), COALESCE(l.name, '')
		FROM services.cat_units u LEFT JOIN services.cat_villas v ON v.id = u.villa_id LEFT JOIN services.cat_locations l ON l.id = v.location_id
		WHERE u.id = $1`, unitID).Scan(&p.Unit.ID, &p.Unit.VillaID, &p.Unit.Code, &p.Unit.Name, &p.Unit.Status, &p.Villa.LocationID, &p.Villa.Name, &p.LocationName)
	if db.NoRows(err) {
		return p, false, nil
	}
	p.Villa.ID = p.Unit.VillaID
	return p, err == nil, err
}

// Units lists every unit, oldest first.
func (s CatalogStore) Units(ctx context.Context) ([]domain.Unit, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT id, villa_id, code, name, status FROM services.cat_units ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Unit, error) {
		var u domain.Unit
		err := r.Scan(&u.ID, &u.VillaID, &u.Code, &u.Name, &u.Status)
		return u, err
	})
}
