// Package domain holds identity's rules, ported from src/domain/access.ts, src/domain/account.ts
// and the access adapter in src/infrastructure/mock/index.ts. Errors carry the TypeScript codes.
package domain

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// User statuses.
const (
	StatusActive   = "active"
	StatusInactive = "inactive"
)

// User is a login. JSON tags give the front end's User shape.
type User struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Email       string    `json:"email"`
	Role        rbac.Role `json:"role"`
	Status      string    `json:"status"`
	LocationIDs []string  `json:"locationIds"`
	VillaIDs    []string  `json:"villaIds"`
	EmployeeID  *string   `json:"employeeId"`
	LastLoginOn *string   `json:"lastLoginOn"`
	CreatedOn   string    `json:"createdOn"`

	PasswordHash    string `json:"-"`
	NotifyArrivals  bool   `json:"-"`
	NotifyApprovals bool   `json:"-"`
	Version         int64  `json:"-"`
}

// Active reports whether the login may sign in.
func (u User) Active() bool { return u.Status == StatusActive }

// UserInput is the users form.
type UserInput struct {
	Name        string    `json:"name"`
	Email       string    `json:"email"`
	Role        rbac.Role `json:"role"`
	Status      string    `json:"status"`
	LocationIDs []string  `json:"locationIds"`
	VillaIDs    []string  `json:"villaIds"`
	EmployeeID  *string   `json:"employeeId"`
}

var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// ValidEmail is the front end's email check.
func ValidEmail(s string) bool { return emailPattern.MatchString(s) }

// ValidateUser is validateUser. emailTaken says whether another login already uses the address.
func ValidateUser(in UserInput, emailTaken bool) error {
	var f errs.Fields
	if utf8.RuneCountInString(strings.TrimSpace(in.Name)) < 2 {
		f.Add("name", "Enter the person’s name.")
	}
	if !ValidEmail(in.Email) {
		f.Add("email", "Enter a valid email address.")
	} else if emailTaken {
		f.Add("email", fmt.Sprintf("%s already has a login.", in.Email))
	}
	if !rbac.ValidRole(in.Role) {
		f.Add("role", "Pick a role.")
	}
	if in.Status != StatusActive && in.Status != StatusInactive {
		f.Add("status", "Pick a status.")
	}
	return f.Err()
}

// Apply copies the form onto the user, trimming the name.
func (u *User) Apply(in UserInput) {
	u.Name = strings.TrimSpace(in.Name)
	u.Email = strings.TrimSpace(in.Email)
	u.Role = in.Role
	u.Status = in.Status
	u.LocationIDs = nonNil(in.LocationIDs)
	u.VillaIDs = nonNil(in.VillaIDs)
	u.EmployeeID = in.EmployeeID
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return slices.Clone(s)
}

// Refusals with the mock adapter's codes and wording.
var (
	ErrInvalidCredentials = errs.New("INVALID_CREDENTIALS", "That email and password do not match.")
	ErrWrongPassword      = errs.New("INVALID_CREDENTIALS", "The current password is wrong.")
	ErrInactive           = errs.New("USER_INACTIVE", "This login is deactivated. Ask the administrator.")
	ErrOwnRole            = errs.New("ACCESS_SELF", "You cannot change your own role.")
	ErrDeactivateSelf     = errs.New("ACCESS_SELF", "You cannot deactivate yourself.")
	ErrOwnerPermissions   = errs.New("ACCESS_OWNER", "Only the owner changes the owner’s permissions.")
)

// CheckUpdate refuses a change of one's own role.
func (u User) CheckUpdate(actorID string, in UserInput) error {
	if u.ID == actorID && in.Role != u.Role {
		return ErrOwnRole
	}
	return nil
}

// CheckSetActive refuses deactivating oneself.
func (u User) CheckSetActive(actorID string, active bool) error {
	if u.ID == actorID && !active {
		return ErrDeactivateSelf
	}
	return nil
}

// LoginInput is the sign-in form.
type LoginInput struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// ValidateLogin is the application layer's login check.
func ValidateLogin(in LoginInput) error {
	var f errs.Fields
	if !ValidEmail(strings.TrimSpace(in.Email)) {
		f.Add("email", "Enter your email address.")
	}
	if in.Password == "" {
		f.Add("password", "Enter your password.")
	}
	return f.Err()
}

// PasswordChange is the change password form.
type PasswordChange struct {
	Current string `json:"current"`
	Next    string `json:"next"`
	Confirm string `json:"confirm"`
}

// ValidatePasswordChange is validatePasswordChange.
func ValidatePasswordChange(p PasswordChange) error {
	var f errs.Fields
	if p.Current == "" {
		f.Add("current", "Enter the current password.")
	}
	if utf8.RuneCountInString(p.Next) < 8 {
		f.Add("next", "Use at least 8 characters.")
	} else if p.Next == p.Current {
		f.Add("next", "Pick a password you have not used.")
	}
	if p.Confirm != p.Next {
		f.Add("confirm", "The two passwords differ.")
	}
	return f.Err()
}

// Profile is the signed-in person with their notification choices (src/domain/account.ts).
type Profile struct {
	UserID          string    `json:"userId"`
	Name            string    `json:"name"`
	Email           string    `json:"email"`
	Role            rbac.Role `json:"role"`
	LocationIDs     []string  `json:"locationIds"`
	VillaIDs        []string  `json:"villaIds"`
	EmployeeID      *string   `json:"employeeId"`
	NotifyArrivals  bool      `json:"notifyArrivals"`
	NotifyApprovals bool      `json:"notifyApprovals"`
}

// ProfileOf builds the profile view.
func ProfileOf(u User) Profile {
	return Profile{UserID: u.ID, Name: u.Name, Email: u.Email, Role: u.Role, LocationIDs: nonNil(u.LocationIDs), VillaIDs: nonNil(u.VillaIDs), EmployeeID: u.EmployeeID, NotifyArrivals: u.NotifyArrivals, NotifyApprovals: u.NotifyApprovals}
}

// ValidateProfile is validateProfile, plus the unique email the users form also demands.
func ValidateProfile(p Profile, emailTaken bool) error {
	var f errs.Fields
	if utf8.RuneCountInString(strings.TrimSpace(p.Name)) < 2 {
		f.Add("name", "Enter your name.")
	}
	if !ValidEmail(p.Email) {
		f.Add("email", "Enter a valid email address.")
	} else if emailTaken {
		f.Add("email", fmt.Sprintf("%s already has a login.", p.Email))
	}
	return f.Err()
}
