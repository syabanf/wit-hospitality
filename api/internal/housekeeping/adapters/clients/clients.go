// Package clients holds housekeeping's answers for the contexts it calls: inventory's stock items,
// maintenance's work orders and the guest context's lost and found.
package clients

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// Stock reads stock items through the inventory context; Client is read at call time, so the
// composition root may fill it after building housekeeping. Without a client the list is
// NOT_AVAILABLE.
type Stock struct{ Client func() inventory.Items }

// Items lists inventory's stock items.
func (s Stock) Items(ctx context.Context) ([]domain.Item, error) {
	var c inventory.Items
	if s.Client != nil {
		c = s.Client()
	}
	if c == nil {
		return nil, command.NotAvailable("The stock item list")
	}
	items, err := c.Items(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.Item, 0, len(items))
	for _, i := range items {
		out = append(out, domain.Item{ID: i.ID, Code: i.Code, Name: i.Name, Kind: i.Kind})
	}
	return out, nil
}

// WorkOrders opens work orders through the maintenance context; Client is read at call time, so
// the composition root may fill it after building housekeeping. Without a client, opening a work
// order is NOT_AVAILABLE.
type WorkOrders struct{ Client func() maintenance.WorkOrders }

// Open opens the work order in the signed-in user's name.
func (w WorkOrders) Open(ctx context.Context, p auth.Principal, o command.NewWorkOrder) (command.WorkOrderRef, error) {
	var c maintenance.WorkOrders
	if w.Client != nil {
		c = w.Client()
	}
	if c == nil {
		return command.WorkOrderRef{}, command.NotAvailable("Opening a work order")
	}
	ref, err := c.Open(ctx, maintenance.Reporter{UserID: p.UserID, Name: p.Name, Role: string(p.Role), VillaIDs: p.VillaIDs, LocationIDs: p.LocationIDs},
		maintenance.Report{VillaID: o.VillaID, UnitID: o.UnitID, Source: o.Source, Category: o.Category, Priority: o.Priority, Title: o.Title, Description: o.Description})
	return command.WorkOrderRef{ID: ref.ID, Number: ref.Number}, err
}

// LostFound logs finds through the guest context; Client is read at call time, so the
// composition root may fill it after building housekeeping.
type LostFound struct{ Client func() guest.LostFound }

// Log logs the find in the attendant's name and returns the lost item id.
func (l LostFound) Log(ctx context.Context, p auth.Principal, f command.LostFind) (string, error) {
	var c guest.LostFound
	if l.Client != nil {
		c = l.Client()
	}
	if c == nil {
		return "", command.NotAvailable("Lost and found")
	}
	unit := f.UnitID
	item, err := c.LogFind(ctx, guest.Finder{UserID: p.UserID, Name: p.Name, Role: string(p.Role), VillaIDs: p.VillaIDs, LocationIDs: p.LocationIDs},
		guest.LostFind{FoundOn: f.FoundOn, VillaID: f.VillaID, UnitID: &unit, Where: f.Where, Description: f.Description, BookingID: f.BookingID})
	return item.ID, err
}
