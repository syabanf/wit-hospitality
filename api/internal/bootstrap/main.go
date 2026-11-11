package bootstrap

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/syabanf/wit-hospitality/api/internal/platform/config"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
)

// Serve is the main of cmd/monolith, cmd/identity and cmd/property: it reads the environment,
// optionally migrates, builds the contexts and serves until SIGINT or SIGTERM.
// `-routes` prints the route list as JSON and exits without touching the database.
func Serve(service string, contexts []string) {
	routes := flag.Bool("routes", false, "print the registered routes as JSON and exit")
	flag.Parse()
	if *routes {
		list, err := RouteList(contexts)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(list)
		return
	}
	cfg, err := config.Load(service, config.Needs{HTTP: true, Database: true, Auth: true})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	log := logging.New(service, cfg.LogLevel)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	d, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("database", "error", err.Error())
		os.Exit(1)
	}
	defer d.Close()
	if cfg.MigrateOnStart {
		if err := Migrate(ctx, d, log, contexts); err != nil {
			log.Error("migrate", "error", err.Error())
			os.Exit(1)
		}
	}
	app, err := Build(ctx, cfg, log, d, Options{Contexts: contexts})
	if err != nil {
		log.Error("build", "error", err.Error())
		os.Exit(1)
	}
	if err := app.Run(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve", "error", err.Error())
		os.Exit(1)
	}
}
