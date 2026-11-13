// Package postgres implements the services context's write repository, catalog copy, read store,
// projections and seed loader on the services schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the services context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "services", FS: sub}
}

// Repo is the write repository.
type Repo struct{ DB *db.DB }

func notFound(err error, what, id string) error {
	if db.NoRows(err) {
		return errs.NotFound(what, id)
	}
	return err
}

func stale(tag pgconn.CommandTag, err error, what string) error {
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errs.Newf(errs.CodeConflict, "Someone else changed this %s. Reload and try again.", what)
	}
	return nil
}

// Next returns the next number of a sequence: order, request.
func (r Repo) Next(ctx context.Context, key string) (int64, error) {
	var n int64
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO services.counters (key, n) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET n = services.counters.n + 1
		RETURNING n - 1`, key).Scan(&n)
	return n, err
}

// load reads and locks one row's doc and version.
func load[T any](ctx context.Context, q db.Querier, sql, what, id string) (T, int64, error) {
	var v T
	var raw []byte
	var version int64
	if err := q.QueryRow(ctx, sql, id).Scan(&raw, &version); err != nil {
		return v, 0, notFound(err, what, id)
	}
	err := json.Unmarshal(raw, &v)
	return v, version, err
}

func docs[T any](rows pgx.Rows, err error) ([]T, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (T, error) {
		var v T
		var raw []byte
		if err := r.Scan(&raw); err != nil {
			return v, err
		}
		return v, json.Unmarshal(raw, &v)
	})
}

// Partner loads and locks a partner.
func (r Repo) Partner(ctx context.Context, id string) (domain.ServicePartner, error) {
	p, v, err := load[domain.ServicePartner](ctx, r.DB.Q(ctx), `SELECT doc, version FROM services.partners WHERE id = $1 FOR UPDATE`, "partner", id)
	p.Version = v
	return p, err
}

// InsertPartner adds a partner at version 1.
func (r Repo) InsertPartner(ctx context.Context, p *domain.ServicePartner) error {
	p.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO services.partners (id, doc, version) VALUES ($1, $2, 1)`, p.ID, mustJSON(p))
	return err
}

// UpdatePartner saves when the version matches.
func (r Repo) UpdatePartner(ctx context.Context, p *domain.ServicePartner) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE services.partners SET doc = $2, version = version + 1 WHERE id = $1 AND version = $3`, p.ID, mustJSON(p), p.Version)
	if err = stale(tag, err, "partner"); err == nil {
		p.Version++
	}
	return err
}

// MenuItem loads and locks a menu item.
func (r Repo) MenuItem(ctx context.Context, id string) (domain.MenuItem, error) {
	m, v, err := load[domain.MenuItem](ctx, r.DB.Q(ctx), `SELECT doc, version FROM services.menu_items WHERE id = $1 FOR UPDATE`, "menu item", id)
	m.Version = v
	return m, err
}

// ActiveMenu lists a villa's items on sale, oldest first.
func (r Repo) ActiveMenu(ctx context.Context, villaID string) ([]domain.MenuItem, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM services.menu_items WHERE villa_id = $1 AND (doc->>'active')::boolean ORDER BY seq`, villaID)
	return docs[domain.MenuItem](rows, err)
}

// InsertMenuItem adds an item at version 1.
func (r Repo) InsertMenuItem(ctx context.Context, m *domain.MenuItem) error {
	m.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO services.menu_items (id, villa_id, doc, version) VALUES ($1, $2, $3, 1)`, m.ID, m.VillaID, mustJSON(m))
	return err
}

// UpdateMenuItem saves when the version matches.
func (r Repo) UpdateMenuItem(ctx context.Context, m *domain.MenuItem) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE services.menu_items SET villa_id = $2, doc = $3, version = version + 1 WHERE id = $1 AND version = $4`,
		m.ID, m.VillaID, mustJSON(m), m.Version)
	if err = stale(tag, err, "menu item"); err == nil {
		m.Version++
	}
	return err
}

