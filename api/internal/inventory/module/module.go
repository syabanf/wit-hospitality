// Package module wires the inventory context: repository, commands, queries, HTTP routes,
// projections, the reactions to delivered and voided service orders and the inventory.Items client
// other contexts read stock items through. It reaches finance through command.CashOutRequests and
// reservation through command.Stays.
package module

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/query"
	inventoryhttp "github.com/syabanf/wit-hospitality/api/internal/inventory/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
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
	log       *slog.Logger
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
	return &Module{db: d.DB, log: d.Log, sales: command.Sales{Deps: deps}, turnovers: command.Turnovers{Deps: deps}, http: inventoryhttp.Handler{
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

// InternalRoutes serves Items to other services in split mode: GET /internal/v1/stock/items,
// guarded by INTERNAL_TOKEN. The gateway does not expose it.
func (m *Module) InternalRoutes(r chi.Router) {
	r.Get("/stock/items", httpx.Handle(m.log, func(w http.ResponseWriter, r *http.Request) error {
		list, err := m.Items(r.Context())
		if err != nil {
			return err
		}
		httpx.OK(w, list)
		return nil
	}))
}

// Client lists stock items in process, for housekeeping in the monolith.
func (m *Module) Client() inventory.Items { return m }

// Items is inventory.Items: every stock item in creation order, inactive ones included.
func (m *Module) Items(ctx context.Context) ([]inventory.StockItem, error) {
	items, err := postgres.ReadStore{DB: m.db}.Items(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]inventory.StockItem, 0, len(items))
	for _, i := range items {
		out = append(out, inventory.StockItem{ID: i.ID, Code: i.Code, Name: i.Name, Kind: i.Kind})
	}
	return out, nil
}

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
