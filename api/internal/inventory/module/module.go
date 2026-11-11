// Package module wires the inventory context: repository, commands, queries, HTTP routes,
// projections and the reactions to delivered and voided service orders. It reaches finance
// through command.CashOutRequests and reservation through command.Stays.
package module

import (
	"context"
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/query"
	inventoryhttp "github.com/syabanf/wit-hospitality/api/internal/inventory/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/services"
)

// Deps is what the inventory context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	// Stays reads bookings; nil reads the copy projected from reservation's booking events.
	Stays command.Stays
	// CashOuts asks finance to pay; nil records requests in this context's outbox until finance runs.
	CashOuts command.CashOutRequests
}

// Module is the wired context.
type Module struct {
	db        *db.DB
	http      inventoryhttp.Handler
	sales     command.Sales
	turnovers command.Turnovers
}

// New wires the inventory context.
func New(d Deps) *Module {
	rec := audit.Recorder{DB: d.DB, Clock: d.Clock}
	st := d.Stays
	if st == nil {
		st = postgres.Stays{DB: d.DB}
	}
	cash := d.CashOuts
	if cash == nil {
		cash = postgres.CashOuts{DB: d.DB, Audit: rec, Clock: d.Clock}
	}
	deps := command.Deps{
		DB: d.DB, Repo: postgres.Repo{DB: d.DB}, Stays: st, CashOuts: cash,
		Authz: rbac.Authorizer{Source: d.Permissions}, Audit: rec, Clock: d.Clock,
	}
	return &Module{db: d.DB, sales: command.Sales{Deps: deps}, turnovers: command.Turnovers{Deps: deps}, http: inventoryhttp.Handler{
		Commands: inventoryhttp.Commands{
			CreateItem: command.CreateItem{Deps: deps}, UpdateItem: command.UpdateItem{Deps: deps},
			Receive: command.Receive{Deps: deps}, CorrectReceipt: command.CorrectReceipt{Deps: deps}, CancelReceipt: command.CancelReceipt{Deps: deps},
			Move: command.Move{Deps: deps}, TakeCount: command.TakeCount{Deps: deps},
			SaveKit: command.SaveKit{Deps: deps}, LinkMinibar: command.LinkMinibar{Deps: deps}, MinibarCheck: command.MinibarCheck{Deps: deps},
		},
		Queries: query.Queries{Store: postgres.ReadStore{DB: d.DB}},
		Log:     d.Log,
	}}
}

// Migrations is the inventory context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// Project registers the reference and cash-out handlers and the minibar sale reactions.
func (m *Module) Project(p *projector.Projector) {
	postgres.Projections{DB: m.db}.Register(p)
	p.On(postgres.ConsumerSales, services.EventOrderDelivered, func(ctx context.Context, msg bus.Message) error {
		e, err := postgres.Decode[services.OrderBilled](msg)
		if err != nil {
			return err
		}
		return m.sales.Delivered(ctx, e)
	})
	p.On(postgres.ConsumerSales, services.EventOrderVoided, func(ctx context.Context, msg bus.Message) error {
		e, err := postgres.Decode[services.OrderBilled](msg)
		if err != nil {
			return err
		}
		return m.sales.Voided(ctx, e)
	})
	p.On(postgres.ConsumerTurnovers, housekeeping.EventRoomReleased, func(ctx context.Context, msg bus.Message) error {
		e, err := postgres.Decode[housekeeping.RoomReleased](msg)
		if err != nil {
			return err
		}
		return m.turnovers.Released(ctx, e)
	})
	p.On(postgres.ConsumerTurnovers, housekeeping.EventLinenDiscarded, func(ctx context.Context, msg bus.Message) error {
		e, err := postgres.Decode[housekeeping.LinenDiscarded](msg)
		if err != nil {
			return err
		}
		return m.turnovers.Discarded(ctx, e)
	})
}
