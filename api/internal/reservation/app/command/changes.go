package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

func total(b domain.Booking) int64 { return domain.PriceOf(b.Priced()).Total }

// edit runs fn on a locked booking inside a transaction, after the booking/edit check.
func (d Deps) edit(ctx context.Context, p auth.Principal, id string, fn func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error) (domain.Booking, error) {
	if err := d.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return domain.Booking{}, err
	}
	var b domain.Booking
	err := d.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := d.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		if b, _, err = d.booking(ctx, p, cat, id); err != nil {
			return err
		}
		return fn(ctx, &b, cat)
	})
	return b, err
}

// partyFits refuses moving a stay whose party is known into a unit that cannot sleep it.
func partyFits(cat domain.Catalog, b domain.Booking, unitID string) error {
	adults, children, ok := b.Party()
	if !ok {
		return nil
	}
	return domain.CheckUnitFits(cat, unitID, adults, children)
}

// MoveInput is the move-unit body.
type MoveInput struct {
	UnitID string              `json:"unitId"`
	Reason string              `json:"reason"`
	Price  *domain.PriceChange `json:"price"`
}

// MoveUnit swaps the guest to an interchangeable unit and keeps the movement. A direct stay
// reprices from the new unit's price list, with an optional staff price; a channel stay keeps its
// price.
type MoveUnit struct{ Deps }

// Handle moves the stay.
func (h MoveUnit) Handle(ctx context.Context, p auth.Principal, id string, in MoveInput) (domain.Booking, error) {
	reason := strings.TrimSpace(in.Reason)
	if len([]rune(reason)) < 3 {
		return domain.Booking{}, errs.Invalid("reason", "Say why the guest moves.")
	}
	if in.Price != nil {
		if err := domain.ValidatePriceChange(*in.Price); err != nil {
			return domain.Booking{}, err
		}
	}
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if b.Over() {
			return domain.ErrInvalidState("This stay is over; nothing to move.")
		}
		if !b.UnitAssigned {
			return errs.Newf("UNIT_UNASSIGNED", "%s has no room yet. Assign one instead.", b.Code)
		}
		target, ok := cat.Unit(in.UnitID)
		if !ok {
			return errs.NotFound("unit", in.UnitID)
		}
		current, _ := cat.Unit(b.UnitID)
		swappable := false
		for _, u := range domain.InterchangeableWith(cat, b.UnitID) {
			swappable = swappable || u.ID == target.ID
		}
		if !swappable {
			return domain.ErrNotInterchangeable(fmt.Sprintf("%s is not interchangeable with %s.", target.Code, current.Code))
		}
		if in.Price != nil && b.IsChannel() {
			return errs.Newf("CHANNEL_PRICE_LOCKED", "%s keeps the price the channel sold it for.", b.Code)
		}
		if err := partyFits(cat, *b, target.ID); err != nil {
			return err
		}
		w, err := h.load(ctx, b.CheckIn, b.CheckOut)
		if err != nil {
			return err
		}
		if err := w.avail.AssertFree(target.ID, b.CheckIn, b.CheckOut, b.ID); err != nil {
			return err
		}
		var nights []domain.NightPrice
		if !b.IsChannel() {
			price, err := h.directPrice(ctx, cat, target.ID)
			if err != nil {
				return err
			}
			if nights, err = priceAll(domain.EachDay(b.CheckIn, b.CheckOut), price); err != nil {
				return err
			}
		}
		before := map[string]any{"unit": current.Code, "total": total(*b)}
		b.Movements = append(b.Movements, domain.UnitMovement{FromUnitID: b.UnitID, ToUnitID: target.ID, On: h.today(), Reason: reason, By: p.Name})
		b.UnitID = target.ID
		if nights != nil {
			b.SetNights(nights)
		}
		if in.Price != nil {
			if err := h.applyPrice(ctx, p, b, *in.Price); err != nil {
				return err
			}
		}
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code,
			Summary: fmt.Sprintf("Moved %s from %s to %s: %s", b.Code, current.Code, target.Code, reason),
			Before:  before, After: map[string]any{"unit": target.Code, "total": total(*b)}})
	})
}

