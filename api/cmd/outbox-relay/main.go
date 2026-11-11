// Command outbox-relay publishes pending platform.outbox rows to NATS JetStream. Split mode runs
// one relay for the shared database; services set OUTBOX_RELAY=off.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/config"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

func main() {
	cfg, err := config.Load("outbox-relay", config.Needs{Database: true})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	log := logging.New("outbox-relay", cfg.LogLevel)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	d, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("database", "error", err.Error())
		os.Exit(1)
	}
	defer d.Close()
	b, err := bus.DialNATS(ctx, cfg.NATSURL, "outbox-relay", log)
	if err != nil {
		log.Error("nats", "error", err.Error())
		os.Exit(1)
	}
	defer b.Close()
	log.Info("relaying outbox to NATS", "nats", cfg.NATSURL)
	r := &outbox.Relay{DB: d, Bus: b, Log: log, Interval: time.Second}
	_ = r.Run(ctx)
}
