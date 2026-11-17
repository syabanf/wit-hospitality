package command

import (
	"context"
	"errors"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// The front desk's standard steps on a stay (docs/contracts/front-desk-sop-contract.md): the
// registration card, early check-in, keys and wake-up calls. Each needs booking/edit; the charges go
// to billing through the outbox, posted once each.

// FrontDesk groups the desk's handlers for the routes.
type FrontDesk struct {
	SignCard      SignCard
	EarlyCheckIn  EarlyCheckIn
	IssueKey      IssueKey
	ReturnKey     ReturnKey
	BookWakeUp    BookWakeUp
	WakeUpOutcome WakeUpOutcome
}

// NewFrontDesk builds the desk's handlers on d.
func NewFrontDesk(d Deps) FrontDesk {
	return FrontDesk{SignCard{d}, EarlyCheckIn{d}, IssueKey{d}, ReturnKey{d}, BookWakeUp{d}, WakeUpOutcome{d}}
}

// charged appends the event that makes billing post a front desk fee, once the stay is saved at its
// new version; a free one (0) sends nothing.
func (d Deps) charged(ctx context.Context, p auth.Principal, eventType string, b domain.Booking, pl place, keyID, code, description string, charge int64) error {
	if charge <= 0 {
		return nil
	}
	return d.emit(ctx, eventType, "booking", b.ID, b.Version, reservation.StayCharged{BookingID: b.ID, BookingCode: b.Code, UnitID: b.UnitID,
		VillaID: pl.villa.ID, LocationID: pl.villa.LocationID, KeyID: keyID, Code: code, Description: description, Charge: charge,
		By: p.Name, ByID: p.UserID, At: d.stamp()})
}

// awaitCharge holds the answer until billing posted the fee, so a folio read next shows it; on a
// timeout the answer goes anyway and the line follows moments later.
func (d Deps) awaitCharge(ctx context.Context, eventType string, b domain.Booking) error {
	if err := projector.AwaitConsumer(ctx, d.DB, reservation.ConsumerStayCharges, eventType, b.ID, b.Version, lateChargeWait); err != nil && !errors.Is(err, projector.ErrTimeout) {
		return err
	}
	return nil
}

// SignCard takes the registration card at the desk: drawn on screen or a paper card's number.
type SignCard struct{ Deps }

// Handle signs the card.
func (h SignCard) Handle(ctx context.Context, p auth.Principal, id string, in domain.CardInput) (domain.Booking, error) {
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if err := b.SignCard(in, p.Name, domain.CardDesk, h.stamp()); err != nil {
			return err
		}
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code,
			Summary: fmt.Sprintf("Signed the registration card of %s %s", b.Code, b.RegistrationCard.CardSummary()), After: map[string]any{"method": in.Method}})
	})
}

// EarlyCheckinInput is the body of POST /bookings/{id}/early-checkin.
type EarlyCheckinInput struct {
	From string `json:"from"`
}

// EarlyCheckinGiven answers an early check-in: the stay and what the folio was charged.
type EarlyCheckinGiven struct {
	Booking domain.Booking `json:"booking"`
	Charge  int64          `json:"charge"`
}

// EarlyCheckIn lets a confirmed stay arrive before the house check-in time, the mirror of late
// check-out: EARLY_CHECKIN_TAKEN while the departing guest holds the unit past that time, the
// property's fee for a room, free for a villa nobody left that morning.
type EarlyCheckIn struct{ Deps }

// Handle gives the early check-in.
func (h EarlyCheckIn) Handle(ctx context.Context, p auth.Principal, id string, in EarlyCheckinInput) (EarlyCheckinGiven, error) {
	var out EarlyCheckinGiven
	b, err := h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if err := b.CheckEarlyCheckinOpen(); err != nil {
			return err
		}
		pl, err := placeOf(cat, b.UnitID)
		if err != nil {
			return err
		}
		leaving, err := h.Repo.Departures(ctx, b.UnitID, b.CheckIn)
		if err != nil {
			return err
		}
		charge, err := domain.EarlyCheckinCharge(domain.EarlyCheckinRequest{From: in.From, CheckInTime: pl.villa.CheckInTime, Kind: cat.UnitKind(pl.unit),
			Operation: pl.villa.Operation, Fee: pl.villa.EarlyCheckinFee, UnitCode: pl.unit.Code, Departure: domain.DepartureOf(*b, leaving, pl.villa.CheckOutTime)})
		if err != nil {
			return err
		}
		b.EarlyCheckin = &domain.EarlyCheckin{From: in.From, Charge: charge, By: p.Name, At: h.stamp()}
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		if err := h.charged(ctx, p, reservation.EventEarlyCheckinGranted, *b, pl, "", reservation.EarlyCheckinCode, "Early check-in from "+in.From, charge); err != nil {
			return err
		}
		out.Charge = charge
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Gave %s early check-in from %s", b.Code, in.From),
			After: map[string]any{"from": in.From, "charge": charge}})
	})
	out.Booking = b
	if err == nil && out.Charge > 0 {
		err = h.awaitCharge(ctx, reservation.EventEarlyCheckinGranted, b)
	}
	return out, err
}

