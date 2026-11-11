// Package query holds identity's read side. Handlers read the identity schema's views
// (v_users, v_permissions) and the projected audit trail; they hold no domain logic beyond the
// permission check a read needs.
package query

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ReadStore reads identity's read models.
type ReadStore interface {
	User(ctx context.Context, id string) (*domain.User, error)
	Users(ctx context.Context) ([]domain.User, error)
	Permissions(ctx context.Context) (rbac.Permissions, error)
	AuditTrail(ctx context.Context) ([]audit.Entry, error)
}

// Queries bundles the read handlers.
type Queries struct {
	Store ReadStore
	Authz rbac.Authorizer
}

// Session is GET /auth/session: the signed-in user, or nil when there is none or the login was
// deactivated since the token was issued.
func (q Queries) Session(ctx context.Context) (*domain.User, error) {
	p, ok := auth.FromContext(ctx)
	if !ok {
		return nil, nil
	}
	u, err := q.Store.User(ctx, p.UserID)
	if err != nil || u == nil || !u.Active() {
		return nil, err
	}
	return u, nil
}

// Users is GET /users; it needs access/view.
func (q Queries) Users(ctx context.Context) ([]domain.User, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	if err := q.Authz.Require(ctx, p.Role, rbac.Need{Module: "access", Action: "view"}); err != nil {
		return nil, err
	}
	return q.Store.Users(ctx)
}

// Permissions is GET /permissions; every signed-in user reads it, the shell needs it.
func (q Queries) Permissions(ctx context.Context) (rbac.Permissions, error) {
	if _, err := auth.Require(ctx); err != nil {
		return nil, err
	}
	return q.Store.Permissions(ctx)
}

// Audit is GET /audit, newest first; it needs access/view.
func (q Queries) Audit(ctx context.Context) ([]audit.Entry, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	if err := q.Authz.Require(ctx, p.Role, rbac.Need{Module: "access", Action: "view"}); err != nil {
		return nil, err
	}
	return q.Store.AuditTrail(ctx)
}

// Profile is GET /me.
func (q Queries) Profile(ctx context.Context) (domain.Profile, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return domain.Profile{}, err
	}
	u, err := q.Store.User(ctx, p.UserID)
	if err != nil {
		return domain.Profile{}, err
	}
	if u == nil {
		return domain.Profile{}, errs.Unauthenticated()
	}
	return domain.ProfileOf(*u), nil
}
