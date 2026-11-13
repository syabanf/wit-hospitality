package command

import (
	"context"
	"fmt"
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// CreateProperty is the New property wizard: the villa, its room types (see WizardTypes) with
// their rate plans, and the rooms, all or nothing. It needs master/create.
type CreateProperty struct{ Deps }

// Handle saves the wizard and returns the new villa.
func (h CreateProperty) Handle(ctx context.Context, p auth.Principal, in domain.PropertyInput) (domain.Villa, error) {
	if err := h.Authz.Require(ctx, p.Role, masterCreate...); err != nil {
		return domain.Villa{}, err
	}
	var villa domain.Villa
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		villaTaken, err := h.Repo.VillaCodeTaken(ctx, in.Villa.Code, "")
		if err != nil {
			return err
		}
		taken := map[string]bool{}
		for _, r := range in.Rooms {
			if _, seen := taken[r.Code]; seen {
				continue
			}
			if taken[r.Code], err = h.Repo.UnitCodeTaken(ctx, r.Code, ""); err != nil {
				return err
			}
		}
		if err := domain.ValidateProperty(in, villaTaken, func(code string) bool { return taken[code] }); err != nil {
			return err
		}
		if _, err := h.Repo.Location(ctx, in.Villa.LocationID); err != nil {
			return err
		}
		villa = domain.NewVilla(ids.New("vil", in.Villa.Name), in.Villa)
		if err := inScope(p, villa); err != nil {
			return err
		}
		if err := h.checkPhotos(ctx, nil, villa.Photos); err != nil {
			return err
		}
		for _, r := range in.Rooms {
			if err := h.checkPhotos(ctx, nil, r.Photos); err != nil {
				return err
			}
		}
		if err := h.Repo.InsertVilla(ctx, &villa); err != nil {
			return err
		}
		if err := h.villaEvent(ctx, property.EventVillaCreated, villa); err != nil {
			return err
		}
		created := property.PropertyCreated{VillaID: villa.ID, GroupIDs: []string{}, UnitIDs: []string{}, LocationID: villa.LocationID, MinStays: []property.MinStay{}}
		groupOf := map[int]string{}
		for _, t := range domain.WizardTypes(in) {
			g := domain.UnitGroup{ID: ids.New("grp", t.Name), VillaID: villa.ID, Name: t.Name, Interchangeable: t.Interchangeable, OperatorAssigns: t.OperatorAssigns, Kind: t.Kind}
			if err := h.Repo.InsertGroup(ctx, &g); err != nil {
				return err
			}
			if err := h.groupEvent(ctx, property.EventGroupCreated, g, villa.LocationID); err != nil {
				return err
			}
			plan := t.Plan.Plan(g.ID)
			if err := h.Repo.SaveRatePlan(ctx, &plan); err != nil {
				return err
			}
			if err := h.planEvent(ctx, plan, villa); err != nil {
				return err
			}
			for _, j := range t.Rooms {
				groupOf[j] = g.ID
			}
			created.GroupIDs = append(created.GroupIDs, g.ID)
			created.MinStays = append(created.MinStays, property.MinStay{GroupID: g.ID, Kind: g.Kind, Nights: t.MinStay})
		}
		for i, r := range in.Rooms {
			group := groupOf[i]
			u := domain.NewUnit(domain.UnitID(r.Code), r.Unit(villa.ID, &group))

			if used, err := h.Repo.UnitIDTaken(ctx, u.ID); err != nil {
				return err
			} else if used || slices.Contains(created.UnitIDs, u.ID) {
				u.ID = ids.New("unit", r.Code)
			}
			if err := h.Repo.InsertUnit(ctx, &u); err != nil {
				return err
			}
			if err := h.unitEvent(ctx, property.EventUnitCreated, u, villa.LocationID); err != nil {
				return err
			}
			created.UnitIDs = append(created.UnitIDs, u.ID)
		}
		if err := h.emit(ctx, property.EventPropertyCreated, "villa", villa.ID, villa.Version, created); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "villa", EntityID: villa.ID, Summary: fmt.Sprintf("Added villa %s with %d units", villa.Name, len(in.Rooms))})
	})
	return villa, err
}
