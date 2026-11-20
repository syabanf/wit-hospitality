package postgres

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// RoomCheck loads and locks a room check; false when there is none.
func (r Repo) RoomCheck(ctx context.Context, id string) (domain.RoomCheck, bool, error) {
	var version int64
	c, err := scanDoc[domain.RoomCheck](r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM housekeeping.room_checks WHERE id = $1 FOR UPDATE`, id), &version)
	if db.NoRows(err) {
		return c, false, nil
	}
	return c, err == nil, err
}

// SaveRoomCheck inserts or replaces a room check.
func (r Repo) SaveRoomCheck(ctx context.Context, c domain.RoomCheck) error {
	doc, err := json.Marshal(c)
	if err != nil {
		return err
	}
	_, err = r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.room_checks (id, unit_id, villa_id, date, doc) VALUES ($1, $2, $3, $4::date, $5)
		ON CONFLICT (id) DO UPDATE SET unit_id = EXCLUDED.unit_id, villa_id = EXCLUDED.villa_id, date = EXCLUDED.date, doc = EXCLUDED.doc,
			version = housekeeping.room_checks.version + 1`, c.ID, c.UnitID, c.VillaID, c.Date, doc)
	return err
}

// UnitStays lists the stays housekeeping holds on the unit, in booking order.
func (r Repo) UnitStays(ctx context.Context, unitID string) ([]domain.Stay, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, stayColumns+` WHERE unit_id = $1 ORDER BY seq`, unitID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Stay, error) { return scanStay(row) })
}

// OpenDiscrepancies counts the checks on or before date with a discrepancy nobody resolved.
func (r Repo) OpenDiscrepancies(ctx context.Context, date string) (int, error) {
	var n int
	err := r.DB.Q(ctx).QueryRow(ctx, `
		SELECT count(*) FROM housekeeping.room_checks
		WHERE date <= $1::date AND jsonb_typeof(doc->'discrepancy') = 'string' AND jsonb_typeof(doc->'resolution') IS DISTINCT FROM 'object'`, date).Scan(&n)
	return n, err
}

// RoomChecks lists the checks whose villa is in scope, newest day first, then by unit code.
func (s ReadStore) RoomChecks(ctx context.Context, sc rbac.Scope) ([]json.RawMessage, error) {
	vil, loc := scopeIDs(sc)
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT t.doc FROM housekeeping.room_checks t
		LEFT JOIN housekeeping.cat_villas v ON v.id = t.villa_id
		LEFT JOIN housekeeping.cat_units u ON u.id = t.unit_id
		WHERE (cardinality($1::text[]) > 0 AND t.villa_id = ANY($1))
		   OR (cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR v.location_id = ANY($2)))
		ORDER BY t.date DESC, u.code, t.unit_id`, vil, loc)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (json.RawMessage, error) {
		var raw []byte
		err := r.Scan(&raw)
		return raw, err
	})
}
