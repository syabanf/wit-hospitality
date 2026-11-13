// Command seed migrates and loads the demo data (the front end's mock seed, exported to
// seed/*.json) into every context whose tables are still empty. It refuses to run unless
// DEMO_MODE=true, because every demo login shares one known password.
//
//	seed          # migrate, then seed the empty contexts
//	seed -reset   # drop every schema the migrations own first (local development only)
package main

import (
	"context"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/config"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
)

func main() {
	reset := flag.Bool("reset", false, "drop every schema the migrations own before migrating and seeding; refused when APP_ENV=production")
	flag.Parse()
	if *reset && os.Getenv("APP_ENV") == "production" {
		fmt.Fprintln(os.Stderr, "seed: -reset refuses to run when APP_ENV=production")
		os.Exit(2)
	}
	cfg, err := config.Load("seed", config.Needs{Database: true})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if !cfg.DemoMode {
		fmt.Fprintln(os.Stderr, "seed: DEMO_MODE must be true; the demo logins share one known password")
		os.Exit(2)
	}
	log := logging.New("seed", cfg.LogLevel)
	ctx := context.Background()
	d, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("database", "error", err.Error())
		os.Exit(1)
	}
	defer d.Close()
	if *reset {
		if err := dropSchemas(ctx, d, cfg.DatabaseURL); err != nil {
			log.Error("reset", "error", err.Error())
			os.Exit(1)
		}
	}
	if err := bootstrap.Migrate(ctx, d, log, bootstrap.All); err != nil {
		log.Error("migrate", "error", err.Error())
		os.Exit(1)
	}
	if err := bootstrap.Seed(ctx, d, log, clock.System{Loc: cfg.BusinessTZ}); err != nil {
		log.Error("seed", "error", err.Error())
		os.Exit(1)
	}
}

// dropSchemas drops the platform schema and every context's, with all they hold, after saying which
// database and schemas it drops. Objects outside those schemas stay.
func dropSchemas(ctx context.Context, d *db.DB, databaseURL string) error {
	var schemas []string
	for _, s := range bootstrap.MigrationSets(bootstrap.All) {
		schemas = append(schemas, s.Schema)
	}
	target := "the database"
	if u, err := url.Parse(databaseURL); err == nil {
		target = u.Host + u.Path
	}
	fmt.Printf("reset: dropping schemas %s in %s\n", strings.Join(schemas, ", "), target)
	for _, s := range schemas {
		if _, err := d.Pool.Exec(ctx, fmt.Sprintf("DROP SCHEMA IF EXISTS %q CASCADE", s)); err != nil {
			return fmt.Errorf("drop schema %s: %w", s, err)
		}
	}
	return nil
}
