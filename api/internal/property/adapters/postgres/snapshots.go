package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/snapshot"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// Snapshots answers the current state behind unit_group.updated and unit.updated, as the events
// carry it, for a copy that started after the events went by (billing.cat_groups and the room type
// on billing.cat_units).
func Snapshots(d *db.DB) snapshot.Sources {
	return snapshot.Sources{
		property.EventGroupUpdated: func(ctx context.Context) ([]snapshot.Record, error) {
			rows, err := d.Q(ctx).Query(ctx, `
				SELECT g.id, g.villa_id, g.name, g.interchangeable, g.operator_assigns, g.version, v.location_id
				FROM property.unit_groups g JOIN property.villas v ON v.id = g.villa_id ORDER BY g.id`)
			if err != nil {
				return nil, err
			}
			return pgx.CollectRows(rows, func(r pgx.CollectableRow) (snapshot.Record, error) {
				var e property.GroupEvent
				var version int64
				if err := r.Scan(&e.Group.ID, &e.Group.VillaID, &e.Group.Name, &e.Group.Interchangeable, &e.Group.OperatorAssigns, &version, &e.LocationID); err != nil {
					return snapshot.Record{}, err
				}
				return snapshot.Of(e.Group.ID, version, e)
			})
		},
		property.EventUnitUpdated: func(ctx context.Context) ([]snapshot.Record, error) {
			rows, err := d.Q(ctx).Query(ctx, `
				SELECT u.id, u.villa_id, u.group_id, u.code, u.name, u.bedrooms, u.nightly_rate, u.status, u.amenities, u.version, v.location_id
				FROM property.units u JOIN property.villas v ON v.id = u.villa_id ORDER BY u.id`)
			if err != nil {
				return nil, err
			}
			return pgx.CollectRows(rows, func(r pgx.CollectableRow) (snapshot.Record, error) {
				var e property.UnitEvent
				var version int64
				u := &e.Unit
				if err := r.Scan(&u.ID, &u.VillaID, &u.GroupID, &u.Code, &u.Name, &u.Bedrooms, &u.NightlyRate, &u.Status, &u.Amenities, &version, &e.LocationID); err != nil {
					return snapshot.Record{}, err
				}
				return snapshot.Of(u.ID, version, e)
			})
		},
	}
}
