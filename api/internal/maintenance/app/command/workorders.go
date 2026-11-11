package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// open creates the work order inside the caller's transaction, as the mock's newWorkOrder does.
func (d Deps) open(ctx context.Context, p auth.Principal, in domain.NewInput, reportedBy string, villa Villa) (domain.WorkOrder, error) {
	n, err := d.Repo.Next(ctx, "workOrder")
	if err != nil {
		return domain.WorkOrder{}, err
	}
	w := domain.NewWorkOrder(fmt.Sprintf("wo-%d", n), fmt.Sprintf("WO-%d", 500+n), in, reportedBy, p.Name, d.today())
	if in.BlockFrom != nil && in.BlockTo != nil && *in.BlockFrom != "" && *in.BlockTo != "" {
		if err := d.hold(ctx, &w, *in.BlockFrom, *in.BlockTo); err != nil {
			return w, err
		}
		w.Log("blocked", p.Name, d.today(), *in.BlockFrom+" to "+*in.BlockTo)
	}
	if err := d.Repo.InsertWorkOrder(ctx, &w); err != nil {
		return w, err
	}
	if err := d.saved(ctx, w, villa.LocationID); err != nil {
		return w, err
	}
	return w, d.record(ctx, p, audit.Line{Action: audit.Create, Entity: "work-order", EntityID: w.Number, Summary: fmt.Sprintf("Opened %s, %s", w.Number, w.Title)})
}

// CreateWorkOrder opens a job; it needs maintenance/create and the villa in scope. A job on a unit
// may block the unit at once.
type CreateWorkOrder struct{ Deps }

// Handle opens the work order.
func (h CreateWorkOrder) Handle(ctx context.Context, p auth.Principal, in domain.NewInput) (domain.WorkOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, needCreate); err != nil {
		return domain.WorkOrder{}, err
	}
	if err := domain.ValidateWorkOrder(in.Input); err != nil {
		return domain.WorkOrder{}, err
	}
	var w domain.WorkOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		villa, err := h.villaInScope(ctx, p, in.VillaID)
		if err != nil {
			return err
		}
		if in.UnitID != nil && *in.UnitID != "" {
			unit, err := h.Repo.Unit(ctx, *in.UnitID)
			if err != nil {
				return err
			}
			if unit.VillaID != in.VillaID {
				return errs.New(errs.CodeValidation, "The unit belongs to another villa.")
			}
		}
		w, err = h.open(ctx, p, in, p.Name, villa)
		return err
	})
	return w, err
}

// UpdateWorkOrder edits a job; it needs maintenance/edit. Verified and cancelled jobs stay as they are.
type UpdateWorkOrder struct{ Deps }

// Handle edits the work order.
func (h UpdateWorkOrder) Handle(ctx context.Context, p auth.Principal, id string, in domain.Input) (domain.WorkOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.WorkOrder{}, err
	}
	var w domain.WorkOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if w, err = h.Repo.WorkOrder(ctx, id); err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, w.VillaID); err != nil {
			return err
		}
		if err := w.CheckEditable(); err != nil {
			return err
		}
		if err := domain.ValidateWorkOrder(in); err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, in.VillaID)
		if err != nil {
			return err
		}
		before := costAudit(w)
		w.Apply(in)
		if err := h.Repo.UpdateWorkOrder(ctx, &w); err != nil {
			return err
		}
		if err := h.saved(ctx, w, villa.LocationID); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "work-order", EntityID: w.Number, Summary: "Edited " + w.Number, Before: before, After: costAudit(w)})
	})
	return w, err
}

func costAudit(w domain.WorkOrder) map[string]any {
	return map[string]any{"priority": w.Priority, "labourCost": w.LabourCost, "vendorCost": w.VendorCost}
}

// TransitionInput is the body of POST work-orders/{id}/status.
type TransitionInput struct {
	Status string `json:"status"`
	Note   string `json:"note"`
}

// TransitionWorkOrder moves a job along its lifecycle; verifying needs maintenance/approve, every
// other step maintenance/edit. Finishing advances its preventive plan and returns its asset to
// service; finishing or cancelling frees the unit.
type TransitionWorkOrder struct{ Deps }

