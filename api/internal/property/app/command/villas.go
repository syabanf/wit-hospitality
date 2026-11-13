package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// CreateVilla adds a villa without rooms; it needs master/create.
type CreateVilla struct{ Deps }

// Handle creates the villa.
func (h CreateVilla) Handle(ctx context.Context, p auth.Principal, in domain.VillaInput) (domain.Villa, error) {
	if err := h.Authz.Require(ctx, p.Role, masterCreate...); err != nil {
		return domain.Villa{}, err
	}
	var v domain.Villa
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.VillaCodeTaken(ctx, in.Code, "")
		if err != nil {
			return err
		}
		if err := domain.ValidateVilla(in, taken); err != nil {
			return err
		}
		if _, err := h.Repo.Location(ctx, in.LocationID); err != nil {
			return err
		}
		v = domain.NewVilla(ids.New("vil", in.Name), in)
		if err := inScope(p, v); err != nil {
			return err
		}
		if err := h.checkPhotos(ctx, nil, v.Photos); err != nil {
			return err
		}
		if err := h.Repo.InsertVilla(ctx, &v); err != nil {
			return err
		}
		if err := h.villaEvent(ctx, property.EventVillaCreated, v); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "villa", EntityID: v.ID, Summary: fmt.Sprintf("Added villa %s", v.Name)})
	})
	return v, err
}

// UpdateVilla edits a villa; it needs master/edit and the villa in scope.
type UpdateVilla struct{ Deps }

// Handle edits the villa.
func (h UpdateVilla) Handle(ctx context.Context, p auth.Principal, id string, in domain.VillaInput) (domain.Villa, error) {
	if err := h.Authz.Require(ctx, p.Role, masterEdit...); err != nil {
		return domain.Villa{}, err
	}
	var v domain.Villa
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.VillaCodeTaken(ctx, in.Code, id)
		if err != nil {
			return err
		}
		if v, err = h.Repo.Villa(ctx, id); err != nil {
			return err
		}
		in.OperatingInput = in.OperatingInput.Keeping(v.Operating)
		if err := domain.ValidateVilla(in, taken); err != nil {
			return err
		}
		if err := inScope(p, v); err != nil {
			return err
		}
		if in.LocationID != v.LocationID {
			if _, err := h.Repo.Location(ctx, in.LocationID); err != nil {
				return err
			}
		}
		before := domain.VillaState(v)
		current := v.Photos
		v.Apply(in)
		if err := h.checkPhotos(ctx, current, v.Photos); err != nil {
			return err
		}
		if err := h.Repo.UpdateVilla(ctx, &v); err != nil {
			return err
		}
		if err := h.villaEvent(ctx, property.EventVillaUpdated, v); err != nil {
			return err
		}
		if err := h.fitGroupKinds(ctx, v); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "villa", EntityID: id, Summary: fmt.Sprintf("Edited villa %s", v.Name), Before: before, After: domain.VillaState(v)})
	})
	return v, err
}

// fitGroupKinds gives the villa's room types the kind its operation takes: rooms in a hotel,
// villas in a villa.
func (d Deps) fitGroupKinds(ctx context.Context, v domain.Villa) error {
	groups, err := d.Repo.VillaGroups(ctx, v.ID)
	if err != nil {
		return err
	}
	for _, g := range groups {
		kind := domain.FitKind(g.Kind, v.Operation)
		if kind == g.Kind {
			continue
		}
		g.Kind = kind
		if err := d.Repo.UpdateGroup(ctx, &g); err != nil {
			return err
		}
		if err := d.groupEvent(ctx, property.EventGroupUpdated, g, v.LocationID); err != nil {
			return err
		}
	}
	return nil
}
