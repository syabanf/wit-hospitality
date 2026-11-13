package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// stayOpen refuses changing a stay that is over.
func stayOpen(b domain.Booking, what string) error {
	if b.Over() {
		return domain.ErrInvalidState(fmt.Sprintf("This stay is over; its %s no longer changes.", what))
	}
	return nil
}

// checkHost refuses a host people does not know or does not allocate to the villa.
func (d Deps) checkHost(ctx context.Context, hostID string, villa domain.Villa) error {
	if d.Clients.Staff == nil {
		return NotAvailable("People")
	}
	member, found, err := d.Clients.Staff.StaffMember(ctx, hostID)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrHostNotAllocated(hostID, villa.Name)
	}
	if !member.AllocatedTo(villa.ID) {
		return domain.ErrHostNotAllocated(member.Name, villa.Name)
	}
	return nil
}

// HostInput is the body of PATCH /bookings/{id}/host; null or "" leaves the stay without a host.
type HostInput struct {
	HostID *string `json:"hostId"`
}

// SetHost changes the host looking after a villa stay; it needs booking/approve, a manager's call.
// The host must be allocated to the villa (HOST_NOT_ALLOCATED); a room stay has none.
type SetHost struct{ Deps }

// Handle sets the host.
func (h SetHost) Handle(ctx context.Context, p auth.Principal, id string, in HostInput) (domain.Booking, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingApprove...); err != nil {
		return domain.Booking{}, err
	}
	var host *string
	if in.HostID != nil && strings.TrimSpace(*in.HostID) != "" {
		trimmed := strings.TrimSpace(*in.HostID)
		host = &trimmed
	}
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if err := stayOpen(*b, "host"); err != nil {
			return err
		}
		pl, err := placeOf(cat, b.UnitID)
		if err != nil {
			return err
		}
		if host != nil {
			if cat.UnitKind(pl.unit) == domain.KindRoom {
				return errs.Invalid("hostId", "A room stay has no host; hosts look after villas.")
			}
			if err := h.checkHost(ctx, *host, pl.villa); err != nil {
				return err
			}
		}
		before := b.HostID
		b.HostID = host
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Changed the host of %s", b.Code),
			Before: map[string]any{"hostId": before}, After: map[string]any{"hostId": host}})
	})
}

// SetPreferences saves what the guest asked for before arrival; a room stay keeps only the arrival
// time and notes. Setups reach the host as service requests through services.
type SetPreferences struct{ Deps }

// Handle saves the preferences.
func (h SetPreferences) Handle(ctx context.Context, p auth.Principal, id string, in domain.Preferences) (domain.Booking, error) {
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if err := stayOpen(*b, "preferences"); err != nil {
			return err
		}
		if err := h.applyPreferences(b, cat, in); err != nil {
			return err
		}
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Updated the guest preferences on %s", b.Code),
			After: map[string]any{"setups": strings.Join(b.Preferences.Setups, ", ")}})
	})
}

// applyPreferences checks the preferences against the stay's unit kind and keeps them cleaned.
func (d Deps) applyPreferences(b *domain.Booking, cat domain.Catalog, in domain.Preferences) error {
	u, _ := cat.Unit(b.UnitID)
	if err := domain.ValidatePreferences(in, cat.UnitKind(u)); err != nil {
		return err
	}
	b.Preferences = in.Clean()
	return nil
}

// SetServiceWindow saves when housekeeping may come in: the schedule, a window, or do not disturb.
type SetServiceWindow struct{ Deps }

// Handle saves the window.
func (h SetServiceWindow) Handle(ctx context.Context, p auth.Principal, id string, in domain.ServiceWindow) (domain.Booking, error) {
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if err := stayOpen(*b, "service window"); err != nil {
			return err
		}
		if err := domain.ValidateServiceWindow(in); err != nil {
			return err
		}
		before := b.ServiceWindow
		b.ServiceWindow = in.Clean()
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Set the service window of %s to %s", b.Code, b.ServiceWindow.Mode),
			Before: before, After: b.ServiceWindow})
	})
}

// LateCheckoutInput is the body of POST /bookings/{id}/late-checkout.
type LateCheckoutInput struct {
	Until string `json:"until"`
}

// LateCheckoutGiven answers a late check-out: the stay and what the folio was charged.
type LateCheckoutGiven struct {
	Booking domain.Booking `json:"booking"`
	Charge  int64          `json:"charge"`
}

// LateCheckOut lets a guest in house leave after the house check-out time. The unit's arrival that
// day must not need it before then (LATE_CHECKOUT_TAKEN); a room pays the property's late check-out
// fee, a villa leaves late for free when nobody arrives that day. The stay keeps the late check-out
// and late_checkout.granted goes out in the same transaction; billing posts the fee on the folio
// from that event.
type LateCheckOut struct{ Deps }

// Handle gives the late check-out.
func (h LateCheckOut) Handle(ctx context.Context, p auth.Principal, id string, in LateCheckoutInput) (LateCheckoutGiven, error) {
	var out LateCheckoutGiven
	b, err := h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if b.Status != domain.CheckedIn {
			return domain.ErrInvalidState(fmt.Sprintf("%s is not in house; a late check-out is given during the stay.", b.Code))
		}
		if b.LateCheckout != nil {
			return domain.ErrInvalidState(fmt.Sprintf("%s already leaves late, by %s.", b.Code, b.LateCheckout.Until))
		}
		pl, err := placeOf(cat, b.UnitID)
		if err != nil {
			return err
		}
		arrival, err := h.arrival(ctx, b.UnitID, b.CheckOut, pl.villa)
		if err != nil {
			return err
		}
		charge, err := domain.LateCheckoutCharge(domain.LateCheckoutRequest{Until: in.Until, CheckOutTime: pl.villa.CheckOutTime, Kind: cat.UnitKind(pl.unit),
			Operation: pl.villa.Operation, Fee: pl.villa.LateCheckoutFee, Arrival: arrival})
		if err != nil {
			return err
		}
		b.LateCheckout = &domain.LateCheckout{Until: in.Until, Charge: charge, By: p.Name, At: h.stamp()}
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		if err := h.emit(ctx, reservation.EventLateCheckoutGranted, "booking", b.ID, b.Version, reservation.LateCheckoutGranted{
			BookingID: b.ID, BookingCode: b.Code, UnitID: b.UnitID, VillaID: pl.villa.ID, LocationID: pl.villa.LocationID, Until: in.Until,
			Code: reservation.LateCheckoutCode, Description: "Late check-out until " + in.Until, Charge: charge, By: p.Name, ByID: p.UserID, At: b.LateCheckout.At,
		}); err != nil {
			return err
		}
		out.Charge = charge
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Gave %s a late check-out until %s", b.Code, in.Until),
			After: map[string]any{"until": in.Until, "charge": charge}})
	})
	out.Booking = b
	return out, err
}

// arrival is the unit's earliest arrival on date with the time it is expected: the guest's
// arrival time, else the villa's check-in time; nil when nobody arrives.
func (d Deps) arrival(ctx context.Context, unitID, date string, villa domain.Villa) (*domain.Arrival, error) {
	stays, err := d.Repo.Arrivals(ctx, unitID, date)
	if err != nil {
		return nil, err
	}
	var first *domain.Arrival
	for _, s := range stays {
		at := s.Preferences.ArrivalTime
		if at == "" {
			at = villa.CheckInTime
		}
		if at == "" {
			at = domain.DefaultCheckInTime
		}
		if first == nil || at < first.Time {
			first = &domain.Arrival{Code: s.Code, Time: at}
		}
	}
	return first, nil
}
