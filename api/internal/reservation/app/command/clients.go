package command

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// CodeNotAvailable answers a call that needs a context this deployment does not run yet.
const CodeNotAvailable = "NOT_AVAILABLE"

// NotAvailable is the refusal a client returns for a context that is not built yet.
func NotAvailable(what string) error {
	return errs.Newf(CodeNotAvailable, "%s is not available in this API yet.", what)
}

// optional turns NOT_AVAILABLE into nil: a guard whose context does not run holds no data that
// could refuse, so the rule passes, as property's stays guard did before reservation existed.
func optional(err error) error {
	if errs.HasCode(err, CodeNotAvailable) {
		return nil
	}
	return err
}

// GuestProfile is what the public check-in page shows of the lead guest.
type GuestProfile struct {
	Name        string
	Email       string
	Phone       string
	Nationality string
	IDType      string
	IDNumber    string
}

// Guests is the guest context as reservation needs it.
type Guests interface {
	// Blacklist returns the guest's name and the blacklist reason, or "" when the guest is not
	// blacklisted. An unknown guest is not blacklisted.
	Blacklist(ctx context.Context, guestID string) (name, reason string, err error)
	// CheckInReady refuses a stay whose foreign adults lack immigration data on `on`
	// (FOREIGN_DATA_MISSING, DOCUMENT_EXPIRED).
	CheckInReady(ctx context.Context, b domain.Booking, on string) error
	// Create adds the guest a booking or group brings along and returns the id.
	Create(ctx context.Context, p auth.Principal, input json.RawMessage) (string, error)
	Profile(ctx context.Context, guestID string) (GuestProfile, error)
	// ApplyPreCheckIn copies a verified online check-in onto the profile and the stay companions.
	ApplyPreCheckIn(ctx context.Context, p auth.Principal, b domain.Booking, pre domain.PreCheckIn) error
}

// Channel is the channel context as pricing needs it.
type Channel interface {
	// Listing returns the unit's live listing, or nil when it has none.
	Listing(ctx context.Context, unitID string) (*domain.Listing, error)
}

// Billing is the billing context as the desk needs it.
type Billing interface {
	// Owed is the room balance a direct stay still owes.
	Owed(ctx context.Context, b domain.Booking) (int64, error)
	// CheckOutHold refuses a check-out the folio holds (SETTLEMENT_PENDING, SERVICE_UNPAID,
	// GROUP_MASTER_OPEN, FOLIO_UNSETTLED).
	CheckOutHold(ctx context.Context, b domain.Booking) error
	// Settle takes the bill at check-out and returns the payment link, or nil when paid at once.
	Settle(ctx context.Context, p auth.Principal, b domain.Booking, input json.RawMessage) (json.RawMessage, error)
	// GroupPayment takes one payment over the group's stays, in order, and returns { payments, link }.
	GroupPayment(ctx context.Context, p auth.Principal, g domain.BookingGroup, stays []domain.Booking, input json.RawMessage) (json.RawMessage, error)
	// PayBalance opens a gateway link for the room balance from the public check-in page.
	PayBalance(ctx context.Context, b domain.Booking, method string) (json.RawMessage, error)
	// CityLedger checks the company account's credit for the stays and returns the billing record.
	CityLedger(ctx context.Context, p auth.Principal, input json.RawMessage, source string, stays []domain.Booking) (json.RawMessage, error)
}

// Settings reads the payment policy and tax settings billing and finance own.
type Settings interface {
	Policy(ctx context.Context) (domain.Policy, error)
}

// Clients bundles the other contexts.
type Clients struct {
	Guests  Guests
	Channel Channel
	Billing Billing
}

// present reports a JSON value other than null.
func present(raw json.RawMessage) bool { return len(raw) > 0 && string(raw) != "null" }
