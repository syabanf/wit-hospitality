package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
)

// SeedCashOut is the status of a transaction a seeded receipt points at.
type SeedCashOut struct {
	ID          string `json:"id"`
	Number      string `json:"number"`
	Status      string `json:"status"`
	Amount      int64  `json:"amount"`
	SourceID    string `json:"sourceId"`
	CreatedByID string `json:"createdById"`
	CreatedBy   string `json:"createdBy"`
}

// SeedData is seed/inventory.json, written by scripts/export-seed.mjs from the mock's buildState.
type SeedData struct {
	BaseDate  string                `json:"baseDate"`
	Items     []domain.Item         `json:"items"`
	Movements []domain.Movement     `json:"movements"`
	Receipts  []domain.StockReceipt `json:"receipts"`
	Counts    []domain.Count        `json:"counts"`
	Kits      []domain.Kit          `json:"kits"`
	Links     []domain.MinibarLink  `json:"links"`
	MenuItems []inventory.MenuItem  `json:"menuItems"`
	CashOuts  []SeedCashOut         `json:"cashOuts"`
	Next      map[string]int        `json:"next"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

func stamp(s string, days int) string {
	if len(s) < 10 {
		return s
	}
	return clock.AddDays(s[:10], days) + s[10:]
}

// Seed replaces the inventory write model with the fixture, every date moved by shiftDays, and
// prices the items from the replay. Villa, room type and unit references arrive from property's
// seed events. Menu items are loaded here as well as from services' events, so a store works on
// a database without the services schema.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int) error {
	repo := Repo{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE inventory.items, inventory.movements, inventory.receipts, inventory.counts, inventory.kits, inventory.minibar_links,
			inventory.minibar_checks, inventory.counters, inventory.cash_outs, inventory.ref_villas, inventory.ref_groups, inventory.ref_units, inventory.ref_menu_items, inventory.ref_stays RESTART IDENTITY`); err != nil {
			return err
		}
		for _, i := range data.Items {
			if err := repo.InsertItem(ctx, &i); err != nil {
				return fmt.Errorf("seed item %s: %w", i.ID, err)
			}
		}
		for _, m := range data.Movements {
			m.On = clock.AddDays(m.On, shiftDays)
			if err := repo.InsertMovement(ctx, m); err != nil {
				return fmt.Errorf("seed movement %s: %w", m.ID, err)
			}
		}
		for _, r := range data.Receipts {
			r.ReceivedOn, r.CreatedOn = clock.AddDays(r.ReceivedOn, shiftDays), clock.AddDays(r.CreatedOn, shiftDays)
			if r.CancelledOn != nil {
				on := clock.AddDays(*r.CancelledOn, shiftDays)
				r.CancelledOn = &on
			}
			for i := range r.Attachments {
				r.Attachments[i].UploadedAt = stamp(r.Attachments[i].UploadedAt, shiftDays)
			}
			if r.Attachments == nil {
				r.Attachments = []domain.Attachment{}
			}
			if err := repo.InsertReceipt(ctx, &r); err != nil {
				return fmt.Errorf("seed receipt %s: %w", r.ID, err)
			}
		}
		for _, c := range data.Counts {
			c.CountedOn = clock.AddDays(c.CountedOn, shiftDays)
			if err := repo.InsertCount(ctx, c); err != nil {
				return fmt.Errorf("seed count %s: %w", c.ID, err)
			}
		}
		for _, k := range data.Kits {
			if err := repo.SaveKit(ctx, k); err != nil {
				return err
			}
		}
		for _, l := range data.Links {
			if err := repo.SaveLink(ctx, l); err != nil {
				return err
			}
		}
		for _, m := range data.MenuItems {
			if err := UpsertMenuItem(ctx, d, m, 1); err != nil {
				return err
			}
		}
		for _, c := range data.CashOuts {
			if _, err := q.Exec(ctx, `
				INSERT INTO inventory.cash_outs (id, number, status, origin, source_id, amount, created_by_id, created_by, request)
				VALUES ($1, $2, $3, 'stock', $4, $5, $6, $7, '{}')`, c.ID, c.Number, c.Status, c.SourceID, c.Amount, c.CreatedByID, c.CreatedBy); err != nil {
				return fmt.Errorf("seed cash-out %s: %w", c.ID, err)
			}
		}
		for key, next := range data.Next {
			if _, err := q.Exec(ctx, `INSERT INTO inventory.counters (key, next) VALUES ($1, $2)`, key, next); err != nil {
				return err
			}
		}
		moves, err := repo.Movements(ctx)
		if err != nil {
			return err
		}
		replay := domain.ReplayCost(moves)
		averages := map[string]int64{}
		for _, i := range data.Items {
			averages[i.ID] = replay.Average(i.ID, "")
		}
		return repo.SetAverages(ctx, averages)
	})
}
