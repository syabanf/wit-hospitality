package bootstrap

import (
	"context"
	"fmt"
	"log/slog"

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
	"github.com/syabanf/wit-hospitality/api/seed"
)

// Seed replaces identity, property, people and payroll data with the demo fixtures, shifted so the base date of
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
	ids, err := identitypg.ParseSeed(rawIdentity)
	if err != nil {
		return fmt.Errorf("identity.json: %w", err)
	}
	props, err := propertypg.ParseSeed(rawProperty)
	if err != nil {
		return fmt.Errorf("property.json: %w", err)
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
	identitymodule.New(identitymodule.Deps{DB: d, Clock: clk, Log: log}).Project(proj)
	static := rbac.Static(rbac.DefaultPermissions())
	propertymodule.New(propertymodule.Deps{DB: d, Clock: clk, Log: log, Permissions: static}).Project(proj)
	peoplemodule.New(peoplemodule.Deps{DB: d, Clock: clk, Log: log, Permissions: static}).Project(proj)
	payrollmodule.New(payrollmodule.Deps{DB: d, Clock: clk, Log: log, Permissions: static}).Project(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		return err
	}
	n, err := (&outbox.Relay{DB: d, Bus: b, Log: log}).Drain(ctx)
	if err != nil {
		return fmt.Errorf("project seed events: %w", err)
	}
	log.Info("seeded", slog.Int("users", len(ids.Users)), slog.Int("units", len(props.Units)), slog.Int("employees", len(staff.Employees)), slog.Int("periods", len(pay.Periods)), slog.Int("events", n), slog.Int("shiftDays", clock.DaysBetween(props.BaseDate, today)))
	return nil
}
