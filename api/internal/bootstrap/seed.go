package bootstrap

import (
	"context"
	"fmt"
	"log/slog"

	billingpg "github.com/syabanf/wit-hospitality/api/internal/billing/adapters/postgres"
	billingmodule "github.com/syabanf/wit-hospitality/api/internal/billing/module"
	channelpg "github.com/syabanf/wit-hospitality/api/internal/channel/adapters/postgres"
	channelmodule "github.com/syabanf/wit-hospitality/api/internal/channel/module"
	guestpg "github.com/syabanf/wit-hospitality/api/internal/guest/adapters/postgres"
	guestmodule "github.com/syabanf/wit-hospitality/api/internal/guest/module"
	housekeepingpg "github.com/syabanf/wit-hospitality/api/internal/housekeeping/adapters/postgres"
	housekeepingmodule "github.com/syabanf/wit-hospitality/api/internal/housekeeping/module"
	identitypg "github.com/syabanf/wit-hospitality/api/internal/identity/adapters/postgres"
	identitymodule "github.com/syabanf/wit-hospitality/api/internal/identity/module"
	messagingpg "github.com/syabanf/wit-hospitality/api/internal/messaging/adapters/postgres"
	messagingmodule "github.com/syabanf/wit-hospitality/api/internal/messaging/module"
	ownerspg "github.com/syabanf/wit-hospitality/api/internal/owners/adapters/postgres"
	ownersmodule "github.com/syabanf/wit-hospitality/api/internal/owners/module"
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

// Seed replaces identity, property, channel, guest, reservation, billing, services, owners, people,
// payroll, housekeeping and messaging data with the demo fixtures, shifted so the base date of the export becomes today, then
// projects the read models in process. It clears the shared platform tables first, so no event of an
// earlier run lands on the fresh data. Reservation and services load after property's events are
// projected, because they read villas and units from their catalog copies. Billing loads last, once
// its copy of the bookings is projected.
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
	rawBilling, err := seed.FS.ReadFile("billing.json")
	if err != nil {
		return err
	}
	money, err := billingpg.ParseSeed(rawBilling)
	if err != nil {
		return fmt.Errorf("billing.json: %w", err)
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
	rawHousekeeping, err := seed.FS.ReadFile("housekeeping.json")
	if err != nil {
		return err
	}
	hk, err := housekeepingpg.ParseSeed(rawHousekeeping)
	if err != nil {
		return fmt.Errorf("housekeeping.json: %w", err)
	}
	rawMessaging, err := seed.FS.ReadFile("messaging.json")
	if err != nil {
		return err
	}
	msgs, err := messagingpg.ParseSeed(rawMessaging)
	if err != nil {
		return fmt.Errorf("messaging.json: %w", err)
	}
	today := clock.Today(clk)
	if _, err := d.Pool.Exec(ctx, `TRUNCATE platform.outbox, platform.processed_events, platform.audit_log, platform.idempotency_keys RESTART IDENTITY`); err != nil {
		return err
	}
	if err := billingpg.Reset(ctx, d); err != nil {
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
	// Housekeeping and messaging clear their copies of other contexts here, before the drains
	// below fill them from the seed events.
	if err := housekeepingpg.Seed(ctx, d, hk, clock.DaysBetween(hk.BaseDate, today)); err != nil {
		return fmt.Errorf("seed housekeeping: %w", err)
	}
	if err := messagingpg.Seed(ctx, d, msgs, clock.DaysBetween(msgs.BaseDate, today)); err != nil {
		return fmt.Errorf("seed messaging: %w", err)
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
	billingmodule.New(billingmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	servicesmodule.New(servicesmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms, Stays: rm.StayLookup()}).Project(proj)
	peoplemodule.New(peoplemodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	payrollmodule.New(payrollmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	housekeepingmodule.New(housekeepingmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms, NoReactions: true}).Project(proj)
	messagingmodule.New(messagingmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms, NoTriggers: true}).Project(proj)
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
	if err := billingpg.Seed(ctx, d, money, clock.DaysBetween(money.BaseDate, today)); err != nil {
		return fmt.Errorf("seed billing: %w", err)
	}
	log.Info("seeded", slog.Int("users", len(ids.Users)), slog.Int("units", len(props.Units)), slog.Int("listings", len(chans.Listings)),
		slog.Int("guests", len(guests.Guests)), slog.Int("bookings", len(stays.Bookings)), slog.Int("payments", len(money.Payments)), slog.Int("menuItems", len(menu.Menu)), slog.Int("orders", len(menu.Orders)), slog.Int("ownerStatements", len(owned.Statements)),
		slog.Int("employees", len(staff.Employees)), slog.Int("periods", len(pay.Periods)), slog.Int("events", n+m),
		slog.Int("shiftDays", clock.DaysBetween(props.BaseDate, today)))
	return nil
}
