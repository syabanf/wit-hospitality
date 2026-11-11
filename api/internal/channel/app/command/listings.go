package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
)

type listingAudit struct {
	AccountID string `json:"accountId"`
	UnitID    string `json:"unitId"`
	Title     string `json:"title"`
	AirbnbID  string `json:"airbnbId"`
	Status    string `json:"status"`
}

func listingAuditOf(l domain.Listing) listingAudit {
	return listingAudit{AccountID: l.AccountID, UnitID: l.UnitID, Title: l.Title, AirbnbID: l.AirbnbID, Status: l.Status}
}

// checkListing validates the form against the listings on file and checks the account exists.
func (d Deps) checkListing(ctx context.Context, in domain.ListingInput, excludeID string) error {
	unitTaken, err := d.Repo.ListingUnitTaken(ctx, in.UnitID, excludeID)
	if err != nil {
		return err
	}
	idTaken, err := d.Repo.ListingAirbnbIDTaken(ctx, in.AirbnbID, excludeID)
	if err != nil {
		return err
	}
	if err := domain.ValidateListing(in, unitTaken, idTaken); err != nil {
		return err
	}
	_, err = d.Repo.Account(ctx, in.AccountID)
	return err
}

// CreateListing adds the one listing a unit may have; it needs airbnb/create and the unit's villa
// in scope. The listing starts with no date prices: every night sells at the unit's base rate.
type CreateListing struct{ Deps }

// Handle creates the listing.
func (h CreateListing) Handle(ctx context.Context, p auth.Principal, in domain.ListingInput) (domain.Listing, error) {
	if err := h.Authz.Require(ctx, p.Role, airbnbCreate...); err != nil {
		return domain.Listing{}, err
	}
	var l domain.Listing
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.checkListing(ctx, in, ""); err != nil {
			return err
		}
		u, err := h.unitInScope(ctx, p, in.UnitID)
		if err != nil {
			return err
		}
		l = domain.NewListing(domain.ListingID(u.Code), in)
		if used, err := h.Repo.ListingIDTaken(ctx, l.ID); err != nil {
			return err
		} else if used {
			l.ID = ids.New("lst", u.Code)
		}
		if err := h.Repo.InsertListing(ctx, &l); err != nil {
			return err
		}
		if err := h.listingEvent(ctx, channel.EventListingCreated, l, u); err != nil {
			return err
		}
		return h.record(ctx, actorOf(p), audit.Line{Action: audit.Create, Entity: "listing", EntityID: l.ID, Summary: fmt.Sprintf("Listed %s on Airbnb as %s", u.Code, l.AirbnbID)})
	})
	return l, err
}

// UpdateListing edits a listing; it needs airbnb/edit and the villas of the old and new unit in
// scope.
type UpdateListing struct{ Deps }

// Handle edits the listing.
func (h UpdateListing) Handle(ctx context.Context, p auth.Principal, id string, in domain.ListingInput) (domain.Listing, error) {
	if err := h.Authz.Require(ctx, p.Role, airbnbEdit...); err != nil {
		return domain.Listing{}, err
	}
	var l domain.Listing
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.checkListing(ctx, in, id); err != nil {
			return err
		}
		var err error
		if l, err = h.Repo.Listing(ctx, id); err != nil {
			return err
		}
		u, err := h.unitInScope(ctx, p, l.UnitID)
		if err != nil {
			return err
		}
		if in.UnitID != l.UnitID {
			if u, err = h.unitInScope(ctx, p, in.UnitID); err != nil {
				return err
			}
		}
		before := listingAuditOf(l)
		l.Apply(in)
		if err := h.Repo.UpdateListing(ctx, &l); err != nil {
			return err
		}
		if err := h.listingEvent(ctx, channel.EventListingUpdated, l, u); err != nil {
			return err
		}
		return h.record(ctx, actorOf(p), audit.Line{Action: audit.Update, Entity: "listing", EntityID: l.ID, Summary: fmt.Sprintf("Edited the %s listing", u.Code), Before: before, After: listingAuditOf(l)})
	})
	return l, err
}

// SetListingStatus takes a listing live or pauses it; it needs airbnb/edit and the villa in scope.
// A paused listing stops pricing direct stays: they fall back to the room type's rate plan.
type SetListingStatus struct{ Deps }

// Handle switches the status.
func (h SetListingStatus) Handle(ctx context.Context, p auth.Principal, id, status string) (domain.Listing, error) {
	if err := h.Authz.Require(ctx, p.Role, airbnbEdit...); err != nil {
		return domain.Listing{}, err
	}
	if err := domain.ValidateListingStatus(status); err != nil {
		return domain.Listing{}, err
	}
	var l domain.Listing
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if l, err = h.Repo.Listing(ctx, id); err != nil {
			return err
		}
		u, err := h.unitInScope(ctx, p, l.UnitID)
		if err != nil {
			return err
		}
		before := map[string]any{"status": l.Status}
		l.Status = status
		if err := h.Repo.UpdateListing(ctx, &l); err != nil {
			return err
		}
		if err := h.listingEvent(ctx, channel.EventListingUpdated, l, u); err != nil {
			return err
		}
		label := map[string]string{domain.StatusActive: "live", domain.StatusPaused: "paused"}[status]
		return h.record(ctx, actorOf(p), audit.Line{Action: audit.Status, Entity: "listing", EntityID: l.ID, Summary: fmt.Sprintf("Set the %s listing %s", u.Code, label), Before: before, After: map[string]any{"status": status}})
	})
	return l, err
}

// SetListingPrices sets the base rate and per-night prices; it needs airbnb/edit and the villa in
// scope. The base rate is the unit's nightly rate, which property owns: the listing.priced event
// carries it and property's policy moves the unit to it, so the unit, new direct stays and the
// listing read one price list. Stays already booked keep the nights they were sold at.
type SetListingPrices struct{ Deps }

// Handle saves the prices.
func (h SetListingPrices) Handle(ctx context.Context, p auth.Principal, id string, in domain.PriceInput) (domain.Listing, error) {
	if err := h.Authz.Require(ctx, p.Role, airbnbEdit...); err != nil {
		return domain.Listing{}, err
	}
	if err := domain.ValidatePrice(in); err != nil {
		return domain.Listing{}, err
	}
	var l domain.Listing
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if l, err = h.Repo.Listing(ctx, id); err != nil {
			return err
		}
		u, err := h.unitInScope(ctx, p, l.UnitID)
		if err != nil {
			return err
		}
		base := l.ApplyPrices(in)
		if err := h.Repo.UpdateListing(ctx, &l); err != nil {
			return err
		}
		if err := h.emit(ctx, channel.EventListingPriced, "listing", l.ID, l.Version, channel.ListingPriced{Listing: ListingState(l), BaseRate: base, VillaID: u.VillaID, LocationID: u.LocationID}); err != nil {
			return err
		}
		return h.record(ctx, actorOf(p), audit.Line{
			Action: audit.Update, Entity: "listing", EntityID: l.ID,
			Summary: fmt.Sprintf("Priced %s: base %d, %d nights changed", u.Code, base, len(in.DateRates)),
			Before:  map[string]any{"baseRate": u.NightlyRate}, After: map[string]any{"baseRate": base},
		})
	})
	return l, err
}