// IssueKey hands out an extra key, or a replacement that marks the lost key with an optional fee.
type IssueKey struct{ Deps }

// Handle issues the key.
func (h IssueKey) Handle(ctx context.Context, p auth.Principal, id string, in domain.IssueKeyInput) (domain.Booking, error) {
	var fee int64
	b, err := h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if err := b.CheckKeysOpen(); err != nil {
			return err
		}
		if err := b.ValidateIssueKey(in); err != nil {
			return err
		}
		at := h.stamp()
		var lost domain.StayKey
		var replaces *string
		if in.Reason == domain.KeyReplacement {
			if in.Fee != nil {
				fee = int64(*in.Fee)
			}
			var err error
			if lost, err = b.CloseKey(*in.ReplacesKeyID, domain.KeyLost, fee, p.Name, at); err != nil {
				return err
			}
			replaces = &lost.ID
		}
		key := b.AddKey(domain.KeyHanded{Number: in.Number, Kind: in.Kind}, in.Reason, replaces, p.Name, at)
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		pl, _ := placeOf(cat, b.UnitID)
		if err := h.charged(ctx, p, reservation.EventKeyCharged, *b, pl, lost.ID, reservation.KeyChargeCode, lost.KeyChargeDescription(), fee); err != nil {
			return err
		}
		what := "an extra"
		if replaces != nil {
			what = "a replacement"
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Gave %s %s key %s", b.Code, what, key.Number),
			After: map[string]any{"number": key.Number, "kind": key.Kind, "fee": fee}})
	})
	if err == nil && fee > 0 {
		err = h.awaitCharge(ctx, reservation.EventKeyCharged, b)
	}
	return b, err
}

// ReturnKey takes a key back, or marks it not returned with an optional fee.
type ReturnKey struct{ Deps }

// Handle closes the key.
func (h ReturnKey) Handle(ctx context.Context, p auth.Principal, id, keyID string, in domain.ReturnKeyInput) (domain.Booking, error) {
	var fee int64
	b, err := h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if err := b.CheckKeysOpen(); err != nil {
			return err
		}
		if err := domain.ValidateReturnFee(in.Fee); err != nil {
			return err
		}
		status := domain.KeyReturned
		if !in.Returned {
			status = domain.KeyNotReturned
			if in.Fee != nil {
				fee = int64(*in.Fee)
			}
		}
		key, err := b.CloseKey(keyID, status, fee, p.Name, h.stamp())
		if err != nil {
			return err
		}
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		pl, _ := placeOf(cat, b.UnitID)
		if err := h.charged(ctx, p, reservation.EventKeyCharged, *b, pl, key.ID, reservation.KeyChargeCode, key.KeyChargeDescription(), fee); err != nil {
			return err
		}
		summary := fmt.Sprintf("Took back key %s from %s", key.Number, b.Code)
		if !in.Returned {
			summary = fmt.Sprintf("Marked key %s of %s not returned", key.Number, b.Code)
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: summary, After: map[string]any{"status": status, "fee": fee}})
	})
	if err == nil && fee > 0 {
		err = h.awaitCharge(ctx, reservation.EventKeyCharged, b)
	}
	return b, err
}

// bookWakeUp books a call on the stay in by's name.
func (d Deps) bookWakeUp(b *domain.Booking, in domain.WakeUpInput, by string) (domain.WakeUpCall, error) {
	if err := b.CheckWakeUpOpen(); err != nil {
		return domain.WakeUpCall{}, err
	}
	if err := b.ValidateWakeUp(in, d.today()); err != nil {
		return domain.WakeUpCall{}, err
	}
	return b.AddWakeUp(in, by, d.stamp()), nil
}

