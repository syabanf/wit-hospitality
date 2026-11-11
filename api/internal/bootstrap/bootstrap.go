// Package bootstrap is the composition root. It builds the contexts a process runs, chooses the
// in-process or HTTP client for each cross-context dependency, picks the bus, attaches the
// projector and assembles the router. The monolith runs every context; cmd/identity,
// cmd/property, cmd/channel and cmd/reservation run one each against NATS.
package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"time"
	_ "time/tzdata" // BUSINESS_TZ resolves in a distroless image without zoneinfo

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api"
	"github.com/syabanf/wit-hospitality/api/internal/channel"
	channelclient "github.com/syabanf/wit-hospitality/api/internal/channel/adapters/client"
	channelmodule "github.com/syabanf/wit-hospitality/api/internal/channel/module"
	identitymodule "github.com/syabanf/wit-hospitality/api/internal/identity/module"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/config"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/property/adapters/stays"
	propertycommand "github.com/syabanf/wit-hospitality/api/internal/property/app/command"
	propertymodule "github.com/syabanf/wit-hospitality/api/internal/property/module"
	reservationclients "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/clients"
	reservationcommand "github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	reservationmodule "github.com/syabanf/wit-hospitality/api/internal/reservation/module"
)

// Context names.
const (
	Identity    = "identity"
	Property    = "property"
	Channel     = "channel"
	Reservation = "reservation"
)

// All lists every context built so far, in migration order.
var All = []string{Identity, Property, Channel, Reservation}

// MigrationSets returns the platform set and the sets of the named contexts.
func MigrationSets(contexts []string) []migrations.Set {
	sets := []migrations.Set{migrations.Platform()}
	if slices.Contains(contexts, Identity) {
		sets = append(sets, identitymodule.Migrations())
	}
	if slices.Contains(contexts, Property) {
		sets = append(sets, propertymodule.Migrations())
	}
	if slices.Contains(contexts, Channel) {
		sets = append(sets, channelmodule.Migrations())
	}
	if slices.Contains(contexts, Reservation) {
		sets = append(sets, reservationmodule.Migrations())
	}
	return sets
}

// Migrate applies the migrations of the named contexts.
func Migrate(ctx context.Context, d *db.DB, log *slog.Logger, contexts []string) error {
	sqlDB := d.SQL()
	defer sqlDB.Close()
	return migrations.Up(ctx, sqlDB, log, MigrationSets(contexts)...)
}

// Options adjusts Build for tests.
type Options struct {
	Contexts []string
	// Bus overrides the configured bus.
	Bus bus.Bus
	// Clock overrides the system clock.
	Clock clock.Clock
}

// App is a built process.
type App struct {
	Cfg       config.Config
	Log       *slog.Logger
	DB        *db.DB
	Bus       bus.Bus
	Projector *projector.Projector
	Relay     *outbox.Relay
	Handler   http.Handler
	Contexts  []string
	// ChannelPrices answers listing price lookups: in process when channel runs here, else over
	// HTTP to CHANNEL_URL. Nil when neither is available.
	ChannelPrices channel.Prices
}

