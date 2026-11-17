package command

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// Housekeeping is the housekeeping context as the stay page needs it.
type Housekeeping interface {
	// GuestClean adds, or finds, today's stayover task for the stay in the guest's name.
	GuestClean(ctx context.Context, bookingID, note string) error
}

// GuestServices is what services shows a guest of their stay: the menu without costs, the stay's
// orders and its requests, each as the JSON the page reads.
type GuestServices struct {
	Menu     json.RawMessage `json:"menu"`
	Orders   json.RawMessage `json:"orders"`
	Requests json.RawMessage `json:"requests"`
}

// StayServices is the services context as the stay page needs it.
type StayServices interface {
	GuestStay(ctx context.Context, bookingID string) (GuestServices, error)
	// GuestOrder places the order at menu prices and returns what was ordered, "2 × Nasi goreng (SO-715)".
	GuestOrder(ctx context.Context, bookingID string, input json.RawMessage) (string, error)
	// GuestRequest logs the request for the desk or the villa host and returns its number.
	GuestRequest(ctx context.Context, bookingID, kind, note string) (string, error)
}

// issueStayLink gives the stay its page link once; a stay that has one keeps it.
func issueStayLink(b *domain.Booking) error {
	if b.StayToken != nil && *b.StayToken != "" {
		return nil
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return fmt.Errorf("stay token: %w", err)
	}
	token := domain.StayToken(random)
	b.StayToken = &token
	return nil
}

// IssueStayLink is POST /bookings/{id}/stay-link: the desk makes the stay page link of a stay in
// house that has none, for a stay checked in before the page existed. It needs booking/edit.
type IssueStayLink struct{ Deps }

// Handle makes the link and returns the stay.
func (h IssueStayLink) Handle(ctx context.Context, p auth.Principal, id string) (domain.Booking, error) {
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if err := domain.CheckLinkable(*b); err != nil {
			return err
		}
		if b.StayToken != nil && *b.StayToken != "" {
			return nil
		}
		if err := issueStayLink(b); err != nil {
			return err
		}
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Made the stay page link of %s", b.Code)})
	})
}

// GuestLateCheckout is the late check-out the guest sees, or is quoted: the time and what it costs.
type GuestLateCheckout struct {
	Until  string `json:"until"`
	Charge int64  `json:"charge"`
}

// GuestStay is GuestStayView: what GET /stay/{token} answers, read without a session. It carries
// this stay alone, the host's first name and nothing the team keeps for itself.
type GuestStay struct {
	Token         string               `json:"token"`
	State         string               `json:"state"`
	BookingCode   string               `json:"bookingCode"`
	GuestName     string               `json:"guestName"`
	VillaName     string               `json:"villaName"`
	LocationName  string               `json:"locationName"`
	UnitName      string               `json:"unitName"`
	UnitKind      string               `json:"unitKind"`
	CheckIn       string               `json:"checkIn"`
	CheckOut      string               `json:"checkOut"`
	Nights        int                  `json:"nights"`
	CheckInTime   string               `json:"checkInTime"`
	CheckOutTime  string               `json:"checkOutTime"`
	HostName      *string              `json:"hostName"`
	HouseRules    []string             `json:"houseRules"`
	Today         string               `json:"today"`
	ServiceWindow domain.ServiceWindow `json:"serviceWindow"`
	Preferences   domain.Preferences   `json:"preferences"`
	CleanAskedAt  *string              `json:"cleanAskedAt"`
	LateCheckout  *GuestLateCheckout   `json:"lateCheckout"`
	// Menu and Folio are null while services or billing do not run.
	Menu     json.RawMessage `json:"menu"`
	Orders   json.RawMessage `json:"orders"`
	Requests json.RawMessage `json:"requests"`
	Folio    json.RawMessage `json:"folio"`
}

// StayPage serves /stay/{token}: the guest's page during the stay, no session needed. Every write
// runs the desk's own rule in the guest's name, lands on the stay's guest actions and on the audit
// trail, and answers the page again.
type StayPage struct{ Deps }

// stay is the booking behind a stay token while its link lives; a write needs the guest in house.
func (h StayPage) stay(ctx context.Context, token string, write bool) (domain.Booking, error) {
	if !domain.IsStayToken(token) {
		return domain.Booking{}, errs.NotFound("stay page", token)
	}
	b, err := h.Repo.BookingByStayToken(ctx, token)
	if err != nil {
		return b, err
	}
	switch state := domain.StayLinkState(b, h.today()); {
	case state == domain.StayLinkExpired:
		return b, domain.ErrStayLinkExpired(b.Code)
	case write && state != domain.StayLinkOpen:
		return b, domain.ErrStayReadOnly()
	}
	return b, nil
}

func orNull(raw json.RawMessage, empty string) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(empty)
	}
	return raw
}

