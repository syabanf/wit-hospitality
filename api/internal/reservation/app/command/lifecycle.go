package command

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// statusEvent writes the stay and appends booking.status_changed; a direct stay cancelled or
// marked no-show carries the cancellation terms on what it has paid, unless terms says otherwise.
func (d Deps) statusEvent(ctx context.Context, b *domain.Booking, c domain.Catalog, from string, terms *reservation.Terms) error {
	if err := d.Repo.UpdateBooking(ctx, b); err != nil {
		return err
	}
	pl, _ := placeOf(c, b.UnitID)
	payload := reservation.StatusChanged{Record: recordOf(b.ID, []domain.Villa{pl.villa}, b), From: from, To: b.Status, Terms: terms}
	if terms == nil && (b.Status == domain.Cancelled || b.Status == domain.NoShow) && b.Source == domain.Direct {
		policy, err := d.Settings.Policy(ctx)
		if err != nil {
			return err
		}
		t := policy.Cancellation(int64(b.PaidAmount), policy.StayTotal(*b), b.CheckIn, d.today(), b.Status)
		payload.Terms = &reservation.Terms{Refund: t.Refund, Retained: t.Retained}
	}
	return d.emit(ctx, reservation.EventBookingStatusChanged, "booking", b.ID, b.Version, payload)
}

// Transition takes one lifecycle step without a front desk record: confirm, cancel, no-show, and
// the plain check-in and check-out. It needs booking/edit.
type Transition struct{ Deps }

// Handle moves the booking to `to`.
func (h Transition) Handle(ctx context.Context, p auth.Principal, id, to string) (domain.Booking, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return domain.Booking{}, err
	}
	var b domain.Booking
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		if b, _, err = h.booking(ctx, p, cat, id); err != nil {
			return err
		}
		if err := b.CheckTransition(to); err != nil {
			return err
		}
		if to == domain.Confirmed {
			w, err := h.load(ctx, b.CheckIn, b.CheckOut)
			if err != nil {
				return err
			}
			if err := w.avail.AssertStayFree(b.Hold(), b.CheckIn, b.CheckOut, b.ID); err != nil {
				return err
			}
		}
		if to == domain.CheckedIn {
			if !b.UnitAssigned {
				return domain.ErrUnitUnassigned(b.Code)
			}
			if err := optional(h.Clients.Guests.CheckInReady(ctx, b)); err != nil {
				return err
			}
		}
		before := b.Status
		b.Status = to
		today := h.today()
		if to == domain.CheckedIn {
			b.CheckedInOn = &today
		}
		if to == domain.CheckedOut {
			b.CheckedOutOn = &today
		}
		if err := h.statusEvent(ctx, &b, cat, before, nil); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "booking", EntityID: b.Code,
			Summary: fmt.Sprintf("%s %s to %s", b.Code, strings.Replace(before, "_", " ", 1), strings.Replace(to, "_", " ", 1)),
			Before:  map[string]any{"status": before}, After: map[string]any{"status": to}})
	})
	return b, err
}

// CheckIn checks the guest in with the front desk record. The deposit is booked by the console
// through finance; reservation keeps it on the arrival record.
type CheckIn struct{ Deps }

// Handle checks the stay in.
func (h CheckIn) Handle(ctx context.Context, p auth.Principal, id string, details domain.CheckInDetails) (domain.Booking, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return domain.Booking{}, err
	}
	var b domain.Booking
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		if b, _, err = h.booking(ctx, p, cat, id); err != nil {
			return err
		}
		if err := b.CheckCan(domain.CheckedIn, "checked in"); err != nil {
			return err
		}
		if !b.UnitAssigned {
			return domain.ErrUnitUnassigned(b.Code)
		}
		if err := domain.ValidateCheckIn(details); err != nil {
			return err
		}
		if err := optional(h.Clients.Guests.CheckInReady(ctx, b)); err != nil {
			return err
		}
		today := h.today()
		details.Notes = strings.TrimSpace(details.Notes)
		b.Status, b.CheckedInOn, b.Arrival = domain.CheckedIn, &today, &details
		if err := h.statusEvent(ctx, &b, cat, domain.Confirmed, nil); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "booking", EntityID: b.Code, Summary: "Checked in " + b.Code,
			Before: map[string]any{"status": domain.Confirmed}, After: map[string]any{"status": domain.CheckedIn, "deposit": details.Deposit}})
	})
	return b, err
}

