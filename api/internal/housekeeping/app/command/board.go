package command

import (
	"context"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// boardRecord loads a unit's record with a lock, or the mock's default: ready, as of today.
func (d Deps) boardRecord(ctx context.Context, p auth.Principal, unitID string) (domain.Record, error) {
	r, ok, err := d.Store.Record(ctx, unitID)
	if err != nil || ok {
		return r, err
	}
	return domain.Record{UnitID: unitID, State: domain.Ready, UpdatedOn: d.today(), UpdatedBy: p.Name}, nil
}

// saveMove saves the record and, when its state moved, appends room.state_changed and, for a room
// turning ready, room.released.
func (d Deps) saveMove(ctx context.Context, p auth.Principal, r *domain.Record, unit domain.Unit, villa domain.Villa, from string) error {
	if err := d.Store.SaveRecord(ctx, r, unit.VillaID); err != nil {
		return err
	}
	if r.State == from {
		return nil
	}
	if err := d.emit(ctx, housekeeping.EventRoomStateChanged, "housekeeping_record", unit.ID, r.Version, housekeeping.RoomState{
		UnitID: unit.ID, VillaID: unit.VillaID, LocationID: villa.LocationID, From: from, To: r.State, On: r.UpdatedOn, By: r.UpdatedBy, Note: r.Note,
	}); err != nil {
		return err
	}
	if r.State != domain.Ready {
		return nil
	}
	return d.emit(ctx, housekeeping.EventRoomReleased, "housekeeping_record", unit.ID, r.Version, housekeeping.RoomReleased{
		UnitID: unit.ID, UnitCode: unit.Code, GroupID: unit.GroupID, VillaID: unit.VillaID, LocationID: villa.LocationID, On: r.UpdatedOn, By: p.Name, ByID: p.UserID,
	})
}

// unitPlace loads a unit and its villa, refusing one outside the caller's scope.
func (d Deps) unitPlace(ctx context.Context, p auth.Principal, unitID string) (domain.Unit, domain.Villa, error) {
	unit, err := d.Store.Unit(ctx, unitID)
	if err != nil {
		return unit, domain.Villa{}, err
	}
	villa, err := d.villaInScope(ctx, p, unit.VillaID)
	return unit, villa, err
}

// SetState moves a unit on the board. Turning ready asks inventory for the amenity kit through
// room.released; the mock's note about a short store comes from inventory now.
type SetState struct{ Deps }

// Handle moves the unit.
func (h SetState) Handle(ctx context.Context, p auth.Principal, unitID, state, note string) (domain.Record, error) {
	var r domain.Record
	if err := h.need(ctx, p, "edit"); err != nil {
		return r, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		unit, villa, err := h.unitPlace(ctx, p, unitID)
		if err != nil {
			return err
		}
		if r, err = h.boardRecord(ctx, p, unitID); err != nil {
			return err
		}
		if err := domain.AssertMove(r, unit.Code, state); err != nil {
			return err
		}
		before := r.State
		r.State, r.UpdatedOn, r.UpdatedBy, r.Note = state, h.today(), p.Name, strings.TrimSpace(note)
		if err := h.saveMove(ctx, p, &r, unit, villa, before); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "housekeeping", EntityID: unit.Code, Summary: unit.Code + " " + before + " to " + state,
			Before: map[string]any{"state": before}, After: map[string]any{"state": state}})
	})
	return r, err
}

// InspectInput is the body of POST housekeeping/{unitId}/inspections.
type InspectInput struct {
	Results        []domain.InspectionResult `json:"results"`
	RaiseWorkOrder bool                      `json:"raiseWorkOrder"`
}

// InspectResult answers an inspection: the record and the work order a failure raised, if any.
type InspectResult struct {
	Record    domain.Record `json:"record"`
	WorkOrder *WorkOrderRef `json:"workOrder"`
}

// Inspect records the supervisor's inspection; a failure sends the room to dirty and can raise a
// work order through maintenance.
type Inspect struct{ Deps }

// Handle inspects the unit.
func (h Inspect) Handle(ctx context.Context, p auth.Principal, unitID string, in InspectInput) (InspectResult, error) {
	var out InspectResult
	if err := h.need(ctx, p, "edit"); err != nil {
		return out, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		unit, villa, err := h.unitPlace(ctx, p, unitID)
		if err != nil {
			return err
		}
		r, err := h.boardRecord(ctx, p, unitID)
		if err != nil {
			return err
		}
		before := r.State
		if err := domain.Inspect(&r, unit.Code, in.Results, h.today(), p.Name); err != nil {
			return err
		}
		if err := h.saveMove(ctx, p, &r, unit, villa, before); err != nil {
			return err
		}
		out.Record = r
		failed := domain.Failed(in.Results)
		if in.RaiseWorkOrder && len(failed) > 0 {
			labels := make([]string, len(failed))
			for i, f := range failed {
				labels[i] = domain.InspectionLabel[f.Item]
			}
			first := failed[0].Item
			w, err := h.Clients.WorkOrders.Open(ctx, p, NewWorkOrder{VillaID: unit.VillaID, UnitID: unit.ID, Source: "inspection", Category: domain.InspectionCategory[first],
				Priority: "normal", Title: "Inspection " + unit.Code + ": " + strings.ToLower(domain.InspectionLabel[first]), Description: strings.Join(labels, " · ")})
			if err != nil {
				return err
			}
			out.WorkOrder = &w
		}
		summary := unit.Code + " passed inspection"
		if len(failed) > 0 {
			summary = unit.Code + " failed inspection"
		}
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "housekeeping", EntityID: unit.Code, Summary: summary})
	})
	return out, err
}

// CheckedOut is the reaction to reservation's check-out: the room goes to dirty when it may.
type CheckedOut struct{ Deps }

// Handle marks the unit dirty after the stay left. It runs inside the projector's transaction.
func (h CheckedOut) Handle(ctx context.Context, unitID, code, by string) error {
	unit, err := h.Store.Unit(ctx, unitID)
	if err != nil {
		return err
	}
	villa, err := h.Store.Villa(ctx, unit.VillaID)
	if err != nil {
		return err
	}
	actor := auth.Principal{Name: by}
	r, err := h.boardRecord(ctx, actor, unitID)
	if err != nil {
		return err
	}
	if r.State != domain.Dirty && !domain.CanMove(r.State, domain.Dirty) {
		return nil
	}
	before := r.State
	r.State, r.UpdatedOn, r.UpdatedBy, r.Note = domain.Dirty, h.today(), by, "Checked out "+code
	return h.saveMove(ctx, actor, &r, unit, villa, before)
}