func (h StayPage) view(ctx context.Context, token string, b domain.Booking) (GuestStay, error) {
	cat, err := h.Catalog.Catalog(ctx)
	if err != nil {
		return GuestStay{}, err
	}
	pl, _ := placeOf(cat, b.UnitID)
	loc, _ := cat.Location(pl.villa.LocationID)
	kind := cat.UnitKind(pl.unit)
	guest, err := h.Clients.Guests.Profile(ctx, b.GuestID)
	if err = optional(err); err != nil {
		return GuestStay{}, err
	}
	out := GuestStay{Token: token, State: domain.StayLinkState(b, h.today()), BookingCode: b.Code, GuestName: domain.FirstName(guest.Name),
		VillaName: pl.villa.Name, LocationName: loc.Name, UnitName: pl.unit.Code + " " + pl.unit.Name, UnitKind: kind,
		CheckIn: b.CheckIn, CheckOut: b.CheckOut, Nights: domain.DaysBetween(b.CheckIn, b.CheckOut),
		CheckInTime: pl.villa.CheckInTime, CheckOutTime: pl.villa.CheckOutTime, HouseRules: domain.HouseRules, Today: h.today(),
		ServiceWindow: b.ServiceWindow, Preferences: b.Preferences}
	if out.CheckInTime == "" {
		out.CheckInTime = domain.DefaultCheckInTime
	}
	if out.CheckOutTime == "" {
		out.CheckOutTime = domain.DefaultCheckOutTime
	}
	if out.Preferences.Setups == nil {
		out.Preferences.Setups = []string{}
	}
	if kind == domain.KindVilla && b.HostID != nil && h.Clients.Staff != nil {
		member, found, err := h.Clients.Staff.StaffMember(ctx, *b.HostID)
		if err = optional(err); err != nil {
			return GuestStay{}, err
		}
		if name := domain.FirstName(member.Name); found && name != "" {
			out.HostName = &name
		}
	}
	if at := b.CleanAskedAt(h.today()); at != "" {
		out.CleanAskedAt = &at
	}
	if b.LateCheckout != nil {
		out.LateCheckout = &GuestLateCheckout{Until: b.LateCheckout.Until, Charge: b.LateCheckout.Charge}
	}
	var sv GuestServices
	if h.Clients.Services != nil {
		if sv, err = h.Clients.Services.GuestStay(ctx, b.ID); optional(err) != nil {
			return GuestStay{}, err
		}
	}
	out.Menu, out.Orders, out.Requests = orNull(sv.Menu, "null"), orNull(sv.Orders, "[]"), orNull(sv.Requests, "[]")
	folio, err := h.Clients.Billing.GuestFolio(ctx, b.ID)
	if err = optional(err); err != nil {
		return GuestStay{}, err
	}
	out.Folio = orNull(folio, "null")
	return out, nil
}

// View is GET /stay/{token}.
func (h StayPage) View(ctx context.Context, token string) (GuestStay, error) {
	b, err := h.stay(ctx, token, false)
	if err != nil {
		return GuestStay{}, err
	}
	return h.view(ctx, token, b)
}

// guestChange is what one guest action did: the line for the stay's guest actions, and what to
// append once the stay is saved.
type guestChange struct {
	summary string
	saved   func(ctx context.Context, b domain.Booking) error
}

// act runs one guest action all or nothing: the change on the locked stay, its guest action, one
// save, and the audit line in the guest's name.
func (h StayPage) act(ctx context.Context, token, kind string, fn func(ctx context.Context, b *domain.Booking, cat domain.Catalog) (guestChange, error)) (domain.Booking, error) {
	var b domain.Booking
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if b, err = h.stay(ctx, token, true); err != nil {
			return err
		}
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		change, err := fn(ctx, &b, cat)
		if err != nil {
			return err
		}
		b.AddGuestAction(domain.GuestAction{Kind: kind, At: h.stamp(), Summary: change.summary})
		if err := h.saveBooking(ctx, &b, cat); err != nil {
			return err
		}
		if change.saved != nil {
			if err := change.saved(ctx, b); err != nil {
				return err
			}
		}
		return h.record(ctx, guestActor, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code,
			Summary: fmt.Sprintf("Guest of %s: %s", b.Code, change.summary), After: map[string]any{"kind": kind}})
	})
	return b, err
}

// answer runs the action and answers the page as it reads afterwards.
func (h StayPage) answer(ctx context.Context, token, kind string, fn func(ctx context.Context, b *domain.Booking, cat domain.Catalog) (guestChange, error)) (GuestStay, error) {
	b, err := h.act(ctx, token, kind, fn)
	if err != nil {
		return GuestStay{}, err
	}
	return h.view(ctx, token, b)
}

// AskClean is POST /stay/{token}/clean: one clean a day, CLEAN_ALREADY_ASKED after that.
// Housekeeping adds today's stayover task, or keeps the one the desk already asked for.
func (h StayPage) AskClean(ctx context.Context, token, note string) (GuestStay, error) {
	return h.answer(ctx, token, domain.GuestClean, func(ctx context.Context, b *domain.Booking, _ domain.Catalog) (guestChange, error) {
		if err := domain.ValidateGuestNote(note); err != nil {
			return guestChange{}, err
		}
		if b.CleanAskedAt(h.today()) != "" {
			return guestChange{}, domain.ErrCleanAlreadyAsked()
		}
		if h.Clients.Housekeeping == nil {
			return guestChange{}, NotAvailable("Housekeeping")
		}
		return guestChange{summary: "Asked for cleaning today"}, h.Clients.Housekeeping.GuestClean(ctx, b.ID, strings.TrimSpace(note))
	})
}

