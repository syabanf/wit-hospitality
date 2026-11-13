// Package module wires the people context: repository, commands, queries, HTTP routes and the
// handlers it runs on other contexts' events (the property villas it scopes by, the loan
// repayments a closed payroll books). It depends on identity only through rbac.Source.
package module

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/payroll"
	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/people/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/people/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/people/app/query"
	peoplehttp "github.com/syabanf/wit-hospitality/api/internal/people/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ConsumerRepayments books loan repayments from closed payrolls.
const ConsumerRepayments = "people.loan-repayments"

// Deps is what the people context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
}

// Module is the wired context.
type Module struct {
	db         *db.DB
	http       peoplehttp.Handler
	repayments command.BookRepayments
}

// New wires the people context.
func New(d Deps) *Module {
	authz := rbac.Authorizer{Source: d.Permissions}
	deps := command.Deps{DB: d.DB, Repo: postgres.Repo{DB: d.DB}, Authz: authz, Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock}
	return &Module{db: d.DB, repayments: command.BookRepayments{Deps: deps}, http: peoplehttp.Handler{
		Commands: peoplehttp.Commands{
			CreateEmployee: command.CreateEmployee{Deps: deps}, UpdateEmployee: command.UpdateEmployee{Deps: deps},
			AssignShift: command.AssignShift{Deps: deps}, RecordAttendance: command.RecordAttendance{Deps: deps},
			RequestLeave: command.RequestLeave{Deps: deps}, DecideLeave: command.DecideLeave{Deps: deps},
			RequestOvertime: command.RequestOvertime{Deps: deps}, DecideOvertime: command.DecideOvertime{Deps: deps},
			RequestLoan: command.RequestLoan{Deps: deps}, DecideLoan: command.DecideLoan{Deps: deps},
			CreateAnnouncement: command.CreateAnnouncement{Deps: deps}, UpdateAnnouncement: command.UpdateAnnouncement{Deps: deps},
			DeleteAnnouncement: command.DeleteAnnouncement{Deps: deps}, SaveKpi: command.SaveKpi{Deps: deps},
		},
		Queries: query.Queries{Store: postgres.ReadStore{DB: d.DB}, Authz: authz},
		Log:     d.Log,
	}}
}

// Migrations is the people context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// Roster answers billing in process: whether the roster puts an employee on a shift that day.
func (m *Module) Roster() people.Roster { return postgres.Repo{DB: m.db} }

// Staff answers property, reservation and services in process: who an employee is and which villas
// they are allocated to.
func (m *Module) Staff() people.Staff { return postgres.Repo{DB: m.db} }

// InternalRoutes serves Roster and Staff to other services in split mode, guarded by
// INTERNAL_TOKEN: GET /internal/v1/people/rostered?employeeId=&date= and
// GET /internal/v1/people/staff/{id}.
func (m *Module) InternalRoutes(r chi.Router) {
	staff := m.Staff()
	r.Get("/people/staff/{id}", httpx.Handle(m.http.Log, func(w http.ResponseWriter, r *http.Request) error {
		id := chi.URLParam(r, "id")
		member, found, err := staff.StaffMember(r.Context(), id)
		if err != nil {
			return err
		}
		if !found {
			return errs.NotFound("employee", id)
		}
		httpx.OK(w, member)
		return nil
	}))
	roster := m.Roster()
	r.Get("/people/rostered", httpx.Handle(m.http.Log, func(w http.ResponseWriter, r *http.Request) error {
		q := r.URL.Query()
		if q.Get("employeeId") == "" || q.Get("date") == "" {
			return errs.New(errs.CodeValidation, "Name the employee and the day.")
		}
		ok, err := roster.Rostered(r.Context(), q.Get("employeeId"), q.Get("date"))
		if err != nil {
			return err
		}
		httpx.OK(w, map[string]bool{"rostered": ok})
		return nil
	}))
}

// Project registers the read model handlers and the loan repayment reaction.
func (m *Module) Project(p *projector.Projector) {
	postgres.Projections{DB: m.db}.Register(p)
	p.On(ConsumerRepayments, payroll.EventPeriodClosed, func(ctx context.Context, msg bus.Message) error {
		var e payroll.PeriodClosed
		if err := json.Unmarshal(msg.Payload, &e); err != nil {
			return err
		}
		var repayments []command.Repayment
		for _, l := range e.Lines {
			repayments = append(repayments, command.Repayment{EmployeeID: l.EmployeeID, Amount: l.LoanDeduction})
		}
		return m.repayments.Handle(ctx, repayments)
	})
}
