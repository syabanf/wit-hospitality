// Package query holds the housekeeping context's read side: the board, tasks, settings, linen pars,
// soiled bags and laundry batches, filtered to the signed-in user's villa and location scope, in
// creation order. The console works out the day view, the phone list, DND alerts and linen levels
// from these reads.
package query

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Lists.
const (
	Board   = "board"
	Tasks   = "tasks"
	Pars    = "pars"
	Soiled  = "soiled"
	Batches = "batches"
)

// ReadStore reads one list narrowed to a scope, and the settings.
type ReadStore interface {
	Docs(ctx context.Context, list string, s rbac.Scope) ([]json.RawMessage, error)
	Settings(ctx context.Context) (domain.Settings, int64, error)
	SectionAssignments(ctx context.Context, s rbac.Scope) ([]domain.SectionAssignment, error)
	RoomChecks(ctx context.Context, s rbac.Scope) ([]json.RawMessage, error)
}

// Queries bundles the read handlers; every signed-in user reads their own scope. Authz guards the
// room report; a nil Source lets every signed-in user read it.
type Queries struct {
	Store ReadStore
	Authz rbac.Authorizer
}

// List is GET on one of the lists.
func (q Queries) List(ctx context.Context, list string) ([]json.RawMessage, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Docs(ctx, list, p.Scope())
}

// Settings is GET housekeeping/settings.
func (q Queries) Settings(ctx context.Context) (domain.Settings, error) {
	if _, err := auth.Require(ctx); err != nil {
		return domain.Settings{}, err
	}
	s, _, err := q.Store.Settings(ctx)
	return s, err
}

// SectionAssignments is GET housekeeping/section-assignments: the section attendants whose
// section's villa is in scope.
func (q Queries) SectionAssignments(ctx context.Context) ([]domain.SectionAssignment, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	out, err := q.Store.SectionAssignments(ctx, p.Scope())
	if out == nil {
		out = []domain.SectionAssignment{}
	}
	return out, err
}

// RoomChecks is GET housekeeping/room-checks: the checks in scope, for someone who views
// housekeeping or bookings.
func (q Queries) RoomChecks(ctx context.Context) ([]json.RawMessage, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	if q.Authz.Source != nil {
		perms, err := q.Authz.Source.Permissions(ctx)
		if err != nil {
			return nil, err
		}
		if !rbac.Can(perms, p.Role, "maintenance", "view") && !rbac.Can(perms, p.Role, "booking", "view") {
			return nil, errs.Forbidden("Your role cannot see the room report.")
		}
	}
	out, err := q.Store.RoomChecks(ctx, p.Scope())
	if out == nil {
		out = []json.RawMessage{}
	}
	return out, err
}
