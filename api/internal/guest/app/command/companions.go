package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func (d Deps) companionEvent(ctx context.Context, eventType string, c domain.Companion, villaID string) error {
	return d.emit(ctx, eventType, "companion", c.ID, c.Version, guest.CompanionEvent{ID: c.ID, BookingID: c.BookingID, Name: c.Name, Adult: c.Adult, VillaID: villaID})
}

// openStay loads the companion's stay in scope and refuses a closed one.
func (d Deps) openStay(ctx context.Context, p auth.Principal, bookingID string) (domain.Stay, domain.VillaRef, error) {
	s, v, err := d.stayInScope(ctx, p, bookingID)
	if err != nil {
		return s, v, err
	}
	if s.Closed() {
		return s, v, domain.ErrStayClosed(s.Code)
	}
	return s, v, nil
}

// AddCompanion registers another person on a stay; it needs guest/edit and an open stay in scope.
type AddCompanion struct{ Deps }

// Handle adds the companion.
func (h AddCompanion) Handle(ctx context.Context, p auth.Principal, bookingID string, in domain.CompanionInput) (domain.Companion, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.Companion{}, err
	}
	if err := domain.ValidateCompanion(in); err != nil {
		return domain.Companion{}, err
	}
	var c domain.Companion
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		stay, villa, err := h.openStay(ctx, p, bookingID)
		if err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "companion")
		if err != nil {
			return err
		}
		c = domain.Companion{ID: fmt.Sprintf("cmp-%d", n), BookingID: stay.ID}
		c.Apply(in)
		if err := h.Repo.InsertCompanion(ctx, &c); err != nil {
			return err
		}
		if err := h.companionEvent(ctx, guest.EventCompanionAdded, c, villa.ID); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "companion", EntityID: c.ID, Summary: fmt.Sprintf("Registered %s on %s", c.Name, stay.Code)})
	})
	return c, err
}

// UpdateCompanion edits a companion; it needs guest/edit and an open stay in scope.
type UpdateCompanion struct{ Deps }

// Handle edits the companion.
func (h UpdateCompanion) Handle(ctx context.Context, p auth.Principal, id string, in domain.CompanionInput) (domain.Companion, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.Companion{}, err
	}
	if err := domain.ValidateCompanion(in); err != nil {
		return domain.Companion{}, err
	}
	var c domain.Companion
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if c, err = h.Repo.Companion(ctx, id); err != nil {
			return err
		}
		_, villa, err := h.openStay(ctx, p, c.BookingID)
		if err != nil {
			return err
		}
		c.Apply(in)
		if err := h.Repo.UpdateCompanion(ctx, &c); err != nil {
			return err
		}
		if err := h.companionEvent(ctx, guest.EventCompanionUpdated, c, villa.ID); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "companion", EntityID: id, Summary: "Edited companion " + c.Name})
	})
	return c, err
}

// RemoveCompanion takes a companion off a stay; it needs guest/edit and an open stay in scope.
type RemoveCompanion struct{ Deps }

// Handle removes the companion.
func (h RemoveCompanion) Handle(ctx context.Context, p auth.Principal, id string) error {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return err
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		c, err := h.Repo.Companion(ctx, id)
		if err != nil {
			return err
		}
		stay, _, err := h.openStay(ctx, p, c.BookingID)
		if err != nil {
			return err
		}
		if err := h.Repo.DeleteCompanion(ctx, id); err != nil {
			return err
		}
		if err := h.emit(ctx, guest.EventCompanionRemoved, "companion", id, c.Version+1, guest.CompanionRemoved{ID: id, BookingID: c.BookingID}); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Delete, Entity: "companion", EntityID: id, Summary: fmt.Sprintf("Removed %s from %s", c.Name, stay.Code)})
	})
}

// MarkReported records that the desk sent people on a stay to Immigration; it needs guest/edit and
// a stay in scope that has checked in.
type MarkReported struct{ Deps }

// Handle writes one report line per person not reported yet.
func (h MarkReported) Handle(ctx context.Context, p auth.Principal, in domain.ReportInput) ([]domain.ForeignReport, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return nil, err
	}
	var lines []domain.ForeignReport
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		stay, villa, err := h.stayInScope(ctx, p, in.BookingID)
		if err != nil {
			return err
		}
		if !stay.Started() {
			return errs.Newf("BOOKING_INVALID_STATE", "%s has not checked in; report the guests once they arrive.", stay.Code)
		}
		companions, err := h.Repo.CompanionsOf(ctx, stay.ID)
		if err != nil {
			return err
		}
		onStay := []string{stay.GuestID}
		for _, c := range companions {
			onStay = append(onStay, c.ID)
		}
		for _, id := range in.PersonIDs {
			if !slices.Contains(onStay, id) {
				return errs.Newf(errs.CodeValidation, "%s is not registered on %s.", id, stay.Code)
			}
		}
		done, err := h.Repo.ReportedPeople(ctx, stay.ID)
		if err != nil {
			return err
		}
		var fresh []string
		for _, id := range in.PersonIDs {
			if !slices.Contains(done, id) && !slices.Contains(fresh, id) {
				fresh = append(fresh, id)
			}
		}
		if len(fresh) == 0 {
			return errs.Newf("ALREADY_REPORTED", "Everyone picked on %s is already reported.", stay.Code)
		}
		reference, at := strings.TrimSpace(in.Reference), h.now()
		ids := make([]string, 0, len(fresh))
		for _, person := range fresh {
			n, err := h.Repo.Next(ctx, "foreignReport")
			if err != nil {
				return err
			}
			line := domain.ForeignReport{ID: fmt.Sprintf("fr-%d", n), BookingID: stay.ID, PersonID: person, ReportedAt: at, ReportedBy: p.Name, Reference: reference}
			if err := h.Repo.InsertReport(ctx, line); err != nil {
				return err
			}
			lines, ids = append(lines, line), append(ids, line.ID)
		}
		if err := h.emit(ctx, guest.EventGuestsReported, "stay", stay.ID, 1, guest.GuestsReported{BookingID: stay.ID, PersonIDs: fresh, ReportIDs: ids, Reference: reference, ReportedAt: at, VillaID: villa.ID}); err != nil {
			return err
		}
		plural := "s"
		if len(lines) == 1 {
			plural = ""
		}
		ref := ""
		if reference != "" {
			ref = ", " + reference
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "foreign-report", EntityID: stay.Code, Summary: fmt.Sprintf("Reported %d foreign guest%s on %s to Immigration%s", len(lines), plural, stay.Code, ref)})
	})
	return lines, err
}
