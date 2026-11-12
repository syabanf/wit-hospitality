package postgres

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/snapshot"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

// Snapshots answers the current state behind booking_group.saved, as the event carries it, for a
// copy that started after the events went by (owners.rm_groups).
func Snapshots(d *db.DB) snapshot.Sources {
	return snapshot.Sources{reservation.EventGroupSaved: func(ctx context.Context) ([]snapshot.Record, error) {
		locations := map[string]string{}
		rows, err := d.Q(ctx).Query(ctx, `SELECT id, location_id FROM reservation.cat_villas`)
		if err != nil {
			return nil, err
		}
		if _, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (struct{}, error) {
			var id, loc string
			err := r.Scan(&id, &loc)
			locations[id] = loc
			return struct{}{}, err
		}); err != nil {
			return nil, err
		}
		rows, err = d.Q(ctx).Query(ctx, `SELECT id, version, doc FROM reservation.booking_groups ORDER BY seq`)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, func(r pgx.CollectableRow) (snapshot.Record, error) {
			var id string
			var version int64
			var doc []byte
			if err := r.Scan(&id, &version, &doc); err != nil {
				return snapshot.Record{}, err
			}
			var g struct {
				VillaIDs []string `json:"villaIds"`
			}
			if err := json.Unmarshal(doc, &g); err != nil {
				return snapshot.Record{}, err
			}
			rec := reservation.Record{ID: id, VillaIDs: []string{}, LocationIDs: []string{}, Data: doc}
			for _, v := range g.VillaIDs {
				if !slices.Contains(rec.VillaIDs, v) {
					rec.VillaIDs = append(rec.VillaIDs, v)
				}
				if loc := locations[v]; loc != "" && !slices.Contains(rec.LocationIDs, loc) {
					rec.LocationIDs = append(rec.LocationIDs, loc)
				}
			}
			return snapshot.Of(id, version, rec)
		})
	}}
}
