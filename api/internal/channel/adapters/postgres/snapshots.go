package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/snapshot"
)

// Snapshots answers the current state behind airbnb_account.updated, as the event carries it, for
// a copy that started after the events went by (billing.cat_accounts).
func Snapshots(d *db.DB) snapshot.Sources {
	return snapshot.Sources{channel.EventAccountUpdated: func(ctx context.Context) ([]snapshot.Record, error) {
		rows, err := d.Q(ctx).Query(ctx, `SELECT id, name, email, status, slot, version FROM channel.airbnb_accounts ORDER BY seq`)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, func(r pgx.CollectableRow) (snapshot.Record, error) {
			var e channel.AccountEvent
			var version int64
			a := &e.Account
			if err := r.Scan(&a.ID, &a.Name, &a.Email, &a.Status, &a.Slot, &version); err != nil {
				return snapshot.Record{}, err
			}
			return snapshot.Of(a.ID, version, e)
		})
	}}
}
