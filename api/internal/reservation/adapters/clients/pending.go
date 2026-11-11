// Package clients holds reservation's clients for the contexts it calls. Listings reads channel's
// prices. Guest and billing are not built yet, so their clients answer NOT_AVAILABLE; commands
// treat that as a pass for guards whose data does not exist in this deployment (blacklist,
// immigration data, folio holds, live listings without a channel) and as a refusal for work only that context can do (new guest
// profiles, payments, city ledger billing). The composition root swaps in the real client when a
// context lands, behind the same interfaces.
package clients

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// PendingGuests stands in for the guest context.
type PendingGuests struct{}

const (
	guests      = "Guest profiles"
	billing     = "Billing"
	channelName = "The channel context"
)

// CheckBookable is not available.
func (PendingGuests) CheckBookable(context.Context, auth.Principal, string, string) error {
	return command.NotAvailable(guests)
}

// CheckInReady is not available.
func (PendingGuests) CheckInReady(context.Context, domain.Booking) error {
	return command.NotAvailable(guests)
}

// Create is not available.
func (PendingGuests) Create(context.Context, auth.Principal, json.RawMessage) (string, error) {
	return "", command.NotAvailable(guests)
}

// Profile is not available.
func (PendingGuests) Profile(context.Context, string) (command.GuestProfile, error) {
	return command.GuestProfile{}, command.NotAvailable(guests)
}

// ApplyPreCheckIn is not available.
func (PendingGuests) ApplyPreCheckIn(context.Context, auth.Principal, domain.Booking, domain.PreCheckIn) error {
	return command.NotAvailable(guests)
}

// Listings reads live listing prices through channel's published price interface. Prices returns
// the client once the composition root has built it, nil while no channel runs.
type Listings struct {
	Prices func() channel.Prices
}

// Listing returns the unit's live listing as a price list.
func (l Listings) Listing(ctx context.Context, unitID string) (*domain.Listing, error) {
	var p channel.Prices
	if l.Prices != nil {
		p = l.Prices()
	}
	if p == nil {
		return nil, command.NotAvailable(channelName)
	}
	listing, err := p.ActiveListing(ctx, unitID)
	if err != nil || listing == nil {
		return nil, err
	}
	return &domain.Listing{DateRates: listing.DateRates}, nil
}

// PendingBilling stands in for the billing context.
type PendingBilling struct{}

// Owed is not available.
func (PendingBilling) Owed(context.Context, string) (int64, error) {
	return 0, command.NotAvailable(billing)
}

// CheckOutHold is not available.
func (PendingBilling) CheckOutHold(context.Context, domain.Booking) error {
	return command.NotAvailable(billing)
}

// Settle is not available.
func (PendingBilling) Settle(context.Context, auth.Principal, domain.Booking, json.RawMessage) (json.RawMessage, error) {
	return nil, command.NotAvailable(billing)
}

// GroupPayment is not available.
func (PendingBilling) GroupPayment(context.Context, auth.Principal, domain.BookingGroup, []domain.Share, json.RawMessage) (json.RawMessage, error) {
	return nil, command.NotAvailable(billing)
}

// PayBalance is not available.
func (PendingBilling) PayBalance(context.Context, domain.Booking, string) (json.RawMessage, error) {
	return nil, command.NotAvailable(billing)
}

// CityLedger is not available.
func (PendingBilling) CityLedger(context.Context, auth.Principal, json.RawMessage, []domain.Booking) (json.RawMessage, error) {
	return nil, command.NotAvailable(billing)
}

// Pending returns every client that is not built yet.
func Pending() command.Clients {
	return command.Clients{Guests: PendingGuests{}, Channel: Listings{}, Billing: PendingBilling{}}
}

// DefaultSettings serves the TypeScript defaults for the payment policy and tax settings until
// billing and finance own them.
type DefaultSettings struct{}

// Policy returns DEFAULT_PAYMENT_POLICY and DEFAULT_TAX_SETTINGS.
func (DefaultSettings) Policy(context.Context) (domain.Policy, error) {
	return domain.DefaultPolicy, nil
}
