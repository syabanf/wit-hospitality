package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Unit inventory lists and checks (villa-operations-contract.md sections 1 and 2).

// UnitInventory is the write model of the lists and checks.
type UnitInventory interface {
	LockUnit(ctx context.Context, unitID string) error
	Items(ctx context.Context, unitID string) ([]domain.UnitItem, error)
	Item(ctx context.Context, id string) (domain.UnitItem, error)
	SaveItem(ctx context.Context, it domain.UnitItem) error
	DeleteItem(ctx context.Context, id string) error
	Check(ctx context.Context, id string) (domain.InventoryCheck, error)
	HasCheck(ctx context.Context, bookingID, kind string) (bool, error)
	InsertCheck(ctx context.Context, c *domain.InventoryCheck) error
	UpdateCheck(ctx context.Context, c *domain.InventoryCheck) error
}

var needBookingEdit = rbac.Need{Module: "booking", Action: "edit"}

// unitInScope loads the unit and refuses one outside the caller's scope.
func (d Deps) unitInScope(ctx context.Context, p auth.Principal, id string) (Unit, Villa, error) {
	u, err := d.Repo.Unit(ctx, id)
	if err != nil {
		return u, Villa{}, err
	}
	v, err := d.villaInScope(ctx, p, u.VillaID)
	return u, v, err
}

// SaveUnitItem adds an item to a unit's list, or changes one; it needs maintenance/edit.
type SaveUnitItem struct{ Deps }

// Handle saves the item; id is empty for a new one.
func (h SaveUnitItem) Handle(ctx context.Context, p auth.Principal, id string, in domain.UnitItemInput) (domain.UnitItem, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.UnitItem{}, err
	}
	var out domain.UnitItem
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var current *domain.UnitItem
		unitID := in.UnitID
		if id != "" {
			it, err := h.Units.Item(ctx, id)
			if err != nil {
				return err
			}
			current, unitID = &it, it.UnitID
		}
		unit, _, err := h.unitInScope(ctx, p, unitID)
		if err != nil {
			return err
		}
		if err := h.Units.LockUnit(ctx, unit.ID); err != nil {
			return err
		}
		list, err := h.Units.Items(ctx, unit.ID)
		if err != nil {
			return err
		}
		if err := domain.ValidateUnitItem(in, list, current); err != nil {
			return err
		}
		out = domain.UnitItem{UnitID: unit.ID, VillaID: unit.VillaID, Name: strings.TrimSpace(in.Name), Category: in.Category, Expected: int64(in.Expected),
			Condition: strings.TrimSpace(in.Condition), Photo: in.Photo, ReplacementCost: int64(in.ReplacementCost)}
		summary := fmt.Sprintf("Changed %s on the inventory of %s", out.Name, unit.Code)
		action := audit.Update
		if current != nil {
			out.ID = current.ID
		} else {
			n, err := h.Repo.Next(ctx, "unitItem")
			if err != nil {
				return err
			}
			out.ID, action, summary = fmt.Sprintf("uit-%d", n), audit.Create, fmt.Sprintf("Added %s to the inventory of %s", out.Name, unit.Code)
		}
		if err := h.Units.SaveItem(ctx, out); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: action, Entity: "unit-item", EntityID: out.ID, Summary: summary})
	})
	return out, err
}

// RemoveUnitItem takes an item off a unit's list; it needs maintenance/edit.
type RemoveUnitItem struct{ Deps }

// Handle removes the item.
func (h RemoveUnitItem) Handle(ctx context.Context, p auth.Principal, id string) error {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return err
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		it, err := h.Units.Item(ctx, id)
		if err != nil {
			return err
		}
		unit, _, err := h.unitInScope(ctx, p, it.UnitID)
		if err != nil {
			return err
		}
		if err := h.Units.DeleteItem(ctx, id); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Delete, Entity: "unit-item", EntityID: id, Summary: fmt.Sprintf("Removed %s from the inventory of %s", it.Name, unit.Code)})
	})
}

// CopyInput is the body of POST /unit-items/copy.
type CopyInput struct {
	FromUnitID string `json:"fromUnitId"`
	ToUnitID   string `json:"toUnitId"`
}

// CopyUnitItems copies the source's items the target lacks; it needs maintenance/edit and answers
// the target's list.
type CopyUnitItems struct{ Deps }

