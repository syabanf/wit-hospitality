package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/services"
)

// KitInput is the body of PUT stock/kits/{groupId}.
type KitInput struct {
	Lines []domain.LineInput `json:"lines"`
}

// SaveKit sets the amenity kit that marking a unit of the room type ready issues; an empty list
// removes it. It needs maintenance/edit and the room type's villa in scope.
type SaveKit struct{ Deps }

// Handle saves the kit.
func (h SaveKit) Handle(ctx context.Context, p auth.Principal, groupID string, in KitInput) (domain.Kit, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.Kit{}, err
	}
	kept := []domain.LineInput{}
	for _, l := range in.Lines {
		if l.Quantity > 0 {
			kept = append(kept, l)
		}
	}
	if err := domain.ValidateKit(kept); err != nil {
		return domain.Kit{}, err
	}
	kit := domain.Kit{GroupID: groupID, Lines: domain.Lines(kept)}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		group, err := h.Repo.Group(ctx, groupID)
		if err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, group.VillaID); err != nil {
			return err
		}
		for _, l := range kit.Lines {
			if _, err := h.Repo.Item(ctx, l.ItemID); err != nil {
				return err
			}
		}
		summary := fmt.Sprintf("Removed the %s amenity kit", group.Name)
		if len(kit.Lines) > 0 {
			summary = fmt.Sprintf("Set the %s amenity kit to %d items", group.Name, len(kit.Lines))
			err = h.Repo.SaveKit(ctx, kit)
		} else {
			err = h.Repo.DeleteKit(ctx, groupID)
		}
		if err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "amenity-kit", EntityID: groupID, Summary: summary})
	})
	return kit, err
}

// LinkInput is the body of PUT stock/minibar-links/{menuItemId}; null unlinks.
type LinkInput struct {
	StockItemID *string `json:"stockItemId"`
}

// LinkMinibar ties a minibar menu item to the stock it sells, or unlinks it; it needs
// maintenance/edit. It answers with every link.
type LinkMinibar struct{ Deps }

// Handle links or unlinks the menu item.
func (h LinkMinibar) Handle(ctx context.Context, p auth.Principal, menuItemID string, in LinkInput) ([]domain.MinibarLink, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return nil, err
	}
	var links []domain.MinibarLink
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		menu, err := h.Repo.MenuItem(ctx, menuItemID)
		if err != nil {
			return err
		}
		if menu.Category != "minibar" {
			return errs.Newf(errs.CodeValidation, "%s is not on the minibar.", menu.Name)
		}
		if _, err := h.villaInScope(ctx, p, menu.VillaID); err != nil {
			return err
		}
		summary := "Unlinked " + menu.Name
		if in.StockItemID != nil && *in.StockItemID != "" {
			item, err := h.Repo.Item(ctx, *in.StockItemID)
			if err != nil {
				return err
			}
			if item.Kind != "minibar" {
				return errs.New(errs.CodeValidation, "Link a minibar stock item.")
			}
			summary = fmt.Sprintf("Linked %s to %s", menu.Name, item.Code)
			err = h.Repo.SaveLink(ctx, domain.MinibarLink{MenuItemID: menuItemID, StockItemID: item.ID})
			if err != nil {
				return err
			}
		} else if err := h.Repo.DeleteLink(ctx, menuItemID); err != nil {
			return err
		}
		if err := h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "minibar-link", EntityID: menuItemID, Summary: summary}); err != nil {
			return err
		}
		links, err = h.Repo.Links(ctx)
		return err
	})
	return links, err
}

// minibarStock is the mock's minibarStock: menu lines (menu item id and quantity) with the stock
// they sell, quantities added up per stock item in first-seen order.
func (d Deps) minibarStock(ctx context.Context, lines []domain.Line) ([]domain.Line, error) {
	links, err := d.Repo.Links(ctx)
	if err != nil {
		return nil, err
	}
	by := map[string]string{}
	for _, l := range links {
		by[l.MenuItemID] = l.StockItemID
	}
	var out []domain.Line
	at := map[string]int{}
	for _, l := range lines {
		stock, ok := by[l.ItemID]
		if !ok {
			continue
		}
		if i, seen := at[stock]; seen {
			out[i].Quantity += l.Quantity
			continue
		}
		at[stock] = len(out)
		out = append(out, domain.Line{ItemID: stock, Quantity: l.Quantity})
	}
	return out, nil
}

