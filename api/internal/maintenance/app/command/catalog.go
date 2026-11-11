package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// CreateAsset registers equipment; it needs maintenance/create and the villa in scope.
type CreateAsset struct{ Deps }

// Handle registers the asset.
func (h CreateAsset) Handle(ctx context.Context, p auth.Principal, in domain.AssetInput) (domain.Asset, error) {
	if err := h.Authz.Require(ctx, p.Role, needCreate); err != nil {
		return domain.Asset{}, err
	}
	var a domain.Asset
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.AssetCodeTaken(ctx, in.Code, "")
		if err != nil {
			return err
		}
		if err := domain.ValidateAsset(in, taken); err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, in.VillaID); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "asset")
		if err != nil {
			return err
		}
		a = domain.NewAsset(fmt.Sprintf("ast-%d", n), in)
		if err := h.Repo.InsertAsset(ctx, &a); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "asset", EntityID: a.Code, Summary: fmt.Sprintf("Registered %s, %s", a.Code, a.Name)})
	})
	return a, err
}

// UpdateAsset edits equipment; it needs maintenance/edit and the villa in scope.
type UpdateAsset struct{ Deps }

// Handle edits the asset.
func (h UpdateAsset) Handle(ctx context.Context, p auth.Principal, id string, in domain.AssetInput) (domain.Asset, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.Asset{}, err
	}
	var a domain.Asset
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.AssetCodeTaken(ctx, in.Code, id)
		if err != nil {
			return err
		}
		if err := domain.ValidateAsset(in, taken); err != nil {
			return err
		}
		if a, err = h.Repo.Asset(ctx, id); err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, a.VillaID); err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, in.VillaID); err != nil {
			return err
		}
		before := map[string]any{"status": a.Status}
		a.Apply(in)
		if err := h.Repo.UpdateAsset(ctx, &a); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "asset", EntityID: a.Code, Summary: "Edited " + a.Code, Before: before, After: map[string]any{"status": a.Status}})
	})
	return a, err
}

// CreateVendor adds a contractor; it needs maintenance/create.
type CreateVendor struct{ Deps }

// Handle adds the vendor.
func (h CreateVendor) Handle(ctx context.Context, p auth.Principal, in domain.VendorInput) (domain.Vendor, error) {
	if err := h.Authz.Require(ctx, p.Role, needCreate); err != nil {
		return domain.Vendor{}, err
	}
	var v domain.Vendor
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.VendorNameTaken(ctx, in.Name, "")
		if err != nil {
			return err
		}
		if err := domain.ValidateVendor(in, taken); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "vendor")
		if err != nil {
			return err
		}
		v = domain.NewVendor(fmt.Sprintf("ven-%d", n), in)
		if err := h.Repo.InsertVendor(ctx, &v); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "vendor", EntityID: v.ID, Summary: "Added vendor " + v.Name})
	})
	return v, err
}

// UpdateVendor edits a contractor; it needs maintenance/edit.
type UpdateVendor struct{ Deps }

// Handle edits the vendor.
func (h UpdateVendor) Handle(ctx context.Context, p auth.Principal, id string, in domain.VendorInput) (domain.Vendor, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.Vendor{}, err
	}
	var v domain.Vendor
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.VendorNameTaken(ctx, in.Name, id)
		if err != nil {
			return err
		}
		if err := domain.ValidateVendor(in, taken); err != nil {
			return err
		}
		if v, err = h.Repo.Vendor(ctx, id); err != nil {
			return err
		}
		v.Apply(in)
		if err := h.Repo.UpdateVendor(ctx, &v); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "vendor", EntityID: v.ID, Summary: "Edited vendor " + v.Name})
	})
	return v, err
}

// CreatePlan adds a preventive plan; it needs maintenance/create and the villa in scope.
type CreatePlan struct{ Deps }

// Handle adds the plan.
func (h CreatePlan) Handle(ctx context.Context, p auth.Principal, in domain.PlanInput) (domain.Plan, error) {
	if err := h.Authz.Require(ctx, p.Role, needCreate); err != nil {
		return domain.Plan{}, err
	}
	if err := domain.ValidatePlan(in); err != nil {
		return domain.Plan{}, err
	}
	var plan domain.Plan
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if _, err := h.villaInScope(ctx, p, in.VillaID); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "plan")
		if err != nil {
			return err
		}
		plan = domain.NewPlan(fmt.Sprintf("plan-%d", n), in)
		if err := h.Repo.InsertPlan(ctx, &plan); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "plan", EntityID: plan.ID, Summary: "Added preventive plan " + plan.Title})
	})
	return plan, err
}

// UpdatePlan edits a preventive plan; it needs maintenance/edit and the villa in scope.
type UpdatePlan struct{ Deps }

// Handle edits the plan.
func (h UpdatePlan) Handle(ctx context.Context, p auth.Principal, id string, in domain.PlanInput) (domain.Plan, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.Plan{}, err
	}
	if err := domain.ValidatePlan(in); err != nil {
		return domain.Plan{}, err
	}
	var plan domain.Plan
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if plan, err = h.Repo.Plan(ctx, id); err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, plan.VillaID); err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, in.VillaID); err != nil {
			return err
		}
		plan.Apply(in)
		if err := h.Repo.UpdatePlan(ctx, &plan); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "plan", EntityID: plan.ID, Summary: "Edited preventive plan " + plan.Title})
	})
	return plan, err
}

// GenerateInput is the body of POST preventive-plans/generate.
type GenerateInput struct {
	HorizonDays int `json:"horizonDays"`
}

// GenerateDue opens a work order for every active plan due within the horizon that has none
// open; it needs maintenance/create. Plans of villas outside the caller's scope are left alone.
type GenerateDue struct{ Deps }

// Handle opens the due jobs and returns them.
func (h GenerateDue) Handle(ctx context.Context, p auth.Principal, in GenerateInput) ([]domain.WorkOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, needCreate); err != nil {
		return nil, err
	}
	created := []domain.WorkOrder{}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		plans, err := h.Repo.DuePlans(ctx, domain.AddDays(h.today(), in.HorizonDays))
		if err != nil {
			return err
		}
		for _, plan := range plans {
			villa, err := h.Repo.Villa(ctx, plan.VillaID)
			if err != nil {
				return err
			}
			if !p.Scope().AllowedVilla(villa.ID, villa.LocationID) {
				continue
			}
			w, err := h.open(ctx, p, plan.JobFor(h.today()), "Preventive plan", villa)
			if err != nil {
				return err
			}
			created = append(created, w)
		}
		return nil
	})
	return created, err
}
