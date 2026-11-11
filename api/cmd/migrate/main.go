// Command migrate applies the embedded migrations: the platform schema, then each context's.
//
//	migrate                       # every context
//	migrate -contexts identity    # one context (plus platform)
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/platform/config"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
)

func main() {
	only := flag.String("contexts", strings.Join(bootstrap.All, ","), "comma-separated contexts to migrate")
	flag.Parse()
	cfg, err := config.Load("migrate", config.Needs{Database: true})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	log := logging.New("migrate", cfg.LogLevel)
	ctx := context.Background()
	d, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("database", "error", err.Error())
		os.Exit(1)
	}
	defer d.Close()
	if err := bootstrap.Migrate(ctx, d, log, strings.Split(*only, ",")); err != nil {
		log.Error("migrate", "error", err.Error())
		os.Exit(1)
	}
	log.Info("migrations up to date")
}
