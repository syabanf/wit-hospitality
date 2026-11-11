package command

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// FollowBilling keeps on the booking and group records what billing decides: what a stay has paid,
// the nights the audit posted, and who pays the bill. Each reaction saves the record and appends
// booking.saved or booking_group.saved, as a command does; running it twice changes nothing more.
type FollowBilling struct{ Deps }

// Paid sets the payment summary billing worked out after a payment, refund or transfer.
func (h FollowBilling) Paid(ctx context.Context, bookingID string, paid int64, status string) error {
	return h.stay(ctx, bookingID, func(b *domain.Booking) bool {
		if int64(b.PaidAmount) == paid && b.PaymentStatus == status {
			return false
		}
		b.PaidAmount, b.PaymentStatus = float64(paid), status
		return true
	})
}

// NightsPosted sets the nights the audit posted on a stay.
func (h FollowBilling) NightsPosted(ctx context.Context, bookingID string, dates []string) error {
	return h.stay(ctx, bookingID, func(b *domain.Booking) bool {
		if b.NightsPosted != nil && slices.Equal(*b.NightsPosted, dates) {
			return false
		}
		posted := slices.Clone(dates)
		b.NightsPosted = &posted
		return true
	})
}

// StayBilling sets who pays a booking; null makes the guest pay.
func (h FollowBilling) StayBilling(ctx context.Context, bookingID string, billing json.RawMessage) error {
	return h.stay(ctx, bookingID, func(b *domain.Booking) bool {
		next := cityLedger(billing)
		if string(next) == string(b.CityLedger) {
			return false
		}
		b.CityLedger = next
		return true
	})
}

// GroupBilling sets who pays a group's stays.
func (h FollowBilling) GroupBilling(ctx context.Context, groupID string, billing json.RawMessage) error {
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		g, err := h.Repo.Group(ctx, groupID)
		if errs.HasCode(err, errs.CodeNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		next := cityLedger(billing)
		if string(next) == string(g.CityLedger) {
			return nil
		}
		g.CityLedger = next
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		return h.saveGroup(ctx, &g, cat, false)
	})
}

// cityLedger keeps a null billing off the record, as the console's optional field.
func cityLedger(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return raw
}

func (h FollowBilling) stay(ctx context.Context, id string, change func(b *domain.Booking) bool) error {
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		b, err := h.Repo.Booking(ctx, id)
		if errs.HasCode(err, errs.CodeNotFound) {
			return nil
		}
		if err != nil || !change(&b) {
			return err
		}
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		return h.saveBooking(ctx, &b, cat)
	})
}