func (d Deps) applyPrice(ctx context.Context, p auth.Principal, b *domain.Booking, price domain.PriceChange) error {
	_, err := d.applyPriceQuoted(ctx, p, b, price)
	return err
}

func (d Deps) applyPriceQuoted(ctx context.Context, p auth.Principal, b *domain.Booking, price domain.PriceChange) (domain.StayPrice, error) {
	policy, err := d.Settings.Policy(ctx)
	if err != nil {
		return domain.StayPrice{}, err
	}
	approve, err := d.mayApprove(ctx, p)
	if err != nil {
		return domain.StayPrice{}, err
	}
	return b.ApplyPrice(price, actor(p), approve, policy.DiscountLimitPct, d.today())
}

func discountValue(b domain.Booking) any {
	if b.Discount == nil {
		return nil
	}
	return b.Discount.Value
}

// SetPrice puts a staff rate or a discount on a direct stay.
type SetPrice struct{ Deps }

// Handle reprices the stay.
func (h SetPrice) Handle(ctx context.Context, p auth.Principal, id string, price domain.PriceChange) (domain.Booking, error) {
	if err := domain.ValidatePriceChange(price); err != nil {
		return domain.Booking{}, err
	}
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if b.Over() {
			return domain.ErrInvalidState("This stay is over; the price is final.")
		}
		before := map[string]any{"total": total(*b), "rateOverride": b.RateOverride, "discount": discountValue(*b)}
		quoted, err := h.applyPriceQuoted(ctx, p, b, price)
		if err != nil {
			return err
		}
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		why := ""
		if b.Discount != nil {
			why = ": " + b.Discount.Reason
		} else if r := strings.TrimSpace(price.Reason); r != "" {
			why = ": " + r
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Repriced %s%s", b.Code, why),
			Before: before, After: map[string]any{"total": quoted.Total, "rateOverride": b.RateOverride, "discount": discountValue(*b)}})
	})
}

// AssignInput is the assign-unit body.
type AssignInput struct {
	UnitID   string           `json:"unitId"`
	Override *domain.Override `json:"override"`
}

// AssignUnit picks the room for a stay booked against the room type, or changes it before
// check-in. The room's own restrictions hold unless a manager overrides.
type AssignUnit struct{ Deps }

// Handle assigns the room.
func (h AssignUnit) Handle(ctx context.Context, p auth.Principal, id string, in AssignInput) (domain.Booking, error) {
	if in.UnitID == "" {
		if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
			return domain.Booking{}, err
		}
		return domain.Booking{}, errs.Invalid("unitId", "Pick a room.")
	}
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if b.Status != domain.Draft && b.Status != domain.Confirmed {
			return domain.ErrInvalidState("Rooms are assigned before check-in.")
		}
		current, _ := cat.Unit(b.UnitID)
		target, ok := cat.Unit(in.UnitID)
		if !ok {
			return errs.NotFound("unit", in.UnitID)
		}
		g, hasGroup := cat.Group(current.Group())
		if current.GroupID == nil || target.Group() != current.Group() || !domain.SellsRoomType(g, hasGroup) {
			return domain.ErrNotInterchangeable(fmt.Sprintf("%s is not a room of the type %s booked.", target.Code, b.Code))
		}
		if target.Status != "active" {
			return errs.Newf("UNIT_UNAVAILABLE", "%s is %s.", target.Code, target.Status)
		}
		if err := partyFits(cat, *b, target.ID); err != nil {
			return err
		}
		w, err := h.load(ctx, b.CheckIn, b.CheckOut)
		if err != nil {
			return err
		}
		if err := w.avail.AssertFree(target.ID, b.CheckIn, b.CheckOut, b.ID); err != nil {
			return err
		}
		check, err := h.stayCheck(ctx, p)
		if err != nil {
			return err
		}
		// The type's rules held at booking; the room meets its own, such as a stop sell on that unit.
		label := fmt.Sprintf("%s for %s, %s to %s,", target.Code, b.Code, b.CheckIn, b.CheckOut)
		note, err := domain.CheckStay(domain.UnitRestrictions(w.rules, target.ID), domain.StayShape{GroupID: current.Group(), UnitID: target.ID, CheckIn: b.CheckIn, CheckOut: b.CheckOut}, b.Source, in.Override, label, check)
		if err != nil {
			return err
		}
		if note != nil {
			merged := domain.MergeNotes(b.RestrictionNote, *note)
			b.RestrictionNote = &merged
		}
		beforeUnit := "Unassigned"
		if b.UnitAssigned {
			beforeUnit = current.Code
		} else {
			b.RequestedUnitID = target.ID
		}
		b.UnitID, b.UnitAssigned = target.ID, true
		b.TakeHost(cat.UnitKind(target), target.HostID)
		if !b.IsChannel() {
			b.SetNights(b.SoldNights())
		}
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		if err := h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Assigned %s to %s", target.Code, b.Code),
			Before: map[string]any{"unit": beforeUnit}, After: map[string]any{"unit": target.Code}}); err != nil {
			return err
		}
		if note == nil {
			return nil
		}
		return h.overrideAudit(ctx, p, b.Code, fmt.Sprintf("Sold %s on %s past stay restrictions: %s", target.Code, b.Code, note.Reason), note)
	})
}

