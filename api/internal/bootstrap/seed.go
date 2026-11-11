package bootstrap

import (
	"context"
	"fmt"
	"log/slog"

	channelpg "github.com/syabanf/wit-hospitality/api/internal/channel/adapters/postgres"
	channelmodule "github.com/syabanf/wit-hospitality/api/internal/channel/module"
	identitypg "github.com/syabanf/wit-hospitality/api/internal/identity/adapters/postgres"
	identitymodule "github.com/syabanf/wit-hospitality/api/internal/identity/module"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	propertypg "github.com/syabanf/wit-hospitality/api/internal/property/adapters/postgres"
	propertymodule "github.com/syabanf/wit-hospitality/api/internal/property/module"
	"github.com/syabanf/wit-hospitality/api/seed"
)

// Seed replaces identity, property and channel data with the demo fixtures, shifted so the base date of
// the export becomes today, then projects the read models in process. It clears the shared
// platform tables first, so no event of an earlier run lands on the fresh data.
func Seed(ctx context.Context, d *db.DB, log *slog.Logger, clk clock.Clock) error {
	rawIdentity, err := seed.FS.ReadFile("identity.json")
	if err != nil {
		return err
	}
	rawProperty, err := seed.FS.ReadFile("property.json")
	if err != nil {
		return err
	}
	rawChannel, err := seed.FS.ReadFile("channel.json")
	if err != nil {
		return err
	}
	chans, err := channelpg.ParseSeed(rawChannel)
	if err != nil {
		return fmt.Errorf("channel.json: %w", err)
	}
	ids, err := identitypg.ParseSeed(rawIdentity)
	if err != nil {
		return fmt.Errorf("identity.json: %w", err)
	}
	props, err := propertypg.ParseSeed(rawProperty)
	if err != nil {
		return fmt.Errorf("property.json: %w", err)
	}
	today := clock.Today(clk)
	if _, err := d.Pool.Exec(ctx, `TRUNCATE platform.outbox, platform.processed_events, platform.audit_log, platform.idempotency_keys RESTART IDENTITY`); err != nil {
		return err
	}
	if err := identitypg.Seed(ctx, d, ids, clock.DaysBetween(ids.BaseDate, today)); err != nil {
		return fmt.Errorf("seed identity: %w", err)
	}
	if err := propertypg.Seed(ctx, d, props, clock.DaysBetween(props.BaseDate, today), clk.Now()); err != nil {
		return fmt.Errorf("seed property: %w", err)
	}
	if err := channelpg.Seed(ctx, d, chans, clock.DaysBetween(chans.BaseDate, today), clk.Now()); err != nil {
		return fmt.Errorf("seed channel: %w", err)
	}
	proj := projector.New(d, log)
	identitymodule.New(identitymodule.Deps{DB: d, Clock: clk, Log: log}).Project(proj)
	propertymodule.New(propertymodule.Deps{DB: d, Clock: clk, Log: log, Permissions: rbac.Static(rbac.DefaultPermissions())}).Project(proj)
	channelmodule.New(channelmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: rbac.Static(rbac.DefaultPermissions())}).Project(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		return err
	}
	n, err := (&outbox.Relay{DB: d, Bus: b, Log: log}).Drain(ctx)
	if err != nil {
		return fmt.Errorf("project seed events: %w", err)
	}
	log.Info("seeded", slog.Int("users", len(ids.Users)), slog.Int("units", len(props.Units)), slog.Int("listings", len(chans.Listings)), slog.Int("events", n), slog.Int("shiftDays", clock.DaysBetween(props.BaseDate, today)))
	return nil
}
