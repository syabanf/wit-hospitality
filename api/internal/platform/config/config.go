// Package config reads the environment once at start-up and fails fast, listing every missing or
// malformed variable in one error so an operator fixes them in one pass.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is everything a process needs from its environment.
type Config struct {
	// Service names the process in logs: monolith, identity, property, outbox-relay, seed, migrate.
	Service     string
	Env         string
	Version     string
	HTTPAddr    string
	DatabaseURL string
	// Bus is "inproc" (monolith only) or "nats".
	Bus     string
	NATSURL string
	// OutboxRelay is "embedded" (the process publishes its own outbox) or "off" (cmd/outbox-relay does).
	OutboxRelay  string
	JWTSecret    []byte
	AccessTTL    time.Duration
	RefreshTTL   time.Duration
	CookieSecure bool
	CORSOrigins  []string
	DemoMode     bool
	LogLevel     string
	BusinessTZ   *time.Location
	IdentityURL  string
	// ReservationURL is where a property service on its own asks about stays.
	ReservationURL string
	InternalToken  string
	// GuestURL is the guest service, for contexts that ask it questions in split mode.
	GuestURL string
	// MigrateOnStart runs the process's own migrations before serving.
	MigrateOnStart bool
}

type reader struct {
	problems []string
}

func (r *reader) str(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return fallback
}

func (r *reader) required(key string) string {
	v := r.str(key, "")
	if v == "" {
		r.problems = append(r.problems, key+" is required")
	}
	return v
}

func (r *reader) boolean(key string, fallback bool) bool {
	v := r.str(key, "")
	if v == "" {
		return fallback
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		r.problems = append(r.problems, fmt.Sprintf("%s must be true or false, got %q", key, v))
	}
	return b
}

func (r *reader) duration(key string, fallback time.Duration) time.Duration {
	v := r.str(key, "")
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		r.problems = append(r.problems, fmt.Sprintf("%s must be a positive duration like 15m, got %q", key, v))
	}
	return d
}

func (r *reader) oneOf(key, fallback string, allowed ...string) string {
	v := r.str(key, fallback)
	for _, a := range allowed {
		if v == a {
			return v
		}
	}
	r.problems = append(r.problems, fmt.Sprintf("%s must be one of %s, got %q", key, strings.Join(allowed, ", "), v))
	return v
}

// Needs says which optional parts a process uses, so a relay does not demand a JWT secret.
type Needs struct {
	HTTP     bool
	Database bool
	Auth     bool
}

// Load reads the environment for service.
func Load(service string, needs Needs) (Config, error) {
	r := &reader{}
	c := Config{
		Service:        service,
		Env:            r.oneOf("APP_ENV", "development", "development", "test", "staging", "production"),
		Version:        r.str("APP_VERSION", "dev"),
		HTTPAddr:       r.str("HTTP_ADDR", ":8080"),
		Bus:            r.oneOf("BUS", "inproc", "inproc", "nats"),
		NATSURL:        r.str("NATS_URL", "nats://localhost:4222"),
		OutboxRelay:    r.oneOf("OUTBOX_RELAY", "embedded", "embedded", "off"),
		AccessTTL:      r.duration("ACCESS_TOKEN_TTL", 15*time.Minute),
		RefreshTTL:     r.duration("REFRESH_TOKEN_TTL", 30*24*time.Hour),
		CookieSecure:   r.boolean("COOKIE_SECURE", false),
		DemoMode:       r.boolean("DEMO_MODE", false),
		LogLevel:       r.oneOf("LOG_LEVEL", "info", "debug", "info", "warn", "error"),
		IdentityURL:    r.str("IDENTITY_URL", ""),
		ReservationURL: r.str("RESERVATION_URL", ""),
		InternalToken:  r.str("INTERNAL_TOKEN", ""),
		GuestURL:       r.str("GUEST_URL", ""),
		MigrateOnStart: r.boolean("MIGRATE_ON_START", false),
	}
	for _, o := range strings.Split(r.str("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.CORSOrigins = append(c.CORSOrigins, o)
		}
	}
	tz := r.str("BUSINESS_TZ", "Asia/Makassar")
	loc, err := time.LoadLocation(tz)
	if err != nil {
		r.problems = append(r.problems, fmt.Sprintf("BUSINESS_TZ %q is not a known time zone", tz))
		loc = time.UTC
	}
	c.BusinessTZ = loc
	if needs.Database {
		c.DatabaseURL = r.required("DATABASE_URL")
	}
	if needs.Auth {
		secret := r.required("JWT_SECRET")
		if secret != "" && len(secret) < 32 {
			r.problems = append(r.problems, "JWT_SECRET must be at least 32 characters")
		}
		c.JWTSecret = []byte(secret)
	}
	if c.Bus == "inproc" && service != "monolith" && service != "seed" && service != "migrate" {
		r.problems = append(r.problems, fmt.Sprintf("BUS=inproc only works in the monolith; %s needs BUS=nats", service))
	}
	if c.Env == "production" && c.DemoMode {
		r.problems = append(r.problems, "DEMO_MODE cannot be true when APP_ENV=production")
	}
	if c.Env == "production" && needs.HTTP && !c.CookieSecure {
		r.problems = append(r.problems, "COOKIE_SECURE must be true when APP_ENV=production")
	}
	if len(r.problems) > 0 {
		return c, errors.New("configuration: " + strings.Join(r.problems, "; "))
	}
	return c, nil
}
