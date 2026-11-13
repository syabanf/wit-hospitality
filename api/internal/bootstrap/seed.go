package bootstrap

import (
	"cmp"
	"context"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"strings"

	billingpg "github.com/syabanf/wit-hospitality/api/internal/billing/adapters/postgres"
	billingmodule "github.com/syabanf/wit-hospitality/api/internal/billing/module"
	channelpg "github.com/syabanf/wit-hospitality/api/internal/channel/adapters/postgres"
	channelmodule "github.com/syabanf/wit-hospitality/api/internal/channel/module"
	financemodule "github.com/syabanf/wit-hospitality/api/internal/finance/module"
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
	"github.com/syabanf/wit-hospitality/api/internal/platform/snapshot"
	propertypg "github.com/syabanf/wit-hospitality/api/internal/property/adapters/postgres"
	propertymodule "github.com/syabanf/wit-hospitality/api/internal/property/module"
	reservationpg "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
	reservationmodule "github.com/syabanf/wit-hospitality/api/internal/reservation/module"
	servicespg "github.com/syabanf/wit-hospitality/api/internal/services/adapters/postgres"
	servicesmodule "github.com/syabanf/wit-hospitality/api/internal/services/module"
	"github.com/syabanf/wit-hospitality/api/seed"
)

// Seed loads the demo fixtures, shifted so the base date of the export becomes today, into every
// context whose tables are still empty (see seedTables), then projects the read models in process.
// A context that already holds data keeps it, so running it again duplicates nothing and an older
// database gains only the contexts it lacks; the copies those new contexts keep of the kept ones
// are filled from the kept records (fillFromKept). Reservation and services load after property's
// events are projected, because they read villas and units from their catalog copies. Billing loads
// last, once its copy of the bookings is projected. `make reset` starts from an empty database.
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
	fresh, err := emptyContexts(ctx, d)
	if err != nil {
		return err
	}
	if len(fresh) == 0 {
		log.Info("every context already holds data; nothing seeded")
		return nil
	}
	if fresh[Identity] {
		if err := identitypg.Seed(ctx, d, ids, clock.DaysBetween(ids.BaseDate, today)); err != nil {
			return fmt.Errorf("seed identity: %w", err)
		}
	}
	if fresh[Property] {
		if err := propertypg.Seed(ctx, d, props, clock.DaysBetween(props.BaseDate, today), clk.Now()); err != nil {
			return fmt.Errorf("seed property: %w", err)
		}
	}
	if fresh[Channel] {
		if err := channelpg.Seed(ctx, d, chans, clock.DaysBetween(chans.BaseDate, today), clk.Now()); err != nil {
			return fmt.Errorf("seed channel: %w", err)
		}
	}
	if fresh[Guest] {
		if err := guestpg.Seed(ctx, d, guests, clock.DaysBetween(guests.BaseDate, today), clk.Now()); err != nil {
			return fmt.Errorf("seed guest: %w", err)
		}
	}
	if fresh[Owners] {
		if err := ownerspg.Seed(ctx, d, owned, clock.DaysBetween(owned.BaseDate, today), today); err != nil {
			return fmt.Errorf("seed owners: %w", err)
		}
	}
	if fresh[People] {
		villaLocations := map[string]string{}
		for _, v := range props.Villas {
			villaLocations[v.ID] = v.LocationID
		}
		if err := peoplepg.Seed(ctx, d, staff, clock.ShiftFor(staff.BaseDate, today), villaLocations, clk.Now()); err != nil {
			return fmt.Errorf("seed people: %w", err)
		}
	}
	if fresh[Payroll] {
		if err := payrollpg.Seed(ctx, d, pay, clock.ShiftFor(pay.BaseDate, today), clk.Now()); err != nil {
			return fmt.Errorf("seed payroll: %w", err)
		}
	}
	// Housekeeping and messaging clear their copies of other contexts here, before the drains
	// below fill them from the seed events.
	if fresh[Housekeeping] {
		if err := housekeepingpg.Seed(ctx, d, hk, clock.DaysBetween(hk.BaseDate, today)); err != nil {
			return fmt.Errorf("seed housekeeping: %w", err)
		}
	}
	if fresh[Messaging] {
		if err := messagingpg.Seed(ctx, d, msgs, clock.DaysBetween(msgs.BaseDate, today)); err != nil {
			return fmt.Errorf("seed messaging: %w", err)
		}
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
	financemodule.New(financemodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	if err := seedOperations(ctx, d, log, clk, proj, fresh); err != nil {
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
	if err := fillFromKept(ctx, d, log, proj, fresh); err != nil {
		return err
	}
	if fresh[Finance] {
		rawFinance, err := seed.FS.ReadFile("finance.json")
		if err != nil {
			return err
		}
		if _, err := financemodule.Seed(ctx, d, rawFinance, today); err != nil {
			return fmt.Errorf("seed finance: %w", err)
		}
	}
	if fresh[Reservation] {
		if err := reservationpg.Seed(ctx, d, stays, clock.DaysBetween(stays.BaseDate, today), clk.Now()); err != nil {
			return fmt.Errorf("seed reservation: %w", err)
		}
	}
	if fresh[Services] {
		if err := servicespg.Seed(ctx, d, menu, clock.DaysBetween(menu.BaseDate, today), clk.Now()); err != nil {
			return fmt.Errorf("seed services: %w", err)
		}
	}
	m, err := relay.Drain(ctx)
	if err != nil {
		return fmt.Errorf("project reservation seed events: %w", err)
	}
	if fresh[Billing] {
		if err := billingpg.Seed(ctx, d, money, clock.DaysBetween(money.BaseDate, today)); err != nil {
			return fmt.Errorf("seed billing: %w", err)
		}
	}
	log.Info("seeded", slog.Any("contexts", slices.Sorted(maps.Keys(fresh))), slog.Int("events", n+m),
		slog.Int("shiftDays", clock.DaysBetween(props.BaseDate, today)))
	return nil
}

// seedTables names, per context, a table only its seed or a user's command fills. A context whose
// table has rows keeps its data and is not seeded again, so seeding an older database adds the
// contexts it lacks and duplicates nothing.
var seedTables = map[string]string{
	Identity: "identity.users", Property: "property.villas", Channel: "channel.airbnb_accounts", Guest: "guest.guests",
	Reservation: "reservation.bookings", Billing: "billing.transaction_codes", Services: "services.menu_items",
	People: "people.employees", Payroll: "payroll.periods", Maintenance: "maintenance.work_orders", Inventory: "inventory.items",
	Owners: "owners.villa_owners", Housekeeping: "housekeeping.settings", Messaging: "messaging.settings", Finance: "finance.categories",
}

// emptyContexts returns the contexts whose seed table has no rows.
func emptyContexts(ctx context.Context, d *db.DB) (map[string]bool, error) {
	fresh := map[string]bool{}
	for name, table := range seedTables {
		var held bool
		if err := d.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM `+table+`)`).Scan(&held); err != nil {
			return nil, fmt.Errorf("check %s: %w", table, err)
		}
		if !held {
			fresh[name] = true
		}
	}
	return fresh, nil
}

// fillFromKept replays the current records of the contexts kept as they were into the copies the
// freshly seeded contexts keep of them, as a monolith start catches a copy up. Without it a context
// seeded on an older database would see none of the villas, bookings, accounts or requests already
// there. Property's catalog goes first: a villa names its location, a unit its room type.
func fillFromKept(ctx context.Context, d *db.DB, log *slog.Logger, proj *projector.Projector, fresh map[string]bool) error {
	sources := snapshot.Sources{}
	for source, s := range map[string]snapshot.Sources{Property: propertypg.Snapshots(d), Reservation: reservationpg.Snapshots(d),
		Channel: channelpg.Snapshots(d), Services: servicespg.Snapshots(d)} {
		if !fresh[source] {
			maps.Copy(sources, s)
		}
	}
	events := slices.Sorted(maps.Keys(sources))
	slices.SortStableFunc(events, func(a, b string) int { return cmp.Compare(catalogOrder(a), catalogOrder(b)) })
	for _, eventType := range events {
		var records []snapshot.Record
		for _, consumer := range proj.Consumers() {
			if !fresh[strings.SplitN(consumer, ".", 2)[0]] || !proj.Handles(consumer, eventType) {
				continue
			}
			if records == nil {
				var err error
				if records, err = sources.Snapshot(ctx, eventType); err != nil {
					return err
				}
			}
			if err := proj.Replay(ctx, consumer, eventType, records); err != nil {
				return err
			}
			log.Info("filled a copy from kept data", slog.String("consumer", consumer), slog.String("event", eventType), slog.Int("records", len(records)))
		}
	}
	return nil
}

// catalogOrder places property's catalog events in catalogEvents order, ahead of every other event.
func catalogOrder(eventType string) int {
	if i := slices.Index(catalogEvents, eventType); i >= 0 {
		return i
	}
	return len(catalogEvents)
}
