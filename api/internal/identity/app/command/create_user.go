package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/identity"
	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// CreateUser adds a login with the initial password (the mock's welcome123 unless configured).
type CreateUser struct{ Deps }

// Handle needs access/create.
func (h CreateUser) Handle(ctx context.Context, p auth.Principal, in domain.UserInput) (domain.User, error) {
	if err := h.Authz.Require(ctx, p.Role, rbac.Need{Module: "access", Action: "create"}); err != nil {
		return domain.User{}, err
	}
	hash, err := auth.HashPassword(h.InitialPassword)
	if err != nil {
		return domain.User{}, err
	}
	var u domain.User
	err = h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Users.EmailTaken(ctx, strings.TrimSpace(in.Email), "")
		if err != nil {
			return err
		}
		if err := domain.ValidateUser(in, taken); err != nil {
			return err
		}
		u = domain.User{ID: ids.New("usr", in.Name), CreatedOn: clock.Today(h.Clock), PasswordHash: hash, NotifyArrivals: true, NotifyApprovals: true, Version: 1}
		u.Apply(in)
		if err := h.Users.Insert(ctx, u); err != nil {
			return err
		}
		if err := h.userEvent(ctx, identity.EventUserCreated, u); err != nil {
			return err
		}
		return h.Audit.Record(ctx, actorOf(p), audit.Line{Action: audit.Create, Entity: "user", EntityID: u.ID, Summary: fmt.Sprintf("Added login for %s as %s", u.Name, rbac.RoleLabel[u.Role])})
	})
	return u, err
}
