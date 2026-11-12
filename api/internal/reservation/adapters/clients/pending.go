// Package clients holds reservation's clients for the contexts it calls. Guests, Listings and
// Billing call the guest, channel and billing contexts through their published clients. A context
// that does not run answers NOT_AVAILABLE; commands treat that as a pass for guards whose
// data does not exist in this deployment (blacklist, immigration data, folio holds, live listings)
// and as a refusal for work only that context can do (new guest profiles, payments, city ledger
// billing). The composition root swaps in the real client when a
// context lands, behind the same interfaces.
package clients

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

const (
	guests      = "Guest profiles"
	billingName = "Billing"
	channelName = "The channel context"
)

// Guests asks the guest context through its published client. Client returns it once the
// composition root has built it, nil while no guest context runs. Copying a verified online
// check-in onto the profile is not on guest's client yet.
type Guests struct {
	Client func() guest.Client
}

func (g Guests) client() guest.Client {
	if g.Client == nil {
		return nil
	}
	return g.Client()
}

// Blacklist reads the guest's blacklist; an unknown guest is not blacklisted, as in the mock.
func (g Guests) Blacklist(ctx context.Context, guestID string) (string, string, error) {
	c := g.client()
	if c == nil {
		return "", "", command.NotAvailable(guests)
	}
	st, err := c.BlacklistStatus(ctx, guestID)
	if errs.HasCode(err, errs.CodeNotFound) {
		return "", "", nil
	}
	if err != nil || !st.Blacklisted || st.Blacklist == nil {
		return "", "", err
	}
	return st.Name, st.Blacklist.Reason, nil
}

// CheckInReady is guest's registration gate for the lead guest and the companions.
func (g Guests) CheckInReady(ctx context.Context, b domain.Booking, on string) error {
	c := g.client()
	if c == nil {
		return command.NotAvailable(guests)
	}
	stay := guest.StayPeople{BookingID: b.ID, GuestID: b.GuestID, On: on}
	if b.PartySize != nil {
		adults := b.PartySize.Adults
		stay.Adults = &adults
	}
	return c.CheckRegistration(ctx, stay)
}

// Create adds the new guest through guest's client. The booking or group command calls it before
// it writes the stay: in the monolith both share one transaction, and in split mode the key derived
// from the request's Idempotency-Key lets a retry find the profile the first attempt made.
func (g Guests) Create(ctx context.Context, p auth.Principal, input json.RawMessage) (string, error) {
	c := g.client()
	if c == nil {
		return "", command.NotAvailable(guests)
	}
	key := ""
	if k := httpx.IdempotencyKey(ctx); k != "" {
		key = "reservation:" + p.UserID + ":" + k
	}
	x, err := c.CreateGuest(ctx, p, input, key)
	return x.ID, err
}

// Profile reads the guest's summary for the public check-in page.
func (g Guests) Profile(ctx context.Context, guestID string) (command.GuestProfile, error) {
	c := g.client()
	if c == nil {
		return command.GuestProfile{}, command.NotAvailable(guests)
	}
	x, err := c.Guest(ctx, guestID)
	return command.GuestProfile{Name: x.Name, Email: x.Email, Phone: x.Phone, Nationality: x.Nationality}, err
}

// ApplyPreCheckIn is not on guest's client yet.
func (Guests) ApplyPreCheckIn(context.Context, auth.Principal, domain.Booking, domain.PreCheckIn) error {
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

// PendingBilling answers for a deployment without billing.
type PendingBilling struct{}

// Owed is not available.
func (PendingBilling) Owed(context.Context, domain.Booking) (int64, error) {
	return 0, command.NotAvailable(billingName)
}

// CheckOutHold is not available.
func (PendingBilling) CheckOutHold(context.Context, domain.Booking) error {
	return command.NotAvailable(billingName)
}

// Settle is not available.
func (PendingBilling) Settle(context.Context, auth.Principal, domain.Booking, json.RawMessage) (json.RawMessage, error) {
	return nil, command.NotAvailable(billingName)
}

// GroupPayment is not available.
func (PendingBilling) GroupPayment(context.Context, auth.Principal, domain.BookingGroup, []domain.Booking, json.RawMessage) (json.RawMessage, error) {
	return nil, command.NotAvailable(billingName)
}

// PayBalance is not available.
func (PendingBilling) PayBalance(context.Context, domain.Booking, string) (json.RawMessage, error) {
	return nil, command.NotAvailable(billingName)
}

// CityLedger is not available.
func (PendingBilling) CityLedger(context.Context, auth.Principal, json.RawMessage, string, []domain.Booking) (json.RawMessage, error) {
	return nil, command.NotAvailable(billingName)
}

// Pending returns every client that is not built yet.
func Pending() command.Clients {
	return command.Clients{Guests: Guests{}, Channel: Listings{}, Billing: PendingBilling{}}
}

// DefaultSettings serves the TypeScript defaults for the payment policy and tax settings until
// billing and finance own them.
type DefaultSettings struct{}

// Policy returns DEFAULT_PAYMENT_POLICY and DEFAULT_TAX_SETTINGS.
func (DefaultSettings) Policy(context.Context) (domain.Policy, error) {
	return domain.DefaultPolicy, nil
}
