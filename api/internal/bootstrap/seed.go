package bootstrap

import (
	"context"
	"fmt"
	"log/slog"

	channelpg "github.com/syabanf/wit-hospitality/api/internal/channel/adapters/postgres"
	channelmodule "github.com/syabanf/wit-hospitality/api/internal/channel/module"
	guestpg "github.com/syabanf/wit-hospitality/api/internal/guest/adapters/postgres"
	guestmodule "github.com/syabanf/wit-hospitality/api/internal/guest/module"
	identitypg "github.com/syabanf/wit-hospitality/api/internal/identity/adapters/postgres"
	identitymodule "github.com/syabanf/wit-hospitality/api/internal/identity/module"
	ownerspg "github.com/syabanf/wit-hospitality/api/internal/owners/adapters/postgres"
	ownersmodule "github.com/syabanf/wit-hospitality/api/internal/owners/module"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	propertypg "github.com/syabanf/wit-hospitality/api/internal/property/adapters/postgres"
	propertymodule "github.com/syabanf/wit-hospitality/api/internal/property/module"
	reservationpg "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
	reservationmodule "github.com/syabanf/wit-hospitality/api/internal/reservation/module"
	"github.com/syabanf/wit-hospitality/api/seed"
)

// Seed replaces identity, property, channel, guest, reservation and owners data with the demo fixtures,
// shifted so the base date of the export becomes today, then projects the read models in process.
// It clears the shared platform tables first, so no event of an earlier run lands on the fresh
// data. Reservation loads after property's events are projected, because it reads villas from its
// catalog copy.
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
	rawGuest, err := seed.FS.ReadFile("guest.json")
	if err != nil {
		return err
	}
	guests, err := guestpg.ParseSeed(rawGuest)
	if err != nil {
		return fmt.Errorf("guest.json: %w", err)
	}
	ids, err := identitypg.ParseSeed(rawIdentity)
	if err != nil {
		return fmt.Errorf("identity.json: %w", err)
	}
	props, err := propertypg.ParseSeed(rawProperty)
	if err != nil {
		return fmt.Errorf("property.json: %w", err)
	}
	rawReservation, err := seed.FS.ReadFile("reservation.json")
	if err != nil {
		return err
	}
	stays, err := reservationpg.ParseSeed(rawReservation)
	if err != nil {
		return fmt.Errorf("reservation.json: %w", err)
	}
	rawOwners, err := seed.FS.ReadFile("owners.json")
	if err != nil {
		return err
	}
	owned, err := ownerspg.ParseSeed(rawOwners)
	if err != nil {
		return fmt.Errorf("owners.json: %w", err)
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
	if err := guestpg.Seed(ctx, d, guests, clock.DaysBetween(guests.BaseDate, today), clk.Now()); err != nil {
		return fmt.Errorf("seed guest: %w", err)
	}
	if err := ownerspg.Seed(ctx, d, owned, clock.DaysBetween(owned.BaseDate, today), today); err != nil {
		return fmt.Errorf("seed owners: %w", err)
	}
	proj := projector.New(d, log)
	perms := rbac.Static(rbac.DefaultPermissions())
	identitymodule.New(identitymodule.Deps{DB: d, Clock: clk, Log: log}).Project(proj)
	rm := reservationmodule.New(reservationmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms})
	rm.Project(proj)
	propertymodule.New(propertymodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms, Stays: rm.Stays()}).Project(proj)
	channelmodule.New(channelmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	guestmodule.New(guestmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	ownersmodule.New(ownersmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		return err
	}
	relay := &outbox.Relay{DB: d, Bus: b, Log: log}
	n, err := relay.Drain(ctx)
	if err != nil {
		return fmt.Errorf("project seed events: %w", err)
	}
	if err := reservationpg.Seed(ctx, d, stays, clock.DaysBetween(stays.BaseDate, today), clk.Now()); err != nil {
		return fmt.Errorf("seed reservation: %w", err)
	}
	m, err := relay.Drain(ctx)
	if err != nil {
		return fmt.Errorf("project reservation seed events: %w", err)
	}
	log.Info("seeded", slog.Int("users", len(ids.Users)), slog.Int("units", len(props.Units)), slog.Int("listings", len(chans.Listings)),
		slog.Int("guests", len(guests.Guests)), slog.Int("bookings", len(stays.Bookings)), slog.Int("ownerStatements", len(owned.Statements)), slog.Int("events", n+m),
		slog.Int("shiftDays", clock.DaysBetween(props.BaseDate, today)))
	return nil
}
