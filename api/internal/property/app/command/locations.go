package command

import (
	"context"
	"fmt"
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// CreateLocation adds a location; it needs master/create.
type CreateLocation struct{ Deps }

// Handle creates the location.
func (h CreateLocation) Handle(ctx context.Context, p auth.Principal, in domain.LocationInput) (domain.Location, error) {
	if err := h.Authz.Require(ctx, p.Role, masterCreate...); err != nil {
		return domain.Location{}, err
	}
	if err := domain.ValidateLocation(in); err != nil {
		return domain.Location{}, err
	}
	l := domain.NewLocation(ids.New("loc", in.Name), in)
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.InsertLocation(ctx, &l); err != nil {
			return err
		}
		if err := h.emit(ctx, property.EventLocationCreated, "location", l.ID, l.Version, property.LocationEvent{Location: locationState(l)}); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "location", EntityID: l.ID, Summary: fmt.Sprintf("Added location %s", l.Name)})
	})
	return l, err
}

// UpdateLocation edits a location; it needs master/edit, and a scoped user edits only locations
// on their list.
type UpdateLocation struct{ Deps }

// Handle edits the location.
func (h UpdateLocation) Handle(ctx context.Context, p auth.Principal, id string, in domain.LocationInput) (domain.Location, error) {
	if err := h.Authz.Require(ctx, p.Role, masterEdit...); err != nil {
		return domain.Location{}, err
	}
	if err := domain.ValidateLocation(in); err != nil {
		return domain.Location{}, err
	}
	var l domain.Location
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if l, err = h.Repo.Location(ctx, id); err != nil {
			return err
		}
		if p.Scope().Restricted() && !slices.Contains(p.LocationIDs, id) {
			return errs.Forbidden(fmt.Sprintf("%s is outside the locations you work with.", l.Name))
		}
		before := locationState(l)
		l.Apply(in)
		if err := h.Repo.UpdateLocation(ctx, &l); err != nil {
			return err
		}
		if err := h.emit(ctx, property.EventLocationUpdated, "location", l.ID, l.Version, property.LocationEvent{Location: locationState(l)}); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "location", EntityID: id, Summary: fmt.Sprintf("Edited location %s", l.Name), Before: before, After: locationState(l)})
	})
	return l, err
}
