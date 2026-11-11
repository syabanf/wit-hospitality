// Package testdb gives integration tests a real, empty Postgres database with every migration
// applied. Contexts own fixed schema names (identity, property, platform), so isolation comes from
// a fresh database per test, dropped when the test ends. Without a reachable Postgres the test is
// skipped with a message saying how to start one.
package testdb

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

// DefaultURL matches docker-compose.yml.
const DefaultURL = "postgres://wit:wit@localhost:55432/wit?sslmode=disable"

// URL is TEST_DATABASE_URL or the compose default.
func URL() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return DefaultURL
}

func withDatabase(raw, name string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	u.Path = "/" + name
	return u.String()
}

// New creates a database, applies sets (the platform set first), and drops it after the test.
func New(t testing.TB, sets ...migrations.Set) *db.DB {
	t.Helper()
	// Parallel HTTP tests each migrate every context's schema at once; allow for a busy server.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	admin, err := pgx.Connect(ctx, URL())
	if err != nil {
		t.Skipf("Postgres is not reachable at %s (%v). Start it with `make up` or set TEST_DATABASE_URL.", URL(), err)
	}
	defer admin.Close(context.Background())
	name := "wit_test_" + strings.ReplaceAll(ids.Random("t")[2:], "-", "")
	if _, err := admin.Exec(ctx, fmt.Sprintf("CREATE DATABASE %q", name)); err != nil {
		t.Fatalf("create test database: %v", err)
	}
	d, err := db.Open(ctx, withDatabase(URL(), name))
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() {
		d.Close()
		c, err := pgx.Connect(context.Background(), URL())
		if err != nil {
			return
		}
		defer c.Close(context.Background())
		_, _ = c.Exec(context.Background(), fmt.Sprintf("DROP DATABASE IF EXISTS %q WITH (FORCE)", name))
	})
	sqlDB := d.SQL()
	defer sqlDB.Close()
	all := append([]migrations.Set{migrations.Platform()}, sets...)
	if err := migrations.Up(ctx, sqlDB, logging.Discard(), all...); err != nil {
		t.Fatalf("migrate test database: %v", err)
	}
	return d
}