// SetServiceWindow is PUT /stay/{token}/service-window: a window or do not disturb on a villa, the
// schedule or do not disturb on a room.
func (h StayPage) SetServiceWindow(ctx context.Context, token string, in domain.ServiceWindow) (GuestStay, error) {
	return h.answer(ctx, token, domain.GuestWindow, func(_ context.Context, b *domain.Booking, cat domain.Catalog) (guestChange, error) {
		u, _ := cat.Unit(b.UnitID)
		if err := domain.ValidateGuestWindow(cat.UnitKind(u), in); err != nil {
			return guestChange{}, err
		}
		b.ServiceWindow = in.Clean()
		return guestChange{summary: domain.GuestWindowSummary(b.ServiceWindow)}, nil
	})
}

// Order is POST /stay/{token}/orders: services places it at menu prices on the stay's folio.
func (h StayPage) Order(ctx context.Context, token string, input json.RawMessage) (GuestStay, error) {
	return h.answer(ctx, token, domain.GuestOrder, func(ctx context.Context, b *domain.Booking, _ domain.Catalog) (guestChange, error) {
		if h.Clients.Services == nil {
			return guestChange{}, NotAvailable("Room service")
		}
		ordered, err := h.Clients.Services.GuestOrder(ctx, b.ID, input)
		return guestChange{summary: "Ordered " + ordered}, err
	})
}

// Request is POST /stay/{token}/requests: towels, a transfer or anything else, for the desk or the
// villa host.
func (h StayPage) Request(ctx context.Context, token string, in domain.GuestRequestInput) (GuestStay, error) {
	return h.answer(ctx, token, domain.GuestRequest, func(ctx context.Context, b *domain.Booking, _ domain.Catalog) (guestChange, error) {
		if err := domain.ValidateGuestRequest(in); err != nil {
			return guestChange{}, err
		}
		if h.Clients.Services == nil {
			return guestChange{}, NotAvailable("Service requests")
		}
		number, err := h.Clients.Services.GuestRequest(ctx, b.ID, in.Kind, strings.TrimSpace(in.Note))
		return guestChange{summary: fmt.Sprintf("Asked for %s (%s)", strings.ToLower(domain.GuestRequestLabel[in.Kind]), number)}, err
	})
}

// QuoteLateCheckout is GET /stay/{token}/late-checkout?until=HH:MM: the price by the desk's rule,
// or why it cannot be given (LATE_CHECKOUT_TAKEN).
func (h StayPage) QuoteLateCheckout(ctx context.Context, token, until string) (GuestLateCheckout, error) {
	b, err := h.stay(ctx, token, true)
	if err != nil {
		return GuestLateCheckout{}, err
	}
	cat, err := h.Catalog.Catalog(ctx)
	if err != nil {
		return GuestLateCheckout{}, err
	}
	charge, _, err := h.lateCheckoutCharge(ctx, b, cat, until)
	return GuestLateCheckout{Until: until, Charge: charge}, err
}

// LateCheckOut is POST /stay/{token}/late-checkout: the guest confirms, and the stay keeps the late
// check-out as given by the guest. Billing posts the fee from the same event as the desk's.
func (h StayPage) LateCheckOut(ctx context.Context, token, until string) (GuestStay, error) {
	var charge int64
	b, err := h.act(ctx, token, domain.GuestLateCheckout, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) (guestChange, error) {
		var granted func(context.Context, domain.Booking) error
		var err error
		if charge, granted, err = h.lateCheckout(ctx, guestActor, b, cat, until); err != nil {
			return guestChange{}, err
		}
		price := "free"
		if charge > 0 {
			price = fmt.Sprintf("charged %d", charge)
		}
		return guestChange{summary: fmt.Sprintf("Asked for a late check-out until %s, %s", until, price), saved: granted}, nil
	})
	if err != nil {
		return GuestStay{}, err
	}
	if charge > 0 {
		// Billing posts the fee from the event; wait for it so the folio on the page shows it.
		if werr := projector.AwaitConsumer(ctx, h.DB, reservation.ConsumerLateCheckoutCharge, reservation.EventLateCheckoutGranted, b.ID, b.Version, lateChargeWait); werr != nil && !errors.Is(werr, projector.ErrTimeout) {
			return GuestStay{}, werr
		}
	}
	return h.view(ctx, token, b)
}

// SetPreferences is PUT /stay/{token}/preferences: the fields the online check-in takes for the
// unit kind. The arrival time stays as it was: the guest has arrived.
func (h StayPage) SetPreferences(ctx context.Context, token string, in domain.Preferences) (GuestStay, error) {
	return h.answer(ctx, token, domain.GuestPreferences, func(_ context.Context, b *domain.Booking, cat domain.Catalog) (guestChange, error) {
		in.ArrivalTime = b.Preferences.ArrivalTime
		return guestChange{summary: "Updated the preferences"}, h.applyPreferences(b, cat, in)
	})
}
