// Package bootstrap is the composition root. It builds the contexts a process runs, chooses the
// in-process or HTTP client for each cross-context dependency, picks the bus, attaches the
// projector and assembles the router. The monolith runs every context; cmd/identity,
// cmd/property, cmd/channel, cmd/guest, cmd/reservation, cmd/billing, cmd/services, cmd/owners and
// cmd/files run one each against NATS.
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
	"github.com/syabanf/wit-hospitality/api/internal/billing"
	billingclients "github.com/syabanf/wit-hospitality/api/internal/billing/adapters/clients"
	billingpg "github.com/syabanf/wit-hospitality/api/internal/billing/adapters/postgres"
	billingmodule "github.com/syabanf/wit-hospitality/api/internal/billing/module"
	"github.com/syabanf/wit-hospitality/api/internal/channel"
	channelclient "github.com/syabanf/wit-hospitality/api/internal/channel/adapters/client"
	"github.com/syabanf/wit-hospitality/api/internal/channel/adapters/sources"
	channelmodule "github.com/syabanf/wit-hospitality/api/internal/channel/module"
	filesmodule "github.com/syabanf/wit-hospitality/api/internal/files/module"
	"github.com/syabanf/wit-hospitality/api/internal/files/storage"
	"github.com/syabanf/wit-hospitality/api/internal/finance"
	financemodule "github.com/syabanf/wit-hospitality/api/internal/finance/module"
	"github.com/syabanf/wit-hospitality/api/internal/guest"
	guestmodule "github.com/syabanf/wit-hospitality/api/internal/guest/module"
	housekeepingmodule "github.com/syabanf/wit-hospitality/api/internal/housekeeping/module"
	identitymodule "github.com/syabanf/wit-hospitality/api/internal/identity/module"
	ownerspg "github.com/syabanf/wit-hospitality/api/internal/owners/adapters/postgres"
	ownersresults "github.com/syabanf/wit-hospitality/api/internal/owners/adapters/results"
	messagingmodule "github.com/syabanf/wit-hospitality/api/internal/messaging/module"
	ownersmodule "github.com/syabanf/wit-hospitality/api/internal/owners/module"
	payrollmodule "github.com/syabanf/wit-hospitality/api/internal/payroll/module"
	peoplemodule "github.com/syabanf/wit-hospitality/api/internal/people/module"
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
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	reservationclients "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/clients"
	reservationcommand "github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	reservationmodule "github.com/syabanf/wit-hospitality/api/internal/reservation/module"
	servicesclients "github.com/syabanf/wit-hospitality/api/internal/services/adapters/clients"
	servicesmodule "github.com/syabanf/wit-hospitality/api/internal/services/module"
)

// Context names.
const (
	Identity    = "identity"
	Property    = "property"
	Channel     = "channel"
	Guest       = "guest"
	Reservation = "reservation"
	Owners      = "owners"
	Files       = "files"
	Billing     = "billing"
	Services    = "services"
	People      = "people"
	Payroll     = "payroll"
	// Housekeeping and Messaging are the phase 3 and 4 contexts built alongside people.
	Housekeeping = "housekeeping"
	Messaging    = "messaging"
	Finance      = "finance"
)