// Order loads and locks an order.
func (r Repo) Order(ctx context.Context, id string) (domain.ServiceOrder, error) {
	o, v, err := load[domain.ServiceOrder](ctx, r.DB.Q(ctx), `SELECT doc, version FROM services.orders WHERE id = $1 FOR UPDATE`, "order", id)
	o.Version = v
	return o, err
}

// InsertOrder adds an order at version 1.
func (r Repo) InsertOrder(ctx context.Context, o *domain.ServiceOrder) error {
	o.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO services.orders (id, booking_id, villa_id, doc, version) VALUES ($1, $2, $3, $4, 1)`,
		o.ID, o.BookingID, o.VillaID, mustJSON(o))
	return err
}

// UpdateOrder saves when the version matches.
func (r Repo) UpdateOrder(ctx context.Context, o *domain.ServiceOrder) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE services.orders SET doc = $2, version = version + 1 WHERE id = $1 AND version = $3`, o.ID, mustJSON(o), o.Version)
	if err = stale(tag, err, "order"); err == nil {
		o.Version++
	}
	return err
}

// SaveBill keeps finance's answer on a partner bill unless a newer one is stored.
func (r Repo) SaveBill(ctx context.Context, orderID string, b domain.CostBill) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO services.partner_bills (transaction_id, order_id, partner_id, status, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (transaction_id) DO UPDATE SET status = EXCLUDED.status, version = EXCLUDED.version
		WHERE services.partner_bills.version < EXCLUDED.version`, b.TransactionID, orderID, b.PartnerID, b.Status, b.Version)
	return err
}

// Bills lists the partner bills finance wrote for an order.
func (r Repo) Bills(ctx context.Context, orderID string) ([]domain.CostBill, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT transaction_id, partner_id, status FROM services.partner_bills WHERE order_id = $1 ORDER BY transaction_id`, orderID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.CostBill, error) {
		var b domain.CostBill
		err := row.Scan(&b.TransactionID, &b.PartnerID, &b.Status)
		return b, err
	})
}

// StayOrders lists a stay's orders, oldest first.
func (r Repo) StayOrders(ctx context.Context, bookingID string) ([]domain.ServiceOrder, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM services.orders WHERE booking_id = $1 ORDER BY seq`, bookingID)
	return docs[domain.ServiceOrder](rows, err)
}

// Request loads and locks a service request.
func (r Repo) Request(ctx context.Context, id string) (domain.ServiceRequest, error) {
	x, v, err := load[domain.ServiceRequest](ctx, r.DB.Q(ctx), `SELECT doc, version FROM services.requests WHERE id = $1 FOR UPDATE`, "request", id)
	x.Version = v
	return x, err
}

// InsertRequest adds a request at version 1.
func (r Repo) InsertRequest(ctx context.Context, x *domain.ServiceRequest, villaID string) error {
	x.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO services.requests (id, unit_id, villa_id, doc, version) VALUES ($1, $2, $3, $4, 1)`,
		x.ID, x.UnitID, villaID, mustJSON(x))
	return err
}

// UpdateRequest saves when the version matches.
func (r Repo) UpdateRequest(ctx context.Context, x *domain.ServiceRequest, villaID string) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE services.requests SET unit_id = $2, villa_id = $3, doc = $4, version = version + 1 WHERE id = $1 AND version = $5`,
		x.ID, x.UnitID, villaID, mustJSON(x), x.Version)
	if err = stale(tag, err, "request"); err == nil {
		x.Version++
	}
	return err
}

// ClaimSetup records that the stay's setup became a request; false when it already did.
func (r Repo) ClaimSetup(ctx context.Context, bookingID, setup string) (bool, error) {
	tag, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO services.setup_requests (booking_id, setup) VALUES ($1, $2) ON CONFLICT DO NOTHING`, bookingID, setup)
	return tag.RowsAffected() == 1, err
}

func mustJSON(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return raw
}