// Handle copies the list.
func (h CopyUnitItems) Handle(ctx context.Context, p auth.Principal, in CopyInput) ([]domain.UnitItem, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return nil, err
	}
	var out []domain.UnitItem
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		from, _, err := h.unitInScope(ctx, p, in.FromUnitID)
		if err != nil {
			return err
		}
		to, _, err := h.unitInScope(ctx, p, in.ToUnitID)
		if err != nil {
			return err
		}
		if err := h.Units.LockUnit(ctx, to.ID); err != nil {
			return err
		}
		source, err := h.Units.Items(ctx, from.ID)
		if err != nil {
			return err
		}
		target, err := h.Units.Items(ctx, to.ID)
		if err != nil {
			return err
		}
		fresh, err := domain.ItemsToCopy(source, target, from.Code, to.Code, from.ID == to.ID)
		if err != nil {
			return err
		}
		for _, it := range fresh {
			n, err := h.Repo.Next(ctx, "unitItem")
			if err != nil {
				return err
			}
			copied := domain.UnitItem{ID: fmt.Sprintf("uit-%d", n), UnitID: to.ID, VillaID: to.VillaID, Name: it.Name, Category: it.Category, Expected: it.Expected, ReplacementCost: it.ReplacementCost}
			if err := h.Units.SaveItem(ctx, copied); err != nil {
				return err
			}
		}
		if out, err = h.Units.Items(ctx, to.ID); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "unit-item", EntityID: to.ID, Summary: fmt.Sprintf("Copied %d items from %s to %s", len(fresh), from.Code, to.Code)})
	})
	return out, err
}

// RecordCheck counts a unit's list before an arrival or after a departure; it needs maintenance/edit.
type RecordCheck struct{ Deps }

// Handle records the check.
func (h RecordCheck) Handle(ctx context.Context, p auth.Principal, in domain.CheckInput) (domain.InventoryCheck, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.InventoryCheck{}, err
	}
	var out domain.InventoryCheck
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		unit, _, err := h.unitInScope(ctx, p, in.UnitID)
		if err != nil {
			return err
		}
		if err := h.Units.LockUnit(ctx, unit.ID); err != nil {
			return err
		}
		list, err := h.Units.Items(ctx, unit.ID)
		if err != nil {
			return err
		}
		stay, err := h.Stays.Stay(ctx, in.BookingID)
		if err != nil {
			return err
		}
		taken, err := h.Units.HasCheck(ctx, stay.ID, in.Kind)
		if err != nil {
			return err
		}
		if err := domain.ValidateCheck(in, list, unit.Code, domain.CheckStay{ID: stay.ID, Code: stay.Code, Status: stay.Status, UnitID: stay.UnitID}, taken); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "inventoryCheck")
		if err != nil {
			return err
		}
		out = domain.InventoryCheck{ID: fmt.Sprintf("ick-%d", n), Number: domain.CheckNumber(n), UnitID: unit.ID, VillaID: unit.VillaID, BookingID: stay.ID,
			BookingCode: stay.Code, Kind: in.Kind, On: h.today(), By: p.Name, ByID: p.UserID, Lines: domain.CheckLines(in, list)}
		if err := h.Units.InsertCheck(ctx, &out); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "inventory-check", EntityID: out.Number,
			Summary: fmt.Sprintf("Recorded %s %s on %s for %s: %d items off", strings.ToLower(domain.CheckKindLabel[out.Kind]), out.Number, unit.Code, stay.Code, domain.LinesOff(out))})
	})
	return out, err
}

// checkInScope loads a check locked and refuses one outside the caller's scope.
func (d Deps) checkInScope(ctx context.Context, p auth.Principal, id string) (domain.InventoryCheck, Villa, error) {
	c, err := d.Units.Check(ctx, id)
	if err != nil {
		return c, Villa{}, err
	}
	v, err := d.villaInScope(ctx, p, c.VillaID)
	return c, v, err
}

// ChargeLine charges a damaged or missing item of a post-departure check to the stay's folio,
// once: inventory.damage.charged.v1 goes to billing. It needs booking/edit.
type ChargeLine struct{ Deps }