// Build wires the named contexts. d may be nil when only the route list is wanted.
func Build(ctx context.Context, cfg config.Config, log *slog.Logger, d *db.DB, opts Options) (*App, error) {
	contexts := opts.Contexts
	if len(contexts) == 0 {
		contexts = All
	}
	clk := opts.Clock
	if clk == nil {
		clk = clock.System{Loc: cfg.BusinessTZ}
	}
	issuer := auth.Issuer{Secret: cfg.JWTSecret, TTL: cfg.AccessTTL}
	cookies := auth.Cookies{Secure: cfg.CookieSecure}
	proj := projector.New(d, log)

	var idm *identitymodule.Module
	var refresher auth.Refresher
	var perms rbac.Source
	if slices.Contains(contexts, Identity) {
		idm = identitymodule.New(identitymodule.Deps{
			DB: d, Clock: clk, Issuer: issuer, Cookies: cookies, Log: log,
			RefreshTTL: cfg.RefreshTTL, InitialPassword: initialPassword(),
		})
		idm.Project(proj)
		refresher, perms = idm.Refresher(), idm.Permissions()
	} else {
		if cfg.IdentityURL == "" || cfg.InternalToken == "" {
			return nil, errors.New("configuration: IDENTITY_URL and INTERNAL_TOKEN are required when identity runs in another process")
		}
		refresher = auth.HTTPRefresher{BaseURL: cfg.IdentityURL, Token: cfg.InternalToken}
		perms = &rbac.Cached{Src: rbac.HTTPSource{BaseURL: cfg.IdentityURL, Token: cfg.InternalToken}, TTL: 10 * time.Second}
	}
	// Reservation prices direct stays from channel's listings and channel reads reservation's
	// stays, so reservation gets the price client through a pointer filled once channel is built.
	var prices channel.Prices
	var rm *reservationmodule.Module
	if slices.Contains(contexts, Reservation) {
		rm = reservationmodule.New(reservationmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log,
			Clients: reservationcommand.Clients{Channel: reservationclients.Listings{Prices: func() channel.Prices { return prices }}}})
		rm.Project(proj)
	}
	var pm *propertymodule.Module
	if slices.Contains(contexts, Property) {
		var st propertycommand.Stays
		if rm != nil {
			st = rm.Stays()
		} else {
			if cfg.ReservationURL == "" || cfg.InternalToken == "" {
				return nil, errors.New("configuration: RESERVATION_URL and INTERNAL_TOKEN are required when reservation runs in another process")
			}
			st = stays.HTTP{BaseURL: cfg.ReservationURL, Token: cfg.InternalToken}
		}
		pm = propertymodule.New(propertymodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log, Stays: st})
		pm.Project(proj)
	}
	var chm *channelmodule.Module
	if slices.Contains(contexts, Channel) {
		cd := channelmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log}
		if rm != nil {
			site := siteSources{site: rm.Site()}
			cd.Bookings, cd.Sources = site, site
		}
		chm = channelmodule.New(cd)
		chm.Project(proj)
		prices = chm.Prices()
	} else if url := os.Getenv("CHANNEL_URL"); url != "" {
		prices = channelclient.HTTP{BaseURL: url, Token: cfg.InternalToken}
	}

	b := opts.Bus
	if b == nil && d != nil {
		if cfg.Bus == "inproc" {
			b = bus.NewInProcess()
		} else {
			nb, err := bus.DialNATS(ctx, cfg.NATSURL, cfg.Service, log)
			if err != nil {
				return nil, err
			}
			b = nb
		}
	}
	if b != nil {
		if err := proj.Attach(b); err != nil {
			return nil, err
		}
	}

	app := &App{Cfg: cfg, Log: log, DB: d, Bus: b, Projector: proj, Contexts: contexts, ChannelPrices: prices}
	if cfg.OutboxRelay == "embedded" && d != nil && b != nil {
		app.Relay = &outbox.Relay{DB: d, Bus: b, Log: log, Interval: time.Second}
	}

	r := httpx.NewRouter(log, cfg.CORSOrigins)
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(auth.Middleware(issuer, refresher, cookies, clk, log))
		r.Use(httpx.Idempotency(d, log))
		r.Use(projector.ReadYourWrites(proj, 3*time.Second, log))
		r.Get("/health", app.health)
		r.Get("/docs/openapi.yaml", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/yaml")
			_, _ = w.Write(api.OpenAPI)
		})
		if idm != nil {
			idm.Routes(r)
		}
		if pm != nil {
			pm.Routes(r)
		}
		if chm != nil {
			chm.Routes(r)
		}
		if rm != nil {
			rm.Routes(r)
		}
	})
	if idm != nil || chm != nil || rm != nil {
		r.Route("/internal/v1", func(r chi.Router) {
			r.Use(httpx.InternalOnly(cfg.InternalToken, log))
			if idm != nil {
				idm.InternalRoutes(r)
			}
			if chm != nil {
				chm.InternalRoutes(r)
			}
			if rm != nil {
				rm.InternalRoutes(r)
			}
		})
	}
	app.Handler = r
	return app, nil
}

// initialPassword is what a login made on the users page starts with: the mock's welcome123
// unless INITIAL_USER_PASSWORD says otherwise.
func initialPassword() string {
	if v := os.Getenv("INITIAL_USER_PASSWORD"); v != "" {
		return v
	}
	return "welcome123"
}

// Health is GET /api/v1/health.
type Health struct {
	OK      bool     `json:"ok"`
	Version string   `json:"version"`
	Service string   `json:"service"`
	DB      string   `json:"db"`
	Bus     string   `json:"bus"`
	Context []string `json:"contexts"`
}

func (a *App) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	h := Health{OK: true, Version: a.Cfg.Version, Service: a.Cfg.Service, DB: "ok", Bus: "ok", Context: a.Contexts}
	if a.DB == nil || a.DB.Ping(ctx) != nil {
		h.OK, h.DB = false, "down"
	}
	if a.Bus == nil || a.Bus.Ping(ctx) != nil {
		h.OK, h.Bus = false, "down"
	} else {
		h.Bus = a.Bus.Kind() + " ok"
	}
	status := http.StatusOK
	if !h.OK {
		status = http.StatusServiceUnavailable
	}
	httpx.JSON(w, status, h)
}

// Run starts delivery, the relay and the HTTP server, and stops them when ctx ends.
func (a *App) Run(ctx context.Context) error {
	if err := a.Bus.Start(ctx); err != nil {
		return fmt.Errorf("start bus: %w", err)
	}
	if a.Relay != nil {
		go func() { _ = a.Relay.Run(ctx) }()
	}
	srv := &http.Server{Addr: a.Cfg.HTTPAddr, Handler: a.Handler, ReadHeaderTimeout: 10 * time.Second}
	errc := make(chan error, 1)
	go func() {
		a.Log.Info("listening", slog.String("addr", a.Cfg.HTTPAddr), slog.Any("contexts", a.Contexts), slog.String("bus", a.Bus.Kind()))
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := srv.Shutdown(shutdown)
	_ = a.Bus.Close()
	return err
}

// RouteList builds the router without a database and lists its routes, for the contract script.
func RouteList(contexts []string) ([]httpx.Route, error) {
	cfg := config.Config{Service: "routes", OutboxRelay: "off", BusinessTZ: time.UTC, IdentityURL: "http://identity", ReservationURL: "http://reservation", InternalToken: "x"}
	app, err := Build(context.Background(), cfg, slog.New(slog.DiscardHandler), nil, Options{Contexts: contexts})
	if err != nil {
		return nil, err
	}
	return httpx.ListRoutes(app.Handler.(chi.Routes)), nil
}
