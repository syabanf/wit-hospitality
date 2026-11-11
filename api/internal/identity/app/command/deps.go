// Package command holds identity's write side: one handler per command. Each handler loads,
// applies the domain rules, saves, appends its events and its audit line in one transaction.
package command

import (
	"context"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/identity"
	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Users is the write repository of logins.
type Users interface {
	ByEmail(ctx context.Context, email string) (*domain.User, error)
	ByID(ctx context.Context, id string) (domain.User, error)
	EmailTaken(ctx context.Context, email, excludeID string) (bool, error)
	Insert(ctx context.Context, u domain.User) error
	// Update saves u if its Version is current and bumps the version.
	Update(ctx context.Context, u *domain.User) error
	SetPassword(ctx context.Context, id, hash string) error
	TouchLogin(ctx context.Context, id, date string) error
}

// Sessions stores sessions and their refresh tokens.
type Sessions interface {
	Create(ctx context.Context, id, userID, userAgent string, at time.Time) error
	InsertToken(ctx context.Context, t domain.RefreshToken) error
	TokenByHash(ctx context.Context, hash string) (*domain.RefreshToken, error)
	// MarkRotated retires a token unless another request already did; it reports whether this call won.
	MarkRotated(ctx context.Context, tokenID, replacedBy string, at time.Time) (bool, error)
	RevokeSession(ctx context.Context, sessionID string, at time.Time) error
	RevokeUserSessions(ctx context.Context, userID, exceptSessionID string, at time.Time) error
	SessionActive(ctx context.Context, sessionID string) (bool, error)
}

// Permissions stores the matrix.
type Permissions interface {
	All(ctx context.Context) (rbac.Permissions, error)
	Save(ctx context.Context, role rbac.Role, modules map[rbac.Module][]rbac.Action) error
}

// Deps is what every identity command needs.
type Deps struct {
	DB              *db.DB
	Users           Users
	Sessions        Sessions
	Permissions     Permissions
	Audit           audit.Recorder
	Clock           clock.Clock
	Issuer          auth.Issuer
	Authz           rbac.Authorizer
	RefreshTTL      time.Duration
	InitialPassword string
}

func actorOf(p auth.Principal) audit.Actor {
	return audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}
}

func actorUser(u domain.User) audit.Actor {
	return audit.Actor{ID: u.ID, Name: u.Name, Role: string(u.Role)}
}

// principalOf builds the token claims from a user.
func principalOf(u domain.User, sessionID string) auth.Principal {
	loc, vil := u.LocationIDs, u.VillaIDs
	if loc == nil {
		loc = []string{}
	}
	if vil == nil {
		vil = []string{}
	}
	return auth.Principal{UserID: u.ID, Name: u.Name, Email: u.Email, Role: u.Role, LocationIDs: loc, VillaIDs: vil, EmployeeID: u.EmployeeID, SessionID: sessionID}
}

// snapshot is the published view of a user.
func snapshot(u domain.User) identity.UserSnapshot {
	return identity.UserSnapshot{ID: u.ID, Name: u.Name, Email: u.Email, Role: string(u.Role), Status: u.Status, LocationIDs: u.LocationIDs, VillaIDs: u.VillaIDs, EmployeeID: u.EmployeeID}
}

func (d Deps) userEvent(ctx context.Context, eventType string, u domain.User) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{
		Type: eventType, AggregateType: "user", AggregateID: u.ID, AggregateVersion: u.Version,
		Payload: identity.UserEvent{User: snapshot(u)},
	})
}
