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

// CreateGroup adds a room type; it needs master/create and the villa in scope.
type CreateGroup struct{ Deps }

// Handle creates the room type.
func (h CreateGroup) Handle(ctx context.Context, p auth.Principal, in domain.GroupInput) (domain.UnitGroup, error) {
	if err := h.Authz.Require(ctx, p.Role, masterCreate...); err != nil {
		return domain.UnitGroup{}, err
	}
	if err := domain.ValidateGroup(in); err != nil {
		return domain.UnitGroup{}, err
	}
	var g domain.UnitGroup
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		villa, err := h.Repo.Villa(ctx, in.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		g = domain.NewGroup(ids.New("grp", in.Name), in)
		if err := h.Repo.InsertGroup(ctx, &g); err != nil {
			return err
		}
		if err := h.groupEvent(ctx, property.EventGroupCreated, g, villa.LocationID); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "unit_group", EntityID: g.ID, Summary: fmt.Sprintf("Added room type %s", g.Name)})
	})
	return g, err
}

// UpdateGroup edits a room type; it needs master/edit or property/edit (the room type page toggles
// selling by room type with property/edit). Selling by room type cannot stop while stays booked
// against the room type still wait for a room.
type UpdateGroup struct{ Deps }

// Handle edits the room type.
func (h UpdateGroup) Handle(ctx context.Context, p auth.Principal, id string, in domain.GroupInput) (domain.UnitGroup, error) {
	if err := h.Authz.Require(ctx, p.Role, groupOrUnitEdit...); err != nil {
		return domain.UnitGroup{}, err
	}
	if err := domain.ValidateGroup(in); err != nil {
		return domain.UnitGroup{}, err
	}
	var g domain.UnitGroup
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if g, err = h.Repo.Group(ctx, id); err != nil {
			return err
		}
		current, err := h.Repo.Villa(ctx, g.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, current); err != nil {
			return err
		}
		villa := current
		if in.VillaID != g.VillaID {
			if villa, err = h.Repo.Villa(ctx, in.VillaID); err != nil {
				return err
			}
			if err := inScope(p, villa); err != nil {
				return err
			}
		}
		waiting, err := h.Stays.WaitingForRoom(ctx, id)
		if err != nil {
			return err
		}
		if err := g.CheckRoomTypeSelling(in, waiting); err != nil {
			return err
		}
		before := groupState(g)
		g.Apply(in)
		if err := h.Repo.UpdateGroup(ctx, &g); err != nil {
			return err
		}
		if err := h.groupEvent(ctx, property.EventGroupUpdated, g, villa.LocationID); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "unit_group", EntityID: id, Summary: fmt.Sprintf("Edited room type %s", g.Name), Before: before, After: groupState(g)})
	})
	return g, err
}
