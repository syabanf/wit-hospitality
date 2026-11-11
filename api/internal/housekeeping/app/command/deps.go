// Package command holds the housekeeping context's write side: one handler per command. Each
// handler checks the permission and villa scope, loads with a row lock, applies the domain rules,
// saves with a version check, and appends its events and audit line in one transaction.
package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Store is the write model on the housekeeping schema plus its copies of the catalog and the
// stays. Loads of tasks, records and batches lock the row for the transaction.
type Store interface {
	Next(ctx context.Context, key string) (int64, error)

	Settings(ctx context.Context) (domain.Settings, int64, error)
	SaveSettings(ctx context.Context, s domain.Settings, version int64) (int64, error)

	// Record loads and locks a unit's board record; false when the unit has none yet.
	Record(ctx context.Context, unitID string) (domain.Record, bool, error)
	SaveRecord(ctx context.Context, r *domain.Record, villaID string) error
	DirtyUnits(ctx context.Context) (map[string]bool, error)

	Task(ctx context.Context, id string) (domain.RoomTask, error)
	// DayTasks loads and locks every task on the date.
	DayTasks(ctx context.Context, date string) ([]domain.RoomTask, error)
	InsertTask(ctx context.Context, t *domain.RoomTask) error
	UpdateTask(ctx context.Context, t *domain.RoomTask) error

	Par(ctx context.Context, groupID string) (*domain.LinenPar, error)
	SavePar(ctx context.Context, p *domain.LinenPar, villaID string) error
	Soiled(ctx context.Context, villaID, itemID string) (int, error)
	AddSoiled(ctx context.Context, villaID string, lines []domain.Line, sign int) error

	Batch(ctx context.Context, id string) (domain.LaundryBatch, error)
	InsertBatch(ctx context.Context, b *domain.LaundryBatch) error
	UpdateBatch(ctx context.Context, b *domain.LaundryBatch) error

	Unit(ctx context.Context, id string) (domain.Unit, error)
	Units(ctx context.Context) ([]domain.Unit, error)
	Villa(ctx context.Context, id string) (domain.Villa, error)
	Group(ctx context.Context, id string) (domain.Group, error)

	Stay(ctx context.Context, id string) (*domain.Stay, error)
	// PlanStays lists the assigned stays that occupy a room: checked in, checked out or confirmed.
	PlanStays(ctx context.Context) ([]domain.PlanStay, error)
	// InHouse is the stay checked in on the unit over date, or nil.
	InHouse(ctx context.Context, unitID, date string) (*domain.Stay, error)
}

// Deps is what every housekeeping command needs.
type Deps struct {
	DB      *db.DB
	Store   Store
	Clients Clients
	Authz   rbac.Authorizer
	Audit   audit.Recorder
	Clock   clock.Clock
}

func (d Deps) today() string { return clock.Today(d.Clock) }

func (d Deps) now() string { return clock.Stamp(d.Clock) }

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}, l)
}

func (d Deps) emit(ctx context.Context, eventType, aggregateType, aggregateID string, version int64, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: aggregateID, AggregateVersion: version, Payload: payload})
}

func (d Deps) can(ctx context.Context, p auth.Principal, action rbac.Action) (bool, error) {
	perms, err := d.Authz.Source.Permissions(ctx)
	if err != nil {
		return false, err
	}
	return rbac.Can(perms, p.Role, "maintenance", action), nil
}

// need mirrors the application service's allow('maintenance', action).
func (d Deps) need(ctx context.Context, p auth.Principal, action rbac.Action) error {
	return d.Authz.Require(ctx, p.Role, rbac.Need{Module: "maintenance", Action: action})
}

// editor is the mock's assertEditor, for the laundry return, which the service lets through on
// maintenance/submit when it carries a bill.
func (d Deps) editor(ctx context.Context, p auth.Principal) error {
	ok, err := d.can(ctx, p, "edit")
	if err != nil {
		return err
	}
	if !ok {
		return errs.Forbidden("Only housekeeping supervisors assign rooms and keep the linen.")
	}
	return nil
}

// worker is the mock's assertWorker: attendants work their own list; someone who approves
// maintenance, or a login with no employee record, works any.
func (d Deps) worker(ctx context.Context, p auth.Principal, t domain.RoomTask) error {
	edit, err := d.can(ctx, p, "edit")
	if err != nil {
		return err
	}
	submit, err := d.can(ctx, p, "submit")
	if err != nil {
		return err
	}
	if !edit && !submit {
		return errs.Forbidden("Your role cannot work housekeeping tasks.")
	}
	if p.EmployeeID == nil || *p.EmployeeID == "" || (t.AttendantID != nil && *t.AttendantID == *p.EmployeeID) {
		return nil
	}
	supervises, err := d.can(ctx, p, "approve")
	if err != nil {
		return err
	}
	if !supervises {
		return errs.Newf("TASK_NOT_YOURS", "%s is on another attendant's list.", t.Number)
	}
	return nil
}

// villaInScope loads a villa and refuses one outside the caller's scope.
func (d Deps) villaInScope(ctx context.Context, p auth.Principal, villaID string) (domain.Villa, error) {
	v, err := d.Store.Villa(ctx, villaID)
	if err != nil {
		return v, err
	}
	if !p.Scope().AllowedVilla(v.ID, v.LocationID) {
		return v, errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", v.Name))
	}
	return v, nil
}

func (d Deps) event(kind string, p auth.Principal, note string) domain.TaskEvent {
	return domain.TaskEvent{Kind: kind, By: p.Name, At: d.now(), Note: note}
}

func ptr[T any](v T) *T { return &v }
