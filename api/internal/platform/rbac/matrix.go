// Package rbac is the permission matrix ported from src/domain/access.ts: roles, modules, actions,
// DEFAULT_PERMISSIONS as data, Can, and the villa and location scope rules. The snapshot test
// keeps it equal to the TypeScript matrix.
package rbac

import "slices"

// Role, Module and Action match the TypeScript string unions.
type (
	Role   string
	Module string
	Action string
)

// Roles in the order the front end lists them.
var Roles = []Role{"owner", "management", "finance", "hr", "reservation", "manager", "staff", "admin", "investor"}

// Modules in the order the front end lists them.
var Modules = []Module{"dashboard", "property", "airbnb", "booking", "guest", "services", "maintenance", "payments", "finance", "approval", "hr", "payroll", "reports", "access", "master", "me", "portal"}

// Actions in the order the front end lists them.
var Actions = []Action{"view", "create", "edit", "submit", "approve", "post", "report", "catalog", "comp"}

// RoleLabel is ROLE_LABEL.
var RoleLabel = map[Role]string{
	"owner": "Owner", "management": "Management", "finance": "Finance", "hr": "HR", "reservation": "Reservation",
	"manager": "Villa manager", "staff": "Staff", "admin": "Administrator", "investor": "Villa owner",
}

// ModuleLabel is MODULE_LABEL.
var ModuleLabel = map[Module]string{
	"dashboard": "Dashboard", "property": "Property", "airbnb": "Airbnb", "booking": "Booking", "guest": "Guest",
	"services": "Room services", "finance": "Finance", "approval": "Approval", "hr": "HR", "payroll": "Payroll",
	"reports": "Reports", "access": "Access and security", "master": "Master data", "me": "Employee area",
	"maintenance": "Maintenance", "payments": "Payments", "portal": "Owner portal",
}

// moduleOnly lists actions that mean something in one module only.
var moduleOnly = map[Action]Module{"catalog": "services", "comp": "services"}

// ActionsFor is actionsFor: the actions a module offers.
func ActionsFor(m Module) []Action {
	var out []Action
	for _, a := range Actions {
		if only, ok := moduleOnly[a]; !ok || only == m {
			out = append(out, a)
		}
	}
	return out
}

// Permissions is, per role and module, the actions the role may take.
type Permissions map[Role]map[Module][]Action

// ValidRole, ValidModule and ValidAction check names from a request.
func ValidRole(r Role) bool     { return slices.Contains(Roles, r) }
func ValidModule(m Module) bool { return slices.Contains(Modules, m) }
func ValidAction(a Action) bool { return slices.Contains(Actions, a) }

// Can is `can` in access.ts.
func Can(p Permissions, role Role, m Module, a Action) bool {
	return slices.Contains(p[role][m], a)
}

// PortalOnly is a role that reaches the owner portal and no operational module.
func PortalOnly(p Permissions, role Role) bool {
	if !Can(p, role, "portal", "view") {
		return false
	}
	for _, m := range Modules {
		if m != "portal" && len(p[role][m]) > 0 {
			return false
		}
	}
	return true
}

var (
	all  = Actions
	read = []Action{"view"}
	work = []Action{"view", "create", "edit", "submit"}
	none = []Action{}
)

func with(base []Action, more ...Action) []Action {
	return append(append([]Action{}, base...), more...)
}

func grant(pick func(Module) []Action) map[Module][]Action {
	out := map[Module][]Action{}
	for _, m := range Modules {
		out[m] = pick(m)
	}
	return out
}

func is(m Module, names ...Module) bool { return slices.Contains(names, m) }

var maintenance = map[Role][]Action{"owner": all, "admin": all, "manager": all, "staff": work, "finance": {"view", "report"}, "management": {"view", "report"}, "hr": read, "reservation": read, "investor": none}
var payments = map[Role][]Action{"owner": all, "admin": all, "finance": all, "management": {"view", "report"}, "manager": {"view", "create", "submit"}, "reservation": {"view", "create", "submit"}, "staff": {"view", "create"}, "hr": none, "investor": none}
var services = map[Role][]Action{"owner": all, "admin": all, "manager": with(work, "approve", "catalog", "comp"), "management": with(work, "report"), "staff": work, "reservation": {"view", "create"}, "finance": {"view", "report"}, "hr": none, "investor": none}
var portal = map[Role][]Action{"investor": {"view", "create"}, "owner": none, "admin": none, "manager": none, "staff": none, "finance": none, "management": none, "hr": none, "reservation": none}

var base = map[Role]func(Module) []Action{
	"owner": func(Module) []Action { return all },
	"admin": func(m Module) []Action {
		if is(m, "payroll", "finance") {
			return with(work, "report")
		}
		return all
	},
	"management": func(m Module) []Action {
		switch {
		case m == "access":
			return none
		case is(m, "finance", "payroll"):
			return []Action{"view", "approve", "report"}
		case is(m, "reports", "dashboard"):
			return []Action{"view", "report"}
		}
		return work
	},
	"finance": func(m Module) []Action {
		switch {
		case is(m, "finance", "approval"):
			return all
		case m == "payroll":
			return []Action{"view", "approve", "post", "report"}
		case is(m, "reports", "dashboard"):
			return []Action{"view", "report"}
		case is(m, "access", "hr"):
			return none
		}
		return read
	},
	"hr": func(m Module) []Action {
		switch {
		case is(m, "hr", "payroll"):
			return with(work, "approve", "report")
		case m == "me":
			return all
		case m == "reports":
			return []Action{"view", "report"}
		case m == "dashboard":
			return read
		}
		return none
	},
	"reservation": func(m Module) []Action {
		switch {
		case m == "booking":
			return with(work, "post")
		case is(m, "guest", "airbnb"):
			return work
		case is(m, "dashboard", "property", "services", "me"):
			return read
		case m == "reports":
			return []Action{"view", "report"}
		}
		return none
	},
	"manager": func(m Module) []Action {
		switch {
		case is(m, "access", "payroll"):
			return none
		case m == "approval", m == "hr":
			return []Action{"view", "approve"}
		case m == "finance":
			return work
		case m == "reports":
			return []Action{"view", "report"}
		case m == "master":
			return read
		case m == "me":
			return all
		case m == "booking":
			return with(work, "approve", "post")
		case m == "guest":
			return with(work, "approve")
		}
		return work
	},
	"staff": func(m Module) []Action {
		switch {
		case is(m, "booking", "guest", "services", "finance"):
			return work
		case is(m, "dashboard", "property"):
			return read
		case m == "me":
			return all
		}
		return none
	},
	"investor": func(Module) []Action { return none },
}

// DefaultPermissions is DEFAULT_PERMISSIONS: the base matrix, the maintenance, payments, services and
// portal overrides, then each module's list cut to the actions that module offers.
func DefaultPermissions() Permissions {
	out := Permissions{}
	for _, r := range Roles {
		perms := grant(base[r])
		perms["maintenance"] = maintenance[r]
		perms["payments"] = payments[r]
		perms["services"] = services[r]
		perms["portal"] = portal[r]
		out[r] = grant(func(m Module) []Action {
			offered := ActionsFor(m)
			kept := []Action{}
			for _, a := range perms[m] {
				if slices.Contains(offered, a) {
					kept = append(kept, a)
				}
			}
			return kept
		})
	}
	return out
}