// heldDeposit is the deposit taken at check-in.
func heldDeposit(b domain.Booking) float64 {
	if b.Arrival == nil {
		return 0
	}
	return b.Arrival.Deposit
}

// closeStay records the departure and appends the step.
func (d Deps) closeStay(ctx context.Context, p auth.Principal, b *domain.Booking, c domain.Catalog, details domain.CheckOutDetails) error {
	today := d.today()
	details.Notes = strings.TrimSpace(details.Notes)
	b.Status, b.CheckedOutOn, b.Departure = domain.CheckedOut, &today, &details
	if err := d.statusEvent(ctx, b, c, domain.CheckedIn, nil); err != nil {
		return err
	}
	return d.record(ctx, p, audit.Line{Action: audit.Status, Entity: "booking", EntityID: b.Code, Summary: "Checked out " + b.Code,
		Before: map[string]any{"status": domain.CheckedIn}, After: map[string]any{"status": domain.CheckedOut, "extraCharges": details.ExtraCharges}})
}

// CheckOut closes the stay with the front desk record once billing holds nothing open.
type CheckOut struct{ Deps }

// Handle checks the stay out.
func (h CheckOut) Handle(ctx context.Context, p auth.Principal, id string, details domain.CheckOutDetails) (domain.Booking, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return domain.Booking{}, err
	}
	var b domain.Booking
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		if b, _, err = h.booking(ctx, p, cat, id); err != nil {
			return err
		}
		if err := b.CheckCan(domain.CheckedOut, "checked out"); err != nil {
			return err
		}
		if err := domain.ValidateCheckOut(details, heldDeposit(b)); err != nil {
			return err
		}
		if err := optional(h.Clients.Billing.CheckOutHold(ctx, b)); err != nil {
			return err
		}
		return h.closeStay(ctx, p, &b, cat, details)
	})
	return b, err
}

// SettleInput is SettleInput: the departure record and how the guest pays the bill.
type SettleInput struct {
	Details domain.CheckOutDetails `json:"details"`
	Method  string                 `json:"method"`
}

// Settled is the answer of settle-check-out.
type Settled struct {
	Booking domain.Booking  `json:"booking"`
	Link    json.RawMessage `json:"link"`
}

// SettleCheckOut takes the bill through billing and checks out, all or nothing. Billing takes the
// payment; a gateway method returns a link and the stay closes when the guest pays it.
type SettleCheckOut struct{ Deps }

// Handle settles and checks out.
func (h SettleCheckOut) Handle(ctx context.Context, p auth.Principal, id string, raw json.RawMessage) (Settled, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return Settled{}, err
	}
	var in SettleInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return Settled{}, err
	}
	var out Settled
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		b, _, err := h.booking(ctx, p, cat, id)
		if err != nil {
			return err
		}
		if err := b.CheckCan(domain.CheckedOut, "checked out"); err != nil {
			return err
		}
		if err := domain.ValidateCheckOut(in.Details, heldDeposit(b)); err != nil {
			return err
		}
		link, err := h.Clients.Billing.Settle(ctx, p, b, raw)
		if err != nil {
			return err
		}
		out = Settled{Booking: b, Link: json.RawMessage("null")}
		if present(link) {
			out.Link = link
			return nil
		}
		if err := h.closeStay(ctx, p, &b, cat, in.Details); err != nil {
			return err
		}
		out.Booking = b
		return nil
	})
	return out, err
}
