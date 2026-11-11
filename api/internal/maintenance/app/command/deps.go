// Package command holds the maintenance context's write side: one handler per command. Each
// handler checks the permission and villa scope, loads with a row lock, applies the domain rules,
// saves with a version check and appends its events and audit line in one transaction.
package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Villa and Unit are what maintenance knows of property's catalog, projected from its events.
type (
	Villa struct {
		ID         string
		LocationID string
		Name       string
	}
	Unit struct {
		ID      string
		VillaID string
		Code    string
	}
)

// Repository is the write model on the maintenance schema. Loads lock the row for the transaction.
type Repository interface {
	Next(ctx context.Context, counter string) (int, error)
	Villa(ctx context.Context, id string) (Villa, error)
	Unit(ctx context.Context, id string) (Unit, error)

	WorkOrder(ctx context.Context, id string) (domain.WorkOrder, error)
	InsertWorkOrder(ctx context.Context, w *domain.WorkOrder) error
	UpdateWorkOrder(ctx context.Context, w *domain.WorkOrder) error

	FindAsset(ctx context.Context, id string) (*domain.Asset, error)
	Asset(ctx context.Context, id string) (domain.Asset, error)
	AssetCodeTaken(ctx context.Context, code, excludeID string) (bool, error)
	InsertAsset(ctx context.Context, a *domain.Asset) error
	UpdateAsset(ctx context.Context, a *domain.Asset) error

	Vendor(ctx context.Context, id string) (domain.Vendor, error)
	VendorNameTaken(ctx context.Context, name, excludeID string) (bool, error)
	InsertVendor(ctx context.Context, v *domain.Vendor) error
	UpdateVendor(ctx context.Context, v *domain.Vendor) error

	FindPlan(ctx context.Context, id string) (*domain.Plan, error)
	Plan(ctx context.Context, id string) (domain.Plan, error)
	// DuePlans lists active plans due by until that have no open work order, locked.
	DuePlans(ctx context.Context, until string) ([]domain.Plan, error)
	InsertPlan(ctx context.Context, p *domain.Plan) error
	UpdatePlan(ctx context.Context, p *domain.Plan) error
}

// Blocks holds and frees units through the property context, which owns unit blocks. The
// monolith calls property in process inside the same transaction; split mode calls property's
// internal HTTP endpoint.
type Blocks interface {
	// Hold blocks the unit for maintenance on [from, to); a stay on those nights refuses it with
	// BLOCK_OVERLAP. It returns the block id.
	Hold(ctx context.Context, unitID, from, to, note string) (string, error)
	// Release frees the nights from today on: a block that has not started goes, one that has is
	// cut to end today, keeping the nights already lost for the downtime report.
	Release(ctx context.Context, blockID, today string) error
}

// CashOutStatus is the local view of a cash-out finance owns.
type CashOutStatus struct {
	ID          string
	Number      string
	Status      string
	CreatedByID string
	CreatedBy   string
}

// CashOutRequests asks finance to pay. Finance is not built yet: the in-process implementation
// records each request in this context's outbox and keeps the status submitted until finance
// answers with finance.cash_out.decided.v1.
type CashOutRequests interface {
	Submit(ctx context.Context, p auth.Principal, r maintenance.CashOut) (CashOutStatus, error)
	Correct(ctx context.Context, p auth.Principal, id string, r maintenance.CashOut, note string) (CashOutStatus, error)
	Cancel(ctx context.Context, p auth.Principal, id, note string) error
	Status(ctx context.Context, id string) (CashOutStatus, error)
}

// Deps is what every maintenance command needs.
type Deps struct {
	DB       *db.DB
	Repo     Repository
	Blocks   Blocks
	CashOuts CashOutRequests
	Authz    rbac.Authorizer
	Audit    audit.Recorder
	Clock    clock.Clock
}

// Permission sets the commands check, taken from the application services' allow() calls.
var (
	needCreate  = rbac.Need{Module: "maintenance", Action: "create"}
	needEdit    = rbac.Need{Module: "maintenance", Action: "edit"}
	needSubmit  = rbac.Need{Module: "maintenance", Action: "submit"}
	needApprove = rbac.Need{Module: "maintenance", Action: "approve"}
)

func (d Deps) today() string { return clock.Today(d.Clock) }

// villaInScope loads the villa and refuses one outside the principal's scope.
func (d Deps) villaInScope(ctx context.Context, p auth.Principal, id string) (Villa, error) {
	v, err := d.Repo.Villa(ctx, id)
	if err != nil {
		return v, err
	}
	if !p.Scope().AllowedVilla(v.ID, v.LocationID) {
		return v, errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", v.Name))
	}
	return v, nil
}

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}, l)
}

// saved appends work_order.saved with the job's current state.
func (d Deps) saved(ctx context.Context, w domain.WorkOrder, locationID string) error {
	state := maintenance.WorkOrder{
		ID: w.ID, Number: w.Number, VillaID: w.VillaID, LocationID: locationID, UnitID: w.UnitID, AssetID: w.AssetID, PlanID: w.PlanID,
		VendorID: w.VendorID, Category: w.Category, Priority: w.Priority, Title: w.Title, Status: w.Status, BlockID: w.BlockID,
		CreatedOn: w.CreatedOn, FinishedOn: w.FinishedOn, Cost: w.Cost(),
	}
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{
		Type: maintenance.EventWorkOrderSaved, AggregateType: "work_order", AggregateID: w.ID, AggregateVersion: w.Version,
		Payload: maintenance.WorkOrderSaved{WorkOrder: state},
	})
}

// releaseBlock is the mock's releaseBlock: the job lets go of its block.
func (d Deps) releaseBlock(ctx context.Context, w *domain.WorkOrder) error {
	if w.BlockID == nil {
		return nil
	}
	id := *w.BlockID
	w.BlockID = nil
	err := d.Blocks.Release(ctx, id, d.today())
	if errs.HasCode(err, errs.CodeNotFound) {
		return nil
	}
	return err
}

// hold blocks the job's unit after the job's own checks.
func (d Deps) hold(ctx context.Context, w *domain.WorkOrder, from, to string) error {
	if err := w.CheckBlock(from, to); err != nil {
		return err
	}
	id, err := d.Blocks.Hold(ctx, *w.UnitID, from, to, w.Number+" "+w.Title)
	if err != nil {
		return err
	}
	w.BlockID = &id
	return nil
}
