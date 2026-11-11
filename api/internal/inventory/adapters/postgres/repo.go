// Package postgres implements the inventory context's write repository, read store, projections,
// cash-out requests and seed loader on the inventory schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the inventory context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "inventory", FS: sub}
}

// Repo is the write repository.
type Repo struct{ DB *db.DB }

var _ command.Repository = Repo{}

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

// Lock takes the transaction's stock lock.
func (r Repo) Lock(ctx context.Context) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('inventory.stock'))`)
	return err
}

// Next returns the counter's next number and moves it on; a counter starts at 1.
func (r Repo) Next(ctx context.Context, counter string) (int, error) {
	var n int
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO inventory.counters (key, next) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET next = inventory.counters.next + 1
		RETURNING next - 1`, counter).Scan(&n)
	return n, err
}

// Villa reads a projected villa.
func (r Repo) Villa(ctx context.Context, id string) (command.Villa, error) {
	var v command.Villa
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, location_id, name FROM inventory.ref_villas WHERE id = $1`, id).Scan(&v.ID, &v.LocationID, &v.Name)
	return v, notFound(err, "villa", id)
}

// Unit reads a projected unit.
func (r Repo) Unit(ctx context.Context, id string) (command.Unit, error) {
	var u command.Unit
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, villa_id, group_id, code FROM inventory.ref_units WHERE id = $1`, id).Scan(&u.ID, &u.VillaID, &u.GroupID, &u.Code)
	return u, notFound(err, "unit", id)
}

// Group reads a projected room type.
func (r Repo) Group(ctx context.Context, id string) (command.Group, error) {
	var g command.Group
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, villa_id, name FROM inventory.ref_groups WHERE id = $1`, id).Scan(&g.ID, &g.VillaID, &g.Name)
	return g, notFound(err, "unit group", id)
}

// MenuItem reads a projected menu item.
func (r Repo) MenuItem(ctx context.Context, id string) (command.MenuItem, error) {
	var m command.MenuItem
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, villa_id, category, name, unit, price, active FROM inventory.ref_menu_items WHERE id = $1`, id).
		Scan(&m.ID, &m.VillaID, &m.Category, &m.Name, &m.Unit, &m.Price, &m.Active)
	return m, notFound(err, "menu item", id)
}

// Stays reads the bookings projected from reservation; it is the module's command.Stays.
type Stays struct{ DB *db.DB }

// Stay reads one projected booking.
func (s Stays) Stay(ctx context.Context, id string) (command.Stay, error) {
	st := command.Stay{ID: id}
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT code, status, unit_id FROM inventory.ref_stays WHERE id = $1`, id).Scan(&st.Code, &st.Status, &st.UnitID)
	return st, notFound(err, "booking", id)
}

const itemColumns = `id, code, name, kind, unit, reorder_level, par, average_cost, active, version`

func scanItem(row pgx.Row) (domain.Item, error) {
	var i domain.Item
	err := row.Scan(&i.ID, &i.Code, &i.Name, &i.Kind, &i.Unit, &i.ReorderLevel, &i.Par, &i.AverageCost, &i.Active, &i.Version)
	return i, err
}

// Items lists every item in creation order.
func (r Repo) Items(ctx context.Context) ([]domain.Item, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT `+itemColumns+` FROM inventory.items ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Item, error) { return scanItem(row) })
}

// Item loads and locks an item.
func (r Repo) Item(ctx context.Context, id string) (domain.Item, error) {
	i, err := scanItem(r.DB.Q(ctx).QueryRow(ctx, `SELECT `+itemColumns+` FROM inventory.items WHERE id = $1 FOR UPDATE`, id))
	return i, notFound(err, "stock item", id)
}

// ItemCodeTaken reports whether another item uses code.
func (r Repo) ItemCodeTaken(ctx context.Context, code, excludeID string) (bool, error) {
	var taken bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM inventory.items WHERE code = $1 AND id <> $2)`, code, excludeID).Scan(&taken)
	return taken, err
}

func duplicateCode(err error, code string) error {
	if _, dup := db.UniqueViolation(err); dup {
		return errs.Invalid("code", code+" is already used.")
	}
	return err
}

// InsertItem adds an item at version 1.
func (r Repo) InsertItem(ctx context.Context, i *domain.Item) error {
	i.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO inventory.items (id, code, name, kind, unit, reorder_level, par, average_cost, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		i.ID, i.Code, i.Name, i.Kind, i.Unit, i.ReorderLevel, i.Par, i.AverageCost, i.Active)
	return duplicateCode(err, i.Code)
}

// UpdateItem saves the form fields when the version matches; the average cost is left alone.
func (r Repo) UpdateItem(ctx context.Context, i *domain.Item) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `
		UPDATE inventory.items SET code = $2, name = $3, kind = $4, unit = $5, reorder_level = $6, par = $7, active = $8, version = version + 1
		WHERE id = $1 AND version = $9`, i.ID, i.Code, i.Name, i.Kind, i.Unit, i.ReorderLevel, i.Par, i.Active, i.Version)
	if err := stale(tag, duplicateCode(err, i.Code), "stock item"); err != nil {
		return err
	}
	i.Version++
	return nil
}

