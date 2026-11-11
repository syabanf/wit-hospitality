package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
)

// Refresh rotates a refresh token. It implements auth.Refresher, so the middleware of any context
// running in this process renews sessions through it.
type Refresh struct{ Deps }

// Refresh returns a new access token, with a new refresh token unless a sibling request rotated the
// presented one inside the grace window. An old token presented after the window revokes the
// session: someone else holds a copy.
func (h Refresh) Refresh(ctx context.Context, token string) (auth.Session, error) {
	if token == "" {
		return auth.Session{}, errs.Unauthenticated()
	}
	var s auth.Session
	var outcome error
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		now := h.Clock.Now()
		rt, err := h.Sessions.TokenByHash(ctx, domain.HashToken(token))
		if err != nil {
			return err
		}
		if rt == nil {
			outcome = errs.Unauthenticated()
			return nil
		}
		active, err := h.Sessions.SessionActive(ctx, rt.SessionID)
		if err != nil {
			return err
		}
		if !active {
			outcome = errs.Unauthenticated()
			return nil
		}
		u, err := h.Users.ByID(ctx, rt.UserID)
		if err != nil {
			return err
		}
		if !u.Active() {
			outcome = domain.ErrInactive
			return h.Sessions.RevokeSession(ctx, rt.SessionID, now)
		}
		switch rt.Decide(now) {
		case domain.Reject:
			outcome = errs.Unauthenticated()
			return nil
		case domain.Theft:
			outcome = errs.Unauthenticated()
			return h.Sessions.RevokeSession(ctx, rt.SessionID, now)
		case domain.Reuse:
			s, err = h.issue(ctx, u, rt.SessionID, now, "")
			return err
		}
		next := ids.Random("rtk")
		won, err := h.Sessions.MarkRotated(ctx, rt.ID, next, now)
		if err != nil {
			return err
		}
		if !won {
			s, err = h.issue(ctx, u, rt.SessionID, now, "")
			return err
		}
		s, err = h.issue(ctx, u, rt.SessionID, now, next)
		return err
	})
	if err != nil {
		return auth.Session{}, err
	}
	if outcome != nil {
		return auth.Session{}, outcome
	}
	return s, nil
}
