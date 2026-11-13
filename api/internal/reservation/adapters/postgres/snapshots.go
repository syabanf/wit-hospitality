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

// bookingSnapshots answers every booking as booking.saved carries it, in its unit's villa.
func bookingSnapshots(d *db.DB) func(ctx context.Context) ([]snapshot.Record, error) {
	return func(ctx context.Context) ([]snapshot.Record, error) {
		rows, err := d.Q(ctx).Query(ctx, `
			SELECT b.id, b.version, b.doc, COALESCE(v.id, ''), COALESCE(v.location_id, '')
			FROM reservation.bookings b LEFT JOIN reservation.cat_units u ON u.id = b.unit_id LEFT JOIN reservation.cat_villas v ON v.id = u.villa_id
			ORDER BY b.seq`)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, func(r pgx.CollectableRow) (snapshot.Record, error) {
			var id, villa, location string
			var version int64
			var doc []byte
			if err := r.Scan(&id, &version, &doc, &villa, &location); err != nil {
				return snapshot.Record{}, err
			}
			rec := reservation.Record{ID: id, VillaIDs: []string{}, LocationIDs: []string{}, Data: doc}
			if villa != "" {
				rec.VillaIDs, rec.LocationIDs = []string{villa}, []string{location}
			}
			return snapshot.Of(id, version, rec)
		})
	}
}

// Snapshots answers the current state behind booking.saved and booking_group.saved, as the events
// carry them, for a copy that started after the events went by (housekeeping's service window on
// housekeeping.stays, owners.rm_groups).
func Snapshots(d *db.DB) snapshot.Sources {
	return snapshot.Sources{reservation.EventBookingSaved: bookingSnapshots(d), reservation.EventGroupSaved: func(ctx context.Context) ([]snapshot.Record, error) {
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
