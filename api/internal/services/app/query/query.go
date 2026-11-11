// Package query holds the services context's read side. Handlers read the write tables of the
// services schema (each row keeps the console's JSON), narrowed to the signed-in user's villa and
// location scope, in creation order. They hold no domain logic.
package query

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Tables the reads serve.
const (
	MenuItems = "menu_items"
	Partners  = "partners"
	Orders    = "orders"
	Requests  = "requests"
)

// ReadStore reads one table narrowed to a scope; partners belong to no villa and read in full.
type ReadStore interface {
	Docs(ctx context.Context, table string, s rbac.Scope) ([]json.RawMessage, error)
}

// Queries bundles the read handlers. Every signed-in user reads the records of their own scope,
// as the console's catalog() narrows them.
type Queries struct{ Store ReadStore }

// List is GET on one of the tables.
func (q Queries) List(ctx context.Context, table string) ([]json.RawMessage, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Docs(ctx, table, p.Scope())
}
