// Package query holds the reservation context's read side. Handlers read the projected rm_*
// tables of the reservation schema, filtered to the signed-in user's villa and location scope.
// Rows come back in the console's JSON shape, in creation order. They hold no domain logic.
package query

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
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
}

// Queries bundles the read handlers. Every signed-in user reads the stays of their own scope,
// except a villa owner, who reads their villas in the owner portal only (Permissions nil skips
// that check).
type Queries struct {
	Store       ReadStore
	Permissions rbac.Source
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
