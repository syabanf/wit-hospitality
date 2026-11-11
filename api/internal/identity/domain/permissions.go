package domain

import (
	"fmt"
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// CheckPermissionEdit is the ACCESS_OWNER rule: only the owner edits the owner's row.
func CheckPermissionEdit(actor rbac.Role, role rbac.Role) error {
	if role == "owner" && actor != "owner" {
		return ErrOwnerPermissions
	}
	return nil
}

// NormalizeRolePermissions checks a role's row from the roles page and returns it with every
// module present, each list in the module's action order and cut to the actions it offers.
func NormalizeRolePermissions(role rbac.Role, in map[rbac.Module][]rbac.Action) (map[rbac.Module][]rbac.Action, error) {
	if !rbac.ValidRole(role) {
		return nil, errs.Invalid("role", fmt.Sprintf("%q is not a role.", role))
	}
	for m, acts := range in {
		if !rbac.ValidModule(m) {
			return nil, errs.Invalid(string(m), fmt.Sprintf("%q is not a module.", m))
		}
		for _, a := range acts {
			if !rbac.ValidAction(a) {
				return nil, errs.Invalid(string(m), fmt.Sprintf("%q is not an action.", a))
			}
		}
	}
	out := map[rbac.Module][]rbac.Action{}
	for _, m := range rbac.Modules {
		kept := []rbac.Action{}
		for _, a := range rbac.ActionsFor(m) {
			if slices.Contains(in[m], a) {
				kept = append(kept, a)
			}
		}
		out[m] = kept
	}
	return out, nil
}