// SetAverages stores the replay's averages.
func (r Repo) SetAverages(ctx context.Context, averages map[string]int64) error {
	for id, avg := range averages {
		if _, err := r.DB.Q(ctx).Exec(ctx, `UPDATE inventory.items SET average_cost = $2 WHERE id = $1`, id, avg); err != nil {
			return err
		}
	}
	return nil
}

const movementColumns = `id, number, villa_id, item_id, kind, quantity, unit_cost, on_date, by_name, unit_id, booking_id, order_id, receipt_id, count_id, transfer_id, other_villa_id, reason`

func scanMovement(row pgx.CollectableRow) (domain.Movement, error) {
	var m domain.Movement
	err := row.Scan(&m.ID, &m.Number, &m.VillaID, &m.ItemID, &m.Kind, &m.Quantity, &m.UnitCost, &m.On, &m.By,
		&m.UnitID, &m.BookingID, &m.OrderID, &m.ReceiptID, &m.CountID, &m.TransferID, &m.OtherVillaID, &m.Reason)
	return m, err
}

// Movements lists every movement in booking order.
func (r Repo) Movements(ctx context.Context) ([]domain.Movement, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT `+movementColumns+` FROM inventory.movements ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanMovement)
}

// InsertMovement books a movement.
func (r Repo) InsertMovement(ctx context.Context, m domain.Movement) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO inventory.movements (`+movementColumns+`) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
		m.ID, m.Number, m.VillaID, m.ItemID, m.Kind, m.Quantity, m.UnitCost, m.On, m.By, m.UnitID, m.BookingID, m.OrderID, m.ReceiptID, m.CountID, m.TransferID, m.OtherVillaID, m.Reason)
	return err
}

// UpdateMovement rewrites a corrected receipt movement.
func (r Repo) UpdateMovement(ctx context.Context, m domain.Movement) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `UPDATE inventory.movements SET quantity = $2, unit_cost = $3, on_date = $4, reason = $5 WHERE id = $1`, m.ID, m.Quantity, m.UnitCost, m.On, m.Reason)
	return err
}

// DeleteMovement drops a corrected receipt's line that is no longer on it.
func (r Repo) DeleteMovement(ctx context.Context, id string) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `DELETE FROM inventory.movements WHERE id = $1`, id)
	return err
}

// Receipt loads and locks a receipt.
func (r Repo) Receipt(ctx context.Context, id string) (domain.StockReceipt, error) {
	var rec domain.StockReceipt
	var raw []byte
	var version int64
	if err := r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM inventory.receipts WHERE id = $1 FOR UPDATE`, id).Scan(&raw, &version); err != nil {
		return rec, notFound(err, "stock receipt", id)
	}
	err := json.Unmarshal(raw, &rec)
	rec.Version = version
	return rec, err
}

// InsertReceipt adds a receipt at version 1.
func (r Repo) InsertReceipt(ctx context.Context, rec *domain.StockReceipt) error {
	rec.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO inventory.receipts (id, number, villa_id, doc) VALUES ($1, $2, $3, $4)`, rec.ID, rec.Number, rec.VillaID, rec)
	return err
}

// UpdateReceipt saves when the version matches.
func (r Repo) UpdateReceipt(ctx context.Context, rec *domain.StockReceipt) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE inventory.receipts SET doc = $2, version = version + 1 WHERE id = $1 AND version = $3`, rec.ID, rec, rec.Version)
	if err := stale(tag, err, "stock receipt"); err != nil {
		return err
	}
	rec.Version++
	return nil
}

// InsertCount adds a count.
func (r Repo) InsertCount(ctx context.Context, c domain.Count) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO inventory.counts (id, villa_id, doc) VALUES ($1, $2, $3)`, c.ID, c.VillaID, c)
	return err
}

// SaveKit replaces a room type's kit; it moves to the end of the list, as in the mock.
func (r Repo) SaveKit(ctx context.Context, k domain.Kit) error {
	if err := r.DeleteKit(ctx, k.GroupID); err != nil {
		return err
	}
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO inventory.kits (group_id, lines) VALUES ($1, $2)`, k.GroupID, k.Lines)
	return err
}

// DeleteKit removes a room type's kit.
func (r Repo) DeleteKit(ctx context.Context, groupID string) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `DELETE FROM inventory.kits WHERE group_id = $1`, groupID)
	return err
}

// Links lists every minibar link.
func (r Repo) Links(ctx context.Context) ([]domain.MinibarLink, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT menu_item_id, stock_item_id FROM inventory.minibar_links ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[domain.MinibarLink])
}

// SaveLink replaces a menu item's link; it moves to the end of the list, as in the mock.
func (r Repo) SaveLink(ctx context.Context, l domain.MinibarLink) error {
	if err := r.DeleteLink(ctx, l.MenuItemID); err != nil {
		return err
	}
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO inventory.minibar_links (menu_item_id, stock_item_id) VALUES ($1, $2)`, l.MenuItemID, l.StockItemID)
	return err
}

// DeleteLink removes a menu item's link.
func (r Repo) DeleteLink(ctx context.Context, menuItemID string) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `DELETE FROM inventory.minibar_links WHERE menu_item_id = $1`, menuItemID)
	return err
}

// InsertMinibarCheck keeps a minibar check for services to adopt.
func (r Repo) InsertMinibarCheck(ctx context.Context, e inventory.MinibarChecked) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO inventory.minibar_checks (id, doc) VALUES ($1, $2)`, e.Order.ID, e)
	return err
}
