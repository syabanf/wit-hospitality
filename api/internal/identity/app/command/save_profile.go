package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/identity"
	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// SaveProfile lets the signed-in person change their name, email and notification choices. Role
// and scope stay as the administrator set them.
type SaveProfile struct{ Deps }

// Handle saves the profile and returns it.
func (h SaveProfile) Handle(ctx context.Context, p auth.Principal, in domain.Profile) (domain.Profile, error) {
	var out domain.Profile
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Users.EmailTaken(ctx, strings.TrimSpace(in.Email), p.UserID)
		if err != nil {
			return err
		}
		if err := domain.ValidateProfile(in, taken); err != nil {
			return err
		}
		u, err := h.Users.ByID(ctx, p.UserID)
		if err != nil {
			return err
		}
		u.Name, u.Email = strings.TrimSpace(in.Name), strings.TrimSpace(in.Email)
		u.NotifyArrivals, u.NotifyApprovals = in.NotifyArrivals, in.NotifyApprovals
		if err := h.Users.Update(ctx, &u); err != nil {
			return err
		}
		if err := h.userEvent(ctx, identity.EventUserUpdated, u); err != nil {
			return err
		}
		out = domain.ProfileOf(u)
		return h.Audit.Record(ctx, actorOf(p), audit.Line{Action: audit.Update, Entity: "user", EntityID: u.ID, Summary: fmt.Sprintf("%s edited their profile", u.Name)})
	})
	return out, err
}