func wakeUpWords(c domain.WakeUpCall) string {
	daily := ""
	if c.RepeatDaily {
		daily = ", daily"
	}
	return fmt.Sprintf("on %s at %s%s", c.Date, c.Time, daily)
}

// BookWakeUp books a wake-up call at the desk.
type BookWakeUp struct{ Deps }

// Handle books the call.
func (h BookWakeUp) Handle(ctx context.Context, p auth.Principal, id string, in domain.WakeUpInput) (domain.Booking, error) {
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		call, err := h.bookWakeUp(b, in, p.Name)
		if err != nil {
			return err
		}
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Booked a wake-up call for %s %s", b.Code, wakeUpWords(call)),
			After: map[string]any{"date": call.Date, "time": call.Time}})
	})
}

// WakeUpOutcome records a call: done (a daily call rolls on), no answer (retry) or cancelled.
type WakeUpOutcome struct{ Deps }

// Handle records the outcome.
func (h WakeUpOutcome) Handle(ctx context.Context, p auth.Principal, id, callID string, in domain.OutcomeInput) (domain.Booking, error) {
	return h.edit(ctx, p, id, func(ctx context.Context, b *domain.Booking, cat domain.Catalog) error {
		if err := b.CheckWakeUpOpen(); err != nil {
			return err
		}
		call, err := b.WakeUpAfter(callID, in.Outcome, p.Name, h.stamp())
		if err != nil {
			return err
		}
		if err := h.saveBooking(ctx, b, cat); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code,
			Summary: fmt.Sprintf("Wake-up call for %s on %s at %s: %s", b.Code, call.Date, call.Time, spacedOutcome(in.Outcome)), After: map[string]any{"outcome": in.Outcome}})
	})
}

func spacedOutcome(o string) string {
	if o == domain.WakeNoAnswer {
		return "no answer"
	}
	return o
}

// SignCard is POST /stay/{token}/registration-card: the guest signs on screen when the stay has no card.
func (h StayPage) SignCard(ctx context.Context, token string, signature *domain.Attachment) (GuestStay, error) {
	return h.answer(ctx, token, domain.GuestCard, func(_ context.Context, b *domain.Booking, _ domain.Catalog) (guestChange, error) {
		return guestChange{summary: "Signed the registration card"}, b.SignCard(domain.CardInput{Method: domain.CardScreen, Signature: signature}, guestActor.Name, domain.CardStay, h.stamp())
	})
}

// BookWakeUp is POST /stay/{token}/wake-up-calls: the guest books a call by the desk's rule.
func (h StayPage) BookWakeUp(ctx context.Context, token string, in domain.WakeUpInput) (GuestStay, error) {
	return h.answer(ctx, token, domain.GuestWakeUp, func(_ context.Context, b *domain.Booking, _ domain.Catalog) (guestChange, error) {
		call, err := h.bookWakeUp(b, in, guestActor.Name)
		return guestChange{summary: "Booked a wake-up call " + wakeUpWords(call)}, err
	})
}

// SignCard is POST /checkin/{token}/registration-card: the guest signs before arrival, or in house.
func (h CheckinLink) SignCard(ctx context.Context, token string, signature *domain.Attachment) (PublicPreCheckIn, error) {
	var out PublicPreCheckIn
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		b, err := h.stay(ctx, token)
		if err != nil {
			return err
		}
		if b.Status != domain.Confirmed && b.Status != domain.CheckedIn {
			return domain.ErrInvalidState("This stay is over; its registration card no longer changes.")
		}
		if err := b.SignCard(domain.CardInput{Method: domain.CardScreen, Signature: signature}, guestActor.Name, domain.CardPreCheckIn, h.stamp()); err != nil {
			return err
		}
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		if err := h.saveBooking(ctx, &b, cat); err != nil {
			return err
		}
		if err := h.record(ctx, guestActor, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Signed the registration card of %s on screen", b.Code)}); err != nil {
			return err
		}
		pre, err := h.Repo.PreCheckIn(ctx, b.ID)
		if err != nil {
			return err
		}
		out, err = h.view(ctx, token, b, pre)
		return err
	})
	return out, err
}
