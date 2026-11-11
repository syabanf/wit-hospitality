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
	payrollpg "github.com/syabanf/wit-hospitality/api/internal/payroll/adapters/postgres"
	payrollmodule "github.com/syabanf/wit-hospitality/api/internal/payroll/module"
	peoplepg "github.com/syabanf/wit-hospitality/api/internal/people/adapters/postgres"
	peoplemodule "github.com/syabanf/wit-hospitality/api/internal/people/module"
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
	servicespg "github.com/syabanf/wit-hospitality/api/internal/services/adapters/postgres"
	servicesmodule "github.com/syabanf/wit-hospitality/api/internal/services/module"
	"github.com/syabanf/wit-hospitality/api/seed"
)

// Seed replaces identity, property, channel, guest, reservation, services, people and payroll data
// with the demo fixtures, shifted so the base date of the export becomes today, then projects the
// read models in process. It clears the shared platform tables first, so no event of an earlier run
// lands on the fresh data. Reservation and services load after property's events are projected,
// because they read villas and units from their catalog copies.
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
	rawServices, err := seed.FS.ReadFile("services.json")
	if err != nil {
		return err
	}
	menu, err := servicespg.ParseSeed(rawServices)
	if err != nil {
		return fmt.Errorf("services.json: %w", err)
	}
	rawPeople, err := seed.FS.ReadFile("people.json")
	if err != nil {
		return err
	}
	rawPayroll, err := seed.FS.ReadFile("payroll.json")
	if err != nil {
		return err
	}
	staff, err := peoplepg.ParseSeed(rawPeople)
	if err != nil {
		return fmt.Errorf("people.json: %w", err)
	}
	pay, err := payrollpg.ParseSeed(rawPayroll)
	if err != nil {
		return fmt.Errorf("payroll.json: %w", err)
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
	villaLocations := map[string]string{}
	for _, v := range props.Villas {
		villaLocations[v.ID] = v.LocationID
	}
	if err := peoplepg.Seed(ctx, d, staff, clock.ShiftFor(staff.BaseDate, today), villaLocations, clk.Now()); err != nil {
		return fmt.Errorf("seed people: %w", err)
	}
	if err := payrollpg.Seed(ctx, d, pay, clock.ShiftFor(pay.BaseDate, today), clk.Now()); err != nil {
		return fmt.Errorf("seed payroll: %w", err)
	}
	proj := projector.New(d, log)
	perms := rbac.Static(rbac.DefaultPermissions())
	identitymodule.New(identitymodule.Deps{DB: d, Clock: clk, Log: log}).Project(proj)
	rm := reservationmodule.New(reservationmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms})
	rm.Project(proj)
	propertymodule.New(propertymodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms, Stays: rm.Stays()}).Project(proj)
	channelmodule.New(channelmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	guestmodule.New(guestmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	servicesmodule.New(servicesmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms, Stays: rm.StayLookup()}).Project(proj)
	peoplemodule.New(peoplemodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	payrollmodule.New(payrollmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	if err := seedOperations(ctx, d, log, clk, proj); err != nil {
		return err
	}
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
	if err := servicespg.Seed(ctx, d, menu, clock.DaysBetween(menu.BaseDate, today), clk.Now()); err != nil {
		return fmt.Errorf("seed services: %w", err)
	}
	m, err := relay.Drain(ctx)
	if err != nil {
		return fmt.Errorf("project reservation seed events: %w", err)
	}
	log.Info("seeded", slog.Int("users", len(ids.Users)), slog.Int("units", len(props.Units)), slog.Int("listings", len(chans.Listings)),
		slog.Int("guests", len(guests.Guests)), slog.Int("bookings", len(stays.Bookings)), slog.Int("menuItems", len(menu.Menu)), slog.Int("orders", len(menu.Orders)),
		slog.Int("employees", len(staff.Employees)), slog.Int("periods", len(pay.Periods)), slog.Int("events", n+m),
		slog.Int("shiftDays", clock.DaysBetween(props.BaseDate, today)))
	return nil
}