// Handle applies the transition.
func (h TransitionWorkOrder) Handle(ctx context.Context, p auth.Principal, id string, in TransitionInput) (domain.WorkOrder, error) {
	need := needEdit
	if in.Status == domain.Verified {
		need = needApprove
	}
	if err := h.Authz.Require(ctx, p.Role, need); err != nil {
		return domain.WorkOrder{}, err
	}
	var w domain.WorkOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if w, err = h.Repo.WorkOrder(ctx, id); err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, w.VillaID)
		if err != nil {
			return err
		}
		before := w.Status
		finished, release, err := w.Transition(in.Status, in.Note, p.Name, h.today())
		if err != nil {
			return err
		}
		if finished {
			if err := h.finish(ctx, w); err != nil {
				return err
			}
		}
		if release {
			if err := h.releaseBlock(ctx, &w); err != nil {
				return err
			}
		}
		if err := h.Repo.UpdateWorkOrder(ctx, &w); err != nil {
			return err
		}
		if err := h.saved(ctx, w, villa.LocationID); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{
			Action: audit.Status, Entity: "work-order", EntityID: w.Number,
			Summary: fmt.Sprintf("%s %s to %s", w.Number, strings.ToLower(domain.StatusLabel[before]), strings.ToLower(domain.StatusLabel[w.Status])),
			Before:  map[string]any{"status": before}, After: map[string]any{"status": w.Status},
		})
	})
	return w, err
}

// finish advances the job's plan and returns an asset under repair to service.
func (h TransitionWorkOrder) finish(ctx context.Context, w domain.WorkOrder) error {
	if w.PlanID != nil {
		plan, err := h.Repo.FindPlan(ctx, *w.PlanID)
		if err != nil {
			return err
		}
		if plan != nil {
			plan.Finish(h.today())
			if err := h.Repo.UpdatePlan(ctx, plan); err != nil {
				return err
			}
		}
	}
	if w.AssetID != nil {
		asset, err := h.Repo.FindAsset(ctx, *w.AssetID)
		if err != nil {
			return err
		}
		if asset != nil && asset.Status == domain.UnderRepair {
			asset.Status = domain.InService
			return h.Repo.UpdateAsset(ctx, asset)
		}
	}
	return nil
}

// NoteInput is the body of POST work-orders/{id}/notes.
type NoteInput struct {
	Note string `json:"note"`
}

// AddNote writes a line in the job's history; it needs maintenance/edit.
type AddNote struct{ Deps }

// Handle adds the note.
func (h AddNote) Handle(ctx context.Context, p auth.Principal, id string, in NoteInput) (domain.WorkOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.WorkOrder{}, err
	}
	var w domain.WorkOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if w, err = h.Repo.WorkOrder(ctx, id); err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, w.VillaID)
		if err != nil {
			return err
		}
		if err := domain.ValidateNote(in.Note); err != nil {
			return err
		}
		w.Log("note", p.Name, h.today(), strings.TrimSpace(in.Note))
		if err := h.Repo.UpdateWorkOrder(ctx, &w); err != nil {
			return err
		}
		return h.saved(ctx, w, villa.LocationID)
	})
	return w, err
}

// BlockInput is the body of PUT work-orders/{id}/block; null dates release the block.
type BlockInput struct {
	From *string `json:"from"`
	To   *string `json:"to"`
}

// SetBlock blocks the job's unit, or releases the block; it needs maintenance/edit.
type SetBlock struct{ Deps }

// Handle sets or releases the block.
func (h SetBlock) Handle(ctx context.Context, p auth.Principal, id string, in BlockInput) (domain.WorkOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.WorkOrder{}, err
	}
	var w domain.WorkOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if w, err = h.Repo.WorkOrder(ctx, id); err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, w.VillaID)
		if err != nil {
			return err
		}
		line := audit.Line{Action: audit.Delete, Entity: "block", EntityID: w.Number, Summary: "Released the block for " + w.Number}
		if in.From != nil && in.To != nil && *in.From != "" && *in.To != "" {
			if err := w.CheckOpenForBlock(); err != nil {
				return err
			}
			if err := w.CheckBlock(*in.From, *in.To); err != nil {
				return err
			}
			if err := h.releaseBlock(ctx, &w); err != nil {
				return err
			}
			if err := h.hold(ctx, &w, *in.From, *in.To); err != nil {
				return err
			}
			unit, err := h.Repo.Unit(ctx, *w.UnitID)
			if err != nil {
				return err
			}
			w.Log("blocked", p.Name, h.today(), *in.From+" to "+*in.To)
			line = audit.Line{Action: audit.Create, Entity: "block", EntityID: *w.BlockID, Summary: fmt.Sprintf("Blocked %s for %s", unit.Code, w.Number)}
		} else {
			if err := h.releaseBlock(ctx, &w); err != nil {
				return err
			}
			w.Log("unblocked", p.Name, h.today(), "")
		}
		if err := h.Repo.UpdateWorkOrder(ctx, &w); err != nil {
			return err
		}
		if err := h.saved(ctx, w, villa.LocationID); err != nil {
			return err
		}
		return h.record(ctx, p, line)
	})
	return w, err
}
