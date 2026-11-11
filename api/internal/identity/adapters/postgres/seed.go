package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// SeedData is seed/identity.json, written by scripts/export-seed.mjs from the mock's buildState.
type SeedData struct {
	BaseDate     string                                      `json:"baseDate"`
	DemoPassword string                                      `json:"demoPassword"`
	Users        []domain.User                               `json:"users"`
	Permissions  map[rbac.Role]map[rbac.Module][]rbac.Action `json:"permissions"`
	Preferences  struct {
		NotifyArrivals  bool `json:"notifyArrivals"`
		NotifyApprovals bool `json:"notifyApprovals"`
	} `json:"preferences"`
	Audit []audit.Entry `json:"audit"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

func shift(date string, days int) string {
	if date == "" || days == 0 {
		return date
	}
	return clock.AddDays(date, days)
}

// Seed replaces identity's data with the fixture, moving every date by shiftDays so the demo
// reads as if it were exported today. Every login gets the demo password.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int) error {
	if data.DemoPassword == "" {
		return fmt.Errorf("identity seed has no demoPassword")
	}
	hashes := make([]string, len(data.Users))
	for i := range data.Users {
		h, err := auth.HashPassword(data.DemoPassword)
		if err != nil {
			return err
		}
		hashes[i] = h
	}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE identity.refresh_tokens, identity.sessions, identity.users, identity.role_permissions, identity.audit_trail RESTART IDENTITY CASCADE`); err != nil {
			return err
		}
		users := Users{DB: d}
		for i, u := range data.Users {
			if u.LastLoginOn != nil {
				v := shift(*u.LastLoginOn, shiftDays)
				u.LastLoginOn = &v
			}
			u.CreatedOn = shift(u.CreatedOn, shiftDays)
			u.PasswordHash = hashes[i]
			u.NotifyArrivals, u.NotifyApprovals = data.Preferences.NotifyArrivals, data.Preferences.NotifyApprovals
			u.Version = 1
			if u.LocationIDs == nil {
				u.LocationIDs = []string{}
			}
			if u.VillaIDs == nil {
				u.VillaIDs = []string{}
			}
			if err := users.Insert(ctx, u); err != nil {
				return fmt.Errorf("seed user %s: %w", u.ID, err)
			}
		}
		perms := Permissions{DB: d}
		for _, role := range rbac.Roles {
			if row, ok := data.Permissions[role]; ok {
				if err := perms.Save(ctx, role, row); err != nil {
					return err
				}
			}
		}
		// Oldest first, so the trail's insertion order matches its time order.
		for i := len(data.Audit) - 1; i >= 0; i-- {
			e := data.Audit[i]
			if len(e.At) >= 10 {
				e.At = shift(e.At[:10], shiftDays) + e.At[10:]
			}
			if err := InsertAuditEntry(ctx, q, e); err != nil {
				return fmt.Errorf("seed audit %s: %w", e.ID, err)
			}
		}
		return nil
	})
}
