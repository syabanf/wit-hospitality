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
}

// Queries bundles the read handlers; every signed-in user reads their own scope.
type Queries struct{ Store ReadStore }

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
