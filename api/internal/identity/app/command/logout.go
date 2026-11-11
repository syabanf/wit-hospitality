package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// Logout ends the session of the signed-in user, or the one the refresh cookie names.
type Logout struct{ Deps }

// Handle revokes the session. Without a session it does nothing, like the mock.
func (h Logout) Handle(ctx context.Context, p *auth.Principal, refreshToken string) error {
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		now := h.Clock.Now()
		sessionID := ""
		if p != nil {
			sessionID = p.SessionID
		} else if refreshToken != "" {
			rt, err := h.Sessions.TokenByHash(ctx, domain.HashToken(refreshToken))
			if err != nil {
				return err
			}
			if rt != nil {
				sessionID = rt.SessionID
			}
		}
		if sessionID != "" {
			if err := h.Sessions.RevokeSession(ctx, sessionID, now); err != nil {
				return err
			}
		}
		if p == nil {
			return nil
		}
		return h.Audit.Record(ctx, actorOf(*p), audit.Line{Action: audit.Logout, Entity: "session", EntityID: p.UserID, Summary: fmt.Sprintf("%s signed out", p.Name)})
	})
}