// All lists every context built so far, in migration order.
var All = []string{Identity, Property, Channel, Guest, Reservation, Billing, Services, People, Payroll, Maintenance, Inventory, Owners, Files, Housekeeping, Messaging, Finance}

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
	if slices.Contains(contexts, Guest) {
		sets = append(sets, guestmodule.Migrations())
	}
	if slices.Contains(contexts, Reservation) {
		sets = append(sets, reservationmodule.Migrations())
	}
	if slices.Contains(contexts, Owners) {
		sets = append(sets, ownersmodule.Migrations())
	}
	if slices.Contains(contexts, Billing) {
		sets = append(sets, billingmodule.Migrations())
	}
	if slices.Contains(contexts, Services) {
		sets = append(sets, servicesmodule.Migrations())
	}
	if slices.Contains(contexts, People) {
		sets = append(sets, peoplemodule.Migrations())
	}
	if slices.Contains(contexts, Payroll) {
		sets = append(sets, payrollmodule.Migrations())
	}
	if slices.Contains(contexts, Housekeeping) {
		sets = append(sets, housekeepingmodule.Migrations())
	}
	if slices.Contains(contexts, Messaging) {
		sets = append(sets, messagingmodule.Migrations())
	}
	sets = append(sets, operationsMigrations(contexts)...)
	if slices.Contains(contexts, Finance) {
		sets = append(sets, financemodule.Migrations())
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
	// Guest answers other contexts' questions about guests: in process when guest runs here,
	// else over HTTP to GUEST_URL; nil when neither is available.
	Guest guest.Client
	// Billing answers reservation and services: in process when billing runs here, else over HTTP
	// to BILLING_URL; nil when neither is available.
	Billing billing.Client
	// Finance answers other contexts' questions about their cash entries: in process when finance
	// runs here, else over HTTP to FINANCE_URL; nil when neither is available.
	Finance finance.Client
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
	// Reservation prices direct stays from channel's listings and asks guest about blacklists and
	// registrations, while channel reads reservation's stays, so reservation reads the channel and
	// guest clients through closures filled once those contexts are built below.
	var prices channel.Prices
	var guestClient guest.Client
	var billingClient billing.Client
	var rm *reservationmodule.Module
	if slices.Contains(contexts, Reservation) {
		rm = reservationmodule.New(reservationmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log,
			Clients: reservationcommand.Clients{
				Channel: reservationclients.Listings{Prices: func() channel.Prices { return prices }},
				Guests:  reservationclients.Guests{Client: func() guest.Client { return guestClient }},
				Billing: reservationclients.Billing{Client: func() billing.Client { return billingClient }},
			},
			Settings: reservationclients.BillingSettings{Client: func() billing.Client { return billingClient }}})
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
	// Services orders against reservation's stays, names the guest through guest's client and asks
	// billing about money; billing is built below, so services reads its client late.
	var sm *servicesmodule.Module
	if slices.Contains(contexts, Services) {
		var st reservation.Stays
		if rm != nil {
			st = rm.StayLookup()
		} else {
			if cfg.ReservationURL == "" || cfg.InternalToken == "" {
				return nil, errors.New("configuration: RESERVATION_URL and INTERNAL_TOKEN are required when reservation runs in another process")
			}
			st = reservation.StaysHTTP{BaseURL: cfg.ReservationURL, Token: cfg.InternalToken}
		}
		sm = servicesmodule.New(servicesmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log, Stays: st,
			Guests:  servicesclients.Guests{Client: func() guest.Client { return guestClient }},
			Billing: servicesBilling{client: func() billing.Client { return billingClient }}})
		sm.Project(proj)
	}
	var chm *channelmodule.Module
	if slices.Contains(contexts, Channel) {
		cd := channelmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log}
		if rm != nil {
			site := siteSources{site: rm.Site()}
			cd.Bookings, cd.Sources = site, site
		}
		if sm != nil {
			if cd.Sources == nil {
				cd.Sources = sources.None{}
			}
			cd.Sources = siteMenu{SiteSources: cd.Sources, menu: sm.SiteMenu}
		}
		chm = channelmodule.New(cd)
		chm.Project(proj)
		prices = chm.Prices()
	} else if url := os.Getenv("CHANNEL_URL"); url != "" {
		prices = channelclient.HTTP{BaseURL: url, Token: cfg.InternalToken}
	}
	var gm *guestmodule.Module
	if slices.Contains(contexts, Guest) {
		gm = guestmodule.New(guestmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log})
		gm.Project(proj)
		guestClient = gm.Client()
	} else if cfg.GuestURL != "" {
		guestClient = guest.HTTPClient{BaseURL: cfg.GuestURL, Token: cfg.InternalToken}
	}
	// Billing names guests through guest and closes a stay whose check-out link the guest paid
	// through reservation; reservation asks billing for money, so both read each other late.
	var financeClient finance.Client
	var bm *billingmodule.Module
	if slices.Contains(contexts, Billing) {
		checkOut := func() billingclients.CheckOut {
			if rm != nil {
				return rm.CheckOut
			}
			if cfg.ReservationURL != "" {
				return billingclients.ReservationHTTP{BaseURL: cfg.ReservationURL, Token: cfg.InternalToken}.CheckOut
			}
			return nil
		}
		bm = billingmodule.New(billingmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log,
			Guests:      billingclients.Guests{Client: func() guest.Client { return guestClient }},
			Reservation: billingclients.Reservation{Func: checkOut},
			Finance:     billingFinance{client: func() finance.Client { return financeClient }, pending: billingclients.PendingFinance{Store: billingpg.Store{DB: d}}}})
		bm.Project(proj)
		billingClient = bm.Client()
	} else if url := os.Getenv("BILLING_URL"); url != "" {
		billingClient = billing.HTTPClient{BaseURL: url, Token: cfg.InternalToken}
	}
	var hm *peoplemodule.Module
	if slices.Contains(contexts, People) {
		hm = peoplemodule.New(peoplemodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log})
		hm.Project(proj)
	}
	// Finance answers billing (approvals, cash accounts, closed months, shift cash), payroll's
	// service charge pool and owners' villa results.
	var finm *financemodule.Module
	if slices.Contains(contexts, Finance) {
		finm = financemodule.New(financemodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log})
		finm.Project(proj)
		financeClient = finm.Client()
	} else if url := os.Getenv("FINANCE_URL"); url != "" {
		financeClient = finance.HTTPClient{BaseURL: url, Token: cfg.InternalToken}
	}
	var paym *payrollmodule.Module
	if slices.Contains(contexts, Payroll) {
		pd := payrollmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log}
		if financeClient != nil {
			pd.Pool = financeClient
		}
		paym = payrollmodule.New(pd)
		paym.Project(proj)
	}
	var hkm *housekeepingmodule.Module
	if slices.Contains(contexts, Housekeeping) {
		var lostFound guest.LostFound
		if gm != nil {
			lostFound = gm.LostFound()
		} else if cfg.GuestURL != "" {
			lostFound = guest.HTTPClient{BaseURL: cfg.GuestURL, Token: cfg.InternalToken}
		}
		hc, err := housekeepingClients(lostFound)
		if err != nil {
			return nil, err
		}
		hkm = housekeepingmodule.New(housekeepingmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log, Clients: hc})
		hkm.Project(proj)
	}
	var mm *messagingmodule.Module
	if slices.Contains(contexts, Messaging) {
		md := messagingmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log, Provider: messagingProvider()}
		if billingClient != nil {
			md.Billing = billingClient
		}
		mm = messagingmodule.New(md)
		mm.Project(proj)
	}
	ops, err := buildOperations(cfg, log, d, clk, perms, contexts, pm, proj)
	if err != nil {
		return nil, err
	}

	// Owners reads villa results through owners.Results; until finance answers them, the module's
	// stub works them out from reservation's stays.
	var om *ownersmodule.Module
	if slices.Contains(contexts, Owners) {
		od := ownersmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: log}
		if financeClient != nil {
			od.Results = villaResults{stays: ownersresults.Stub{Store: ownerspg.Store{DB: d}}, finance: financeClient}
		}
		om = ownersmodule.New(od)
		om.Project(proj)
	}
	var fm *filesmodule.Module
	if slices.Contains(contexts, Files) {
		store, err := storage.FromEnv()
		if err != nil {
			return nil, err
		}
		public := os.Getenv("FILES_PUBLIC_URL")
		if public == "" {
			public = "http://localhost:8080/api/v1"
		}
		fm = filesmodule.New(filesmodule.Deps{Storage: store, Clock: clk, Log: log, PublicURL: public})
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

	app := &App{Cfg: cfg, Log: log, DB: d, Bus: b, Projector: proj, Contexts: contexts, ChannelPrices: prices, Guest: guestClient, Billing: billingClient, Finance: financeClient}
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
		if gm != nil {
			gm.Routes(r)
		}
		if rm != nil {
			rm.Routes(r)
		}
		if om != nil {
			om.Routes(r)
		}
		if fm != nil {
			fm.Routes(r)
		}
		if bm != nil {
			bm.Routes(r)
		}
		if sm != nil {
			sm.Routes(r)
		}
		if hm != nil {
			hm.Routes(r)
		}
		if paym != nil {
			paym.Routes(r)
		}
		ops.routes(r)
		if hkm != nil {
			hkm.Routes(r)
		}
		if mm != nil {
			mm.Routes(r)
		}
		if finm != nil {
			finm.Routes(r)
		}
	})
	if idm != nil || pm != nil || chm != nil || gm != nil || rm != nil || bm != nil || finm != nil {
		r.Route("/internal/v1", func(r chi.Router) {
			r.Use(httpx.InternalOnly(cfg.InternalToken, log))
			if idm != nil {
				idm.InternalRoutes(r)
			}
			if pm != nil {
				pm.InternalRoutes(r)
			}
			if chm != nil {
				chm.InternalRoutes(r)
			}
			if gm != nil {
				gm.InternalRoutes(r)
			}
			if rm != nil {
				rm.InternalRoutes(r)
			}
			if bm != nil {
				bm.InternalRoutes(r)
			}
			if finm != nil {
				finm.InternalRoutes(r)
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
