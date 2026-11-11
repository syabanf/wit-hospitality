package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ReadStore reads the write tables, which hold the console's JSON, narrowed to a scope.
type ReadStore struct{ DB *db.DB }

// lists maps each list to its table and the JSON it answers.
var lists = map[string]struct{ table, doc string }{
	query.Board:   {"board", "t.doc"},
	query.Tasks:   {"tasks", "t.doc"},
	query.Pars:    {"linen_pars", "t.doc"},
	query.Soiled:  {"linen_soiled", "jsonb_build_object('villaId', t.villa_id, 'itemId', t.item_id, 'quantity', t.quantity)"},
	query.Batches: {"laundry_batches", "t.doc"},
}

// Docs returns one list's rows in scope, oldest first. A villa list wins over a location list;
// empty lists allow all, as allowedVilla does.
func (s ReadStore) Docs(ctx context.Context, list string, sc rbac.Scope) ([]json.RawMessage, error) {
	l, ok := lists[list]
	if !ok {
		return nil, fmt.Errorf("unknown list %q", list)
	}
	vil, loc := sc.VillaIDs, sc.LocationIDs
	if vil == nil {
		vil = []string{}
	}
	if loc == nil {
		loc = []string{}
	}
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT `+l.doc+` FROM housekeeping.`+l.table+` t LEFT JOIN housekeeping.cat_villas v ON v.id = t.villa_id
		WHERE (cardinality($1::text[]) > 0 AND t.villa_id = ANY($1))
		   OR (cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR v.location_id = ANY($2)))
		ORDER BY t.seq`, vil, loc)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (json.RawMessage, error) {
		var raw []byte
		err := r.Scan(&raw)
		return raw, err
	})
}

// Settings reads the settings.
func (s ReadStore) Settings(ctx context.Context) (domain.Settings, int64, error) {
	return Repo(s).Settings(ctx)
}
