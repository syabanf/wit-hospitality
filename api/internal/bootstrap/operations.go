package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"

	"github.com/go-chi/chi/v5"

	inventorypg "github.com/syabanf/wit-hospitality/api/internal/inventory/adapters/postgres"
	inventorymodule "github.com/syabanf/wit-hospitality/api/internal/inventory/module"
	maintenanceclient "github.com/syabanf/wit-hospitality/api/internal/maintenance/adapters/client"
	maintenancepg "github.com/syabanf/wit-hospitality/api/internal/maintenance/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/command"
	maintenancemodule "github.com/syabanf/wit-hospitality/api/internal/maintenance/module"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/config"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	propertymodule "github.com/syabanf/wit-hospitality/api/internal/property/module"
	"github.com/syabanf/wit-hospitality/api/seed"
)

// Operations context names.
const (
	Maintenance = "maintenance"
	Inventory   = "inventory"
)

// operationsMigrations returns the maintenance and inventory sets the named contexts need.
func operationsMigrations(contexts []string) []migrations.Set {
	var sets []migrations.Set
	if slices.Contains(contexts, Maintenance) {
		sets = append(sets, maintenancemodule.Migrations())
	}
	if slices.Contains(contexts, Inventory) {
		sets = append(sets, inventorymodule.Migrations())
	}
	return sets
}

// operations are the maintenance and inventory modules a process runs.
type operations struct {
	maintenance *maintenancemodule.Module
	inventory   *inventorymodule.Module
}

// buildOperations wires maintenance and inventory. Maintenance holds units through property: in
// process when property runs here (inside the work order's transaction), else over HTTP to
// PROPERTY_URL. Finance is not built, so both record cash-out requests in their own outbox.
func buildOperations(cfg config.Config, log *slog.Logger, d *db.DB, clk clock.Clock, perms rbac.Source, contexts []string, pm *propertymodule.Module, proj *projector.Projector) (operations, error) {
	var ops operations
	if slices.Contains(contexts, Maintenance) {
		var blocks command.Blocks
		switch {
		case pm != nil:
			blocks = pm.Blocks()
		case os.Getenv("PROPERTY_URL") != "" && cfg.InternalToken != "":
			blocks = maintenanceclient.PropertyBlocks{BaseURL: os.Getenv("PROPERTY_URL"), Token: cfg.InternalToken}
		default:
			return ops, errors.New("configuration: PROPERTY_URL and INTERNAL_TOKEN are required when maintenance runs without property")
		}
		ops.maintenance = maintenancemodule.New(maintenancemodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log, Blocks: blocks})
		ops.maintenance.Project(proj)
	}
	if slices.Contains(contexts, Inventory) {
		ops.inventory = inventorymodule.New(inventorymodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log})
		ops.inventory.Project(proj)
	}
	return ops, nil
}

// seedOperations loads seed/maintenance.json and seed/inventory.json into whichever of the two is
// fresh, dates shifted so each file's base date becomes today, and registers both contexts'
// projections on proj so the seed drain fills their property references.
func seedOperations(ctx context.Context, d *db.DB, log *slog.Logger, clk clock.Clock, proj *projector.Projector, fresh map[string]bool) error {
	rawMaintenance, err := seed.FS.ReadFile("maintenance.json")
	if err != nil {
		return err
	}
	rawInventory, err := seed.FS.ReadFile("inventory.json")
	if err != nil {
		return err
	}
	mnt, err := maintenancepg.ParseSeed(rawMaintenance)
	if err != nil {
		return fmt.Errorf("maintenance.json: %w", err)
	}
	inv, err := inventorypg.ParseSeed(rawInventory)
	if err != nil {
		return fmt.Errorf("inventory.json: %w", err)
	}
	today := clock.Today(clk)
	if fresh[Maintenance] {
		if err := maintenancepg.Seed(ctx, d, mnt, clock.DaysBetween(mnt.BaseDate, today), clk.Now()); err != nil {
			return fmt.Errorf("seed maintenance: %w", err)
		}
	}
	if fresh[Inventory] {
		if err := inventorypg.Seed(ctx, d, inv, clock.DaysBetween(inv.BaseDate, today)); err != nil {
			return fmt.Errorf("seed inventory: %w", err)
		}
	}
	perms := rbac.Static(rbac.DefaultPermissions())
	maintenancemodule.New(maintenancemodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	inventorymodule.New(inventorymodule.Deps{DB: d, Clock: clk, Log: log, Permissions: perms}).Project(proj)
	return nil
}

// routes registers the public routes of the modules this process runs.
func (o operations) routes(r chi.Router) {
	if o.maintenance != nil {
		o.maintenance.Routes(r)
	}
	if o.inventory != nil {
		o.inventory.Routes(r)
	}
}