// ServiceOrder is the delivered order a minibar check answers with, in the console's shape.
type ServiceOrder struct {
	ID                 string                `json:"id"`
	Number             string                `json:"number"`
	BookingID          string                `json:"bookingId"`
	UnitID             string                `json:"unitId"`
	VillaID            string                `json:"villaId"`
	Lines              []inventory.OrderLine `json:"lines"`
	Note               string                `json:"note"`
	RequestedOn        string                `json:"requestedOn"`
	RequestedAt        int                   `json:"requestedAt"`
	Priority           string                `json:"priority"`
	Status             string                `json:"status"`
	Assignee           string                `json:"assignee"`
	PlacedBy           string                `json:"placedBy"`
	CreatedOn          string                `json:"createdOn"`
	DeliveredOn        *string               `json:"deliveredOn"`
	DeliveredAt        *int                  `json:"deliveredAt"`
	DiscountPct        int                   `json:"discountPct"`
	DiscountReason     string                `json:"discountReason"`
	CompReason         string                `json:"compReason"`
	PaymentID          *string               `json:"paymentId"`
	CostTransactionIDs []string              `json:"costTransactionIds"`
	History            []OrderHistory        `json:"history"`
}

// OrderHistory is OrderEvent.
type OrderHistory struct {
	Kind string `json:"kind"`
	By   string `json:"by"`
	At   string `json:"at"`
	Note string `json:"note"`
}

// MinibarCheck records what a guest in house took from the in-room minibar: a delivered order
// billed on the stay, plus, with restock, the same quantities issued from the villa store. It
// needs services/create. Services, once built, adopts the order from EventMinibarChecked.
type MinibarCheck struct{ Deps }

// Handle records the check.
func (h MinibarCheck) Handle(ctx context.Context, p auth.Principal, bookingID string, in domain.MinibarCheckInput) (ServiceOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, needServices); err != nil {
		return ServiceOrder{}, err
	}
	if err := domain.ValidateMinibarCheck(in); err != nil {
		return ServiceOrder{}, err
	}
	var o ServiceOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		stay, err := h.Stays.Stay(ctx, bookingID)
		if err != nil {
			return err
		}
		if stay.Status != "checked_in" {
			return errs.Newf("ORDER_NO_STAY", "%s is not in house; check the minibar while the guest stays.", stay.Code)
		}
		unit, err := h.Repo.Unit(ctx, stay.UnitID)
		if err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, unit.VillaID)
		if err != nil {
			return err
		}
		var lines []inventory.OrderLine
		var taken []domain.Line
		var charge int64
		summary := make([]string, 0, len(in.Lines))
		for _, l := range in.Lines {
			if l.Quantity <= 0 {
				continue
			}
			item, err := h.Repo.MenuItem(ctx, l.MenuItemID)
			if err != nil {
				return err
			}
			if item.VillaID != unit.VillaID || item.Category != "minibar" {
				return errs.Newf("ITEM_UNAVAILABLE", "%s is not in the %s minibar.", item.Name, villa.Name)
			}
			q := int(l.Quantity)
			lines = append(lines, inventory.OrderLine{ItemID: item.ID, Name: item.Name, Category: item.Category, Unit: item.Unit, Price: item.Price, Quantity: q})
			taken = append(taken, domain.Line{ItemID: item.ID, Quantity: q})
			charge += domain.Round(float64(item.Price) * float64(q))
			summary = append(summary, fmt.Sprintf("%d × %s", q, item.Name))
		}
		n, err := h.Repo.Next(ctx, "minibarCheck")
		if err != nil {
			return err
		}
		now := h.Clock.Now()
		today, at, stamp := h.today(), now.Hour()*60+now.Minute(), now.Format("2006-01-02T15:04:05")
		note := strings.TrimSpace(in.Note)
		if note == "" {
			note = "Minibar check"
		}
		o = ServiceOrder{
			ID: fmt.Sprintf("so-mb-%d", n), Number: fmt.Sprintf("SO-M%d", 700+n), BookingID: stay.ID, UnitID: unit.ID, VillaID: unit.VillaID, Lines: lines,
			Note: note, RequestedOn: today, RequestedAt: at, Priority: "normal", Status: "delivered", Assignee: p.Name, PlacedBy: "staff", CreatedOn: today,
			DeliveredOn: &today, DeliveredAt: &at, CostTransactionIDs: []string{},
			History: []OrderHistory{{Kind: "placed", By: p.Name, At: stamp, Note: note}, {Kind: "delivered", By: p.Name, At: stamp, Note: "Taken from the in-room minibar"}},
		}
		// The restock leaves the store; refused as a whole when the store runs short, before the order exists.
		if in.Restock {
			b, err := h.open(ctx, p.Name)
			if err != nil {
				return err
			}
			stock, err := h.minibarStock(ctx, taken)
			if err != nil {
				return err
			}
			if _, err := b.Take(ctx, villa, stock, domain.Movement{Kind: domain.Issue, UnitID: ptr(unit.ID), BookingID: ptr(stay.ID), OrderID: ptr(o.ID), Reason: "Minibar restock, " + unit.Code}); err != nil {
				return err
			}
			if err := b.Close(ctx); err != nil {
				return err
			}
		}
		event := inventory.MinibarChecked{
			Order: inventory.Order{ID: o.ID, Number: o.Number, BookingID: o.BookingID, UnitID: o.UnitID, VillaID: o.VillaID, Lines: lines},
			Note:  note, Restocked: in.Restock, DeliveredOn: today, DeliveredAt: at, By: p.Name,
		}
		if err := h.Repo.InsertMinibarCheck(ctx, event); err != nil {
			return err
		}
		if err := h.emit(ctx, inventory.EventMinibarChecked, "service_order", o.ID, 1, event); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{
			Action: audit.Create, Entity: "service-order", EntityID: o.Number, Summary: fmt.Sprintf("Minibar check on %s: %s", stay.Code, strings.Join(summary, ", ")),
			After: map[string]any{"charge": charge},
		})
	})
	return o, err
}

