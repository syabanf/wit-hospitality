// Package clients holds housekeeping's answers for the contexts it calls: the people and inventory
// stubs that serve the seed's roster and stock items until those contexts run, maintenance's
// pending work orders, and the guest context's lost and found.
package clients

import (
	"context"
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
)

// SeedStaff answers command.People and command.Stock from the demo seed: the mock's employees,
// roster and leaves and its stock items, with the roster moved so the seed's base date is today.
// The people and inventory contexts replace it with their clients.
type SeedStaff struct {
	BaseDate string
	Staff    domain.StaffDay
	Stock    []domain.Item
	Clock    clock.Clock
}

// Day returns the staff with the roster and leaves shifted to the current business date.
func (s SeedStaff) Day(_ context.Context, date string) (domain.StaffDay, error) {
	n := clock.DaysBetween(s.BaseDate, clock.Today(s.Clock))
	day := domain.StaffDay{Employees: s.Staff.Employees, Roster: []domain.RosterDay{}, Leaves: []domain.Leave{}}
	for _, r := range s.Staff.Roster {
		if r.Date = clock.AddDays(r.Date, n); r.Date == date {
			day.Roster = append(day.Roster, r)
		}
	}
	for _, l := range s.Staff.Leaves {
		l.From, l.To = clock.AddDays(l.From, n), clock.AddDays(l.To, n)
		day.Leaves = append(day.Leaves, l)
	}
	return day, nil
}

// Items lists the seed's stock items.
func (s SeedStaff) Items(context.Context) ([]domain.Item, error) { return slices.Clone(s.Stock), nil }

// PendingWorkOrders answers for maintenance until it runs: opening a work order is NOT_AVAILABLE.
type PendingWorkOrders struct{}

// Open refuses.
func (PendingWorkOrders) Open(context.Context, auth.Principal, command.NewWorkOrder) (command.WorkOrderRef, error) {
	return command.WorkOrderRef{}, command.NotAvailable("Opening a work order")
}

// NoPeople answers for a process without people and without the seed: nobody is on shift.
type NoPeople struct{}

// Day answers an empty day.
func (NoPeople) Day(context.Context, string) (domain.StaffDay, error) { return domain.StaffDay{}, nil }

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