// Handle charges the line.
func (h ChargeLine) Handle(ctx context.Context, p auth.Principal, checkID, itemID string, in domain.ChargeInput) (domain.InventoryCheck, error) {
	if err := h.Authz.Require(ctx, p.Role, needBookingEdit); err != nil {
		return domain.InventoryCheck{}, err
	}
	var out domain.InventoryCheck
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		c, villa, err := h.checkInScope(ctx, p, checkID)
		if err != nil {
			return err
		}
		l, err := c.Line(itemID)
		if err != nil {
			return err
		}
		stay, err := h.Stays.Stay(ctx, c.BookingID)
		if err != nil {
			return err
		}
		if err := domain.ValidateCharge(c, *l, in, stay.Status == "checked_in"); err != nil {
			return err
		}
		quantity := int64(in.Quantity)
		amount := l.ReplacementCost * quantity
		ref := c.ID + ":" + itemID
		l.Charge = &domain.LineCharge{SourceRef: ref, Quantity: quantity, Amount: amount, Reason: strings.TrimSpace(in.Reason), By: p.Name, On: h.today()}
		if err := h.Units.UpdateCheck(ctx, &c); err != nil {
			return err
		}
		e := inventory.DamageCharged{SourceRef: ref, BookingID: c.BookingID, BookingCode: c.BookingCode, UnitID: c.UnitID, VillaID: c.VillaID, LocationID: villa.LocationID,
			Code: "DMG", Description: domain.ChargeDescription(*l, quantity, in.Reason), Amount: amount, By: p.Name, ByID: p.UserID, At: clock.Stamp(h.Clock)}
		if err := h.emit(ctx, inventory.EventDamageCharged, "inventory_check", c.ID, c.Version, e); err != nil {
			return err
		}
		out = c
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "inventory-check", EntityID: c.Number, Summary: fmt.Sprintf("Charged %s on %s: %d", l.Name, c.BookingCode, amount)})
	})
	return out, err
}

// RaiseWorkOrder opens a maintenance work order for a damaged or missing item; it needs
// maintenance/create.
type RaiseWorkOrder struct{ Deps }

// Handle opens the job through maintenance.WorkOrders.
func (h RaiseWorkOrder) Handle(ctx context.Context, p auth.Principal, checkID, itemID string) (domain.InventoryCheck, error) {
	if err := h.Authz.Require(ctx, p.Role, needCreate); err != nil {
		return domain.InventoryCheck{}, err
	}
	var out domain.InventoryCheck
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		c, _, err := h.checkInScope(ctx, p, checkID)
		if err != nil {
			return err
		}
		l, err := c.Line(itemID)
		if err != nil {
			return err
		}
		if err := domain.AssertWorkOrderable(*l); err != nil {
			return err
		}
		if h.WorkOrders == nil {
			return errs.New("NOT_AVAILABLE", "Opening a work order is not available in this API yet.")
		}
		unit, err := h.Repo.Unit(ctx, c.UnitID)
		if err != nil {
			return err
		}
		category, title, description := domain.LineJob(c, *l, unit.Code)
		ref, err := h.WorkOrders.Open(ctx, maintenance.Reporter{UserID: p.UserID, Name: p.Name, Role: string(p.Role), VillaIDs: p.VillaIDs, LocationIDs: p.LocationIDs},
			maintenance.Report{VillaID: c.VillaID, UnitID: c.UnitID, Source: "inspection", Category: category, Priority: "normal", Title: title, Description: description})
		if err != nil {
			return err
		}
		l.WorkOrder = &domain.LineWorkOrder{ID: ref.ID, Number: ref.Number}
		if err := h.Units.UpdateCheck(ctx, &c); err != nil {
			return err
		}
		out = c
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "inventory-check", EntityID: c.Number, Summary: fmt.Sprintf("Raised %s for %s from %s", ref.Number, l.Name, c.Number)})
	})
	return out, err
}

// AdjustLine sets the list's expected count of an item to what the check found; a count of 0
// takes the item off. It needs maintenance/edit.
type AdjustLine struct{ Deps }

// Handle adjusts the list.
func (h AdjustLine) Handle(ctx context.Context, p auth.Principal, checkID, itemID string) (domain.InventoryCheck, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.InventoryCheck{}, err
	}
	var out domain.InventoryCheck
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		c, _, err := h.checkInScope(ctx, p, checkID)
		if err != nil {
			return err
		}
		l, err := c.Line(itemID)
		if err != nil {
			return err
		}
		if err := domain.AssertAdjustable(*l); err != nil {
			return err
		}
		unit, err := h.Repo.Unit(ctx, c.UnitID)
		if err != nil {
			return err
		}
		it, err := h.Units.Item(ctx, itemID)
		switch {
		case errs.HasCode(err, errs.CodeNotFound):
		case err != nil:
			return err
		case l.Counted == 0:
			if err := h.Units.DeleteItem(ctx, itemID); err != nil {
				return err
			}
		default:
			it.Expected = l.Counted
			if err := h.Units.SaveItem(ctx, it); err != nil {
				return err
			}
		}
		l.Adjusted = true
		if err := h.Units.UpdateCheck(ctx, &c); err != nil {
			return err
		}
		out = c
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "unit-item", EntityID: itemID, Summary: fmt.Sprintf("Adjusted %s on the inventory of %s to %d", l.Name, unit.Code, l.Counted)})
	})
	return out, err
}