// Sales books the minibar stock of service orders services delivers or voids. It runs inside the
// projector's transaction for services.order.delivered.v1 and services.order.voided.v1.
type Sales struct{ Deps }

// salesBy names the movements a service order books; the order events carry no person.
const salesBy = "Room service"

// Delivered is the mock's sell: a delivered order's minibar lines leave the villa store. The
// order already reached the guest, so a short store does not refuse it: the sale is booked in
// full on the delivery day, the store shows below zero and the next count puts it right.
func (h Sales) Delivered(ctx context.Context, o services.OrderBilled) error {
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		lines := make([]domain.Line, 0, len(o.Lines))
		for _, l := range o.Lines {
			lines = append(lines, domain.Line{ItemID: l.ItemID, Quantity: int(l.Quantity)})
		}
		stock, err := h.minibarStock(ctx, lines)
		if err != nil || len(stock) == 0 {
			return err
		}
		b, err := h.open(ctx, salesBy)
		if err != nil {
			return err
		}
		for _, l := range stock {
			if _, err := b.Item(l.ItemID); err != nil {
				return err
			}
			if _, err := b.Push(ctx, domain.Movement{VillaID: o.VillaID, ItemID: l.ItemID, Kind: domain.MinibarSale, Quantity: -l.Quantity, On: o.On, UnitID: ptr(o.UnitID), BookingID: ptr(o.BookingID), OrderID: ptr(o.OrderID), Reason: o.Number}); err != nil {
				return err
			}
		}
		return b.Close(ctx)
	})
}

// Voided is the mock's unsell: a voided delivery goes back into the store at the cost it left at.
func (h Sales) Voided(ctx context.Context, o services.OrderBilled) error {
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		b, err := h.open(ctx, salesBy)
		if err != nil {
			return err
		}
		var sold []domain.Movement
		for _, m := range b.moves {
			if m.Kind == domain.MinibarSale && m.OrderID != nil && *m.OrderID == o.OrderID && m.Quantity < 0 {
				sold = append(sold, m)
			}
		}
		for _, m := range sold {
			if _, err := b.Push(ctx, domain.Movement{VillaID: m.VillaID, ItemID: m.ItemID, Kind: domain.MinibarSale, Quantity: -m.Quantity, UnitCost: m.UnitCost, UnitID: m.UnitID, BookingID: m.BookingID, OrderID: ptr(o.OrderID), Reason: "Voided " + o.Number}); err != nil {
				return err
			}
		}
		return b.Close(ctx)
	})
}
