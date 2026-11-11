// Package migrations runs goose migration sets. Each bounded context embeds its own set and owns
// one Postgres schema; the platform set owns the shared `platform` schema (outbox, processed
// events, idempotency keys, audit log). Every set keeps its version table inside its own schema,
// so a context moves to its own database with its migrations intact.
package migrations

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"

	"github.com/pressly/goose/v3"
)

// Set is one context's migrations.
type Set struct {
	// Schema the set owns; it is created before goose runs.
	Schema string
	FS     fs.FS
}

//go:embed sql/*.sql
var platformFS embed.FS

// Platform is the shared schema's set.
func Platform() Set {
	sub, _ := fs.Sub(platformFS, "sql")
	return Set{Schema: "platform", FS: sub}
}

// Up applies every pending migration of each set, in order.
func Up(ctx context.Context, db *sql.DB, log *slog.Logger, sets ...Set) error {
	for _, s := range sets {
		if _, err := db.ExecContext(ctx, fmt.Sprintf("CREATE SCHEMA IF NOT EXISTS %q", s.Schema)); err != nil {
			return fmt.Errorf("create schema %s: %w", s.Schema, err)
		}
		p, err := goose.NewProvider(goose.DialectPostgres, db, s.FS,
			goose.WithTableName(s.Schema+".goose_db_version"),
			goose.WithDisableGlobalRegistry(true),
		)
		if err != nil {
			return fmt.Errorf("migrations for %s: %w", s.Schema, err)
		}
		results, err := p.Up(ctx)
		if err != nil {
			return fmt.Errorf("migrate %s: %w", s.Schema, err)
		}
		for _, r := range results {
			log.Info("migration applied", slog.String("schema", s.Schema), slog.String("file", r.Source.Path))
		}
	}
	return nil
}
