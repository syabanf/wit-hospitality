// Package clients holds housekeeping's answers for the contexts it calls: the inventory stub that
// serves the seed's stock items until inventory runs, maintenance's pending work orders, and the
// guest context's lost and found.
package clients

import (
	"context"
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// SeedStock answers command.Stock with the demo seed's stock items (names and kinds) until the
// inventory context runs.
type SeedStock []domain.Item

// Items lists the seed's stock items.
func (s SeedStock) Items(context.Context) ([]domain.Item, error) { return slices.Clone(s), nil }

// PendingWorkOrders answers for maintenance until it runs: opening a work order is NOT_AVAILABLE.
type PendingWorkOrders struct{}

// Open refuses.
func (PendingWorkOrders) Open(context.Context, auth.Principal, command.NewWorkOrder) (command.WorkOrderRef, error) {
	return command.WorkOrderRef{}, command.NotAvailable("Opening a work order")
}

// NoStock answers for a process without inventory: NOT_AVAILABLE.
type NoStock struct{}

// Items refuses.
func (NoStock) Items(context.Context) ([]domain.Item, error) {
	return nil, command.NotAvailable("The stock item list")
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
