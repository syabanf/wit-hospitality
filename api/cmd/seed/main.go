// Command seed loads the demo data (the front end's mock seed, exported to seed/*.json) into the
// identity and property schemas. It refuses to run unless DEMO_MODE=true, because every demo
// login shares one known password.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/config"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
)

func main() {
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
	if err := bootstrap.Migrate(ctx, d, log, bootstrap.All); err != nil {
		log.Error("migrate", "error", err.Error())
		os.Exit(1)
	}
	if err := bootstrap.Seed(ctx, d, log, clock.System{Loc: cfg.BusinessTZ}); err != nil {
		log.Error("seed", "error", err.Error())
		os.Exit(1)
	}
}
