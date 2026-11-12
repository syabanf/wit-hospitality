package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/snapshot"
	"github.com/syabanf/wit-hospitality/api/internal/services"
)

// Snapshots answers the current state behind request.saved, as the event carries it, for a copy
// that started after the events went by (billing.rm_requests).
func Snapshots(d *db.DB) snapshot.Sources {
	return snapshot.Sources{services.EventRequestSaved: func(ctx context.Context) ([]snapshot.Record, error) {
		rows, err := d.Q(ctx).Query(ctx, `
			SELECT r.id, r.version, r.doc, r.villa_id, COALESCE(v.location_id, '')
			FROM services.requests r LEFT JOIN services.cat_villas v ON v.id = r.villa_id ORDER BY r.seq`)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, func(r pgx.CollectableRow) (snapshot.Record, error) {
			var id string
			var version int64
			var e services.RequestSaved
			var doc []byte
			if err := r.Scan(&id, &version, &doc, &e.VillaID, &e.LocationID); err != nil {
				return snapshot.Record{}, err
			}
			e.Request = doc
			return snapshot.Of(id, version, e)
		})
	}}
}
