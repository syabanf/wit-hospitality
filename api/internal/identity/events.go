// Package identity is the published language of the identity and access context: the events it
// publishes. Other contexts may import this package and nothing below it.
package identity

// Event types. The suffix is the payload version; a breaking payload change gets a new name.
const (
	EventUserCreated      = "identity.user.created.v1"
	EventUserUpdated      = "identity.user.updated.v1"
	EventPasswordChanged  = "identity.user.password_changed.v1"
	EventPermissionsSaved = "identity.permissions.saved.v1"
)

// UserSnapshot is a login as other contexts see it.
type UserSnapshot struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Email       string   `json:"email"`
	Role        string   `json:"role"`
	Status      string   `json:"status"`
	LocationIDs []string `json:"locationIds"`
	VillaIDs    []string `json:"villaIds"`
	EmployeeID  *string  `json:"employeeId"`
}

// UserEvent is the payload of user.created and user.updated.
type UserEvent struct {
	User UserSnapshot `json:"user"`
}

// PasswordChanged names the user only.
type PasswordChanged struct {
	UserID string `json:"userId"`
}

// PermissionsSaved carries one role's row of the matrix.
type PermissionsSaved struct {
	Role    string              `json:"role"`
	Modules map[string][]string `json:"modules"`
}