// StayPatch is PATCH /bookings/{id}: new dates, or the notes alone.
type StayPatch struct {
	CheckIn     *string          `json:"checkIn"`
	CheckOut    string           `json:"checkOut"`
	ChannelRate *float64         `json:"channelRate"`
	Override    *domain.Override `json:"override"`
	Notes       *string          `json:"notes"`
	// ServiceWindow alone sets when housekeeping may come in (SetServiceWindow).
	ServiceWindow *domain.ServiceWindow `json:"serviceWindow"`
}

// AdjustStay changes the dates. New nights take the price list on a direct stay, or the channel
// rate on a channel stay; nights already sold keep their price. New dates meet the restrictions
// unless overridden; a guest in house who leaves early is never held to them.
type AdjustStay struct{ Deps }

// Handle applies the patch.
func (h AdjustStay) Handle(ctx context.Context, p auth.Principal, id string, in StayPatch) (domain.Booking, error) {
	if in.ServiceWindow != nil && in.CheckIn == nil && in.Notes == nil {
		return SetServiceWindow(h).Handle(ctx, p, id, *in.ServiceWindow)
	}
	if in.CheckIn == nil {
		return h.notes(ctx, p, id, in.Notes)
	}
	checkIn, checkOut := *in.CheckIn, in.CheckOut
	if msg := domain.ValidateStay(checkIn, checkOut); msg != "" {
		return domain.Booking{}, errs.Invalid("checkOut", msg)
	}
	if in.ChannelRate != nil && !wholePositive(in.ChannelRate) {
		return domain.Booking{}, errs.Invalid("channelRate", "Enter the nightly price the channel charged.")
	}
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if b.Over() {
			return domain.ErrInvalidState("This stay is over; the dates are final.")
		}
		if b.Status == domain.CheckedIn && checkIn != b.CheckIn {
			return domain.ErrInvalidState("The guest has checked in; only the check-out can move.")
		}
		if posted := postedNights(*b); domain.DaysBetween(checkIn, checkOut) < posted {
			return errs.Newf("NIGHT_POSTED", "The night audit has posted %d nights of %s; the stay keeps at least those. Correct a posted night with a rebate.", posted, b.Code)
		}
		w, err := h.load(ctx, checkIn, checkOut)
		if err != nil {
			return err
		}
		if err := w.avail.AssertStayFree(b.Hold(), checkIn, checkOut, b.ID); err != nil {
			return err
		}
		var note *domain.RestrictionNote
		if b.Status != domain.CheckedIn || checkOut > b.CheckOut {
			unit, _ := cat.Unit(b.UnitID)
			shape := domain.StayShape{GroupID: unit.Group(), CheckIn: checkIn, CheckOut: checkOut}
			if b.UnitAssigned {
				shape.UnitID = b.UnitID
			}
			check, err := h.stayCheck(ctx, p)
			if err != nil {
				return err
			}
			if note, err = domain.CheckStay(w.rules, shape, b.Source, in.Override, fmt.Sprintf("%s, %s to %s,", b.Code, checkIn, checkOut), check); err != nil {
				return err
			}
			if note != nil {
				b.RestrictionNote = note
			}
		}
		gains := false
		for _, r := range domain.RepriceNights(b.CheckIn, b.ListRates, checkIn, checkOut, func(string) int64 { return 0 }) {
			gains = gains || r == 0
		}
		if b.IsChannel() && gains && !wholePositive(in.ChannelRate) {
			return errs.New(errs.CodeValidation, "Enter the nightly price the channel charged for the new nights.")
		}
		var price nightPricer
		if b.IsChannel() {
			rate := int64(0)
			if in.ChannelRate != nil {
				rate = int64(*in.ChannelRate)
			}
			channel := domain.ChannelPrice(rate)
			price = func(date string) (domain.NightPrice, error) { return channel(date), nil }
		} else if price, err = h.directPrice(ctx, cat, b.UnitID); err != nil {
			return err
		}
		sold := b.SoldNights()
		var nights []domain.NightPrice
		for _, date := range domain.EachDay(checkIn, checkOut) {
			at := domain.DaysBetween(b.CheckIn, date)
			if at >= 0 && at < len(sold) {
				nights = append(nights, domain.NightPrice{Date: date, Rate: sold[at].Rate, Source: sold[at].Source})
			} else if nights, err = appendNight(nights, price, date); err != nil {
				return err
			}
		}
		before := map[string]any{"checkIn": b.CheckIn, "checkOut": b.CheckOut, "total": total(*b)}
		b.SetNights(nights)
		b.CheckIn, b.CheckOut = checkIn, checkOut
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		past := ""
		if note != nil && note.Kind == "override" {
			past = ", past stay restrictions: " + note.Reason
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Changed the dates of %s%s", b.Code, past),
			Before: before, After: map[string]any{"checkIn": checkIn, "checkOut": checkOut, "total": total(*b)}})
	})
}

