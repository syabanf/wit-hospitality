package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/identity"
	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// SetUserActive activates or deactivates a login. Nobody deactivates themselves; a deactivated
// login loses its sessions at once.
type SetUserActive struct{ Deps }

// Handle needs access/edit.
func (h SetUserActive) Handle(ctx context.Context, p auth.Principal, id string, active bool) (domain.User, error) {
	if err := h.Authz.Require(ctx, p.Role, rbac.Need{Module: "access", Action: "edit"}); err != nil {
		return domain.User{}, err
	}
	var u domain.User
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if u, err = h.Users.ByID(ctx, id); err != nil {
			return err
		}
		if err := u.CheckSetActive(p.UserID, active); err != nil {
			return err
		}
		before := u.Status
		u.Status = domain.StatusInactive
		verb := "Deactivated"
		if active {
			u.Status, verb = domain.StatusActive, "Activated"
		}
		if err := h.Users.Update(ctx, &u); err != nil {
			return err
		}
		if !active {
			if err := h.Sessions.RevokeUserSessions(ctx, u.ID, "", h.Clock.Now()); err != nil {
				return err
			}
		}
		if err := h.userEvent(ctx, identity.EventUserUpdated, u); err != nil {
			return err
		}
		return h.Audit.Record(ctx, actorOf(p), audit.Line{Action: audit.Update, Entity: "user", EntityID: id, Summary: fmt.Sprintf("%s %s", verb, u.Name), Before: map[string]any{"status": before}, After: map[string]any{"status": u.Status}})
	})
	return u, err
}
