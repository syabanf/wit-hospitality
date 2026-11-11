package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/identity"
	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

// ChangePassword sets a new password after checking the current one. Other sessions of the user
// end; the one making the change stays signed in.
type ChangePassword struct{ Deps }

// Handle applies the change.
func (h ChangePassword) Handle(ctx context.Context, p auth.Principal, in domain.PasswordChange) error {
	if err := domain.ValidatePasswordChange(in); err != nil {
		return err
	}
	u, err := h.Users.ByID(ctx, p.UserID)
	if err != nil {
		return err
	}
	ok, err := auth.VerifyPassword(u.PasswordHash, in.Current)
	if err != nil {
		return err
	}
	if !ok {
		return domain.ErrWrongPassword
	}
	hash, err := auth.HashPassword(in.Next)
	if err != nil {
		return err
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		now := h.Clock.Now()
		if err := h.Users.SetPassword(ctx, u.ID, hash); err != nil {
			return err
		}
		if err := h.Sessions.RevokeUserSessions(ctx, u.ID, p.SessionID, now); err != nil {
			return err
		}
		if err := outbox.Append(ctx, h.DB.Q(ctx), now, outbox.Event{Type: identity.EventPasswordChanged, AggregateType: "user", AggregateID: u.ID, AggregateVersion: u.Version, Payload: identity.PasswordChanged{UserID: u.ID}}); err != nil {
			return err
		}
		return h.Audit.Record(ctx, actorOf(p), audit.Line{Action: audit.Update, Entity: "user", EntityID: u.ID, Summary: fmt.Sprintf("%s changed their password", u.Name)})
	})
}
