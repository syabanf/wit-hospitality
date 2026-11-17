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

// SaveSection adds a section (id "") or edits one; it needs property/edit and the villa in scope.
type SaveSection struct{ Deps }

// sectionRooms is the villa's units as the section rules read them, each with its kind.
func (d Deps) sectionRooms(ctx context.Context, villa domain.Villa) (map[string]domain.SectionRoom, error) {
	groups, err := d.Repo.VillaGroups(ctx, villa.ID)
	if err != nil {
		return nil, err
	}
	kinds := map[string]string{}
	for _, g := range groups {
		kinds[g.ID] = g.Kind
	}
	units, err := d.Repo.VillaUnits(ctx, villa.ID)
	if err != nil {
		return nil, err
	}
	rooms := map[string]domain.SectionRoom{}
	for _, u := range units {
		kind := domain.DefaultKind(villa.Operation)
		if u.GroupID != nil && kinds[*u.GroupID] != "" {
			kind = kinds[*u.GroupID]
		}
		rooms[u.ID] = domain.SectionRoom{ID: u.ID, Code: u.Code, VillaID: u.VillaID, Kind: kind}
	}
	return rooms, nil
}

// Handle saves the section.
func (h SaveSection) Handle(ctx context.Context, p auth.Principal, id string, in domain.SectionInput) (domain.Section, error) {
	if err := h.Authz.Require(ctx, p.Role, propertyEdit...); err != nil {
		return domain.Section{}, err
	}
	var s domain.Section
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var current *domain.Section
		villaID := in.VillaID
		if id != "" {
			found, err := h.Repo.Section(ctx, id)
			if err != nil {
				return err
			}
			current, s, villaID = &found, found, found.VillaID
		}
		villa, err := h.Repo.Villa(ctx, villaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		all, err := h.Repo.VillaSections(ctx, villa.ID)
		if err != nil {
			return err
		}
		var others []domain.Section
		for _, o := range all {
			if o.ID != id {
				others = append(others, o)
			}
		}
		rooms, err := h.sectionRooms(ctx, villa)
		if err != nil {
			return err
		}
		if err := domain.ValidateSection(in, villa, rooms, others, current); err != nil {
			return err
		}
		before := domain.SectionState(s)
		s.Apply(in)
		line := audit.Line{Entity: "section"}
		if current == nil {
			s.ID = ids.New("sec", s.Name)
			if err := h.Repo.InsertSection(ctx, &s); err != nil {
				return err
			}
			line.Action, line.Summary = audit.Create, fmt.Sprintf("Added section %s to %s: %d rooms", s.Name, villa.Name, len(s.UnitIDs))
		} else {
			if err := h.Repo.UpdateSection(ctx, &s); err != nil {
				return err
			}
			line.Action, line.Summary, line.Before = audit.Update, fmt.Sprintf("Changed section %s of %s: %d rooms", s.Name, villa.Name, len(s.UnitIDs)), before
		}
		line.EntityID, line.After = s.ID, domain.SectionState(s)
		if err := h.emit(ctx, property.EventSectionSaved, "section", s.ID, s.Version, property.SectionSaved{Section: domain.SectionState(s), LocationID: villa.LocationID}); err != nil {
			return err
		}
		return h.record(ctx, p, line)
	})
	return s, err
}

// RemoveSection deletes a section; it needs property/edit and the villa in scope.
type RemoveSection struct{ Deps }

// Handle removes the section.
func (h RemoveSection) Handle(ctx context.Context, p auth.Principal, id string) error {
	if err := h.Authz.Require(ctx, p.Role, propertyEdit...); err != nil {
		return err
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		s, err := h.Repo.Section(ctx, id)
		if err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, s.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		if err := h.Repo.DeleteSection(ctx, id); err != nil {
			return err
		}
		if err := h.emit(ctx, property.EventSectionRemoved, "section", id, s.Version+1, property.SectionRemoved{ID: id, VillaID: villa.ID, LocationID: villa.LocationID}); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Delete, Entity: "section", EntityID: id, Summary: fmt.Sprintf("Removed section %s from %s", s.Name, villa.Name), Before: domain.SectionState(s)})
	})
}
