// Package module wires the reservation context: repository, catalog copy, commands, queries, HTTP
// routes, projections and the stays answers property asks for. It depends on identity only
// through rbac.Source and on guest, channel and billing through command.Clients.
package module

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/clients"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/query"
	reservationhttp "github.com/syabanf/wit-hospitality/api/internal/reservation/ports/http"
)

// Deps is what the reservation context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	// Clients reach the guest, channel and billing contexts; the zero value uses clients.Pending.
	Clients command.Clients
}

// Module is the wired context.
type Module struct {
	db   *db.DB
	log  *slog.Logger
	http reservationhttp.Handler
}

// New wires the reservation context.
func New(d Deps) *Module {
	cl := d.Clients
	pending := clients.Pending()
	if cl.Guests == nil {
		cl.Guests = pending.Guests
	}
	if cl.Channel == nil {
		cl.Channel = pending.Channel
	}
	if cl.Billing == nil {
		cl.Billing = pending.Billing
	}
	deps := command.Deps{
		DB: d.DB, Repo: postgres.Repo{DB: d.DB}, Catalog: postgres.CatalogStore{DB: d.DB}, Clients: cl,
		Authz: rbac.Authorizer{Source: d.Permissions}, Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock,
		Settings: clients.DefaultSettings{},
	}
	return &Module{db: d.DB, log: d.Log, http: reservationhttp.Handler{
		Commands: reservationhttp.Commands{
			CreateBooking: command.CreateBooking{Deps: deps}, Transition: command.Transition{Deps: deps},
			CheckIn: command.CheckIn{Deps: deps}, CheckOut: command.CheckOut{Deps: deps}, SettleCheckOut: command.SettleCheckOut{Deps: deps},
			MoveUnit: command.MoveUnit{Deps: deps}, SetPrice: command.SetPrice{Deps: deps}, AssignUnit: command.AssignUnit{Deps: deps},
			AdjustStay: command.AdjustStay{Deps: deps}, SetPayment: command.SetPayment{Deps: deps},
			SaveRestriction: command.SaveRestriction{Deps: deps}, RemoveRestriction: command.RemoveRestriction{Deps: deps},
			BulkRestrictions: command.BulkRestrictions{Deps: deps}, SetOverbooking: command.SetOverbooking{Deps: deps},
			Walk: command.WalkGuest{Deps: deps}, CreateGroup: command.CreateGroup{Deps: deps}, AddGroupStay: command.AddGroupStay{Deps: deps},
			RemoveGroupStay: command.RemoveGroupStay{Deps: deps}, PayGroup: command.PayGroup{Deps: deps},
			VerifyPreCheckIn: command.VerifyPreCheckIn{Deps: deps}, CheckinLink: command.CheckinLink{Deps: deps},
		},
		Queries: query.Queries{Store: postgres.ReadStore{DB: d.DB}, Permissions: d.Permissions},
		Log:     d.Log,
	}}
}

// Migrations is the reservation context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// Project registers the catalog copy and read model handlers.
func (m *Module) Project(p *projector.Projector) { postgres.Projections{DB: m.db}.Register(p) }

// Stays answers property's questions about stays in process; it satisfies property's command.Stays.
func (m *Module) Stays() postgres.Stays { return postgres.Stays{DB: m.db} }

// StayLookup answers other contexts' questions about one stay or the stays in a unit, in process.
func (m *Module) StayLookup() postgres.StayLookup { return postgres.StayLookup{DB: m.db} }

// Site answers channel's questions about bookings, held nights and stay restrictions in process.
func (m *Module) Site() postgres.Site { return postgres.Site{DB: m.db} }

// InternalRoutes serves the stays answers to a property or services service in split mode,
// under /internal/v1/stays, guarded by INTERNAL_TOKEN.
func (m *Module) InternalRoutes(r chi.Router) {
	lookup := m.StayLookup()
	r.Get("/stays/booking/{id}", httpx.Handle(m.log, func(w http.ResponseWriter, r *http.Request) error {
		s, err := lookup.Stay(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			return err
		}
		httpx.OK(w, s)
		return nil
	}))
	r.Get("/stays/unit/{unitId}", httpx.Handle(m.log, func(w http.ResponseWriter, r *http.Request) error {
		list, err := lookup.InUnit(r.Context(), chi.URLParam(r, "unitId"))
		if err != nil {
			return err
		}
		if list == nil {
			list = []reservation.Stay{}
		}
		httpx.OK(w, list)
		return nil
	}))
	st := m.Stays()
	r.Get("/stays/overlap", httpx.Handle(m.log, func(w http.ResponseWriter, r *http.Request) error {
		q := r.URL.Query()
		code, found, err := st.OverlappingStay(r.Context(), q.Get("unitId"), q.Get("from"), q.Get("to"))
		if err != nil {
			return err
		}
		httpx.OK(w, map[string]any{"code": code, "found": found})
		return nil
	}))
	r.Get("/stays/upcoming", httpx.Handle(m.log, func(w http.ResponseWriter, r *http.Request) error {
		q := r.URL.Query()
		found, err := st.HasUpcomingStays(r.Context(), q.Get("unitId"), q.Get("today"))
		if err != nil {
			return err
		}
		httpx.OK(w, map[string]any{"found": found})
		return nil
	}))
	r.Get("/stays/waiting", httpx.Handle(m.log, func(w http.ResponseWriter, r *http.Request) error {
		codes, err := st.WaitingForRoom(r.Context(), r.URL.Query().Get("groupId"))
		if err != nil {
			return err
		}
		if codes == nil {
			codes = []string{}
		}
		httpx.OK(w, map[string]any{"codes": codes})
		return nil
	}))
}
