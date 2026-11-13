package postgres

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/snapshot"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// Snapshots answers the current state behind villa.updated, unit_group.updated and unit.updated, as
// the events carry it, for a copy that started after the events went by (billing.cat_groups and
// the room type on billing.cat_units, reservation's unit capacity, channel's site profile).
func Snapshots(d *db.DB) snapshot.Sources {
	return snapshot.Sources{
		property.EventVillaUpdated: func(ctx context.Context) ([]snapshot.Record, error) {
			rows, err := d.Q(ctx).Query(ctx, `SELECT `+villaColumns+`, version FROM property.villas ORDER BY id`)
			if err != nil {
				return nil, err
			}
			return pgx.CollectRows(rows, func(r pgx.CollectableRow) (snapshot.Record, error) {
				var v domain.Villa
				if err := r.Scan(append(villaFields(&v), &v.Version)...); err != nil {
					return snapshot.Record{}, err
				}
				return snapshot.Of(v.ID, v.Version, property.VillaEvent{Villa: domain.VillaState(v)})
			})
		},
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
				SELECT `+qualified("u", unitColumns)+`, to_char(u.status_until, 'YYYY-MM-DD'), u.version, v.location_id
				FROM property.units u JOIN property.villas v ON v.id = u.villa_id ORDER BY u.id`)
			if err != nil {
				return nil, err
			}
			return pgx.CollectRows(rows, func(r pgx.CollectableRow) (snapshot.Record, error) {
				var u domain.Unit
				var location string
				if err := r.Scan(append(unitFields(&u), &u.Version, &location)...); err != nil {
					return snapshot.Record{}, err
				}
				return snapshot.Of(u.ID, u.Version, property.UnitEvent{Unit: domain.UnitState(u), LocationID: location})
			})
		},
	}
}

// qualified prefixes each column of a column list with the table alias.
func qualified(alias, columns string) string {
	parts := strings.Split(columns, ",")
	for i, p := range parts {
		parts[i] = alias + "." + strings.TrimSpace(p)
	}
	return strings.Join(parts, ", ")
}
