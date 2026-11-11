// Package query holds the messaging context's read side: the outbox of guest messages, filtered
// to the stays in the caller's scope, and the settings. The console joins stays and guests itself.
package query

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/messaging/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ReadStore reads the outbox and the settings.
type ReadStore interface {
	// Messages lists messages in scope, oldest first; cityLedger adds the city ledger invoices,
	// which belong to no villa.
	Messages(ctx context.Context, s rbac.Scope, cityLedger bool) ([]json.RawMessage, error)
	Settings(ctx context.Context) (domain.Settings, int64, error)
}

// Queries bundles the read handlers.
type Queries struct {
	Store ReadStore
	Authz rbac.Authorizer
}

var bookingView = rbac.Need{Module: "booking", Action: "view"}

// Messages is GET messages; finance also reads the city ledger invoices.
func (q Queries) Messages(ctx context.Context) ([]json.RawMessage, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	if err := q.Authz.Require(ctx, p.Role, bookingView); err != nil {
		return nil, err
	}
	perms, err := q.Authz.Source.Permissions(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Messages(ctx, p.Scope(), rbac.Can(perms, p.Role, "finance", "view"))
}

// Settings is GET messages/settings.
func (q Queries) Settings(ctx context.Context) (domain.Settings, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return domain.Settings{}, err
	}
	if err := q.Authz.Require(ctx, p.Role, bookingView); err != nil {
		return domain.Settings{}, err
	}
	s, _, err := q.Store.Settings(ctx)
	return s, err
}
