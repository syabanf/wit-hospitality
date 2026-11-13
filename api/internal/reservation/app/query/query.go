// Package query holds the reservation context's read side. Handlers read the projected rm_*
// tables of the reservation schema, filtered to the signed-in user's villa and location scope.
// Rows come back in the console's JSON shape, in creation order. They hold no domain logic.
package query

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Read model tables.
const (
	Bookings     = "rm_bookings"
	Groups       = "rm_booking_groups"
	Restrictions = "rm_restrictions"
	Overbooking  = "rm_overbooking"
	Walks        = "rm_walks"
	PreCheckIns  = "rm_pre_checkins"
)

// ReadStore reads one read model narrowed to a scope.
type ReadStore interface {
	Docs(ctx context.Context, table string, s rbac.Scope) ([]json.RawMessage, error)
	// HostStays lists the host's confirmed and in-house stays leaving on or after today.
	HostStays(ctx context.Context, hostID, today string, s rbac.Scope) ([]json.RawMessage, error)
}

// Queries bundles the read handlers. Every signed-in user reads the stays of their own scope,
// except a villa owner, who reads their villas in the owner portal only (Permissions nil skips
// that check).
type Queries struct {
	Store       ReadStore
	Permissions rbac.Source
	Clock       clock.Clock
}

// List is GET on one of the read models.
func (q Queries) List(ctx context.Context, table string) ([]json.RawMessage, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	if q.Permissions != nil {
		perms, err := q.Permissions.Permissions(ctx)
		if err != nil {
			return nil, err
		}
		if rbac.PortalOnly(perms, p.Role) {
			return nil, errs.Forbidden("A villa owner sees their villas in the owner portal.")
		}
	}
	return q.Store.Docs(ctx, table, p.Scope())
}

// HostStays is GET /host-stays: the upcoming and in-house stays a villa host looks after, by
// arrival, with their preferences and service window. Without hostId it lists the signed-in
// employee's own stays, wherever they are; another host's need booking/view and stay in scope.
func (q Queries) HostStays(ctx context.Context, hostID string) ([]json.RawMessage, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	own := p.EmployeeID != nil && (hostID == "" || hostID == *p.EmployeeID)
	scope := rbac.Scope{}
	switch {
	case own:
		hostID = *p.EmployeeID
	case hostID == "":
		return nil, errs.Invalid("hostId", "This login is not linked to an employee; name the host.")
	default:
		if err := (rbac.Authorizer{Source: q.Permissions}).Require(ctx, p.Role, rbac.Need{Module: "booking", Action: "view"}); err != nil {
			return nil, err
		}
		scope = p.Scope()
	}
	return q.Store.HostStays(ctx, hostID, clock.Today(q.Clock), scope)
}