// postedNights is how many nights the night audit has posted on the stay.
func postedNights(b domain.Booking) int {
	if b.NightsPosted == nil {
		return 0
	}
	return len(*b.NightsPosted)
}

// notes is updateNotes: the mock keeps no audit line for it.
func (h AdjustStay) notes(ctx context.Context, p auth.Principal, id string, notes *string) (domain.Booking, error) {
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if notes != nil {
			b.Notes = strings.TrimSpace(*notes)
		}
		return h.saveBooking(ctx, b, cat)
	})
}

// SetPayment edits the booking's payment summary: status, amount paid and the Airbnb fee.
type SetPayment struct{ Deps }

// Handle saves the summary.
func (h SetPayment) Handle(ctx context.Context, p auth.Principal, id string, in domain.PaymentInput) (domain.Booking, error) {
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		policy, err := h.Settings.Policy(ctx)
		if err != nil {
			return err
		}
		if err := domain.ValidatePayment(in, policy.StayTotal(*b), b.Source); err != nil {
			return err
		}
		before := map[string]any{"paymentStatus": b.PaymentStatus, "paidAmount": b.PaidAmount, "airbnbFee": b.AirbnbFee}
		b.PaymentStatus, b.PaidAmount, b.AirbnbFee = in.PaymentStatus, in.PaidAmount, in.AirbnbFee
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Updated payment on %s: %s", b.Code, in.PaymentStatus),
			Before: before, After: map[string]any{"paymentStatus": in.PaymentStatus, "paidAmount": in.PaidAmount, "airbnbFee": in.AirbnbFee}})
	})
}
