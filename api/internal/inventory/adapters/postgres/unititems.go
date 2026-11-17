package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// UnitInventory keeps the unit inventory lists and checks.
type UnitInventory struct{ DB *db.DB }

var _ command.UnitInventory = UnitInventory{}

// LockUnit serialises writes to one unit's list.
func (u UnitInventory) LockUnit(ctx context.Context, unitID string) error {
	_, err := u.DB.Q(ctx).Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('inventory.unit:' || $1))`, unitID)
	return err
}

// Items lists a unit's items in the order they were added.
func (u UnitInventory) Items(ctx context.Context, unitID string) ([]domain.UnitItem, error) {
	return docs[domain.UnitItem](u.DB.Q(ctx).Query(ctx, `SELECT doc FROM inventory.unit_items WHERE unit_id = $1 ORDER BY seq`, unitID))
}

// Item reads one item.
func (u UnitInventory) Item(ctx context.Context, id string) (domain.UnitItem, error) {
	var raw []byte
	var it domain.UnitItem
	if err := u.DB.Q(ctx).QueryRow(ctx, `SELECT doc FROM inventory.unit_items WHERE id = $1`, id).Scan(&raw); err != nil {
		return it, notFound(err, "inventory item", id)
	}
	return it, json.Unmarshal(raw, &it)
}

// SaveItem inserts or replaces an item.
func (u UnitInventory) SaveItem(ctx context.Context, it domain.UnitItem) error {
	doc, err := json.Marshal(it)
	if err != nil {
		return err
	}
	_, err = u.DB.Q(ctx).Exec(ctx, `
		INSERT INTO inventory.unit_items (id, unit_id, villa_id, doc) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = inventory.unit_items.version + 1`, it.ID, it.UnitID, it.VillaID, doc)
	return err
}

// DeleteItem removes an item.
func (u UnitInventory) DeleteItem(ctx context.Context, id string) error {
	_, err := u.DB.Q(ctx).Exec(ctx, `DELETE FROM inventory.unit_items WHERE id = $1`, id)
	return err
}

// Check reads one check, locked for the transaction.
func (u UnitInventory) Check(ctx context.Context, id string) (domain.InventoryCheck, error) {
	var raw []byte
	var c domain.InventoryCheck
	if err := u.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM inventory.unit_checks WHERE id = $1 FOR UPDATE`, id).Scan(&raw, &c.Version); err != nil {
		return c, notFound(err, "inventory check", id)
	}
	return c, json.Unmarshal(raw, &c)
}

// HasCheck reports whether the stay already has a check of the kind.
func (u UnitInventory) HasCheck(ctx context.Context, bookingID, kind string) (bool, error) {
	var taken bool
	err := u.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM inventory.unit_checks WHERE booking_id = $1 AND kind = $2)`, bookingID, kind).Scan(&taken)
	return taken, err
}

// InsertCheck stores a new check.
func (u UnitInventory) InsertCheck(ctx context.Context, c *domain.InventoryCheck) error {
	doc, err := json.Marshal(c)
	if err != nil {
		return err
	}
	c.Version = 1
	_, err = u.DB.Q(ctx).Exec(ctx, `
		INSERT INTO inventory.unit_checks (id, number, unit_id, villa_id, booking_id, kind, doc) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		c.ID, c.Number, c.UnitID, c.VillaID, c.BookingID, c.Kind, doc)
	return err
}

// UpdateCheck saves a check at the version it was read.
func (u UnitInventory) UpdateCheck(ctx context.Context, c *domain.InventoryCheck) error {
	doc, err := json.Marshal(c)
	if err != nil {
		return err
	}
	tag, err := u.DB.Q(ctx).Exec(ctx, `UPDATE inventory.unit_checks SET doc = $2, version = version + 1 WHERE id = $1 AND version = $3`, c.ID, doc, c.Version)
	if err := stale(tag, err, "check"); err != nil {
		return err
	}
	c.Version++
	return nil
}

// UnitItems lists the items of units in scope.
func (s ReadStore) UnitItems(ctx context.Context, sc rbac.Scope) ([]domain.UnitItem, error) {
	return docs[domain.UnitItem](s.DB.Q(ctx).Query(ctx, `SELECT doc FROM inventory.v_unit_items WHERE `+inScope+` ORDER BY seq`, args(sc)...))
}

// UnitChecks lists the checks of units in scope.
func (s ReadStore) UnitChecks(ctx context.Context, sc rbac.Scope) ([]domain.InventoryCheck, error) {
	return docs[domain.InventoryCheck](s.DB.Q(ctx).Query(ctx, `SELECT doc FROM inventory.v_unit_checks WHERE `+inScope+` ORDER BY seq`, args(sc)...))
}
