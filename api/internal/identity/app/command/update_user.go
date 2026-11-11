package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/identity"
	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// UpdateUser edits a login. Nobody changes their own role.
type UpdateUser struct{ Deps }

type accessFields struct {
	Role        rbac.Role `json:"role"`
	Status      string    `json:"status"`
	LocationIDs []string  `json:"locationIds"`
	VillaIDs    []string  `json:"villaIds"`
}

func accessOf(u domain.User) accessFields {
	return accessFields{Role: u.Role, Status: u.Status, LocationIDs: slices.Clone(u.LocationIDs), VillaIDs: slices.Clone(u.VillaIDs)}
}

// Handle needs access/edit.
func (h UpdateUser) Handle(ctx context.Context, p auth.Principal, id string, in domain.UserInput) (domain.User, error) {
	if err := h.Authz.Require(ctx, p.Role, rbac.Need{Module: "access", Action: "edit"}); err != nil {
		return domain.User{}, err
	}
	var u domain.User
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Users.EmailTaken(ctx, strings.TrimSpace(in.Email), id)
		if err != nil {
			return err
		}
		if err := domain.ValidateUser(in, taken); err != nil {
			return err
		}
		if u, err = h.Users.ByID(ctx, id); err != nil {
			return err
		}
		if err := u.CheckUpdate(p.UserID, in); err != nil {
			return err
		}
		before := accessOf(u)
		u.Apply(in)
		if err := h.Users.Update(ctx, &u); err != nil {
			return err
		}
		if before.Status == domain.StatusActive && !u.Active() {
			if err := h.Sessions.RevokeUserSessions(ctx, u.ID, "", h.Clock.Now()); err != nil {
				return err
			}
		}
		if err := h.userEvent(ctx, identity.EventUserUpdated, u); err != nil {
			return err
		}
		return h.Audit.Record(ctx, actorOf(p), audit.Line{Action: audit.Update, Entity: "user", EntityID: id, Summary: fmt.Sprintf("Edited login %s", u.Name), Before: before, After: accessOf(u)})
	})
	return u, err
}
