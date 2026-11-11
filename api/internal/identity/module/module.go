// Package module wires the identity and access context: repositories, commands, queries, HTTP
// routes and projections. The composition root (internal/bootstrap) builds one per process that
// runs identity.
package module

import (
	"log/slog"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/identity/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/identity/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/identity/app/query"
	identityhttp "github.com/syabanf/wit-hospitality/api/internal/identity/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Deps is what identity needs from the process.
type Deps struct {
	DB              *db.DB
	Clock           clock.Clock
	Issuer          auth.Issuer
	Cookies         auth.Cookies
	Log             *slog.Logger
	RefreshTTL      time.Duration
	InitialPassword string
}

// Module is the wired context.
type Module struct {
	db      *db.DB
	http    identityhttp.Handler
	refresh command.Refresh
	matrix  postgres.Permissions
}

// ConsumerAuditTrail projects audit events of every context into identity.audit_trail.
const ConsumerAuditTrail = "identity.audit-trail"

// New wires identity.
func New(d Deps) *Module {
	matrix := postgres.Permissions{DB: d.DB}
	authz := rbac.Authorizer{Source: matrix}
	deps := command.Deps{
		DB: d.DB, Users: postgres.Users{DB: d.DB}, Sessions: postgres.Sessions{DB: d.DB}, Permissions: matrix,
		Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock, Issuer: d.Issuer, Authz: authz,
		RefreshTTL: d.RefreshTTL, InitialPassword: d.InitialPassword,
	}
	m := &Module{db: d.DB, refresh: command.Refresh{Deps: deps}, matrix: matrix}
	m.http = identityhttp.Handler{
		Commands: identityhttp.Commands{
			Login: command.Login{Deps: deps}, Refresh: m.refresh, Logout: command.Logout{Deps: deps},
			ChangePassword: command.ChangePassword{Deps: deps}, CreateUser: command.CreateUser{Deps: deps},
			UpdateUser: command.UpdateUser{Deps: deps}, SetUserActive: command.SetUserActive{Deps: deps},
			SavePermissions: command.SavePermissions{Deps: deps}, SaveProfile: command.SaveProfile{Deps: deps},
		},
		Queries: query.Queries{Store: postgres.ReadStore{DB: d.DB, Matrix: matrix}, Authz: authz},
		Cookies: d.Cookies, Clock: d.Clock, Log: d.Log,
	}
	return m
}

// Migrations is identity's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// InternalRoutes registers the service-to-service routes.
func (m *Module) InternalRoutes(r chi.Router) { m.http.InternalRoutes(r) }

// Project registers identity's read model handlers.
func (m *Module) Project(p *projector.Projector) {
	p.On(ConsumerAuditTrail, audit.EventRecorded, postgres.ProjectAuditEntry(m.db))
}

// Refresher renews sessions in process.
func (m *Module) Refresher() auth.Refresher { return m.refresh }

// Permissions serves the matrix in process.
func (m *Module) Permissions() rbac.Source { return m.matrix }
