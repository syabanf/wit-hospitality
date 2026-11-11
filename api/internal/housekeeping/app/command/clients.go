package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// CodeNotAvailable answers a call that needs a context this deployment does not run yet.
const CodeNotAvailable = "NOT_AVAILABLE"

// NotAvailable is the refusal a client returns for a context that is not built yet.
func NotAvailable(what string) error {
	return errs.Newf(CodeNotAvailable, "%s is not available in this API yet.", what)
}

// People is the people context as housekeeping needs it: who works on a day.
type People interface {
	// Day returns the employees, the day's roster and the approved leaves that cover it.
	Day(ctx context.Context, date string) (domain.StaffDay, error)
}

// Stock is the inventory context's item list, for linen names and the linen-only par rule.
type Stock interface {
	Items(ctx context.Context) ([]domain.Item, error)
}

// NewWorkOrder is what housekeeping asks maintenance to open: from an inspection or a task issue.
type NewWorkOrder struct {
	VillaID     string `json:"villaId"`
	UnitID      string `json:"unitId"`
	Source      string `json:"source"`
	Category    string `json:"category"`
	Priority    string `json:"priority"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

// WorkOrderRef is the opened work order.
type WorkOrderRef struct {
	ID     string `json:"id"`
	Number string `json:"number"`
}

// WorkOrders is the maintenance context as housekeeping needs it.
type WorkOrders interface {
	Open(ctx context.Context, p auth.Principal, w NewWorkOrder) (WorkOrderRef, error)
}

// LostFind is a find an attendant logs from a task.
type LostFind struct {
	FoundOn     string
	VillaID     string
	UnitID      string
	Where       string
	Description string
	BookingID   *string
}

// LostFound is the guest context's lost and found, which logs the find in the attendant's name.
type LostFound interface {
	Log(ctx context.Context, p auth.Principal, f LostFind) (string, error)
}

// Clients bundles the other contexts.
type Clients struct {
	People     People
	Stock      Stock
	WorkOrders WorkOrders
	LostFound  LostFound
}

// itemName names a stock item; without inventory the id stands in.
func (d Deps) itemName(ctx context.Context, itemID string) (string, error) {
	items, err := d.Clients.Stock.Items(ctx)
	if errs.HasCode(err, CodeNotAvailable) {
		return itemID, nil
	}
	if err != nil {
		return "", err
	}
	for _, i := range items {
		if i.ID == itemID {
			return i.Name, nil
		}
	}
	return "", errs.NotFound("stock item", itemID)
}
