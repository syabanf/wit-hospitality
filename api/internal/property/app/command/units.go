package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// unitAudit is what the mock's audit line keeps of a unit, with the reason for its status.
type unitAudit struct {
	Status       string `json:"status"`
	StatusReason string `json:"statusReason,omitempty"`
	NightlyRate  int64  `json:"nightlyRate"`
	Name         string `json:"name"`
}

func unitAuditOf(u domain.Unit) unitAudit {
	return unitAudit{Status: u.Status, StatusReason: u.StatusReason, NightlyRate: u.NightlyRate, Name: u.Name}
}

// checkUnit validates the form against the stored codes and room types, and the reason a change
// of status from current carries.
func (d Deps) checkUnit(ctx context.Context, in domain.UnitInput, excludeID string, current domain.Unit) error {
	if err := current.CheckStatusChange(in, clock.Today(d.Clock)); err != nil {
		return err
	}
	taken, err := d.Repo.UnitCodeTaken(ctx, in.Code, excludeID)
	if err != nil {
		return err
	}
	var group *domain.UnitGroup
	if in.GroupID != nil && *in.GroupID != "" {
		if group, err = d.Repo.FindGroup(ctx, *in.GroupID); err != nil {
			return err
		}
	}
	return domain.ValidateUnit(in, taken, group)
}

// CreateUnit adds a unit; it needs master/create and the villa in scope. A unit that joins a room
// type without a rate plan starts the plan from its base price.
type CreateUnit struct{ Deps }

// Handle creates the unit.
func (h CreateUnit) Handle(ctx context.Context, p auth.Principal, in domain.UnitInput) (domain.Unit, error) {
	if err := h.Authz.Require(ctx, p.Role, masterCreate...); err != nil {
		return domain.Unit{}, err
	}
	var u domain.Unit
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.checkUnit(ctx, in, "", domain.Unit{}); err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, in.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		u = domain.NewUnit(domain.UnitID(in.Code), in)
		if err := h.checkPhotos(ctx, nil, u.Photos); err != nil {
			return err
		}
		if used, err := h.Repo.UnitIDTaken(ctx, u.ID); err != nil {
			return err
		} else if used {
			u.ID = ids.New("unit", in.Code)
		}
		if err := h.Repo.InsertUnit(ctx, &u); err != nil {
			return err
		}
		if err := h.unitEvent(ctx, property.EventUnitCreated, u, villa.LocationID); err != nil {
			return err
		}
		// A unit that starts out of service opens its history with the reason, from no status.
		if domain.OutOfService(u.Status) {
			if err := h.statusChanged(ctx, u, "", p.Name, villa); err != nil {
				return err
			}
		}
		if err := h.startPlan(ctx, p, u, villa); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "unit", EntityID: u.ID, Summary: fmt.Sprintf("Added unit %s", u.Code)})
	})
	return u, err
}

// UpdateUnit edits a unit; it needs master/edit or property/edit and the villa in scope. A unit
// with confirmed stays ahead cannot go inactive.
type UpdateUnit struct{ Deps }

// Handle edits the unit.
func (h UpdateUnit) Handle(ctx context.Context, p auth.Principal, id string, in domain.UnitInput) (domain.Unit, error) {
	if err := h.Authz.Require(ctx, p.Role, groupOrUnitEdit...); err != nil {
		return domain.Unit{}, err
	}
	var u domain.Unit
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if u, err = h.Repo.Unit(ctx, id); err != nil {
			return err
		}
		if err := h.checkUnit(ctx, in, id, u); err != nil {
			return err
		}
		current, err := h.Repo.Villa(ctx, u.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, current); err != nil {
			return err
		}
		villa := current
		if in.VillaID != u.VillaID {
			if villa, err = h.Repo.Villa(ctx, in.VillaID); err != nil {
				return err
			}
			if err := inScope(p, villa); err != nil {
				return err
			}
		}
		upcoming, err := h.Stays.HasUpcomingStays(ctx, id, clock.Today(h.Clock))
		if err != nil {
			return err
		}
		if err := u.CheckDeactivate(in.Status, upcoming); err != nil {
			return err
		}
		before, photos := unitAuditOf(u), u.Photos
		u.Apply(in)
		if err := h.checkPhotos(ctx, photos, u.Photos); err != nil {
			return err
		}
		if err := h.Repo.UpdateUnit(ctx, &u); err != nil {
			return err
		}
		if err := h.unitEvent(ctx, property.EventUnitUpdated, u, villa.LocationID); err != nil {
			return err
		}
		if before.Status != u.Status {
			if err := h.statusChanged(ctx, u, before.Status, p.Name, villa); err != nil {
				return err
			}
		}

		if err := h.startPlan(ctx, p, u, villa); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "unit", EntityID: id, Summary: fmt.Sprintf("Edited unit %s", u.Code), Before: before, After: unitAuditOf(u)})
	})
	return u, err
}
