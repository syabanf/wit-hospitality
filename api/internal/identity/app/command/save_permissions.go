package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/identity"
	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// SavePermissions replaces one role's row of the matrix and returns the whole matrix.
type SavePermissions struct{ Deps }

// Handle needs access/edit; only the owner edits the owner's row.
func (h SavePermissions) Handle(ctx context.Context, p auth.Principal, role rbac.Role, modules map[rbac.Module][]rbac.Action) (rbac.Permissions, error) {
	if err := h.Authz.Require(ctx, p.Role, rbac.Need{Module: "access", Action: "edit"}); err != nil {
		return nil, err
	}
	if err := domain.CheckPermissionEdit(p.Role, role); err != nil {
		return nil, err
	}
	row, err := domain.NormalizeRolePermissions(role, modules)
	if err != nil {
		return nil, err
	}
	var all rbac.Permissions
	err = h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Permissions.Save(ctx, role, row); err != nil {
			return err
		}
		payload := identity.PermissionsSaved{Role: string(role), Modules: map[string][]string{}}
		for m, acts := range row {
			list := []string{}
			for _, a := range acts {
				list = append(list, string(a))
			}
			payload.Modules[string(m)] = list
		}
		if err := outbox.Append(ctx, h.DB.Q(ctx), h.Clock.Now(), outbox.Event{Type: identity.EventPermissionsSaved, AggregateType: "role", AggregateID: string(role), Payload: payload}); err != nil {
			return err
		}
		if err := h.Audit.Record(ctx, actorOf(p), audit.Line{Action: audit.Update, Entity: "permissions", EntityID: string(role), Summary: fmt.Sprintf("Changed the permissions of %s", rbac.RoleLabel[role])}); err != nil {
			return err
		}
		all, err = h.Permissions.All(ctx)
		return err
	})
	return all, err
}
