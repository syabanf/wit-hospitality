package command

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
)

// Login checks the email and password and opens a session.
type Login struct{ Deps }

// Handle returns the session and the user. A wrong password on a known login writes a "denied"
// audit line in its own transaction, as the mock does.
func (h Login) Handle(ctx context.Context, in domain.LoginInput, userAgent string) (auth.Session, domain.User, error) {
	if err := domain.ValidateLogin(in); err != nil {
		return auth.Session{}, domain.User{}, err
	}
	u, err := h.Users.ByEmail(ctx, strings.ToLower(strings.TrimSpace(in.Email)))
	if err != nil {
		return auth.Session{}, domain.User{}, err
	}
	if u == nil {
		return auth.Session{}, domain.User{}, domain.ErrInvalidCredentials
	}
	ok, err := auth.VerifyPassword(u.PasswordHash, in.Password)
	if err != nil {
		return auth.Session{}, domain.User{}, fmt.Errorf("verify password: %w", err)
	}
	if !ok {
		if err := h.DB.InTx(ctx, func(ctx context.Context) error {
			return h.Audit.Record(ctx, actorUser(*u), audit.Line{Action: audit.Denied, Entity: "session", EntityID: u.ID, Summary: fmt.Sprintf("Failed sign-in for %s", u.Email)})
		}); err != nil {
			return auth.Session{}, domain.User{}, err
		}
		return auth.Session{}, domain.User{}, domain.ErrInvalidCredentials
	}
	if !u.Active() {
		return auth.Session{}, domain.User{}, domain.ErrInactive
	}
	var s auth.Session
	err = h.DB.InTx(ctx, func(ctx context.Context) error {
		today := clock.Today(h.Clock)
		if err := h.Users.TouchLogin(ctx, u.ID, today); err != nil {
			return err
		}
		u.LastLoginOn = &today
		s, err = h.open(ctx, *u, userAgent)
		if err != nil {
			return err
		}
		return h.Audit.Record(ctx, actorUser(*u), audit.Line{Action: audit.Login, Entity: "session", EntityID: u.ID, Summary: fmt.Sprintf("%s signed in", u.Name)})
	})
	return s, *u, err
}

// open starts a session with its first refresh token.
func (d Deps) open(ctx context.Context, u domain.User, userAgent string) (auth.Session, error) {
	now := d.Clock.Now()
	sessionID := ids.Random("ses")
	if err := d.Sessions.Create(ctx, sessionID, u.ID, userAgent, now); err != nil {
		return auth.Session{}, err
	}
	return d.issue(ctx, u, sessionID, now, ids.Random("rtk"))
}

// issue signs an access token and, given a refresh token id, stores and returns a new refresh token.
func (d Deps) issue(ctx context.Context, u domain.User, sessionID string, now time.Time, refreshID string) (auth.Session, error) {
	p := principalOf(u, sessionID)
	access, exp, err := d.Issuer.Issue(p, now)
	if err != nil {
		return auth.Session{}, err
	}
	s := auth.Session{Principal: p, AccessToken: access, AccessExpires: exp}
	if refreshID == "" {
		return s, nil
	}
	token := sessionID + "." + ids.Token(32)
	rt := domain.RefreshToken{ID: refreshID, SessionID: sessionID, UserID: u.ID, Hash: domain.HashToken(token), ExpiresAt: now.Add(d.RefreshTTL)}
	if err := d.Sessions.InsertToken(ctx, rt); err != nil {
		return auth.Session{}, err
	}
	s.RefreshToken, s.RefreshExpires = token, rt.ExpiresAt
	return s, nil
}
