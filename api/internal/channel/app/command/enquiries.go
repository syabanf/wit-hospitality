package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// SubmitEnquiry files a request to book, or an owner's note, from the public website. It needs no
// session; the audit names the guest. It holds no room: the reservations team answers.
type SubmitEnquiry struct{ Deps }

// Handle files the enquiry as New.
func (h SubmitEnquiry) Handle(ctx context.Context, in domain.EnquiryInput) (domain.Receipt, error) {
	var out domain.Receipt
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		groupVilla := ""
		if !in.Owner() && in.GroupID != nil && *in.GroupID != "" {
			var err error
			if groupVilla, err = h.Catalog.GroupVilla(ctx, *in.GroupID); err != nil {
				return err
			}
		}
		today := clock.Today(h.Clock)
		if err := domain.ValidateEnquiry(in, today, groupVilla); err != nil {
			return err
		}
		var villa *domain.Villa
		if !in.Owner() {
			var err error
			if villa, err = h.Catalog.Villa(ctx, in.VillaID); err != nil {
				return err
			}
			if villa == nil {
				return errs.NotFound("villa", in.VillaID)
			}
			open, err := h.Catalog.VillaTakesStays(ctx, villa.ID, in.GroupID)
			if err != nil {
				return err
			}
			if !open {
				return errs.Newf("SITE_VILLA_CLOSED", "%s is not taking stays at the moment.", villa.Name)
			}
		}
		seq, err := h.Repo.NextEnquirySeq(ctx)
		if err != nil {
			return err
		}
		e := domain.NewEnquiry(seq, in, today, clock.Stamp(h.Clock))
		if err := h.Repo.InsertEnquiry(ctx, &e); err != nil {
			return err
		}
		if err := h.enquiryEvent(ctx, channel.EventEnquiryReceived, e); err != nil {
			return err
		}
		summary := "Owner enquiry " + e.Number
		out = domain.Receipt{Number: e.Number, CheckIn: e.CheckIn, CheckOut: e.CheckOut}
		if villa != nil {
			summary = fmt.Sprintf("Web enquiry %s for %s", e.Number, villa.Name)
			out.VillaName = villa.Name
		}
		return h.record(ctx, guestActor, audit.Line{Action: audit.Create, Entity: "enquiry", EntityID: e.Number, Summary: summary})
	})
	return out, err
}

// enquiryInScope refuses an enquiry about a villa outside the user's scope. Owners write about
// villas the operator does not run yet, so everyone who answers enquiries may handle theirs.
func (d Deps) enquiryInScope(ctx context.Context, p auth.Principal, e domain.Enquiry) error {
	if e.Owner() || !p.Scope().Restricted() {
		return nil
	}
	v, err := d.Catalog.Villa(ctx, e.VillaID)
	if err != nil {
		return err
	}
	if v == nil || !p.Scope().AllowedVilla(v.ID, v.LocationID) {
		return errs.Forbidden(fmt.Sprintf("%s is about a villa outside the ones you work with.", e.Number))
	}
	return nil
}

// moveEnquiry applies a transition, saves it and appends the event and audit line.
func (d Deps) moveEnquiry(ctx context.Context, p auth.Principal, e *domain.Enquiry, to, note string) error {
	before := map[string]any{"status": e.Status}
	if err := e.Move(to, note, p.Name); err != nil {
		return err
	}
	if err := d.Repo.UpdateEnquiry(ctx, e); err != nil {
		return err
	}
	if err := d.enquiryEvent(ctx, channel.EventEnquiryUpdated, *e); err != nil {
		return err
	}
	return d.record(ctx, actorOf(p), audit.Line{
		Action: audit.Status, Entity: "enquiry", EntityID: e.Number,
		Summary: fmt.Sprintf("Marked %s %s", e.Number, strings.ToLower(domain.EnquiryStatusLabel[to])),
		Before:  before, After: map[string]any{"status": to, "note": e.StatusNote},
	})
}

// SetEnquiryStatus marks an enquiry contacted or closed, or picks a closed one up again; it needs
// booking/edit. Closing needs a reason.
type SetEnquiryStatus struct{ Deps }

// Handle moves the enquiry.
func (h SetEnquiryStatus) Handle(ctx context.Context, p auth.Principal, id, status, note string) (domain.Enquiry, error) {
	if err := h.allowEnquiries(ctx, p, "edit"); err != nil {
		return domain.Enquiry{}, err
	}
	var e domain.Enquiry
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if e, err = h.Repo.Enquiry(ctx, id); err != nil {
			return err
		}
		if err := h.enquiryInScope(ctx, p, e); err != nil {
			return err
		}
		if err := domain.ValidateStatusChange(status, note); err != nil {
			return err
		}
		return h.moveEnquiry(ctx, p, &e, status, note)
	})
	return e, err
}

// ConvertEnquiry links the booking made from an enquiry and marks it converted; it needs
// booking/edit. Reservation creates the booking; channel only asks it for the booking's code.
type ConvertEnquiry struct{ Deps }

// Handle converts the enquiry.
func (h ConvertEnquiry) Handle(ctx context.Context, p auth.Principal, id, bookingID string) (domain.Enquiry, error) {
	if err := h.allowEnquiries(ctx, p, "edit"); err != nil {
		return domain.Enquiry{}, err
	}
	var e domain.Enquiry
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if e, err = h.Repo.Enquiry(ctx, id); err != nil {
			return err
		}
		if err := h.enquiryInScope(ctx, p, e); err != nil {
			return err
		}
		code, found, err := h.Bookings.BookingCode(ctx, bookingID)
		if err != nil {
			return err
		}
		if !found {
			return errs.NotFound("booking", bookingID)
		}
		e.BookingID = &bookingID
		return h.moveEnquiry(ctx, p, &e, domain.EnquiryConverted, "Booked as "+code)
	})
	return e, err
}
